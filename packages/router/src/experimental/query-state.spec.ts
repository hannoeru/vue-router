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
  type QueryParamRef,
  type QueryParamsState,
  type QueryStateOptions,
} from './query-state'

const useQueryParam = useTypedQueryParam as (
  name: string,
  key: string,
  options?: QueryStateOptions
) => QueryParamRef<any>
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
  const [page, control] = use(() => useQueryParam('search', 'page'))
  const shared = use(() => useQueryParam('search', 'page'))
  const state = use(() => useQueryParams('search'))
  const navigate = vi.spyOn(router, 'push')
  const a = control.update(3)
  const b = state.$patch({ q: 'vue' })
  expect(page.value).toBe(3)
  expect(shared.value).toBe(3)
  expect(state.page).toBe(3)
  expect(control.pending.value).toBe(true)
  expect(state.$pending).toBe(true)
  expect(router.currentRoute.value.params.page).toBe(1)
  await Promise.all([a, b])
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(router.currentRoute.value.fullPath).toBe(
    '/search/7?other=keep&p=3&q=vue#anchor'
  )
  expect(control.pending.value).toBe(false)
  expect(state.$pending).toBe(false)
})

it('is a writable ref and a query-only writable reactive object with toRefs', async () => {
  const { router, use } = await setup()
  const page = use(() => useQueryParam('search', 'page'))
  const state = use(() => useQueryParams('search'))
  const refs = toRefs(state)
  expect(Object.keys(state)).toEqual(['page', 'q', 'tags', 'filter'])
  expect('id' in state).toBe(false)
  page.value = 2
  refs.q.value = 'hello'
  await page[1].flush()
  expect(state.page).toBe(2)
  expect(router.currentRoute.value.params.q).toBe('hello')
  expect(() => state.$patch({ id: 8 })).toThrow('Not a query param')
  expect(() => use(() => useQueryParam('search', 'id'))).toThrow(
    'Not a query param'
  )
})

it('debounces, chooses the shortest wait and flushes all queued keys', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const [q, control] = use(() =>
    useQueryParam('search', 'q', { debounce: 100 })
  )
  const [, page] = use(() => useQueryParam('search', 'page', { debounce: 20 }))
  const a = control.update('v')
  await vi.advanceTimersByTimeAsync(50)
  const b = control.update('vue')
  expect(q.value).toBe('vue')
  await vi.advanceTimersByTimeAsync(19)
  expect(router.currentRoute.value.params.q).toBe('')
  const c = page.update(2)
  await vi.advanceTimersByTimeAsync(20)
  await Promise.all([a, b, c])
  expect(router.currentRoute.value.params.q).toBe('vue')
  expect(router.currentRoute.value.params.page).toBe(2)
})

it('throttles subsequent writes but commits the first write in the same tick', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const [, control] = use(() => useQueryParam('search', 'q', { throttle: 100 }))
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
  const [q, control] = use(() => useQueryParam('search', 'q'))
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
  const [, control] = use(() => useQueryParam('search', 'page'))
  await control.update(2)
  await control.reset({ clearOnDefault: false })
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  await control.update(3)
  await control.reset()
  expect(router.currentRoute.value.query.p).toBeUndefined()
  const state = use(() => useQueryParams('search'))
  await state.$patch({ page: 4, q: 'vue', tags: ['a'] })
  await state.$reset()
  expect(state.page).toBe(1)
  expect(state.tags).toEqual([])
  expect(router.currentRoute.value.query).toEqual({ other: ['keep'] })
})

