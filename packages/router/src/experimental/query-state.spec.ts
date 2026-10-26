/**
 * @vitest-environment happy-dom
 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  effectScope,
  h,
  nextTick,
  toRefs,
  watch,
} from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from '../history/memory'
import { RouterView } from '../RouterView'
import { NavigationFailureType } from '../errors'
import { onBeforeRouteUpdate } from '../navigationGuards'
import type { NavigationGuard } from '../typed-routes'
import { experimental_createRouter, normalizeRouteRecord } from './router'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import {
  MatcherPatternPathDynamic,
  MatcherPatternPathStatic,
} from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import {
  defineParamParserRaw,
  PARAM_PARSER_INT,
} from './route-resolver/matchers/param-parsers'
import {
  useQueryParam as useTypedQueryParam,
  useQueryParams as useTypedQueryParams,
  type QueryParamState,
  type QueryParamsState,
  type QueryStateOptions,
  type QueryStateResult,
} from './query-state'

const useQueryParam = useTypedQueryParam as (
  name: string,
  key: string,
  options?: QueryStateOptions
) => QueryParamState<any>
const useQueryParams = useTypedQueryParams as (
  name: string,
  options?: QueryStateOptions
) => QueryParamsState<Record<string, any>>
import { QUERY_STATE_SCROLL } from './query-state-internals'
import { ScrollRestoration, useScrollRestoration } from './scroll-restoration'

async function setup(path = '/search/7?other=keep#anchor') {
  const json = defineParamParserRaw<unknown>({
    get: value => JSON.parse(value as string),
    set: (value: unknown) => JSON.stringify(value),
  })
  const router = experimental_createRouter({
    history: createMemoryHistory(),
    resolver: createFixedResolver([
      normalizeRouteRecord({
        name: 'search',
        path: new MatcherPatternPathDynamic(
          /^\/search\/([^/]+)$/,
          { id: [PARAM_PARSER_INT] },
          ['search', 1]
        ),
        query: [
          new MatcherPatternQueryParam(
            'page',
            'p',
            'value',
            PARAM_PARSER_INT,
            1
          ),
          new MatcherPatternQueryParam('q', 'q', 'value', undefined, ''),
          new MatcherPatternQueryParam('tags', 'tag', 'array', undefined, []),
          new MatcherPatternQueryParam(
            'filter',
            'f',
            'value',
            json,
            () => ({})
          ),
        ],
        components: { default: defineComponent(() => () => null) },
      }),
      normalizeRouteRecord({
        name: 'other',
        path: new MatcherPatternPathStatic('/other'),
        components: { default: defineComponent(() => () => null) },
      }),
    ]),
  })
  await router.push(path)
  const app = createApp({})
  app.use(router)
  const scopes: ReturnType<typeof effectScope>[] = []
  const use = <T>(fn: () => T) => {
    const scope = effectScope()
    scopes.push(scope)
    return app.runWithContext(() => scope.run(fn)!)
  }
  const stop = () => scopes.forEach(scope => scope.stop())
  cleanups.push(stop)
  return { router, use, stop }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})

it('shares optimistic refs, batches keys, preserves path, raw query and hash', async () => {
  const { router, use } = await setup()
  const { state: page, ...control } = use(() => useQueryParam('search', 'page'))
  const shared = use(() => useQueryParam('search', 'page'))
  const state = use(() => useQueryParams('search'))
  const navigate = vi.spyOn(router, 'push')
  const a = control.update(3)
  const b = state.patch({ q: 'vue' })
  expect(page.value).toBe(3)
  expect(shared.state.value).toBe(3)
  expect(state.state.page).toBe(3)
  expect(control.pending.value).toBe(true)
  expect(state.pending.value).toBe(true)
  expect(router.currentRoute.value.params.page).toBe(1)
  await Promise.all([a, b])
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(router.currentRoute.value.fullPath).toBe(
    '/search/7?other=keep&p=3&q=vue#anchor'
  )
  expect(control.pending.value).toBe(false)
  expect(state.pending.value).toBe(false)
})

it('is a writable ref and a query-only writable reactive object with toRefs', async () => {
  const { router, use } = await setup()
  const page = use(() => useQueryParam('search', 'page'))
  const state = use(() => useQueryParams('search'))
  const refs = toRefs(state.state)
  expect(Object.keys(state.state)).toEqual(['page', 'q', 'tags', 'filter'])
  expect('id' in state.state).toBe(false)
  page.state.value = 2
  refs.q.value = 'hello'
  await page.flush()
  expect(state.state.page).toBe(2)
  expect(router.currentRoute.value.params.q).toBe('hello')
  await expect(state.patch({ id: 8 })).rejects.toThrow('Not a query param')
  expect(() => use(() => useQueryParam('search', 'id'))).toThrow(
    'Not a query param'
  )
})

it('debounces, chooses the longest wait and flushes all queued keys', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const { state: q, ...control } = use(() =>
    useQueryParam('search', 'q', { debounce: 100 })
  )
  const page = use(() => useQueryParam('search', 'page', { debounce: 20 }))
  const a = control.update('v')
  await vi.advanceTimersByTimeAsync(50)
  const b = control.update('vue')
  expect(q.value).toBe('vue')
  await vi.advanceTimersByTimeAsync(19)
  expect(router.currentRoute.value.params.q).toBe('')
  const c = page.update(2)
  await vi.advanceTimersByTimeAsync(20)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(61)
  await Promise.all([a, b, c])
  expect(router.currentRoute.value.params.q).toBe('vue')
  expect(router.currentRoute.value.params.page).toBe(2)
})

it('throttles subsequent writes but commits the first write in the same tick', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const control = use(() => useQueryParam('search', 'q', { throttle: 100 }))
  const first = control.update('a')
  await vi.advanceTimersByTimeAsync(0)
  await first
  const second = control.update('b')
  await vi.advanceTimersByTimeAsync(99)
  expect(router.currentRoute.value.params.q).toBe('a')
  await vi.advanceTimersByTimeAsync(1)
  await second
  expect(router.currentRoute.value.params.q).toBe('b')
})

it('lets any push win and updates from back and forward navigation', async () => {
  const { router, use } = await setup()
  const { state: q, ...control } = use(() => useQueryParam('search', 'q'))
  const first = control.update('first', { history: 'push' })
  const second = control.update('second')
  await Promise.all([first, second])
  const afterNavigation = () =>
    new Promise<void>(resolve => {
      const remove = router.afterEach(() => {
        remove()
        resolve()
      })
    })
  let navigated = afterNavigation()
  router.back()
  await navigated
  expect(q.value).toBe('')
  navigated = afterNavigation()
  router.forward()
  await navigated
  expect(q.value).toBe('second')
})

it('resets defaults and supports per-update clearOnDefault overrides', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'page'))
  await control.update(2)
  await control.reset({ clearOnDefault: false })
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  await control.update(3)
  await control.reset()
  expect(router.currentRoute.value.query.p).toBeUndefined()
  const state = use(() => useQueryParams('search'))
  await state.patch({ page: 4, q: 'vue', tags: ['a'] })
  await state.reset()
  expect(state.state.page).toBe(1)
  expect(state.state.tags).toEqual([])
  expect(router.currentRoute.value.query).toEqual({ other: ['keep'] })
})

it('uses structural equality for fresh arrays and objects', async () => {
  const { router, use } = await setup(
    '/search/7?tag=a&f=%7B%22a%22:1,%22b%22:2%7D'
  )
  const tags = use(() => useQueryParam('search', 'tags'))
  const filter = use(() => useQueryParam('search', 'filter'))
  const navigate = vi.spyOn(router, 'push')
  await tags.update(['a'])
  await filter.update({ b: 2, a: 1 })
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps pending until guards settle and serializes writes during navigation', async () => {
  const { router, use } = await setup()
  const { state: q, ...control } = use(() => useQueryParam('search', 'q'))
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    const remove = router.beforeEach(() => {
      remove()
      resolve()
      return new Promise<void>(resolve => {
        release = resolve
      })
    })
  })
  const first = control.update('a')
  await entered
  const second = control.update('b', { debounce: Infinity })
  expect(control.flush()).toBe(second)
  expect(control.flush()).toBe(second)
  expect(control.pending.value).toBe(true)
  expect(q.value).toBe('b')
  release()
  await Promise.all([first, second])
  expect(q.value).toBe('b')
  expect(control.pending.value).toBe(false)
})

it('settles rejected updates and clears optimistic overlays', async () => {
  const { router, use } = await setup()
  const { state: q, ...control } = use(() => useQueryParam('search', 'q'))
  router.beforeEach(() => false)
  await expect(control.update('blocked')).resolves.toMatchObject({
    type: NavigationFailureType.aborted,
  })
  expect(q.value).toBe('')
  expect(control.pending.value).toBe(false)
})

it('flushes on scope disposal and clears the debounce timer', async () => {
  const { router, use, stop } = await setup()
  vi.useFakeTimers()
  const control = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  const settled = control.update('saved')
  stop()
  await settled
  expect(router.currentRoute.value.params.q).toBe('saved')
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels queued writes before programmatic leave without cancelling the destination', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  const settled = control.update('saved')
  const seen: string[] = []
  router.afterEach(to => {
    seen.push(to.fullPath)
  })
  await router.push('/other')
  await settled
  expect(seen).toEqual(['/other'])
  expect(router.currentRoute.value.name).toBe('other')
})

it('passes the scroll policy on the batched navigation', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'q'))
  const navigate = vi.spyOn(router, 'push')
  await control.update('a')
  expect((navigate.mock.calls[0][0] as any)[QUERY_STATE_SCROLL]).toBe(false)
  await control.update('b', { scroll: true })
  expect((navigate.mock.calls[1][0] as any)[QUERY_STATE_SCROLL]).toBe(true)
})

it('supports mounted v-model writes', async () => {
  const { router } = await setup()
  let flush!: () => Promise<QueryStateResult>
  const wrapper = mount(
    defineComponent({
      setup() {
        const { state: q, ...control } = useQueryParam('search', 'q')
        flush = control.flush
        return { q }
      },
      template: '<input v-model="q" />',
    }),
    { global: { plugins: [router] } }
  )
  await wrapper.get('input').setValue('mounted')
  await flush()
  await nextTick()
  expect(router.currentRoute.value.params.q).toBe('mounted')
  expect(wrapper.get('input').element.value).toBe('mounted')
  wrapper.unmount()
})

it('shares optimistic state across two mounted components', async () => {
  const { router } = await setup()
  const controls: (() => Promise<QueryStateResult>)[] = []
  const component = defineComponent({
    setup() {
      const { state: q, ...control } = useQueryParam('search', 'q', {
        debounce: 100,
      })
      controls.push(control.flush)
      return { q, pending: control.pending }
    },
    template: '<label><input v-model="q" /><span>{{ pending }}</span></label>',
  })
  const wrapper = mount(
    defineComponent(() => () => [h(component), h(component)]),
    {
      global: { plugins: [router] },
    }
  )
  cleanups.push(() => wrapper.unmount())
  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('shared')
  expect(inputs[1].element.value).toBe('shared')
  expect(wrapper.findAll('span').map(span => span.text())).toEqual([
    'true',
    'true',
  ])
  expect(router.currentRoute.value.params.q).toBe('')
  await controls[0]()
  await nextTick()
  expect(router.currentRoute.value.params.q).toBe('shared')
  expect(wrapper.findAll('span').map(span => span.text())).toEqual([
    'false',
    'false',
  ])
})

it('cancels queued updates on native history traversal without replacing the destination', async () => {
  const { router, use } = await setup()
  await router.push('/search/7?q=current')
  const { state: q, ...control } = use(() =>
    useQueryParam('search', 'q', { debounce: 500 })
  )
  const settled = control.update('not-saved')
  const rejected = expect(settled).resolves.toEqual({ cancelled: true })
  const navigated = new Promise<void>(resolve => {
    const remove = router.afterEach(() => {
      remove()
      resolve()
    })
  })
  router.options.history.go(-1)
  await navigated
  await rejected
  expect(router.currentRoute.value.fullPath).toBe('/search/7?other=keep#anchor')
  expect(q.value).toBe('')
  expect(control.pending.value).toBe(false)
  await control.flush()
  expect(router.currentRoute.value.fullPath).toBe('/search/7?other=keep#anchor')
})

it('rejects thrown navigation errors and removes optimistic state', async () => {
  const { router, use } = await setup()
  const { state: q, ...control } = use(() => useQueryParam('search', 'q'))
  router.onError(() => {})
  const remove = router.beforeEach(() => {
    throw new Error('guard failed')
  })
  await expect(control.update('failed')).rejects.toThrow('guard failed')
  expect(q.value).toBe('')
  expect(control.pending.value).toBe(false)
  remove()
  const seen: string[] = []
  router.afterEach(to => {
    seen.push(to.fullPath)
  })
  const next = control.update('next', { debounce: 1000 })
  await router.push('/other')
  await next
  expect(seen).toEqual(['/other'])
})

it('keeps equal parsed object identities stable through unrelated updates', async () => {
  const { use } = await setup('/search/7?tag=a&f=%7B%22a%22:1%7D')
  const { state: tags } = use(() => useQueryParam('search', 'tags'))
  const state = use(() => useQueryParams('search'))
  const changed = vi.fn()
  use(() => watch(() => [tags.value, state.state.filter], changed))
  const initialTags = tags.value
  const initialFilter = state.state.filter
  await state.patch({ page: 2 })
  await nextTick()
  expect(tags.value).toBe(initialTags)
  expect(state.state.filter).toBe(initialFilter)
  expect(changed).not.toHaveBeenCalled()
})

it('suppresses the legacy scroll callback by default and permits it on request', async () => {
  const { router, use } = await setup()
  const scroll = vi.fn(() => undefined)
  router.options.scrollBehavior = scroll
  const control = use(() => useQueryParam('search', 'q'))
  await control.update('no-scroll')
  await nextTick()
  expect(scroll).not.toHaveBeenCalled()
  await control.update('scroll', { scroll: true })
  await nextTick()
  expect(scroll).toHaveBeenCalledTimes(1)
})

it('does not carry query scroll suppression into an ordinary duplicate navigation', async () => {
  const { router, use } = await setup('/search/7')
  router.getRoutes()[0].query = [
    new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
  ]
  await router.push('/search/7')
  const controls = use(() => useQueryParam('search', 'q'))
  const scroll = vi.fn(() => ({ top: 10 }))
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  cleanups.push(() => scrollTo.mockRestore())
  router.options.scrollBehavior = scroll
  await controls.update('value')
  await flushPromises()
  expect(scroll).not.toHaveBeenCalled()
  const failure = await router.push('/search/7?q=value')
  expect(failure).toMatchObject({ type: NavigationFailureType.duplicated })
  await flushPromises()
  expect(scroll).toHaveBeenCalledOnce()
  expect(scrollTo).toHaveBeenCalledOnce()
  await controls.update('value', { clearOnDefault: true })
  await flushPromises()
  expect(scroll).toHaveBeenCalledOnce()
  expect(scrollTo).toHaveBeenCalledOnce()
})

it('preserves cancellation results for concurrent flush callers on external navigation', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    const remove = router.beforeEach(() => {
      remove()
      resolve()
      return new Promise<void>(resolve => {
        release = resolve
      })
    })
  })
  const seen: [string, number | undefined][] = []
  router.afterEach((to, _from, failure) =>
    seen.push([to.fullPath, failure?.type])
  )
  const first = control.update('first')
  const forced = control.flush()
  await entered
  const second = control.update('second')
  const external = router.push('/other')
  release()
  await Promise.all([first, forced, second, external])
  expect(seen).toEqual([
    ['/search/7?other=keep&q=first#anchor', NavigationFailureType.cancelled],
    ['/other', undefined],
  ])
  expect(router.currentRoute.value.fullPath).toBe('/other')
})

it('cancels queued writes on an external push during an in-flight query write', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'q'))
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    const remove = router.beforeEach(() => {
      remove()
      resolve()
      return new Promise<void>(resolve => {
        release = resolve
      })
    })
  })
  const first = control.update('first')
  await entered
  const second = control.update('second')
  const external = router.push('/other')
  const seen: string[] = []
  router.afterEach(to => {
    seen.push(to.fullPath)
  })
  release()
  await Promise.all([first, second, external])
  expect(seen).toEqual(['/search/7?other=keep&q=first#anchor', '/other'])
  await expect(first).resolves.toMatchObject({
    type: NavigationFailureType.cancelled,
  })
  await expect(second).resolves.toEqual({ cancelled: true })
  expect(control.pending.value).toBe(false)
})

it.each(['single', 'group'] as const)(
  'honors a later debounce before the scheduled microtask for %s state',
  async kind => {
    const { router, use } = await setup()
    vi.useFakeTimers()
    const control = use(() => useQueryParam('search', 'q'))
    const state = use(() => useQueryParams('search'))
    const update = (value: string, options?: QueryStateOptions) =>
      kind === 'single'
        ? control.update(value, options)
        : state.patch({ q: value }, options)
    const first = update('first')
    const second = update('second', { debounce: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(router.currentRoute.value.params.q).toBe('')
    expect(control.pending.value).toBe(true)
    await vi.advanceTimersByTimeAsync(99)
    expect(router.currentRoute.value.params.q).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(router.currentRoute.value.params.q).toBe('second')
    expect(control.pending.value).toBe(false)
  }
)

it('does not let an immediate binding flush a later debounce', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const immediate = use(() => useQueryParam('search', 'q'))
  const slow = use(() => useQueryParam('search', 'q', { debounce: 100 }))
  const first = immediate.update('first')
  const second = slow.update('last')
  await vi.advanceTimersByTimeAsync(0)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(100)
  await Promise.all([first, second])
  expect(router.currentRoute.value.params.q).toBe('last')
})

it('uses the longest wait when two composables write the same param', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const fast = use(() => useQueryParam('search', 'q', { debounce: 20 }))
  const slow = use(() => useQueryParam('search', 'q', { debounce: 100 }))
  const first = fast.update('fast')
  const second = slow.update('last')
  await vi.advanceTimersByTimeAsync(20)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(80)
  await Promise.all([first, second])
  expect(router.currentRoute.value.params.q).toBe('last')
})

it('keeps the composable clearOnDefault policy during reset', async () => {
  const { router, use } = await setup()
  const control = use(() =>
    useQueryParam('search', 'page', { clearOnDefault: false })
  )
  await control.update(2)
  await control.reset()
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  const state = use(() => useQueryParams('search', { clearOnDefault: false }))
  await state.patch({ page: 3 })
  await state.reset()
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  await state.reset({ clearOnDefault: true })
  expect(router.currentRoute.value.query.p).toBeUndefined()
})

it.each([
  ['beforeEach', 'push'],
  ['beforeEach', 'replace'],
  ['beforeResolve', 'push'],
  ['beforeResolve', 'replace'],
] as const)(
  'settles a query write when %s awaits router.%s',
  async (guard, method) => {
    const { router, use } = await setup()
    const controls = use(() => useQueryParam('search', 'q'))
    router[guard](async to => {
      if (to.query.q?.[0] === 'redirect') {
        await router[method]('/other')
        return false
      }
      return undefined
    })
    await Promise.all([controls.update('redirect'), controls.flush()])
    expect(router.currentRoute.value.fullPath).toBe('/other')
    expect(controls.pending.value).toBe(false)
  },
  1500
)

it.each(['composition', 'options'] as const)(
  'settles an awaited child navigation from a mounted %s update guard',
  async kind => {
    const { router } = await setup()
    let controls!: ReturnType<typeof useQueryParam>
    const redirect: NavigationGuard = async to => {
      if (to.query.q?.[0] === 'redirect') {
        await router.push('/other')
        return false
      }
      return undefined
    }
    router.getRoutes()[0].components!.default = defineComponent({
      setup() {
        controls = useQueryParam('search', 'q')
        if (kind === 'composition') onBeforeRouteUpdate(redirect)
        return () => h('main', 'Search')
      },
      beforeRouteUpdate: kind === 'options' ? redirect : undefined,
    })
    const wrapper = mount(
      defineComponent(() => () => h(RouterView)),
      { global: { plugins: [router] } }
    )
    cleanups.push(() => wrapper.unmount())
    await Promise.all([controls.update('redirect'), controls.flush()])
    expect(router.currentRoute.value.fullPath).toBe('/other')
    expect(controls.pending.value).toBe(false)
  },
  1500
)

it.each(['record', 'returned'] as const)(
  'keeps the query origin through a child navigation with a %s redirect',
  async kind => {
    const { router, use } = await setup()
    const controls = use(() => useQueryParam('search', 'q'))
    router.getRoutes().push(
      normalizeRouteRecord({
        name: 'intermediate',
        path: new MatcherPatternPathStatic('/intermediate'),
        components: {},
        ...(kind === 'record' ? { redirect: '/other' } : {}),
      }),
      normalizeRouteRecord({
        name: 'done',
        path: new MatcherPatternPathStatic('/done'),
        components: {},
      })
    )
    router.beforeEach(async to => {
      if (to.query.q?.[0] === 'redirect') {
        await router.push('/intermediate')
        return false
      }
      if (to.path === '/intermediate') return '/other'
      if (to.path === '/other') {
        await router.replace('/done')
        return false
      }
      return undefined
    })
    await Promise.all([controls.update('redirect'), controls.flush()])
    expect(router.currentRoute.value.fullPath).toBe('/done')
    expect(controls.pending.value).toBe(false)
  },
  1500
)

it('settles later queued writes after a guard awaits its child navigation', async () => {
  const { router, use } = await setup()
  const controls = use(() => useQueryParam('search', 'q'))
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    router.beforeEach(async to => {
      if (to.query.q?.[0] === 'redirect') {
        await router.push('/other')
        return false
      }
      if (to.path === '/other') {
        resolve()
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      return undefined
    })
  })
  const first = controls.update('redirect')
  const drain = controls.flush()
  await entered
  const second = expect(controls.update('late')).resolves.toEqual({
    cancelled: true,
  })
  release()
  await Promise.all([first, drain, second])
  expect(router.currentRoute.value.fullPath).toBe('/other')
  expect(controls.pending.value).toBe(false)
}, 1500)

it.each(['beforeEach', 'beforeResolve'] as const)(
  'settles a query write redirected by %s from a mounted route',
  async guard => {
    const { router } = await setup()
    let controls!: ReturnType<typeof useQueryParam>
    router.getRoutes()[0].components!.default = defineComponent({
      setup() {
        controls = useQueryParam('search', 'q')
        return () => h('main', 'Search')
      },
    })
    const wrapper = mount(
      defineComponent(() => () => h(RouterView)),
      {
        global: { plugins: [router] },
      }
    )
    cleanups.push(() => wrapper.unmount())
    router[guard](to => (to.query.q?.[0] === 'redirect' ? '/other' : undefined))
    await Promise.all([controls.update('redirect'), controls.flush()])
    expect(router.currentRoute.value.fullPath).toBe('/other')
    expect(controls.pending.value).toBe(false)
  },
  1000
)

it('settles later queued writes after an async guard redirects a mounted query write', async () => {
  const { router } = await setup()
  let controls!: ReturnType<typeof useQueryParam>
  router.getRoutes()[0].components!.default = defineComponent({
    setup() {
      controls = useQueryParam('search', 'q')
      return () => h('main', 'Search')
    },
  })
  const wrapper = mount(
    defineComponent(() => () => h(RouterView)),
    { global: { plugins: [router] } }
  )
  cleanups.push(() => wrapper.unmount())
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    router.beforeEach(async to => {
      if (to.query.q?.[0] === 'redirect') {
        resolve()
        await new Promise<void>(resolve => {
          release = resolve
        })
        return '/other'
      }
      return undefined
    })
  })
  const first = controls.update('redirect')
  const drain = controls.flush()
  await entered
  const second = expect(controls.update('late')).resolves.toEqual({
    cancelled: true,
  })
  release()
  await Promise.all([first, drain, second])
  expect(router.currentRoute.value.fullPath).toBe('/other')
  expect(controls.pending.value).toBe(false)
}, 1000)

it('cancels a mounted route component write before leave without a leave guard', async () => {
  const { router } = await setup()
  let update!: (value: string) => Promise<QueryStateResult>
  router.getRoutes()[0].components!.default = defineComponent({
    setup() {
      const { state: q, ...control } = useQueryParam('search', 'q', {
        debounce: 500,
      })
      update = control.update
      return () => h('input', { value: q.value })
    },
  })
  const wrapper = mount(
    defineComponent(() => () => h(RouterView)),
    { global: { plugins: [router] } }
  )
  const settled = update('leaving')
  await router.push('/other')
  await settled
  expect(router.currentRoute.value.name).toBe('other')
  expect(router.getRoutes()[0].leaveGuards.size).toBe(0)
  wrapper.unmount()
})

it('uses defaults when a retained composable route is inactive and rejects writes', async () => {
  const { router, use } = await setup()
  const { state: q, ...control } = use(() => useQueryParam('search', 'q'))
  const state = use(() => useQueryParams('search'))
  await control.update('active')
  await router.push('/other?q=unrelated')
  expect(q.value).toBe('')
  expect(state.state.q).toBe('')
  await expect(control.update('inactive')).rejects.toThrow('inactive route')
  expect(control.pending.value).toBe(false)
})

it('applies debounce and throttle together and permits an explicit early flush', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const control = use(() =>
    useQueryParam('search', 'q', { debounce: 20, throttle: 100 })
  )
  const first = control.update('a')
  await vi.advanceTimersByTimeAsync(19)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  await first
  const second = control.update('b')
  await vi.advanceTimersByTimeAsync(20)
  expect(router.currentRoute.value.params.q).toBe('a')
  await control.flush()
  await second
  expect(router.currentRoute.value.params.q).toBe('b')
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels writes made before and during an external navigation', async () => {
  const { router, use } = await setup()
  const control = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    const remove = router.beforeEach(() => {
      remove()
      resolve()
      return new Promise<void>(resolve => {
        release = resolve
      })
    })
  })
  const first = control.update('first')
  const external = router.push('/other')
  await entered
  const second = control.update('second')
  const seen: string[] = []
  router.afterEach(to => {
    seen.push(to.fullPath)
  })
  release()
  await Promise.all([first, second, external])
  expect(seen).toEqual(['/other'])
  await expect(first).resolves.toEqual({ cancelled: true })
  await expect(second).resolves.toEqual({ cancelled: true })
})

it('uses custom parser equality for no-op updates', async () => {
  const { router, use } = await setup(
    '/search/7?f=%7B%22id%22:1,%22label%22:%22first%22%7D'
  )
  const matcher = router.getRoutes()[0].query![3] as MatcherPatternQueryParam<
    any,
    string
  >
  matcher.parser.eq = (a, b) => a.id === b.id
  const { state: filter, ...control } = use(() =>
    useQueryParam('search', 'filter')
  )
  const navigate = vi.spyOn(router, 'push')
  await control.update({ id: 1, label: 'second' })
  expect(navigate).not.toHaveBeenCalled()
  expect(filter.value).toEqual({ id: 1, label: 'first' })
})

it('rejects required resets without changing the route or other query fields', async () => {
  const { router, use } = await setup()
  router
    .getRoutes()[0]
    .query!.push(
      new MatcherPatternQueryParam(
        'required',
        'r',
        'value',
        {},
        undefined,
        true
      )
    )
  await router.push('/search/7?q=vue&r=keep')
  const controls = use(() => useQueryParam('search', 'required'))
  const state = use(() => useQueryParams('search'))
  await expect(controls.reset()).rejects.toThrow(
    'Cannot reset required query param'
  )
  await expect(state.reset()).rejects.toThrow(
    'Cannot reset required query param'
  )
  expect(router.currentRoute.value.fullPath).toBe('/search/7?q=vue&r=keep')
  expect(state.state.q).toBe('vue')
  expect(state.pending.value).toBe(false)
})

it('suppresses automatic ScrollRestoration unless scroll is true', async () => {
  const restore = vi.fn()
  let controls!: ReturnType<typeof useQueryParam>
  const page = defineComponent({
    setup() {
      useScrollRestoration()
      controls = useQueryParam('search', 'q')
      return () => h('main', 'Search')
    },
  })
  const router = experimental_createRouter({
    history: createMemoryHistory(),
    resolver: createFixedResolver([
      normalizeRouteRecord({
        name: 'search',
        path: new MatcherPatternPathStatic('/search'),
        query: [new MatcherPatternQueryParam('q', 'q', 'value', {}, '')],
        components: { default: page },
      }),
    ]),
  })
  await router.push('/search')
  const wrapper = mount(
    defineComponent(() => () => h(RouterView)),
    {
      global: {
        plugins: [
          [ScrollRestoration, { router, capture: () => null, restore }],
          router,
        ],
      },
    }
  )
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  restore.mockClear()
  await controls.update('vue')
  await flushPromises()
  expect(restore).not.toHaveBeenCalled()
  await controls.update('router', { scroll: true })
  await flushPromises()
  expect(restore).toHaveBeenCalledOnce()
})

it('normalizes optimistic parser inputs before exposing state', async () => {
  const { router, use } = await setup()
  const control = use(() =>
    useQueryParam('search', 'page', { debounce: Infinity })
  )
  const result = control.update('2')
  expect(control.state.value).toBe(2)
  await control.flush()
  await result
  expect(router.currentRoute.value.params.page).toBe(2)
})

it('does not shorten a pending wait through an override on the same binding', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const control = use(() => useQueryParam('search', 'q'))
  const first = control.update('first', { debounce: 100 })
  expect(control.update('last', { debounce: 0 })).toBe(first)
  await vi.advanceTimersByTimeAsync(99)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  await first
  expect(router.currentRoute.value.params.q).toBe('last')
})

it('clears explicit defaults when the group resets', async () => {
  const { router, use } = await setup('/search/7?p=1')
  const group = use(() => useQueryParams('search'))
  await group.reset()
  expect(router.currentRoute.value.query.p).toBeUndefined()
})

it('shares one settlement promise for every write and flush in a batch', async () => {
  const { router, use } = await setup()
  const single = use(() => useQueryParam('search', 'q', { debounce: Infinity }))
  const group = use(() => useQueryParams('search'))
  const first = single.update('first')
  for (let i = 0; i < 1000; i++) expect(single.update(String(i))).toBe(first)
  expect(group.patch({ page: 2 })).toBe(first)
  expect(group.flush()).toBe(first)
  await first
  expect(router.currentRoute.value.params).toMatchObject({ q: '999', page: 2 })
  expect(single.pending.value).toBe(false)
})

it.each([NaN, -1, -Infinity])(
  'rejects invalid wait %s before queueing a write',
  async wait => {
    const { router, use } = await setup()
    expect(() =>
      use(() => useQueryParam('search', 'q', { debounce: wait }))
    ).toThrow('waits')
    const group = use(() => useQueryParams('search'))
    await expect(
      group.patch({ q: 'invalid' }, { throttle: wait })
    ).rejects.toThrow('waits')
    expect(group.pending.value).toBe(false)
    expect(router.currentRoute.value.params.q).toBe('')
  }
)

it.each(['debounce', 'throttle'] as const)(
  'requires explicit flush for %s Infinity',
  async option => {
    const { router, use } = await setup()
    vi.useFakeTimers()
    const control = use(() =>
      useQueryParam('search', 'q', { [option]: Infinity })
    )
    const result = control.update('manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(router.currentRoute.value.params.q).toBe('')
    await control.flush()
    await result
    expect(router.currentRoute.value.params.q).toBe('manual')
  }
)

it('does not overflow large finite waits', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const control = use(() =>
    useQueryParam('search', 'q', { debounce: 2 ** 31 + 10 })
  )
  const result = control.update('later')
  await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(11)
  await result
  expect(router.currentRoute.value.params.q).toBe('later')
})

it.each(['reset', 'serialize', 'parse', 'throw'] as const)(
  'validates the whole patch before queueing: %s',
  async failure => {
    const { router, use } = await setup()
    router.getRoutes()[0].query!.push(
      new MatcherPatternQueryParam<any, string>(
        'required',
        'r',
        'value',
        {
          set: value => {
            if (value === 'throw') throw new Error('invalid write')
            return value === 'serialize' ? undefined : String(value)
          },
          get: value => {
            if (value === 'parse') throw new Error('invalid read')
            return value
          },
        },
        undefined,
        true
      )
    )
    await router.push('/search/7?r=keep')
    const group = use(() => useQueryParams('search'))
    await expect(
      group.patch({
        q: 'must-not-commit',
        required: failure === 'reset' ? undefined : failure,
      })
    ).rejects.toBeDefined()
    await group.flush()
    expect(group.state.q).toBe('')
    expect(group.pending.value).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/search/7?r=keep')
  }
)

it('protects nested arrays and objects while permitting top-level replacement', async () => {
  const { router, use } = await setup(
    '/search/7?tag=a&f=%7B%22nested%22:%7B%22value%22:1%7D%7D'
  )
  const single = use(() => useQueryParam('search', 'tags'))
  const group = use(() => useQueryParams('search'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    single.state.value.push('bad')
    group.state.filter.nested.value = 2
    expect(router.currentRoute.value.params.tags).toEqual(['a'])
    expect(router.currentRoute.value.params.filter).toEqual({
      nested: { value: 1 },
    })
    expect(warn).toHaveBeenCalled()
    single.state.value = ['b']
    group.state.filter = { nested: { value: 3 } }
    await group.flush()
    expect(router.currentRoute.value.params.tags).toEqual(['b'])
    expect(router.currentRoute.value.params.filter).toEqual({
      nested: { value: 3 },
    })
  } finally {
    warn.mockRestore()
  }
})

it('separates control names and writes special keys without changing prototypes', async () => {
  const { router, use } = await setup()
  for (const key of ['__proto__', 'constructor', '$patch']) {
    router
      .getRoutes()[0]
      .query!.push(new MatcherPatternQueryParam(key, key, 'value', {}, ''))
  }
  await router.push('/search/7?__proto__=old&constructor=old&$patch=old')
  const group = use(() => useQueryParams('search'))
  const single = use(() => useQueryParam('search', '__proto__'))
  expect(single.state.value).toBe('old')
  expect(group.state.constructor).toBe('old')
  await group.patch({ ['__proto__']: 'new', constructor: 'new', $patch: 'new' })
  expect(single.state.value).toBe('new')
  expect(group.state.$patch).toBe('new')
  expect(router.currentRoute.value.query['0']).toBeUndefined()
  expect(router.currentRoute.value.fullPath).toContain('__proto__=new')
  expect(Object.getPrototypeOf(group.state)).toBeNull()
})
