import {
  computed,
  effectScope,
  getCurrentScope,
  getCurrentInstance,
  inject,
  onScopeDispose,
  reactive,
  shallowRef,
  type ComputedRef,
  type WritableComputedRef,
} from 'vue'
import { useRouter } from '../useApi'
import { onBeforeRouteLeave } from '../navigationGuards'
import { matchedRouteKey } from '../injectionSymbols'
import type { RouteMap } from '../typed-routes/route-map'
import type { RouteLocationNormalizedLoaded } from '../typed-routes'
import type { EXPERIMENTAL_Router } from './router'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { QUERY_STATE_SCROLL } from './query-state-internals'
import { experimental_normalizeQuery } from './query'

export interface QueryStateOptions {
  history?: 'replace' | 'push'
  debounce?: number
  throttle?: number
  scroll?: boolean
  clearOnDefault?: boolean
}

export interface QueryParamControls<T> {
  pending: ComputedRef<boolean>
  update(value: T, options?: QueryStateOptions): Promise<void>
  flush(): Promise<void>
  reset(options?: QueryStateOptions): Promise<void>
}

export type QueryParamRef<T> = WritableComputedRef<T> &
  readonly [WritableComputedRef<T>, QueryParamControls<T>]

type Params<Name extends keyof RouteMap> = RouteLocationNormalizedLoaded<
  Name | RouteMap[Name]['childrenNames']
>['params']

export type QueryParamsState<T> = T & {
  $patch(values: Partial<T>, options?: QueryStateOptions): Promise<void>
  $reset(options?: QueryStateOptions): Promise<void>
  readonly $pending: boolean
}

type Name = string | symbol
type Matcher = MatcherPatternQueryParam<any, string>
type Deferred = { resolve(): void; reject(reason: unknown): void }
type Write = {
  value: unknown
  options: QueryStateOptions
  deadlines: Map<symbol, number>
  deferred: Deferred[]
}

const engines = new WeakMap<
  EXPERIMENTAL_Router,
  ReturnType<typeof createEngine>
>()

function queryMatchers(router: EXPERIMENTAL_Router, name: Name) {
  const record = router.getRoutes().find(record => record.name === name)
  if (!record) throw new Error(`Unknown query-state route: ${String(name)}`)
  const chain = []
  for (
    let current: typeof record | undefined = record;
    current;
    current = current.parent as typeof record | undefined
  ) {
    chain.unshift(current)
  }
  const matchers = new Map<string, Matcher>()
  for (const current of chain) {
    for (const matcher of current.query || []) {
      if (!(matcher instanceof MatcherPatternQueryParam)) {
        throw new Error(
          'Query state requires MatcherPatternQueryParam matchers'
        )
      }
      matchers.set(matcher.paramName, matcher)
    }
  }
  return matchers
}

