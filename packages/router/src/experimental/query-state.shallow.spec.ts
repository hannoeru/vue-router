/**
 * @vitest-environment happy-dom
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, effectScope, h, watch } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from '../history/memory'
import { RouterView } from '../RouterView'
import { useRoute } from '../useApi'
import type { Router } from '../router'
import { isNavigationFailure, NavigationFailureType } from '../errors'
import { experimental_createRouter, normalizeRouteRecord } from './router'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import { MatcherPatternPathStatic } from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { PARAM_PARSER_INT } from './route-resolver/matchers/param-parsers'
import { defineBasicLoader } from './data-loaders/defineLoader'
import {
  ABORT_CONTROLLER_KEY,
  DataLoaderPlugin,
  LOADER_SET_KEY,
} from './data-loaders/entries'
import { ScrollRestoration, useScrollRestoration } from './scroll-restoration'
import {
  useQueryParam,
  useQueryParams,
  type QueryStateOptions,
  type QueryParamState,
  type QueryParamsState,
} from './query-state'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(
  options: QueryStateOptions = {},
  loaderOptions: { lazy?: boolean; load?: () => Promise<string> } = {}
) {
  const history = createMemoryHistory()
  const load = vi.fn(loaderOptions.load ?? (async () => 'loaded'))
  const loader = defineBasicLoader(load, { lazy: loaderOptions.lazy })
  const restore = vi.fn()
  let scroll!: () => void
  let injectedRoute!: ReturnType<typeof useRoute>
  const component = defineComponent({
    setup() {
      injectedRoute = useRoute()
      scroll = useScrollRestoration().scroll
      return () => h('main', injectedRoute.fullPath)
    },
  })
  const router = experimental_createRouter({
    history,
    resolver: createFixedResolver([
      normalizeRouteRecord({
        name: 'search',
        path: new MatcherPatternPathStatic('/search'),
        query: [
          new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
          new MatcherPatternQueryParam(
            'page',
            'p',
            'value',
            PARAM_PARSER_INT,
            1
          ),
          new MatcherPatternQueryParam('tags', 'tag', 'array', {}, []),
        ],
        meta: { loaders: [loader] },
        components: { default: component },
      }),
      normalizeRouteRecord({
        name: 'other',
        path: new MatcherPatternPathStatic('/other'),
        components: { default: { render: () => h('p', 'other') } },
      }),
    ]),
  })
  const app = createApp({ render: () => h(RouterView) })
  app.use(DataLoaderPlugin, { router: router as unknown as Router })
  app.use(ScrollRestoration, { router, capture: () => null, restore })
  await router.push('/search?other=keep#anchor')
  app.use(router)
  const element = document.createElement('div')
  document.body.append(element)
  app.mount(element)
  const scope = effectScope()
  const controls = app.runWithContext(() =>
    scope.run(() => ({
      q: useQueryParam('search', 'q', options),
      page: useQueryParam('search', 'page', options) as QueryParamState<any>,
      group: useQueryParams('search', options) as QueryParamsState<
        Record<string, any>
      >,
    }))!
  )
  cleanups.push(() => {
    scope.stop()
    app.unmount()
    element.remove()
  })
  await flushPromises()
  load.mockClear()
  restore.mockClear()
  return {
    router,
    app,
    loader,
    history,
    load,
    restore,
    scroll,
    injectedRoute,
    ...controls,
  }
}

it('commits shallow by default through the router and preserves loader metadata', async () => {
  const { router, history, q, page, group, injectedRoute, load, restore } =
    await setup()
  const current = router.currentRoute.value
  const abort = current.meta[ABORT_CONTROLLER_KEY]
  const loaders = current.meta[LOADER_SET_KEY]
  current.meta.custom = 'retained'
  const before = vi.fn()
  const resolve = vi.fn()
  const after = vi.fn()
  const scroll = vi.fn()
  const changed = vi.fn()
  router.beforeEach(before)
  router.beforeResolve(resolve)
  router.afterEach(after)
  router.options.scrollBehavior = scroll
  const stop = watch(() => injectedRoute.query, changed)
  cleanups.push(stop)
  const a = q.update('vue')
  const b = page.update(2)
  expect(group.state.q).toBe('vue')
  expect(group.state.page).toBe(2)
  expect(q.pending.value).toBe(true)
  expect(current.params.q).toBe('')
  await Promise.all([a, b])
  await flushPromises()
  expect(history.location).toBe('/search?other=keep&q=vue&p=2#anchor')
  expect(router.currentRoute.value.fullPath).toBe(history.location)
  expect(injectedRoute.fullPath).toBe(history.location)
  expect(injectedRoute.query).toEqual({ other: ['keep'], q: ['vue'], p: ['2'] })
  expect(injectedRoute.params).toMatchObject({ q: 'vue', page: 2 })
  expect(router.currentRoute.value.meta).toBe(current.meta)
  expect(router.currentRoute.value.meta[ABORT_CONTROLLER_KEY]).toBe(abort)
  expect(router.currentRoute.value.meta[LOADER_SET_KEY]).toBe(loaders)
  expect(router.currentRoute.value.meta.custom).toBe('retained')
  expect(router.currentRoute.value.matched).toBe(current.matched)
  expect(abort!.signal.aborted).toBe(false)
  for (const callback of [before, resolve, after, scroll, load, restore])
    expect(callback).not.toHaveBeenCalled()
  expect(changed).toHaveBeenCalledOnce()
  expect(q.pending.value).toBe(false)
})

it('allows a pending lazy loader to finish after a shallow commit', async () => {
  const release = gate()
  const { router, app, loader, q, load } = await setup(
    {},
    {
      lazy: true,
      load: () => release.promise.then(() => 'late data'),
    }
  )
  const data = app.runWithContext(() => loader())
  const meta = router.currentRoute.value.meta
  expect(data.isLoading.value).toBe(true)
  await q.update('shallow')
  expect(router.currentRoute.value.meta).toBe(meta)
  expect(data.isLoading.value).toBe(true)
  expect(meta[ABORT_CONTROLLER_KEY]!.signal.aborted).toBe(false)
  release.resolve()
  await data
  await flushPromises()
  expect(data.data.value).toBe('late data')
  expect(data.isLoading.value).toBe(false)
  expect(load).not.toHaveBeenCalled()
})

it.each([undefined, true, false])(
  'lets a call override binding shallow=%s',
  async shallow => {
    const { router, q, load, restore } = await setup({ shallow })
    const before = vi.fn()
    const scroll = vi.fn()
    router.beforeEach(before)
    router.options.scrollBehavior = scroll
    await q.update('full', { shallow: false })
    await flushPromises()
    expect(before).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
    expect(scroll).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    await q.update('shallow', { shallow: true })
    await flushPromises()
    expect(before).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
    expect(scroll).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  }
)

it('uses full navigation when any ready key requests it', async () => {
  const { router, q, page } = await setup()
  const before = vi.fn()
  router.beforeEach(before)
  await Promise.all([q.update('full', { shallow: false }), page.update(2)])
  expect(before).toHaveBeenCalledOnce()
  expect(router.currentRoute.value.params).toMatchObject({ q: 'full', page: 2 })
})

it('retains full intent while a replacement remains ready', async () => {
  const { router, q } = await setup()
  vi.useFakeTimers()
  await q.update('initial')
  const before = vi.fn()
  router.beforeEach(before)
  const first = q.update('full', { shallow: false })
  const second = q.update('latest', { shallow: true })
  await vi.advanceTimersByTimeAsync(50)
  await Promise.all([first, second])
  expect(before).toHaveBeenCalledOnce()
  expect(router.currentRoute.value.params.q).toBe('latest')
})

it('discards full intent when a ready key returns to debounce', async () => {
  const { router, q, page } = await setup()
  vi.useFakeTimers()
  await q.update('initial')
  const before = vi.fn()
  router.beforeEach(before)
  const first = q.update('full', { shallow: false, history: 'push' })
  const second = q.update('latest', { shallow: true, debounce: 100 })
  const third = page.update(2)
  await vi.advanceTimersByTimeAsync(50)
  await third
  expect(router.currentRoute.value.params.q).toBe('initial')
  await vi.advanceTimersByTimeAsync(50)
  await Promise.all([first, second])
  expect(before).not.toHaveBeenCalled()
  expect(router.currentRoute.value.params.q).toBe('latest')
})

it.each(['success', 'abort', 'error'] as const)(
  'serializes shallow writes behind a full %s',
  async outcome => {
    const { router, q, page } = await setup()
    const entered = gate()
    const release = gate()
    const error = new Error('full failed')
    router.onError(() => {})
    const remove = router.beforeEach(async () => {
      remove()
      entered.resolve()
      await release.promise
      if (outcome === 'error') throw error
      return outcome === 'abort' ? false : undefined
    })
    const full = page.update(2, { shallow: false }).catch(reason => reason)
    await entered.promise
    const done = vi.fn()
    const shallow = q.update('later').then(done)
    await flushPromises()
    expect(q.state.value).toBe('later')
    expect(q.pending.value).toBe(true)
    expect(router.currentRoute.value.params.q).toBe('')
    expect(done).not.toHaveBeenCalled()
    release.resolve()
    const result = await full
    if (outcome === 'abort')
      expect(isNavigationFailure(result, NavigationFailureType.aborted)).toBe(
        true
      )
    if (outcome === 'error') expect(result).toBe(error)
    await shallow
    expect(router.currentRoute.value.params).toMatchObject({
      q: 'later',
      page: outcome === 'success' ? 2 : 1,
    })
    expect(done).toHaveBeenCalledWith(undefined)
    expect(q.pending.value).toBe(false)
  }
)

it.each([false, true])(
  'cancels queued shallow work on external takeover, blocked=%s',
  async blocked => {
    const { router, q, page } = await setup()
    const entered = gate()
    const release = gate()
    router.beforeEach(async to => {
      if (Number(to.params.page) === 2) {
        entered.resolve()
        await release.promise
      } else if (blocked) return false
      return undefined
    })
    const full = page.update(2, { shallow: false })
    await entered.promise
    const shallow = q.update('cancelled')
    await router.push('/other')
    await expect(shallow).resolves.toEqual({ cancelled: true })
    release.resolve()
    await full
    expect(router.currentRoute.value.params.q).not.toBe('cancelled')
    expect(q.pending.value).toBe(false)
  }
)

it('restores automatically on traversal but only manually after a shallow write', async () => {
  const { router, q, restore, scroll, load } = await setup()
  const before = vi.fn()
  const scrollBehavior = vi.fn()
  router.beforeEach(before)
  router.options.scrollBehavior = scrollBehavior
  await q.update('pushed', { history: 'push' })
  await flushPromises()
  expect(restore).not.toHaveBeenCalled()
  scroll()
  expect(restore).toHaveBeenCalledOnce()
  const traversed = new Promise<void>(done => {
    const remove = router.afterEach(() => {
      remove()
      done()
    })
  })
  router.back()
  await traversed
  await flushPromises()
  expect(before).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
  expect(scrollBehavior).toHaveBeenCalledOnce()
  expect(restore).toHaveBeenCalledTimes(2)
  expect(q.state.value).toBe('')
})

it.each(['other', 'search'])(
  'rejects a shallow change to a different record named %s',
  async name => {
    const history = createMemoryHistory()
    const router = experimental_createRouter({
      history,
      resolver: createFixedResolver([
        normalizeRouteRecord({
          name: 'search',
          path: new MatcherPatternPathStatic('/search'),
          query: [
            new MatcherPatternQueryParam(
              'q',
              'q',
              'value',
              {
                get(value) {
                  if (value !== 'first') throw new Error('not first')
                  return value
                },
              },
              undefined,
              true
            ),
          ],
          components: {},
        }),
        normalizeRouteRecord({
          name,
          path: new MatcherPatternPathStatic('/search'),
          components: {},
        }),
      ]),
    })
    await router.push('/search?q=first')
    const current = router.currentRoute.value
    const app = createApp({ render: () => null })
    app.use(router)
    app.mount(document.createElement('div'))
    cleanups.push(() => app.unmount())
    const q = app.runWithContext(() => useQueryParam('search', 'q'))
    const attempt = q.update('second', { history: 'push' })
    expect(q.state.value).toBe('second')
    await expect(attempt).rejects.toThrow('shallow: false')
    expect(q.state.value).toBe('first')
    expect(q.pending.value).toBe(false)
    expect(router.currentRoute.value).toBe(current)
    expect(history.location).toBe('/search?q=first')
    const before = vi.fn()
    router.beforeEach(before)
    await Promise.all([
      q.update('second'),
      q.update('second', { shallow: false }),
    ])
    expect(before).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.matched[0]).not.toBe(current.matched[0])
  }
)

it('rejects an unmatched shallow target without committing history', async () => {
  const { router, history } = await setup()
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
  const current = router.currentRoute.value
  await expect(
    Promise.resolve().then(() =>
      router._commitQueryState({ q: ['bad'] }, 'push')
    )
  ).rejects.toThrow('shallow: false')
  expect(router.currentRoute.value).toBe(current)
  expect(history.location).toBe(current.fullPath)
})

it('does not write history for an unchanged shallow URL', async () => {
  const { router, history } = await setup()
  const replace = vi.spyOn(history, 'replace')
  const current = router.currentRoute.value
  router._commitQueryState(current.query, 'replace')
  expect(router.currentRoute.value).toBe(current)
  expect(replace).not.toHaveBeenCalled()
})
