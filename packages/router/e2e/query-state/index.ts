import { createApp, defineComponent, ref } from 'vue'
import { createWebHistory } from 'vue-router'
import {
  experimental_createRouter,
  normalizeRouteRecord,
  createFixedResolver,
  MatcherPatternPathStatic,
  MatcherPatternQueryParam,
  useQueryParam,
  useQueryParams,
  PARAM_PARSER_INT,
  type QueryParamState,
  type QueryParamsState,
} from 'vue-router/experimental'

const router = experimental_createRouter({
  history: createWebHistory('/query-state'),
  resolver: createFixedResolver([
    normalizeRouteRecord({
      name: 'search',
      path: new MatcherPatternPathStatic('/'),
      query: [
        new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
        new MatcherPatternQueryParam('page', 'p', 'value', PARAM_PARSER_INT, 1),
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

const block = ref(false)
const visits = ref(0)
router.beforeEach(to => {
  if (block.value) return false
  if (to.query.q?.[0] === 'sync-child')
    return router.push('/other').then(() => undefined)
  if (to.query.q?.[0] === 'async-child')
    return Promise.resolve()
      .then(() => router.push('/other'))
      .then(() => undefined)
  return undefined
})
router.afterEach(() => {
  visits.value++
})

const app = createApp(
  defineComponent({
    setup() {
      const q = useQueryParam('search', 'q', { debounce: 250 })
      const group = useQueryParams('search') as QueryParamsState<{
        q: string
        page: number
      }>
      const page = useQueryParam('search', 'page') as QueryParamState<any>
      const result = ref('idle')
      const observe = async (promise: ReturnType<typeof q.update>) => {
        result.value = 'waiting'
        try {
          const outcome = await promise
          result.value =
            outcome && 'cancelled' in outcome
              ? 'cancelled'
              : outcome
                ? 'failure'
                : 'success'
        } catch {
          result.value = 'error'
        }
      }
      return {
        q: q.state,
        pending: q.pending,
        query: group.state,
        result,
        block,
        visits,
        split: () => {
          void observe(group.patch({ q: 'split', page: 2 }, { debounce: 250 }))
          void page.update(3)
        },
        clear: () => observe(group.clear({ clearOnDefault: false })),
        reset: () => observe(group.reset({ clearOnDefault: false })),
        submit: () => observe(q.update(q.state.value, { debounce: 0 })),
        syncChild: () => observe(q.update('sync-child', { debounce: 0 })),
        asyncChild: () => observe(q.update('async-child', { debounce: 0 })),
        external: () => router.push('/?q=external'),
        next: () => router.push('/?q=next'),
        committed: router.currentRoute,
      }
    },
    template: `
    <label>Search <input v-model="q" /></label>
    <label>Block navigation <input type="checkbox" v-model="block" /></label>
    <p id="state">{{ q }}</p><p id="pending">{{ pending }}</p>
    <p id="path">{{ committed.fullPath }}</p><p id="page">{{ committed.params.page }}</p>
    <p id="result">{{ result }}</p><p id="visits">{{ visits }}</p>
    <button @click="submit">Apply</button><button @click="split">Split patch</button>
    <button @click="clear">Clear</button><button @click="reset">Reset</button>
    <button @click="external">External</button><button @click="next">Next</button>
    <button @click="syncChild">Sync child</button><button @click="asyncChild">Async child</button>
  `,
  })
)
app.use(router)
await router.isReady()
app.mount('#app')