function createEngine(router: EXPERIMENTAL_Router) {
  const overlay = shallowRef(new Map<Name, Map<string, Write>>())
  const queue = new Map<Name, Map<string, Write>>()
  const lastFlush = new Map<Name, Map<string, number>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let running: Promise<void> | undefined
  let internalNavigation = false
  router._beforeQueryStateNavigation = () =>
    internalNavigation ? Promise.resolve() : flush()
  router._cancelQueryStateNavigation = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const error = new Error(
      'Query-state update cancelled by native history navigation'
    )
    for (const writes of queue.values()) {
      for (const write of writes.values()) {
        for (const deferred of write.deferred) deferred.reject(error)
      }
    }
    queue.clear()
    overlay.value = new Map()
  }

  function notify() {
    overlay.value = new Map(overlay.value)
  }

  function nextDeadline() {
    let due = Infinity
    for (const writes of queue.values()) {
      for (const write of writes.values()) {
        for (const deadline of write.deadlines.values())
          due = Math.min(due, deadline)
      }
    }
    return due
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const due = nextDeadline()
    if (due === Infinity) return
    if (due <= Date.now()) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          void flush(false)
        })
      }
    } else {
      timer = setTimeout(() => {
        timer = undefined
        void flush(false)
      }, due - Date.now())
    }
  }

  function write(
    name: Name,
    key: string,
    value: unknown,
    options: QueryStateOptions,
    source: symbol
  ) {
    const matcher = queryMatchers(router, name).get(key)
    if (!matcher) throw new Error(`Not a query param: ${key}`)
    if (router.currentRoute.value.name !== name) {
      return Promise.reject(
        new Error('Cannot update query state for an inactive route')
      )
    }
    if (
      value === undefined &&
      matcher.required &&
      matcher.defaultValue === undefined
    ) {
      return Promise.reject(
        new Error(`Cannot reset required query param: ${key}`)
      )
    }
    const previous = overlay.value.get(name)?.get(key)
    const current = previous
      ? previous.value
      : router.currentRoute.value.params[key]
    if (
      matcher.equals(current, value) &&
      !previous &&
      options.clearOnDefault === undefined
    )
      return Promise.resolve()
    const now = Date.now()
    const deadlines = new Map(queue.get(name)?.get(key)?.deadlines)
    deadlines.set(
      source,
      Math.max(
        now + Math.max(0, options.debounce || 0),
        (lastFlush.get(name)?.get(key) ?? -Infinity) +
          Math.max(0, options.throttle || 0)
      )
    )
    const entry: Write = {
      value,
      options: {
        ...options,
        history:
          options.history === 'push' ||
          queue.get(name)?.get(key)?.options.history === 'push'
            ? 'push'
            : 'replace',
        scroll:
          options.scroll === true ||
          queue.get(name)?.get(key)?.options.scroll === true,
      },
      deadlines,
      deferred: queue.get(name)?.get(key)?.deferred || [],
    }
    const promise = new Promise<void>((resolve, reject) =>
      entry.deferred.push({ resolve, reject })
    )
    if (!queue.has(name)) queue.set(name, new Map())
    queue.get(name)!.set(key, entry)
    if (!overlay.value.has(name)) overlay.value.set(name, new Map())
    overlay.value.get(name)!.set(key, entry)
    notify()
    schedule()
    return promise
  }

  async function commit() {
    const batch = new Map(queue)
    queue.clear()
    for (const [name, writes] of batch) {
      try {
        const current = router.currentRoute.value
        if (current.name !== name)
          throw new Error('Query-state route changed before settlement')
        const params = { ...current.params }
        for (const [key, write] of writes) params[key] = write.value as any
        const query = { ...current.query }
        for (const [key, matcher] of queryMatchers(router, name)) {
          delete query[matcher.queryKey]
          Object.assign(
            query,
            experimental_normalizeQuery(
              matcher.build(params, {
                clearOnDefault: writes.get(key)?.options.clearOnDefault,
              })
            )
          )
        }
        const options = [...writes.values()].map(write => write.options)
        const location = {
          path: current.path,
          query,
          hash: current.hash,
          replace: !options.some(option => option.history === 'push'),
          [QUERY_STATE_SCROLL]: options.some(option => option.scroll === true),
        }
        if (!lastFlush.has(name)) lastFlush.set(name, new Map())
        for (const key of writes.keys())
          lastFlush.get(name)!.set(key, Date.now())
        let navigation: ReturnType<EXPERIMENTAL_Router['push']>
        internalNavigation = true
        try {
          navigation = router.push(location)
        } finally {
          internalNavigation = false
        }
        await navigation
        for (const write of writes.values())
          for (const deferred of write.deferred) deferred.resolve()
      } catch (error) {
        for (const write of writes.values())
          for (const deferred of write.deferred) deferred.reject(error)
      } finally {
        for (const [key, write] of writes) {
          if (overlay.value.get(name)?.get(key) === write)
            overlay.value.get(name)!.delete(key)
        }
        if (!overlay.value.get(name)?.size) overlay.value.delete(name)
        notify()
      }
    }
  }

  async function flush(force = true): Promise<void> {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (running) {
      await running
      if (force) return flush()
      if (queue.size) schedule()
      return
    }
    if (!queue.size) return
    if (!force && nextDeadline() > Date.now()) {
      schedule()
      return
    }
    running = commit()
    await running
    running = undefined
    if (queue.size) {
      if (force) return flush()
      schedule()
    }
  }

  function flushBeforeLeave() {
    return running ? undefined : flush()
  }

  return { overlay, write, flush, flushBeforeLeave }
}

function useEngine() {
  const router = useRouter() as unknown as EXPERIMENTAL_Router
  let engine = engines.get(router)
  if (!engine) engines.set(router, (engine = createEngine(router)))
  return { router, engine }
}

