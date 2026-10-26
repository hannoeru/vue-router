import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  reactive,
  readonly,
  shallowRef,
  ssrContextKey,
  type ComputedRef,
  type DeepReadonly,
  type WritableComputedRef,
} from 'vue'
import { useRouter } from '../useApi'
import type { NavigationFailure } from '../errors'
import type { RouteMap } from '../typed-routes/route-map'
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

export type QueryStateResult =
  | void
  | NavigationFailure
  | { readonly cancelled: true }

export interface QueryParamControls<T> {
  pending: ComputedRef<boolean>
  update(value: T, options?: QueryStateOptions): Promise<QueryStateResult>
  flush(): Promise<QueryStateResult>
  reset(options?: QueryStateOptions): Promise<QueryStateResult>
}

export type QueryParamState<T, Raw = T> = QueryParamControls<Raw> & {
  state: WritableComputedRef<DeepReadonly<T>, Raw>
}

type Params<Name extends keyof RouteMap> = Pick<
  RouteMap[Name]['params'],
  RouteMap[Name]['queryKeys']
>
type ParamsRaw<Name extends keyof RouteMap> = Pick<
  RouteMap[Name]['paramsRaw'],
  RouteMap[Name]['queryKeys']
>

export type QueryParamsState<T, Raw = T> = {
  state: { [K in keyof T]: DeepReadonly<T[K]> }
  patch(
    values: keyof Raw extends never ? Record<string, never> : Partial<Raw>,
    options?: QueryStateOptions
  ): Promise<QueryStateResult>
  reset(options?: QueryStateOptions): Promise<QueryStateResult>
  flush(): Promise<QueryStateResult>
  pending: ComputedRef<boolean>
}

