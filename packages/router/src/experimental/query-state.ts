import {
  computed,
  getCurrentScope,
  getCurrentInstance,
  handleError,
  ErrorCodes,
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
import { experimental_normalizeQuery } from './query'

export interface QueryStateOptions {
  history?: 'replace' | 'push'
  debounce?: number
  clearOnDefault?: boolean
}

export type QueryStateResult =
  | void
  | NavigationFailure
  | { readonly cancelled: true }

export interface QueryParamControls<T> {
  pending: ComputedRef<boolean>
  update(value: T, options?: QueryStateOptions): Promise<QueryStateResult>
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
  pending: ComputedRef<boolean>
}

type Name = string | symbol
type Matcher = MatcherPatternQueryParam<any, string>
type Settlement = {
  keys: Set<string>
  history: QueryStateOptions['history']
  resolve(result: QueryStateResult): void
  reject(reason: unknown): void
}
type Write = {
  raw: unknown
  value: unknown
  options: QueryStateOptions
  source: symbol
  deadline: number
}
type Group = {
  name: Name
  writes: Map<string, Write>
  settlements: Set<Settlement>
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
  const wait = options.debounce
  if (wait !== undefined && (!Number.isFinite(wait) || wait < 0)) {
    throw new Error('Query-state waits must be finite non-negative numbers')
  }
}

function immutable<T>(value: T): DeepReadonly<T> {
  return (
    value !== null && typeof value === 'object' ? readonly(value) : value
  ) as DeepReadonly<T>
}

function createEngine(router: EXPERIMENTAL_Router) {
  const overlay = shallowRef(new Map<Name, Map<string, Write>>())
  const queue = new Set<Group>()
  const active = new Map<Name, Map<string, Write>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let running = false
  let activeCommitOrigin: symbol | undefined

  router._beforeQueryStateNavigation = (to, origin) => {
    if (origin !== undefined && origin === activeCommitOrigin) return
    const current = experimental_normalizeQuery(router.currentRoute.value.query)
    const target = experimental_normalizeQuery(to.query)
    cancelKeys((name, key) => {
      if (name !== to.name) return true
      const matcher = queryMatchers(router, name).get(key)!
      const before = current[matcher.queryKey]
      const after = target[matcher.queryKey]
      return (
        before?.length !== after?.length ||
        !!before?.some((value, index) => value !== after?.[index])
      )
    })
  }
  router._afterQueryStateNavigation = () => {
    cancelKeys(name => name !== router.currentRoute.value.name)
  }
  router._cancelQueryStateNavigation = () => {
    cancelKeys(() => true)
  }

  function notify() {
    overlay.value = new Map(overlay.value)
  }

  function removeOverlay(name: Name, key: string, write: Write) {
    const values = overlay.value.get(name)
    if (values?.get(key) === write) {
      const previous = active.get(name)?.get(key)
      if (previous && previous !== write) values.set(key, previous)
      else values.delete(key)
    }
    if (!values?.size) overlay.value.delete(name)
  }

  function cancelKeys(conflicts: (name: Name, key: string) => boolean) {
    for (const group of queue) {
      for (const [key, write] of group.writes) {
        if (!conflicts(group.name, key)) continue
        group.writes.delete(key)
        removeOverlay(group.name, key, write)
        for (const settlement of group.settlements) {
          if (settlement.keys.has(key)) {
            settlement.resolve({ cancelled: true })
            group.settlements.delete(settlement)
          }
        }
      }
      if (!group.writes.size) queue.delete(group)
    }
    notify()
    schedule()
  }

  function deadline(group: Group) {
    return Math.max(...[...group.writes.values()].map(write => write.deadline))
  }

  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!queue.size || running || router._pendingQueryStateNavigations) return
    const due = Math.min(...[...queue].map(deadline))
    if (due <= Date.now()) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          flush()
        })
      }
    } else {
      timer = setTimeout(
        () => {
          timer = undefined
          flush()
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
  ): Promise<QueryStateResult> {
    if (server) return Promise.resolve()
    try {
      validateOptions(options)
      if (router.currentRoute.value.name !== name)
        throw new Error('Cannot update query state for an inactive route')
      const matchers = queryMatchers(router, name)
      const params = Object.assign(
        Object.create(null),
        router.currentRoute.value.params,
        values
      )
      const writes = new Map<string, Write>()
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
        const normalized = matcher.match(
          experimental_normalizeQuery(
            matcher.build(params, { clearOnDefault: options.clearOnDefault })
          )
        )[key]
        writes.set(key, {
          raw: value,
          value: normalized,
          options,
          source,
          deadline: Date.now() + (options.debounce ?? 0),
        })
      }
      if (!writes.size) return Promise.resolve()
      if (
        !reset &&
        options.clearOnDefault === undefined &&
        [...writes].every(
          ([key, write]) =>
            !overlay.value.get(name)?.has(key) &&
            matchers
              .get(key)!
              .equals(router.currentRoute.value.params[key], write.value)
        )
      )
        return Promise.resolve()

      return new Promise<QueryStateResult>((resolve, reject) => {
        const group: Group = {
          name,
          writes: new Map(),
          settlements: new Set(),
        }
        for (const queued of queue) {
          if (
            queued.name !== name ||
            ![...writes.keys()].some(key => queued.writes.has(key))
          )
            continue
          queue.delete(queued)
          for (const [key, write] of queued.writes) group.writes.set(key, write)
          for (const settlement of queued.settlements)
            group.settlements.add(settlement)
        }
        for (const [key, write] of writes) group.writes.set(key, write)
        group.settlements.add({
          keys: new Set(writes.keys()),
          history: options.history,
          resolve,
          reject,
        })
        queue.add(group)
        if (!overlay.value.has(name)) overlay.value.set(name, new Map())
        for (const [key, write] of writes)
          overlay.value.get(name)!.set(key, write)
        notify()
        schedule()
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  async function commit(groups: Group[]): Promise<QueryStateResult> {
    const current = router.currentRoute.value
    const name = groups[0].name
    if (current.name !== name) return { cancelled: true }
    const writes = new Map(groups.flatMap(group => [...group.writes]))
    const params = Object.assign(Object.create(null), current.params)
    for (const [key, write] of writes) params[key] = write.raw
    const query = Object.assign(Object.create(null), current.query)
    const matchers = queryMatchers(router, name)
    for (const [key, write] of writes) {
      const matcher = matchers.get(key)!
      delete query[matcher.queryKey]
      Object.assign(
        query,
        experimental_normalizeQuery(
          matcher.build(params, {
            clearOnDefault: write.options.clearOnDefault,
          })
        )
      )
    }
    activeCommitOrigin = Symbol()
    try {
      return await router._withQueryStateNavigation(activeCommitOrigin, () =>
        router.push({
          path: current.path,
          query,
          hash: current.hash,
          replace: !groups.some(group =>
            [...group.settlements].some(
              settlement => settlement.history === 'push'
            )
          ),
        })
      )
    } finally {
      activeCommitOrigin = undefined
    }
  }

  function flush() {
    if (running || router._pendingQueryStateNavigations) return
    const groups = [...queue].filter(group => deadline(group) <= Date.now())
    if (!groups.length) {
      schedule()
      return
    }
    for (const group of groups) {
      queue.delete(group)
      if (!active.has(group.name)) active.set(group.name, new Map())
      for (const [key, write] of group.writes)
        active.get(group.name)!.set(key, write)
    }
    running = true
    const finish = () => {
      active.clear()
      for (const group of groups) {
        for (const [key, write] of group.writes)
          removeOverlay(group.name, key, write)
      }
      running = false
      notify()
      cancelKeys(name => name !== router.currentRoute.value.name)
      schedule()
    }
    void commit(groups).then(
      result => {
        finish()
        for (const group of groups) {
          for (const settlement of group.settlements) settlement.resolve(result)
        }
      },
      error => {
        finish()
        for (const group of groups) {
          for (const settlement of group.settlements) settlement.reject(error)
        }
      }
    )
  }

  function flushSource(source: symbol) {
    for (const group of queue) {
      for (const write of group.writes.values()) {
        if (write.source === source) write.deadline = Date.now()
      }
    }
    schedule()
  }

  return { overlay, write, flushSource }
}

function useEngine() {
  const router = useRouter() as unknown as EXPERIMENTAL_Router
  let engine = engines.get(router)
  if (!engine) engines.set(router, (engine = createEngine(router)))
  const server =
    typeof window === 'undefined' || !!inject(ssrContextKey, undefined)
  const source = Symbol()
  const instance = getCurrentInstance()
  const reportError = (error: unknown) => {
    handleError(error, instance, ErrorCodes.COMPONENT_EVENT_HANDLER, false)
  }
  if (getCurrentScope()) onScopeDispose(() => engine.flushSource(source))
  return { router, engine, server, source, reportError }
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
  const { router, engine, server, source, reportError } = useEngine()
  const matcher = queryMatchers(router, name).get(key)
  if (!matcher) throw new Error(`Not a query param: ${key}`)
  type T = Params<Name>[Key]
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
      void update(value).catch(reportError)
    },
  })
  return {
    state,
    pending: computed(() => engine.overlay.value.get(name)?.has(key) || false),
    update,
    reset: override =>
      engine.write(
        name,
        { [key]: matcher.getDefaultValue() },
        {
          ...options,
          clearOnDefault: options.clearOnDefault ?? matcher.clearOnDefault,
          ...override,
        },
        source,
        server,
        true
      ),
  }
}

export function useQueryParams<Name extends keyof RouteMap>(
  name: Name,
  options: QueryStateOptions = {}
): QueryParamsState<Params<Name>, ParamsRaw<Name>> {
  validateOptions(options)
  const { router, engine, server, source, reportError } = useEngine()
  const matchers = queryMatchers(router, name)
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
        void patch({ [key]: value }).catch(reportError)
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
    pending: computed(() => !!engine.overlay.value.get(name)?.size),
  }
}