function scoped<T>(engine: ReturnType<typeof createEngine>, setup: () => T): T {
  const parent = getCurrentScope()
  const scope = effectScope()
  const value = scope.run(setup)!
  if (getCurrentInstance() && inject(matchedRouteKey, undefined)?.value) {
    onBeforeRouteLeave(engine.flushBeforeLeave)
  }
  if (parent) {
    onScopeDispose(() => {
      void engine.flush()
      scope.stop()
    })
  }
  return value
}

export function useQueryParam<
  Name extends keyof RouteMap,
  Key extends keyof Params<Name> & string,
>(
  name: Name,
  key: Key,
  options: QueryStateOptions = {}
): QueryParamRef<Params<Name>[Key]> {
  const { router, engine } = useEngine()
  const matcher = queryMatchers(router, name).get(key)
  if (!matcher) throw new Error(`Not a query param: ${key}`)
  return scoped(engine, () => {
    type T = Params<Name>[Key]
    const source = Symbol()
    const update = (value: T, override?: QueryStateOptions) =>
      engine.write(name, key, value, { ...options, ...override }, source)
    const value = computed<T>({
      get: previous => {
        const write = engine.overlay.value.get(name)?.get(key)
        const route = router.currentRoute.value
        const next = (
          write
            ? write.value
            : route.name === name
              ? route.params[key]
              : matcher.getDefaultValue()
        ) as T
        return previous !== undefined && matcher.equals(previous, next)
          ? (previous as T)
          : next
      },
      set: value => {
        void update(value).catch(() => {})
      },
    })
    const controls: QueryParamControls<T> = {
      pending: computed(
        () => engine.overlay.value.get(name)?.has(key) || false
      ),
      update,
      flush: engine.flush,
      reset: override =>
        update(matcher.getDefaultValue() as T, {
          clearOnDefault: options.clearOnDefault ?? matcher.clearOnDefault,
          ...override,
        }),
    }
    Object.defineProperties(value, {
      0: { value },
      1: { value: controls },
      length: { value: 2 },
      [Symbol.iterator]: {
        value: function* () {
          yield value
          yield controls
        },
      },
    })
    return value as QueryParamRef<T>
  })
}

export function useQueryParams<Name extends keyof RouteMap>(
  name: Name,
  options: QueryStateOptions = {}
): QueryParamsState<Params<Name>> {
  const { router, engine } = useEngine()
  const matchers = queryMatchers(router, name)
  return scoped(engine, () => {
    const source = Symbol()
    const state: Record<string, unknown> = {}
    const patch = (
      values: Record<string, unknown>,
      override?: QueryStateOptions
    ) => {
      for (const key of Object.keys(values)) {
        if (!matchers.has(key)) throw new Error(`Not a query param: ${key}`)
      }
      return Promise.all(
        Object.entries(values).map(([key, value]) =>
          engine.write(name, key, value, { ...options, ...override }, source)
        )
      ).then(() => {})
    }
    for (const [key, matcher] of matchers) {
      const value = computed(previous => {
        const write = engine.overlay.value.get(name)?.get(key)
        const route = router.currentRoute.value
        const next = write
          ? write.value
          : route.name === name
            ? route.params[key]
            : matcher.getDefaultValue()
        return previous !== undefined && matcher.equals(previous, next)
          ? previous
          : next
      })
      Object.defineProperty(state, key, {
        enumerable: true,
        get: () => value.value,
        set: value => {
          void patch({ [key]: value }).catch(() => {})
        },
      })
    }
    Object.defineProperties(state, {
      $patch: { value: patch },
      $reset: {
        value: (override?: QueryStateOptions) => {
          for (const [key, matcher] of matchers) {
            if (matcher.required && matcher.defaultValue === undefined) {
              return Promise.reject(
                new Error(`Cannot reset required query param: ${key}`)
              )
            }
          }
          return Promise.all(
            [...matchers].map(([key, matcher]) =>
              engine.write(
                name,
                key,
                matcher.getDefaultValue(),
                {
                  ...options,
                  clearOnDefault:
                    options.clearOnDefault ?? matcher.clearOnDefault,
                  ...override,
                },
                source
              )
            )
          ).then(() => {})
        },
      },
      $pending: { get: () => !!engine.overlay.value.get(name)?.size },
    })
    return reactive(state) as QueryParamsState<Params<Name>>
  })
}