it('uses structural equality for fresh arrays and objects', async () => {
  const { router, use } = await setup(
    '/search/7?tag=a&f=%7B%22a%22:1,%22b%22:2%7D'
  )
  const [, tags] = use(() => useQueryParam('search', 'tags'))
  const [, filter] = use(() => useQueryParam('search', 'filter'))
  const navigate = vi.spyOn(router, 'push')
  await tags.update(['a'])
  await filter.update({ b: 2, a: 1 })
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps pending until guards settle and serializes writes during navigation', async () => {
  const { router, use } = await setup()
  const [q, control] = use(() => useQueryParam('search', 'q'))
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
  const second = control.update('b')
  expect(control.pending.value).toBe(true)
  expect(q.value).toBe('b')
  release()
  await Promise.all([first, second])
  expect(q.value).toBe('b')
  expect(control.pending.value).toBe(false)
})

it('settles rejected updates and clears optimistic overlays', async () => {
  const { router, use } = await setup()
  const [q, control] = use(() => useQueryParam('search', 'q'))
  router.beforeEach(() => false)
  await control.update('blocked')
  expect(q.value).toBe('')
  expect(control.pending.value).toBe(false)
})

it('flushes on scope disposal and clears the debounce timer', async () => {
  const { router, use, stop } = await setup()
  vi.useFakeTimers()
  const [, control] = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  const settled = control.update('saved')
  stop()
  await settled
  expect(router.currentRoute.value.params.q).toBe('saved')
  expect(vi.getTimerCount()).toBe(0)
})

it('flushes before programmatic leave without cancelling the destination', async () => {
  const { router, use } = await setup()
  const [, control] = use(() => useQueryParam('search', 'q', { debounce: 500 }))
  const settled = control.update('saved')
  const seen: string[] = []
  router.afterEach(to => {
    seen.push(to.fullPath)
  })
  await router.push('/other')
  await settled
  expect(seen).toEqual(['/search/7?other=keep&q=saved#anchor', '/other'])
  expect(router.currentRoute.value.name).toBe('other')
})

it('passes the scroll policy on the batched navigation', async () => {
  const { router, use } = await setup()
  const [, control] = use(() => useQueryParam('search', 'q'))
  const navigate = vi.spyOn(router, 'push')
  await control.update('a')
  expect((navigate.mock.calls[0][0] as any)[QUERY_STATE_SCROLL]).toBe(false)
  await control.update('b', { scroll: true })
  expect((navigate.mock.calls[1][0] as any)[QUERY_STATE_SCROLL]).toBe(true)
})

