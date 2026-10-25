import { expectTypeOf, it } from 'vitest'
import type { ExtractParamParserType as _ExtractParamParserType } from '../../experimental/route-resolver/matchers/param-parsers/standard-schema'
type Param_ids = _ExtractParamParserType<
  typeof import('../../experimental/route-resolver/matchers/param-parsers/data-parsers.test-d').parser
>
type Resolved = { ids: Param_ids | undefined }
type Navigation = { ids?: Param_ids | undefined }
type RequiredResolved = { ids: Exclude<Param_ids, undefined> }
type RequiredNavigation = { ids: Exclude<Param_ids, undefined> }
type DefaultResolved = { ids: Exclude<Param_ids, undefined> }
type DefaultNavigation = { ids?: Exclude<Param_ids, undefined> }
it('keeps generated delimited array types', () => {
  expectTypeOf<Resolved['ids']>().toEqualTypeOf<number[] | undefined>()
  expectTypeOf<Navigation['ids']>().toEqualTypeOf<number[] | undefined>()
  expectTypeOf<RequiredResolved['ids']>().toEqualTypeOf<number[]>()
  expectTypeOf<RequiredNavigation['ids']>().toEqualTypeOf<number[]>()
  expectTypeOf<DefaultResolved['ids']>().toEqualTypeOf<number[]>()
  expectTypeOf<DefaultNavigation>().toEqualTypeOf<{ ids?: number[] }>()
  expectTypeOf<Navigation>().toExtend<{ ids?: number[] | undefined }>()
})
