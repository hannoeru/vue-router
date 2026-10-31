import {
  computed,
  getCurrentInstance,
  handleError,
  ErrorCodes,
  inject,
  reactive,
  readonly,
  shallowRef,
  ssrContextKey,
  type ComputedRef,
  type DeepReadonly,
  type WritableComputedRef,
} from 'vue'
import { useRouter } from '../useApi'
import { isNavigationFailure, type NavigationFailure } from '../errors'
import type { RouteMap } from '../typed-routes/route-map'
import type { EXPERIMENTAL_Router } from './router'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { experimental_normalizeQuery } from './query'

export interface QueryStateOptions {
  history?: 'replace' | 'push'
  debounce?: number
  throttle?: number
  clearOnDefault?: boolean
}

export type QueryStateResult =
  | void
  | NavigationFailure
  | { readonly cancelled: true }

export interface QueryParamControls<T> {
  pending: ComputedRef<boolean>
  update(
    value: DeepReadonly<T>,
    options?: QueryStateOptions
  ): Promise<QueryStateResult>
  reset(options?: QueryStateOptions): Promise<QueryStateResult>
  clear(options?: QueryStateOptions): Promise<QueryStateResult>
}

export type QueryParamState<T> = QueryParamControls<T> & {
  state: WritableComputedRef<DeepReadonly<T>, DeepReadonly<T>>
}

type QueryKeys<Name extends keyof RouteMap> = {
  [K in RouteMap[Name]['queryKeys']]: DeepReadonly<
    RouteMap[Name]['params'][K]
  > extends DeepReadonly<RouteMap[Name]['paramsRaw'][K]>
    ? K
    : never
}[RouteMap[Name]['queryKeys']]
type Params<Name extends keyof RouteMap> = Pick<
  RouteMap[Name]['params'],
  QueryKeys<Name>
>

export type QueryParamsState<T> = {
  state: { [K in keyof T]: DeepReadonly<T[K]> }
  patch(
    values: keyof T extends never
      ? Record<string, never>
      : Partial<{ [K in keyof T]: DeepReadonly<T[K]> }>,
    options?: QueryStateOptions
  ): Promise<QueryStateResult>
  reset(options?: QueryStateOptions): Promise<QueryStateResult>
  clear(options?: QueryStateOptions): Promise<QueryStateResult>
  pending: ComputedRef<boolean>
}

type Name = string | symbol
type Matcher = MatcherPatternQueryParam<any, string>
type Outcome = { result: QueryStateResult } | { error: unknown }
type Write = {
  name: Name
  value: unknown
  query: ReturnType<typeof experimental_normalizeQuery>
  options: QueryStateOptions
  deadline: number
  ready: boolean
  optimistic: boolean
  promise: Promise<Outcome>
  settle(outcome: Outcome): void
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
      if (!(matcher instanceof MatcherPatternQueryParam))
        throw new Error(
          'Query state requires MatcherPatternQueryParam matchers'
        )
      matchers.set(matcher.paramName, matcher)
    }
  }
  return matchers
}

function validateOptions(options: QueryStateOptions) {
  for (const wait of [options.debounce, options.throttle]) {
    if (wait !== undefined && (!Number.isFinite(wait) || wait < 0))
      throw new Error('Query-state waits must be finite non-negative numbers')
  }
}

function immutable<T>(value: T): DeepReadonly<T> {
  return (
    value !== null && typeof value === 'object' ? readonly(value) : value
  ) as DeepReadonly<T>
}

export function queryStateThrottle() {
  if (
    typeof window === 'undefined' ||
    !('GestureEvent' in window) ||
    !window.GestureEvent
  )
    return 50
  const version = navigator.userAgent.match(/version\/([\d.]+) safari/i)
  return version && parseFloat(version[1]) >= 17 ? 120 : 320
}

async function settleCall(
  promises: Promise<Outcome>[]
): Promise<QueryStateResult> {
  const outcomes = await Promise.all(promises)
  for (const outcome of outcomes) if ('error' in outcome) throw outcome.error
  for (const outcome of outcomes)
    if ('result' in outcome && isNavigationFailure(outcome.result))
      return outcome.result
  for (const outcome of outcomes)
    if ('result' in outcome && outcome.result && 'cancelled' in outcome.result)
      return outcome.result
}

