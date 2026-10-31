/**
 * @vitest-environment happy-dom
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, effectScope } from 'vue'
import { createMemoryHistory } from '../history/memory'
import { isNavigationFailure, NavigationFailureType } from '../errors'
import { experimental_createRouter, normalizeRouteRecord } from './router'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import {
  MatcherPatternPathDynamic,
  MatcherPatternPathStatic,
} from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { PARAM_PARSER_INT } from './route-resolver/matchers/param-parsers'
import {
  queryStateThrottle,
  useQueryParam,
  useQueryParams,
  type QueryParamState,
  type QueryParamsState,
} from './query-state'

const apps: ReturnType<typeof createApp>[] = []
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(path = '/search/1') {
  const router = experimental_createRouter({
    history: createMemoryHistory(),
    resolver: createFixedResolver([
      normalizeRouteRecord({
        name: 'search',
        path: new MatcherPatternPathDynamic(/^\/search\/([^/]+)$/, { id: [] }, [
          'search',
          1,
        ]),
        query: [
          new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
          new MatcherPatternQueryParam(
            'page',
            'p',
            'value',
            PARAM_PARSER_INT,
            1
          ),
          new MatcherPatternQueryParam('tags', 'tag', 'array'),
        ],
        components: { default: { render: () => null } },
      }),
      normalizeRouteRecord({
        name: 'other',
        path: new MatcherPatternPathStatic('/other'),
        components: { default: { render: () => null } },
      }),
    ]),
  })
  await router.push(path)
  const app = createApp({ render: () => null })
  app.use(router)
  app.mount(document.createElement('div'))
  apps.push(app)
  const scope = effectScope()
  const controls = app.runWithContext(() =>
    scope.run(() => ({
      q: useQueryParam('search', 'q', {
        shallow: false,
      }) as QueryParamState<any>,
      page: useQueryParam('search', 'page', {
        shallow: false,
      }) as QueryParamState<any>,
      group: useQueryParams('search', { shallow: false }) as QueryParamsState<
        Record<string, any>
      >,
    }))!
  )
  return { router, app, scope, ...controls }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('settles split patches only after every replaced key completes', async () => {
  const { router, group, page } = await setup()
  vi.useFakeTimers()
  const done = vi.fn()
  const patch = group.patch({ q: 'vue', page: 2 }, { debounce: 200 }).then(done)
  await page.update(3)
  expect(router.currentRoute.value.params.page).toBe(3)
  expect(router.currentRoute.value.params.q).toBe('')
  expect(done).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(200)
  await patch
  expect(done).toHaveBeenCalledWith(undefined)
  expect(router.currentRoute.value.params.q).toBe('vue')
})

it.each(['error', 'failure', 'cancel'] as const)(
  'waits for surviving keys before reporting %s',
  async kind => {
    const { router, group, page } = await setup()
    vi.useFakeTimers()
    const error = new Error('page failed')
    router.onError(() => {})
    router.beforeEach(to => {
      if (Number(to.params.page) === 3) {
        if (kind === 'error') throw error
        if (kind === 'failure') return false
      }
      return undefined
    })
    const settled = vi.fn()
    const patch = group.patch({ q: 'vue', page: 2 }, { debounce: 200 }).then(
      result => {
        settled()
        return result
      },
      error => {
        settled()
        return error
      }
    )
    if (kind === 'cancel') {
      await router.push('/search/1')
    } else {
      await page.update(3).catch(() => {})
      expect(settled).not.toHaveBeenCalled()
    }
    await vi.advanceTimersByTimeAsync(200)
    const result = await patch
    if (kind === 'error') expect(result).toBe(error)
    if (kind === 'failure')
      expect(isNavigationFailure(result, NavigationFailureType.aborted)).toBe(
        true
      )
    if (kind === 'cancel') expect(result).toEqual({ cancelled: true })
  }
)

it('chooses the first error in input order rather than completion order', async () => {
  const { router, group, page } = await setup()
  vi.useFakeTimers()
  const qError = new Error('q error')
  const pageError = new Error('page error')
  router.onError(() => {})
  router.beforeEach(to => {
    if (Number(to.params.page) === 3) throw pageError
    if (to.params.q === 'vue') throw qError
  })
  const result = group
    .patch({ q: 'vue', page: 2 }, { debounce: 200 })
    .catch(error => error)
  await page.update(3).catch(() => {})
  await vi.advanceTimersByTimeAsync(200)
  expect(await result).toBe(qError)
})

it('retains cancellation until another covered active key finishes with an error', async () => {
  const { router, group, page } = await setup()
  const entered = gate()
  const release = gate()
  const error = new Error('active error')
  router.onError(() => {})
  router.beforeEach(async to => {
    if (Number(to.params.page) === 3) {
      entered.resolve()
      await release.promise
      throw error
    }
  })
  const settled = vi.fn()
  const patch = group
    .patch({ q: 'vue', page: 2 }, { debounce: 200 })
    .catch(error => error)
    .then(result => {
      settled()
      return result
    })
  const replacement = page.update(3).catch(() => {})
  await entered.promise
  await router.push('/other')
  expect(settled).not.toHaveBeenCalled()
  release.resolve()
  await replacement
  expect(await patch).toBe(error)
})

it('starts the throttle interval after navigation settlement', async () => {
  const { router, q } = await setup()
  vi.useFakeTimers()
  const entered = gate()
  const release = gate()
  const remove = router.beforeEach(async () => {
    remove()
    entered.resolve()
    await release.promise
  })
  const first = q.update('first')
  await entered.promise
  const second = q.update('second', { debounce: 0, throttle: 0 })
  await vi.advanceTimersByTimeAsync(1000)
  release.resolve()
  await first
  await vi.advanceTimersByTimeAsync(49)
  expect(router.currentRoute.value.params.q).toBe('first')
  await vi.advanceTimersByTimeAsync(1)
  await second
  expect(router.currentRoute.value.params.q).toBe('second')
})

it('discards superseded debounce options and options for keys that return to debounce', async () => {
  const { router, q, page } = await setup()
  vi.useFakeTimers()
  await q.update('initial')
  const navigate = vi.spyOn(router, 'push')
  const first = q.update('push', { history: 'push', throttle: 1000 })
  const second = q.update('delayed', { history: 'replace', debounce: 200 })
  const third = page.update(2)
  await vi.advanceTimersByTimeAsync(50)
  await third
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ replace: true })
  )
  expect(router.currentRoute.value.params.q).toBe('initial')
  await vi.advanceTimersByTimeAsync(150)
  await Promise.all([first, second])
  expect(
    navigate.mock.calls.every(
      ([to]) => typeof to === 'object' && 'replace' in to && to.replace
    )
  ).toBe(true)
})

it('combines options while the same key remains in the ready batch', async () => {
  const { router, q } = await setup()
  vi.useFakeTimers()
  await q.update('initial')
  const navigate = vi.spyOn(router, 'push')
  const a = q.update('push', { history: 'push', throttle: 100 })
  const b = q.update('replace')
  await vi.advanceTimersByTimeAsync(99)
  expect(navigate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([a, b])
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ replace: false })
  )
})

it.each([
  [false, '', 50],
  [true, 'Version/17.0 Safari', 120],
  [true, 'Version/16.6 Safari', 320],
  [true, 'unrecognized', 320],
])(
  'selects the browser floor for Safari=%s, %s',
  (safari, userAgent, expected) => {
    vi.stubGlobal('GestureEvent', safari ? class {} : undefined)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    expect(queryStateThrottle()).toBe(expected)
  }
)

it('rejects invalid throttle options', async () => {
  const { q } = await setup()
  for (const throttle of [-1, NaN, Infinity])
    await expect(q.update('bad', { throttle })).rejects.toThrow('waits')
  expect(q.pending.value).toBe(false)
})

it('does not accelerate or cancel accepted writes when the scope ends', async () => {
  const { router, scope, q } = await setup()
  vi.useFakeTimers()
  const result = q.update('later', { debounce: 200 })
  scope.stop()
  await vi.advanceTimersByTimeAsync(199)
  expect(router.currentRoute.value.params.q).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  await result
  expect(router.currentRoute.value.params.q).toBe('later')
  expect(vi.getTimerCount()).toBe(0)
})

it('distinguishes default reset, explicit removal, absent arrays, and ignored undefined', async () => {
  const { router, group, page } = await setup('/search/1?p=2&tag=x')
  await page.reset({ clearOnDefault: false })
  expect(router.currentRoute.value.query.p).toEqual(['1'])
  await page.clear({ clearOnDefault: false })
  expect(router.currentRoute.value.query.p).toBeUndefined()
  expect(page.state.value).toBe(1)
  await group.patch({ page: undefined, q: undefined })
  const result = group.clear({ debounce: 10, clearOnDefault: false })
  expect(group.state.tags).toEqual([])
  await result
  expect(router.currentRoute.value.query).toEqual({})
  expect(group.state.tags).toEqual([])
})

it('removes explicit defaults even when the parsed value does not change', async () => {
  const { router, page } = await setup('/search/1?p=1')
  await page.update(1)
  expect(router.currentRoute.value.query.p).toBeUndefined()
})

it('prepares all serialization before enqueueing and retains supplied lossy state', async () => {
  const { router, app, group } = await setup()
  let serializations = 0
  router.getRoutes()[0].query!.push(
    new MatcherPatternQueryParam(
      'lossy',
      'l',
      'value',
      {
        get: value => Number(value),
        set: value => {
          serializations++
          if (value === 9) throw new Error('bad')
          return Number(value).toFixed(1)
        },
      },
      0
    )
  )
  const lossy = app.runWithContext(() =>
    useQueryParam('search', 'lossy')
  ) as QueryParamState<any>
  await expect(group.patch({ q: 'partial', lossy: 9 })).rejects.toThrow('bad')
  expect(group.pending.value).toBe(false)
  const result = lossy.update(1.234, { debounce: 10 })
  expect(lossy.state.value).toBe(1.234)
  await result
  expect(lossy.state.value).toBe(1.2)
  expect(serializations).toBe(2)
})

it.each([false, true])(
  'cancels external writes at start even when navigation aborts=%s',
  async abort => {
    const { router, q } = await setup()
    const entered = gate()
    const release = gate()
    const first = q.update('old', { debounce: 200 })
    router.beforeEach(async () => {
      entered.resolve()
      await release.promise
      return abort ? false : undefined
    })
    const navigation = router.push('/search/2')
    await entered.promise
    await expect(first).resolves.toEqual({ cancelled: true })
    await expect(q.update('during')).resolves.toEqual({ cancelled: true })
    expect(q.state.value).toBe('')
    expect(q.pending.value).toBe(false)
    release.resolve()
    await navigation
  }
)

it('does not let an older unresolved external guard block a newer committed location', async () => {
  const { router, q } = await setup()
  const entered = gate()
  const release = gate()
  router.beforeEach(async to => {
    if (to.path === '/other') {
      entered.resolve()
      await release.promise
    }
  })
  const old = router.push('/other')
  await entered.promise
  await router.push('/search/2')
  await q.update('new-location')
  expect(router.currentRoute.value.params.q).toBe('new-location')
  release.resolve()
  await old
})

it('reads inactive defaults while an older active query guard remains unresolved', async () => {
  const { router, q, group } = await setup()
  const entered = gate()
  const release = gate()
  router.beforeEach(async to => {
    if (to.params.q === 'old') {
      entered.resolve()
      await release.promise
    }
  })
  const old = q.update('old')
  await entered.promise
  await router.push('/other')
  expect(q.state.value).toBe('')
  expect(group.state.q).toBe('')
  release.resolve()
  await old
})

it.each([false, true])(
  'settles ordinary child push after an earlier await=%s',
  async waitFirst => {
    const { router, q } = await setup()
    router.beforeEach(async to => {
      if (to.params.q === 'child') {
        if (waitFirst) await Promise.resolve()
        await router.push('/other')
      }
    })
    const result = await q.update('child')
    expect(isNavigationFailure(result, NavigationFailureType.cancelled)).toBe(
      true
    )
    expect(router.currentRoute.value.name).toBe('other')
  }
)

it('cancels queued work and timers on router teardown', async () => {
  const { app, q } = await setup()
  vi.useFakeTimers()
  const result = q.update('later', { debounce: 200 })
  app.unmount()
  apps.splice(apps.indexOf(app), 1)
  await expect(result).resolves.toEqual({ cancelled: true })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['/search/2', '/search/1?q=external'])(
  'does not show an older active value over external destination %s',
  async destination => {
    const { router, q, group } = await setup()
    const entered = gate()
    const release = gate()
    router.beforeEach(async to => {
      if (to.params.q === 'old') {
        entered.resolve()
        await release.promise
      }
    })
    const settled = vi.fn()
    const old = q.update('old').then(result => {
      settled()
      return result
    })
    await entered.promise
    await router.push(destination)
    expect(q.state.value).toBe(
      destination.includes('external') ? 'external' : ''
    )
    expect(group.state.q).toBe(q.state.value)
    expect(q.pending.value).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    release.resolve()
    expect(
      isNavigationFailure(await old, NavigationFailureType.cancelled)
    ).toBe(true)
    expect(q.pending.value).toBe(false)
  }
)

it('cancels writes when external navigation started before the first binding', async () => {
  const original = await setup()
  const router = experimental_createRouter({
    ...original.router.options,
    history: createMemoryHistory(),
  })
  await router.push('/search/1')
  const entered = gate()
  const release = gate()
  router.beforeEach(async () => {
    entered.resolve()
    await release.promise
  })
  const navigation = router.push('/search/2')
  await entered.promise
  const app = createApp({ render: () => null })
  app.use(router)
  app.mount(document.createElement('div'))
  apps.push(app)
  const q = app.runWithContext(() => useQueryParam('search', 'q'))
  await expect(q.update('late')).resolves.toEqual({ cancelled: true })
  expect(q.pending.value).toBe(false)
  expect(q.state.value).toBe('')
  release.resolve()
  await navigation
})

it('prepares a serialized snapshot that later mutation cannot change', async () => {
  const { router, group } = await setup()
  const tags = ['accepted']
  const result = group.patch({ tags }, { debounce: 10 })
  tags.push('later')
  await result
  expect(router.currentRoute.value.query.tag).toEqual(['accepted'])
})

it('validates clear-all and reset-all before enqueueing any key', async () => {
  const { router, app } = await setup('/search/1?q=keep')
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
  const group = app.runWithContext(() => useQueryParams('search'))
  for (const operation of ['clear', 'reset'] as const) {
    await expect(group[operation]()).rejects.toThrow('required')
    expect(group.pending.value).toBe(false)
    expect(router.currentRoute.value.query.q).toEqual(['keep'])
  }
})

it('treats an empty repeated URL value as absent for no-op detection', async () => {
  const { router, group } = await setup()
  const navigate = vi.spyOn(router, 'push')
  await expect(group.patch({ tags: [] })).resolves.toBeUndefined()
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps pending ownership per route when a new route uses the same URL key', async () => {
  const { router, app, q } = await setup()
  router.getRoutes()[1].query = [
    new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
  ]
  const other = app.runWithContext(() => useQueryParam('other', 'q'))
  const entered = gate()
  const release = gate()
  router.beforeEach(async to => {
    if (to.params.q === 'old') {
      entered.resolve()
      await release.promise
    }
  })
  const old = q.update('old')
  await entered.promise
  await router.push('/other')
  const next = other.update('new')
  expect(q.pending.value).toBe(true)
  expect(other.pending.value).toBe(true)
  expect(q.state.value).toBe('')
  release.resolve()
  await Promise.all([old, next])
  expect(q.pending.value).toBe(false)
  expect(other.pending.value).toBe(false)
  expect(other.state.value).toBe('new')
})

it('reports an error instead of an earlier navigation failure from another key', async () => {
  const { router, group, page } = await setup()
  vi.useFakeTimers()
  const error = new Error('q failed')
  router.onError(() => {})
  router.beforeEach(to => {
    if (Number(to.params.page) === 3) return false
    if (to.params.q === 'vue') throw error
    return undefined
  })
  const result = group
    .patch({ q: 'vue', page: 2 }, { debounce: 200 })
    .catch(error => error)
  expect(isNavigationFailure(await page.update(3))).toBe(true)
  await vi.advanceTimersByTimeAsync(200)
  expect(await result).toBe(error)
})

it('reports a navigation failure instead of cancellation from another key', async () => {
  const { router, group, page } = await setup()
  const entered = gate()
  const release = gate()
  router.beforeEach(async to => {
    if (Number(to.params.page) === 3) {
      entered.resolve()
      await release.promise
      return false
    }
    return undefined
  })
  const result = group.patch({ q: 'vue', page: 2 }, { debounce: 200 })
  const replacement = page.update(3)
  await entered.promise
  await router.push('/other')
  release.resolve()
  await replacement
  expect(isNavigationFailure(await result, NavigationFailureType.aborted)).toBe(
    true
  )
})
