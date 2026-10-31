/**
 * @vitest-environment node
 */
import { expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory } from '../history/memory'
import { experimental_createRouter, normalizeRouteRecord } from './router'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import { MatcherPatternPathStatic } from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import {
  useQueryParam,
  useQueryParams,
  type QueryStateResult,
} from './query-state'

it.each([false, true])(
  'does not queue SSR writes with a window global: %s',
  async browserGlobal => {
    vi.useFakeTimers()
    if (browserGlobal) vi.stubGlobal('window', {})
    try {
      const router = experimental_createRouter({
        history: createMemoryHistory(),
        resolver: createFixedResolver([
          normalizeRouteRecord({
            name: 'search',
            path: new MatcherPatternPathStatic('/search'),
            query: [new MatcherPatternQueryParam('q', 'q', 'value', {}, '')],
            components: {},
          }),
        ]),
      })
      await router.push('/search?q=server')
      const promises: Promise<QueryStateResult>[] = []
      const app = createSSRApp({
        setup() {
          const single = useQueryParam('search', 'q', { debounce: 60000 })
          const group = useQueryParams('search', { debounce: 60000 })
          single.state.value = 'ignored'
          group.state.q = 'ignored'
          promises.push(
            single.update('ignored'),
            group.patch({ q: 'ignored' }),
            single.reset(),
            group.reset(),
            single.clear(),
            group.clear()
          )
          expect(single.pending.value).toBe(false)
          expect(group.pending.value).toBe(false)
          return () => h('p', String(single.state.value))
        },
      })
      app.use(router)
      expect(await renderToString(app)).toBe('<p>server</p>')
      expect(await Promise.all(promises)).toEqual(Array(6).fill(undefined))
      expect(router.currentRoute.value.fullPath).toBe('/search?q=server')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  }
)