it('supports mounted v-model writes', async () => {
  const { router } = await setup()
  let flush!: () => Promise<void>
  const wrapper = mount(
    defineComponent({
      setup() {
        const [q, control] = useQueryParam('search', 'q')
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
  const controls: (() => Promise<void>)[] = []
  const component = defineComponent({
    setup() {
      const [q, control] = useQueryParam('search', 'q', { debounce: 100 })
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
  const [q, control] = use(() =>
    useQueryParam('search', 'q', { debounce: 500 })
  )
  const settled = control.update('not-saved')
  const rejected = expect(settled).rejects.toThrow(
    'cancelled by native history navigation'
  )
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
  const [q, control] = use(() => useQueryParam('search', 'q'))
  router.onError(() => {})
  router.beforeEach(() => {
    throw new Error('guard failed')
  })
  await expect(control.update('failed')).rejects.toThrow('guard failed')
  expect(q.value).toBe('')
  expect(control.pending.value).toBe(false)
})

it('keeps equal parsed object identities stable through unrelated updates', async () => {
  const { use } = await setup('/search/7?tag=a&f=%7B%22a%22:1%7D')
  const [tags] = use(() => useQueryParam('search', 'tags'))
  const state = use(() => useQueryParams('search'))
  const changed = vi.fn()
  use(() => watch(() => [tags.value, state.filter], changed))
  const initialTags = tags.value
  const initialFilter = state.filter
  await state.$patch({ page: 2 })
  await nextTick()
  expect(tags.value).toBe(initialTags)
  expect(state.filter).toBe(initialFilter)
  expect(changed).not.toHaveBeenCalled()
})

it('suppresses the legacy scroll callback by default and permits it on request', async () => {
  const { router, use } = await setup()
  const scroll = vi.fn(() => undefined)
  router.options.scrollBehavior = scroll
  const [, control] = use(() => useQueryParam('search', 'q'))
  await control.update('no-scroll')
  await nextTick()
  expect(scroll).not.toHaveBeenCalled()
  await control.update('scroll', { scroll: true })
  await nextTick()
  expect(scroll).toHaveBeenCalledTimes(1)
})

it('flushes queued writes before an external push during an in-flight query write', async () => {
  const { router, use } = await setup()
  const [, control] = use(() => useQueryParam('search', 'q'))
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
  expect(seen).toEqual([
    '/search/7?other=keep&q=first#anchor',
    '/search/7?other=keep&q=second#anchor',
    '/other',
  ])
  expect(control.pending.value).toBe(false)
})

it('uses the shortest wait when two composables write the same param', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const [, fast] = use(() => useQueryParam('search', 'q', { debounce: 20 }))
  const [, slow] = use(() => useQueryParam('search', 'q', { debounce: 100 }))
  const first = fast.update('fast')
  const second = slow.update('last')
  await vi.advanceTimersByTimeAsync(20)
  await Promise.all([first, second])
  expect(router.currentRoute.value.params.q).toBe('last')
})

it('keeps the composable clearOnDefault policy during reset', async () => {
  const { router, use } = await setup()
  const [, control] = use(() =>
    useQueryParam('search', 'page', { clearOnDefault: false })
  )
  await control.update(2)
  await control.reset()
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  const state = use(() => useQueryParams('search', { clearOnDefault: false }))
  await state.$patch({ page: 3 })
  await state.$reset()
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  await state.$reset({ clearOnDefault: true })
  expect(router.currentRoute.value.query.p).toBeUndefined()
})

it('flushes a mounted route component before leave and removes its guard on unmount', async () => {
  const { router } = await setup()
  let update!: (value: string) => Promise<void>
  router.getRoutes()[0].components!.default = defineComponent({
    setup() {
      const [q, control] = useQueryParam('search', 'q', { debounce: 500 })
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
  const [q, control] = use(() => useQueryParam('search', 'q'))
  const state = use(() => useQueryParams('search'))
  await control.update('active')
  await router.push('/other?q=unrelated')
  expect(q.value).toBe('')
  expect(state.q).toBe('')
  await expect(control.update('inactive')).rejects.toThrow('inactive route')
  expect(control.pending.value).toBe(false)
})

it('applies debounce and throttle together and permits an explicit early flush', async () => {
  const { router, use } = await setup()
  vi.useFakeTimers()
  const [, control] = use(() =>
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

it('drains writes added while a pre-navigation flush is in progress', async () => {
  const { router, use } = await setup()
  const [, control] = use(() => useQueryParam('search', 'q', { debounce: 500 }))
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
  expect(seen).toEqual([
    '/search/7?other=keep&q=first#anchor',
    '/search/7?other=keep&q=second#anchor',
    '/other',
  ])
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
  const [filter, control] = use(() => useQueryParam('search', 'filter'))
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
  const [, controls] = use(() => useQueryParam('search', 'required'))
  const state = use(() => useQueryParams('search'))
  await expect(controls.reset()).rejects.toThrow(
    'Cannot reset required query param'
  )
  await expect(state.$reset()).rejects.toThrow(
    'Cannot reset required query param'
  )
  expect(router.currentRoute.value.fullPath).toBe('/search/7?q=vue&r=keep')
  expect(state.q).toBe('vue')
  expect(state.$pending).toBe(false)
})

it('suppresses automatic ScrollRestoration unless scroll is true', async () => {
  const restore = vi.fn()
  let controls!: ReturnType<typeof useQueryParam>[1]
  const page = defineComponent({
    setup() {
      useScrollRestoration()
      ;[, controls] = useQueryParam('search', 'q')
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