type Name = string | symbol
type Matcher = MatcherPatternQueryParam<any, string>
type Batch = {
  promise: Promise<QueryStateResult>
  resolve(result: QueryStateResult): void
  reject(reason: unknown): void
}
type Write = {
  raw: unknown
  value: unknown
  options: QueryStateOptions
  deadlines: Map<symbol, number>
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

function validateOptions(options: QueryStateOptions) {
  for (const wait of [options.debounce, options.throttle]) {
    if (wait !== undefined && (Number.isNaN(wait) || wait < 0)) {
      throw new Error(
        'Query-state waits must be non-negative numbers or Infinity'
      )
    }
  }
}

function immutable<T>(value: T): DeepReadonly<T> {
  return (
    value !== null && typeof value === 'object' ? readonly(value) : value
  ) as DeepReadonly<T>
}

function createEngine(router: EXPERIMENTAL_Router) {
  const overlay = shallowRef(new Map<Name, Map<string, Write>>())
  const queue = new Map<Name, Map<string, Write>>()
  const lastFlush = new Map<Name, Map<string, number>>()
  let batch: Batch | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let running: Promise<QueryStateResult> | undefined
  let forceQueued = false
  let activeCommitOrigin: symbol | undefined
  router._beforeQueryStateNavigation = origin => {
    if (origin === undefined || origin !== activeCommitOrigin) cancel()
    return Promise.resolve()
  }
  router._cancelQueryStateNavigation = cancel
  router.afterEach(to => {
    if ([...queue.keys()].some(name => name !== to.name)) cancel()
  })

  function cancel() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    batch?.resolve({ cancelled: true })
    batch = undefined
    forceQueued = false
    queue.clear()
    overlay.value = new Map()
  }

  function notify() {
    overlay.value = new Map(overlay.value)
  }

  function nextDeadline() {
    let due = -Infinity
    for (const writes of queue.values()) {
      for (const write of writes.values()) {
        for (const deadline of write.deadlines.values())
          due = Math.max(due, deadline)
      }
    }
    return due
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!queue.size || running) return
    const due = nextDeadline()
    if (due === Infinity) return
    if (due <= Date.now()) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          if (nextDeadline() <= Date.now()) void flush().catch(() => {})
          else schedule()
        })
      }
    } else {
      timer = setTimeout(
        () => {
          timer = undefined
          if (nextDeadline() <= Date.now()) void flush().catch(() => {})
          else schedule()
        },
        Math.min(due - Date.now(), 2 ** 31 - 1)
      )
    }
  }

  function write(
    name: Name,
    values: Record<string, unknown>,
    options: QueryStateOptions,
    source: symbol,
    server: boolean,
    reset = false
  ) {
    if (server) return Promise.resolve()
    const matchers = queryMatchers(router, name)
    try {
      validateOptions(options)
      if (router.currentRoute.value.name !== name)
        throw new Error('Cannot update query state for an inactive route')
      const params = Object.assign(
        Object.create(null),
        router.currentRoute.value.params,
        values
      )
      const normalized = new Map<string, unknown>()
      for (const [key, value] of Object.entries(values)) {
        const matcher = matchers.get(key)
        if (!matcher) throw new Error(`Not a query param: ${key}`)
        if (
          value === undefined &&
          matcher.required &&
          matcher.defaultValue === undefined
        ) {
          throw new Error(`Cannot reset required query param: ${key}`)
        }
        normalized.set(
          key,
          matcher.match(
            experimental_normalizeQuery(
              matcher.build(params, { clearOnDefault: options.clearOnDefault })
            )
          )[key]
        )
      }
      const entries: [string, Write][] = []
      for (const [key, value] of Object.entries(values)) {
        const matcher = matchers.get(key)!
        const previous = overlay.value.get(name)?.get(key)
        if (
          !reset &&
          !previous &&
          options.clearOnDefault === undefined &&
          matcher.equals(
            Object.hasOwn(router.currentRoute.value.params, key)
              ? router.currentRoute.value.params[key]
              : undefined,
            value
          )
        )
          continue
        const queued = queue.get(name)?.get(key)
        const deadlines = new Map(queued?.deadlines)
        deadlines.set(
          source,
          options.throttle === Infinity
            ? Infinity
            : Math.max(
                deadlines.get(source) ?? -Infinity,
                Date.now() + (options.debounce ?? 0),
                (lastFlush.get(name)?.get(key) ?? -Infinity) +
                  (options.throttle ?? 0)
              )
        )
        entries.push([
          key,
          {
            raw: value,
            value: normalized.get(key),
            options: {
              ...options,
              history:
                options.history === 'push' || queued?.options.history === 'push'
                  ? 'push'
                  : 'replace',
              scroll:
                options.scroll === true || queued?.options.scroll === true,
            },
            deadlines,
          },
        ])
      }
      if (!entries.length) return batch?.promise ?? Promise.resolve()
      if (!batch) {
        let resolve!: Batch['resolve']
        let reject!: Batch['reject']
        const promise = new Promise<QueryStateResult>((res, rej) => {
          resolve = res
          reject = rej
        })
        void promise.catch(() => {})
        batch = { promise, resolve, reject }
      }
      if (!queue.has(name)) queue.set(name, new Map())
      if (!overlay.value.has(name)) overlay.value.set(name, new Map())
      for (const [key, entry] of entries) {
        queue.get(name)!.set(key, entry)
        overlay.value.get(name)!.set(key, entry)
      }
      notify()
      schedule()
      return batch.promise
    } catch (error) {
      const rejected = Promise.reject<QueryStateResult>(error)
      void rejected.catch(() => {})
      return rejected
    }
  }

  async function commit(writesByName: Map<Name, Map<string, Write>>) {
    let result: QueryStateResult = undefined
    for (const [name, writes] of writesByName) {
      try {
        const current = router.currentRoute.value
        if (current.name !== name) return { cancelled: true } as const
        const params = Object.assign(Object.create(null), current.params)
        for (const [key, write] of writes) params[key] = write.raw
        const query = Object.assign(Object.create(null), current.query)
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
        activeCommitOrigin = Symbol()
        try {
          result = await router._withQueryStateNavigation(
            activeCommitOrigin,
            () => router.push(location)
          )
        } finally {
          activeCommitOrigin = undefined
        }
      } finally {
        for (const [key, write] of writes) {
          if (overlay.value.get(name)?.get(key) === write)
            overlay.value.get(name)!.delete(key)
        }
        if (!overlay.value.get(name)?.size) overlay.value.delete(name)
        notify()
      }
    }
    return result
  }

  function flush(): Promise<QueryStateResult> {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (running) {
      if (batch) forceQueued = true
      return batch?.promise ?? running
    }
    if (!batch) return Promise.resolve()
    const settlement = batch
    const writes = new Map(queue)
    batch = undefined
    queue.clear()
    running = settlement.promise
    void commit(writes).then(
      result => {
        finish()
        settlement.resolve(result)
      },
      error => {
        finish()
        settlement.reject(error)
      }
    )
    return settlement.promise
  }

  function finish() {
    running = undefined
    if (forceQueued) {
      forceQueued = false
      void flush().catch(() => {})
    } else {
      schedule()
    }
  }

  return { overlay, write, flush }
}

