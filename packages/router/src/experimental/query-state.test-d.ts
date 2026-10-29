import { expectTypeOf, it } from 'vitest'
import { toRefs, type ComputedRef, type WritableComputedRef } from 'vue'
import {
  useQueryParam,
  useQueryParams,
  type QueryParamState,
  type QueryParamsState,
  type QueryStateResult,
} from './query-state'

it('keeps state separate from controls', () => {
  const result = useQueryParam('search', 'page')
  expectTypeOf(result.pending).toEqualTypeOf<ComputedRef<boolean>>()
  // @ts-expect-error: flushing is internal
  result.flush()
  expectTypeOf(result.reset()).toEqualTypeOf<Promise<QueryStateResult>>()
  const group = useQueryParams('search')
  expectTypeOf(group.pending).toEqualTypeOf<ComputedRef<boolean>>()
  // @ts-expect-error: flushing is internal
  group.flush()
  expectTypeOf(group.reset()).toEqualTypeOf<Promise<QueryStateResult>>()
  // @ts-expect-error: results are not tuples
  const [_state] = result
  // @ts-expect-error: results have no array methods
  result.map(value => value)
  // @ts-expect-error: unsupported history mode
  useQueryParam('search', 'page', { history: 'append' })
  // @ts-expect-error: throttle is not supported
  useQueryParam('search', 'page', { throttle: 100 })
  // @ts-expect-error: scroll uses the router policy
  useQueryParams('search', { scroll: false })
  // @ts-expect-error: debounce is a duration in milliseconds
  useQueryParams('search', { debounce: true })
})

it('preserves parsed reads and raw writes', () => {
  const page = null! as QueryParamState<number, number | undefined>
  expectTypeOf(page.state).toEqualTypeOf<
    WritableComputedRef<number, number | undefined>
  >()
  page.state.value = 2
  page.state.value = undefined
  expectTypeOf(page.update(3)).toEqualTypeOf<Promise<QueryStateResult>>()
  page.update(undefined)
  // @ts-expect-error: parsed numbers cannot be set to URL strings
  page.state.value = '2'
  // @ts-expect-error: update takes the parser input type
  page.update('3')
  // @ts-expect-error: pending is read only
  page.pending.value = false
})

it('makes nested reads readonly and top-level values writable', () => {
  const tags = null! as QueryParamState<string[]>
  expectTypeOf(tags.state.value).toEqualTypeOf<readonly string[]>()
  tags.state.value = ['vue']
  // @ts-expect-error: nested arrays are read only
  tags.state.value.push('router')

  const result = null! as QueryParamsState<{
    page: number
    tags: string[]
    filters: { range: { min: number }; tags: string[] }
    date: Date | undefined
    $patch: string
  }>
  result.patch({ page: 2, tags: ['vue'], $patch: 'query value' })
  result.state.tags = ['router']
  result.state.filters = { range: { min: 1 }, tags: [] }
  const refs = toRefs(result.state)
  expectTypeOf(refs.page.value).toEqualTypeOf<number>()
  expectTypeOf(refs.tags.value).toEqualTypeOf<readonly string[]>()
  expectTypeOf(refs.date.value).toEqualTypeOf<Date | undefined>()
  expectTypeOf(result.state.$patch).toEqualTypeOf<string>()
  // @ts-expect-error: nested arrays are read only
  result.state.tags.push('router')
  // @ts-expect-error: nested object properties are read only
  result.state.filters.range.min = 2
  // @ts-expect-error: nested object arrays are read only
  result.state.filters.tags.push('vue')
  // @ts-expect-error: partial updates preserve field types
  result.patch({ page: '2' })
  // @ts-expect-error: unknown query key
  result.patch({ missing: 1 })
  // @ts-expect-error: pending is read only
  result.pending.value = false
})
