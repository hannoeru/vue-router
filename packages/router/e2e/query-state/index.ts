import { createApp, defineComponent, h, ref } from 'vue'
import { createWebHistory, RouterView, useRoute } from 'vue-router'
import {
  experimental_createRouter,
  normalizeRouteRecord,
  createFixedResolver,
  MatcherPatternPathStatic,
  MatcherPatternQueryParam,
  useQueryParam,
  useQueryParams,
  PARAM_PARSER_INT,
  DataLoaderPlugin,
  defineBasicLoader,
  ScrollRestoration,
  useScrollRestoration,
  type QueryParamState,
  type QueryParamsState,
} from 'vue-router/experimental'

const loads = ref(0)
const guards = ref(0)
const scrolls = ref(0)
const restores = ref(0)
const held = ref(false)
let releaseFull: (() => void) | undefined
const loader = defineBasicLoader(async () => ++loads.value)
const component = defineComponent({
  setup() {
    useScrollRestoration()
    const route = useRoute()
    return () => h('span', route.fullPath)
  },
})

const router = experimental_createRouter({
  scrollBehavior() {
    scrolls.value++
    return { top: 0 }
  },
  history: createWebHistory('/query-state'),
  resolver: createFixedResolver([
    normalizeRouteRecord({
      name: 'search',
      path: new MatcherPatternPathStatic('/'),
      query: [
        new MatcherPatternQueryParam('q', 'q', 'value', {}, ''),
        new MatcherPatternQueryParam('page', 'p', 'value', PARAM_PARSER_INT, 1),
      ],
      meta: { loaders: [loader] },
      components: { default: component },
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
  guards.value++
  if (block.value) return false
  if (to.query.q?.[0] === 'slow') {
    held.value = true
    return new Promise<void>(resolve => {
      releaseFull = () => {
        held.value = false
        resolve()
      }
    })
  }
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
      const route = useRoute()
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
        guards,
        loads,
        scrolls,
        restores,
        held,
        route,
        push: () =>
          observe(q.update('pushed', { debounce: 0, history: 'push' })),
        replace: () => observe(q.update('replaced', { debounce: 0 })),
        full: () => observe(q.update('full', { debounce: 0, shallow: false })),
        slow: () => observe(q.update('slow', { debounce: 0, shallow: false })),
        release: () => releaseFull?.(),
        split: () => {
          void observe(group.patch({ q: 'split', page: 2 }, { debounce: 250 }))
          void page.update(3)
        },
        clear: () => observe(group.clear({ clearOnDefault: false })),
        reset: () => observe(group.reset({ clearOnDefault: false })),
        submit: () => observe(q.update(q.state.value, { debounce: 0 })),
        syncChild: () =>
          observe(q.update('sync-child', { debounce: 0, shallow: false })),
        asyncChild: () =>
          observe(q.update('async-child', { debounce: 0, shallow: false })),
        external: () => router.push('/?q=external'),
        next: () => router.push('/?q=next'),
        committed: router.currentRoute,
      }
    },
    template: `
    <RouterView />
    <label>Search <input v-model="q" /></label>
    <label>Block navigation <input type="checkbox" v-model="block" /></label>
    <p id="state">{{ q }}</p><p id="pending">{{ pending }}</p>
    <p id="path">{{ committed.fullPath }}</p><p id="page">{{ committed.params.page }}</p>
    <p id="result">{{ result }}</p><p id="visits">{{ visits }}</p>
    <p id="guards">{{ guards }}</p><p id="loads">{{ loads }}</p>
    <p id="scrolls">{{ scrolls }}</p><p id="restores">{{ restores }}</p>
    <p id="held">{{ held }}</p><p id="route">{{ route.fullPath }}</p>
    <p id="route-query">{{ JSON.stringify(route.query) }}</p>
    <p id="route-params">{{ JSON.stringify(route.params) }}</p>
    <button @click="push">Shallow push</button><button @click="replace">Shallow replace</button>
    <button @click="full">Full</button><button @click="slow">Slow full</button>
    <button @click="release">Release full</button>
    <button @click="submit">Apply</button><button @click="split">Split patch</button>
    <button @click="clear">Clear</button><button @click="reset">Reset</button>
    <button @click="external">External</button><button @click="next">Next</button>
    <button @click="syncChild">Sync child</button><button @click="asyncChild">Async child</button>
  `,
  })
)
app.component('RouterView', RouterView)
app.use(DataLoaderPlugin, { router })
app.use(ScrollRestoration, {
  router,
  capture: () => ({ default: { top: window.scrollY } }),
  restore: () => {
    restores.value++
    window.scrollTo(0, 0)
  },
})
app.use(router)
await router.isReady()
await router.replace({
  path: '/',
  query: router.currentRoute.value.query,
  state: { custom: 'keep' },
  force: true,
})
app.mount('#app')