function createEngine(router: EXPERIMENTAL_Router) {
  const overlay = shallowRef(new Map<string, Write>())
  const queue = new Map<string, Write>()
  const active = new Map<string, Write>()
  const floor = queryStateThrottle()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let running = false
  let lastSettled: number | undefined
  let activeCommitOrigin: symbol | undefined
  let activeTarget: string | undefined

  router._beforeQueryStateNavigation = (to, origin) => {
    if (origin !== undefined && origin === activeCommitOrigin) {
      if (activeTarget === undefined) activeTarget = to.fullPath
      else if (activeTarget !== to.fullPath) cancel()
    } else {
      for (const write of active.values()) write.optimistic = false
      cancel()
    }
  }
  router._afterQueryStateNavigation = schedule
  router._cancelQueryStateNavigation = cancel

  function notify() {
    overlay.value = new Map(overlay.value)
  }

  function removeOverlay(urlKey: string, write: Write) {
    if (overlay.value.get(urlKey) !== write) return
    const previous = active.get(urlKey)
    if (previous && previous !== write) overlay.value.set(urlKey, previous)
    else overlay.value.delete(urlKey)
  }

  function cancel() {
    for (const [urlKey, write] of queue) {
      removeOverlay(urlKey, write)
      write.settle({ result: { cancelled: true } })
    }
    queue.clear()
    notify()
    schedule()
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!queue.size || running || router._hasExternalQueryStateNavigation)
      return
    const now = Date.now()
    for (const write of queue.values()) {
      if (!write.ready && write.deadline <= now) {
        write.ready = true
      }
    }
    const writes = [...queue.values()]
    const ready = writes.some(write => write.ready)
    const batchThrottle = Math.max(
      floor,
      ...writes
        .filter(write => write.ready)
        .map(write => write.options.throttle ?? floor)
    )
    const nextDeadline = Math.min(
      ...writes.filter(write => !write.ready).map(write => write.deadline)
    )
    const due = ready
      ? Math.min(
          nextDeadline,
          lastSettled === undefined
            ? now
            : Math.max(now, lastSettled + batchThrottle)
        )
      : nextDeadline
    if (due <= now) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          flush()
        })
      }
    } else {
      timer = setTimeout(schedule, Math.min(due - now, 2 ** 31 - 1))
    }
  }

  function write(
    name: Name,
    values: Record<string, unknown>,
    options: QueryStateOptions,
    server: boolean,
    operation: 'update' | 'reset' | 'clear' = 'update'
  ): Promise<QueryStateResult> {
    if (server) return Promise.resolve()
    try {
      validateOptions(options)
      if (router.currentRoute.value.name !== name)
        throw new Error('Cannot update query state for an inactive route')
      if (router._hasExternalQueryStateNavigation)
        return Promise.resolve({ cancelled: true })
      const matchers = queryMatchers(router, name)
      const prepared = []
      for (const [key, input] of Object.entries(values)) {
        const matcher = matchers.get(key)
        if (!matcher) throw new Error(`Not a query param: ${key}`)
        if (operation === 'update' && input === undefined) continue
        if (
          operation !== 'update' &&
          matcher.required &&
          matcher.defaultValue === undefined
        )
          throw new Error(`Cannot ${operation} required query param: ${key}`)
        const value =
          operation === 'clear' ||
          (operation === 'reset' && matcher.defaultValue === undefined)
            ? matcher.match(Object.create(null))[key]
            : operation === 'reset'
              ? matcher.getDefaultValue()
              : input
        const query =
          operation === 'clear' ||
          (operation === 'reset' && matcher.defaultValue === undefined)
            ? (Object.create(null) as ReturnType<
                typeof experimental_normalizeQuery
              >)
            : experimental_normalizeQuery(
                matcher.build(
                  { [key]: value },
                  { clearOnDefault: options.clearOnDefault }
                )
              )
        prepared.push({ urlKey: matcher.queryKey, value, query })
      }
      const currentQuery = experimental_normalizeQuery(
        router.currentRoute.value.query
      )
      const promises: Promise<Outcome>[] = []
      for (const { urlKey, value, query } of prepared) {
        const previous = queue.get(urlKey)
        const before = currentQuery[urlKey] ?? []
        const after = query[urlKey] ?? []
        if (
          !previous &&
          !active.has(urlKey) &&
          before.length === after.length &&
          before.every((value, index) => value === after[index])
        )
          continue
        let settle!: Write['settle']
        const promise =
          previous?.promise ??
          new Promise<Outcome>(resolve => {
            settle = resolve
          })
        const next: Write = {
          name,
          value: immutable(value),
          query,
          options:
            previous?.ready && !options.debounce
              ? {
                  ...options,
                  history:
                    previous.options.history === 'push'
                      ? 'push'
                      : options.history,
                  throttle: Math.max(
                    previous.options.throttle ?? floor,
                    options.throttle ?? floor
                  ),
                }
              : options,
          deadline: Date.now() + (options.debounce ?? 0),
          ready: false,
          optimistic: true,
          promise,
          settle: previous?.settle ?? settle,
        }
        queue.set(urlKey, next)
        overlay.value.set(urlKey, next)
        promises.push(promise)
      }
      notify()
      schedule()
      return settleCall(promises)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  async function commit(writes: Map<string, Write>): Promise<QueryStateResult> {
    const current = router.currentRoute.value
    const query = Object.assign(Object.create(null), current.query)
    for (const [urlKey, write] of writes) {
      delete query[urlKey]
      Object.assign(query, write.query)
    }
    const history = [...writes.values()].some(
      write => write.options.history === 'push'
    )
      ? 'push'
      : 'replace'
    activeCommitOrigin = Symbol()
    activeTarget = undefined
    try {
      return await router._withQueryStateNavigation(activeCommitOrigin, () =>
        router.push({
          path: current.path,
          query,
          hash: current.hash,
          replace: history !== 'push',
        })
      )
    } finally {
      activeCommitOrigin = undefined
      activeTarget = undefined
    }
  }

  function flush() {
    if (running || router._hasExternalQueryStateNavigation) return
    const now = Date.now()
    const batchThrottle = Math.max(
      floor,
      ...[...queue.values()]
        .filter(write => write.ready)
        .map(write => write.options.throttle ?? floor)
    )
    if (lastSettled !== undefined && now < lastSettled + batchThrottle) {
      schedule()
      return
    }
    for (const [urlKey, write] of queue) {
      if (write.ready) {
        queue.delete(urlKey)
        active.set(urlKey, write)
      }
    }
    if (!active.size) {
      schedule()
      return
    }
    running = true
    const finish = (outcome: Outcome) => {
      const writes = new Map(active)
      active.clear()
      for (const [urlKey, write] of writes) {
        removeOverlay(urlKey, write)
        write.settle(outcome)
      }
      running = false
      lastSettled = Date.now()
      notify()
      schedule()
    }
    void commit(active).then(
      result => finish({ result }),
      error => finish({ error })
    )
  }

  function pending(name: Name, urlKey?: string) {
    const values = overlay.value
    return urlKey !== undefined
      ? values.get(urlKey)?.name === name || active.get(urlKey)?.name === name
      : [...values.values(), ...active.values()].some(
          write => write.name === name
        )
  }

  return { overlay, write, pending }
}

function useEngine() {
  const router = useRouter() as unknown as EXPERIMENTAL_Router
  let engine = engines.get(router)
  if (!engine) engines.set(router, (engine = createEngine(router)))
  const server =
    typeof window === 'undefined' || !!inject(ssrContextKey, undefined)
  const instance = getCurrentInstance()
  const reportError = (error: unknown) =>
    handleError(error, instance, ErrorCodes.COMPONENT_EVENT_HANDLER, false)
  return { router, engine, server, reportError }
}

export function useQueryParam<
  Name extends keyof RouteMap,
  Key extends keyof Params<Name> & string,
>(
  name: Name,
  key: Key,
  options: QueryStateOptions = {}
): QueryParamState<Params<Name>[Key]> {
  validateOptions(options)
  const { router, engine, server, reportError } = useEngine()
  const matcher = queryMatchers(router, name).get(key)
  if (!matcher) throw new Error(`Not a query param: ${key}`)
  type T = Params<Name>[Key]
  const update = (value: DeepReadonly<T>, override?: QueryStateOptions) =>
    engine.write(name, { [key]: value }, { ...options, ...override }, server)
  const state = computed<DeepReadonly<T>, DeepReadonly<T>>({
    get: previous => {
      const write = engine.overlay.value.get(matcher.queryKey)
      const route = router.currentRoute.value
      const next = (
        route.name !== name
          ? matcher.getDefaultValue()
          : write?.name === name && write.optimistic
            ? write.value
            : Object.hasOwn(route.params, key)
              ? route.params[key]
              : matcher.getDefaultValue()
      ) as T
      return previous !== undefined && matcher.equals(previous, next)
        ? previous
        : immutable(next)
    },
    set: value => {
      void update(value).catch(reportError)
    },
  })
  const perform = (
    operation: 'reset' | 'clear',
    override?: QueryStateOptions
  ) =>
    engine.write(
      name,
      { [key]: undefined },
      { ...options, ...override },
      server,
      operation
    )
  return {
    state,
    update,
    reset: override => perform('reset', override),
    clear: override => perform('clear', override),
    pending: computed(() => engine.pending(name, matcher.queryKey)),
  }
}

export function useQueryParams<Name extends keyof RouteMap>(
  name: Name &
    (Exclude<RouteMap[Name]['queryKeys'], QueryKeys<Name>> extends never
      ? unknown
      : never),
  options: QueryStateOptions = {}
): QueryParamsState<Params<Name>> {
  validateOptions(options)
  const { router, engine, server, reportError } = useEngine()
  const matchers = queryMatchers(router, name)
  const state: Record<string, unknown> = Object.create(null)
  const patch = (
    values: Record<string, unknown>,
    override?: QueryStateOptions
  ) => engine.write(name, values, { ...options, ...override }, server)
  for (const [key, matcher] of matchers) {
    const value = computed(previous => {
      const write = engine.overlay.value.get(matcher.queryKey)
      const route = router.currentRoute.value
      const next =
        route.name !== name
          ? matcher.getDefaultValue()
          : write?.name === name && write.optimistic
            ? write.value
            : Object.hasOwn(route.params, key)
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
        void patch({ [key]: value }).catch(reportError)
      },
    })
  }
  const perform = (
    operation: 'reset' | 'clear',
    override?: QueryStateOptions
  ) =>
    engine.write(
      name,
      Object.fromEntries([...matchers.keys()].map(key => [key, undefined])),
      { ...options, ...override },
      server,
      operation
    )
  return {
    state: reactive(state) as QueryParamsState<Params<Name>>['state'],
    patch,
    reset: override => perform('reset', override),
    clear: override => perform('clear', override),
    pending: computed(() => engine.pending(name)),
  }
}