function useEngine() {
  const router = useRouter() as unknown as EXPERIMENTAL_Router
  let engine = engines.get(router)
  if (!engine) engines.set(router, (engine = createEngine(router)))
  const server =
    typeof window === 'undefined' || !!inject(ssrContextKey, undefined)
  if (getCurrentScope())
    onScopeDispose(() => {
      void engine!.flush().catch(() => {})
    })
  return { router, engine, server }
}

export function useQueryParam<
  Name extends keyof RouteMap,
  Key extends keyof Params<Name> & keyof ParamsRaw<Name> & string,
>(
  name: Name,
  key: Key,
  options: QueryStateOptions = {}
): QueryParamState<Params<Name>[Key], ParamsRaw<Name>[Key]> {
  validateOptions(options)
  const { router, engine, server } = useEngine()
  const matcher = queryMatchers(router, name).get(key)
  if (!matcher) throw new Error(`Not a query param: ${key}`)
  type T = Params<Name>[Key]
  const source = Symbol()
  type Raw = ParamsRaw<Name>[Key]
  const update = (value: Raw, override?: QueryStateOptions) =>
    engine.write(
      name,
      { [key]: value },
      { ...options, ...override },
      source,
      server
    )
  const state = computed<DeepReadonly<T>, Raw>({
    get: previous => {
      const write = engine.overlay.value.get(name)?.get(key)
      const route = router.currentRoute.value
      const next = (
        write
          ? write.value
          : route.name === name && Object.hasOwn(route.params, key)
            ? route.params[key]
            : matcher.getDefaultValue()
      ) as T
      return previous !== undefined && matcher.equals(previous, next)
        ? previous
        : immutable(next)
    },
    set: value => {
      void update(value)
    },
  })
  return {
    state,
    pending: computed(() => engine.overlay.value.get(name)?.has(key) || false),
    update,
    flush: engine.flush,
    reset: override =>
      update(matcher.getDefaultValue() as Raw, {
        clearOnDefault: options.clearOnDefault ?? matcher.clearOnDefault,
        ...override,
      }),
  }
}

export function useQueryParams<Name extends keyof RouteMap>(
  name: Name,
  options: QueryStateOptions = {}
): QueryParamsState<Params<Name>, ParamsRaw<Name>> {
  validateOptions(options)
  const { router, engine, server } = useEngine()
  const matchers = queryMatchers(router, name)
  const source = Symbol()
  const state: Record<string, unknown> = Object.create(null)
  const patch = (
    values: Record<string, unknown>,
    override?: QueryStateOptions
  ) => engine.write(name, values, { ...options, ...override }, source, server)
  for (const [key, matcher] of matchers) {
    const value = computed(previous => {
      const write = engine.overlay.value.get(name)?.get(key)
      const route = router.currentRoute.value
      const next = write
        ? write.value
        : route.name === name && Object.hasOwn(route.params, key)
          ? route.params[key]
          : matcher.getDefaultValue()
      return previous !== undefined && matcher.equals(previous, next)
        ? previous
        : immutable(next)
    })
    Object.defineProperty(state, key, {
      enumerable: true,
      get: () => value.value,
      set: value => {
        void patch({ [key]: value })
      },
    })
  }
  return {
    state: reactive(state) as QueryParamsState<Params<Name>>['state'],
    patch,
    reset: override =>
      engine.write(
        name,
        Object.fromEntries(
          [...matchers].map(([key, matcher]) => [
            key,
            matcher.getDefaultValue(),
          ])
        ),
        { ...options, ...override },
        source,
        server,
        true
      ),
    flush: engine.flush,
    pending: computed(() => !!engine.overlay.value.get(name)?.size),
  }
}
