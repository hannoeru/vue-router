import { expectTypeOf, it } from 'vitest'
import { toRefs, type ComputedRef, type WritableComputedRef } from 'vue'
import { useRoute } from '../useApi'
import {
  useQueryParam,
  useQueryParams,
  type QueryParamRef,
  type QueryParamsState,
} from './query-state'

it('uses the same route param inference as useRoute', () => {
  const route = useRoute('search')
  const ref = useQueryParam('search', 'page')
  expectTypeOf(ref.value).toEqualTypeOf<typeof route.params.page>()
  const [page, control] = ref
  expectTypeOf(page).toEqualTypeOf<
    WritableComputedRef<typeof route.params.page>
  >()
  expectTypeOf(control.pending).toEqualTypeOf<ComputedRef<boolean>>()
  expectTypeOf(control.update(page.value)).toEqualTypeOf<Promise<void>>()
  expectTypeOf(control.reset()).toEqualTypeOf<Promise<void>>()
  expectTypeOf(control.flush()).toEqualTypeOf<Promise<void>>()
  const state = useQueryParams('search')
  expectTypeOf(state.page).toEqualTypeOf<typeof route.params.page>()
  expectTypeOf(state.$patch({ page: route.params.page })).toEqualTypeOf<
    Promise<void>
  >()
  expectTypeOf(state.$reset()).toEqualTypeOf<Promise<void>>()
  expectTypeOf(state.$pending).toEqualTypeOf<boolean>()
  const refs = toRefs(state)
  expectTypeOf(refs.page.value).toEqualTypeOf<typeof route.params.page>()
  // @ts-expect-error: unsupported history mode
  useQueryParam('search', 'page', { history: 'append' })
  // @ts-expect-error: debounce is a duration in milliseconds
  useQueryParams('search', { debounce: true })
})

it('preserves rich parsed value types in refs and objects', () => {
  const page = null! as QueryParamRef<number>
  page.value = 2
  const [value, control] = page
  expectTypeOf(value.value).toEqualTypeOf<number>()
  expectTypeOf(control.update(3)).toEqualTypeOf<Promise<void>>()
  // @ts-expect-error: parsed numbers cannot be set to raw strings
  page.value = '2'
  // @ts-expect-error: update takes the parsed type
  control.update('3')
  const state = null! as QueryParamsState<{
    page: number
    tags: string[]
    date: Date | undefined
  }>
  state.$patch({ page: 2, tags: ['vue'] })
  const refs = toRefs(state)
  expectTypeOf(refs.page.value).toEqualTypeOf<number>()
  expectTypeOf(refs.date.value).toEqualTypeOf<Date | undefined>()
  // @ts-expect-error: partial updates preserve field types
  state.$patch({ page: '2' })
  // @ts-expect-error: unknown query key
  state.$patch({ missing: 1 })
  // @ts-expect-error: pending is read only
  state.$pending = false
})
