import { expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  defineArrayParser,
  defineEnumParser,
  defineJsonParser,
  PARAM_PARSER_FLOAT,
} from './data-parsers'
import {
  defineParamParser,
  defineParamParserRaw,
  defineHashParamParser,
} from './define-param-parser'
import type { ParamParser } from './types'
import type { ParamParserTypeOf } from '../../../runtime'

export const parser = defineArrayParser(PARAM_PARSER_FLOAT)

it('infers enum literals and delimited array items', () => {
  const strings = defineEnumParser(['asc', 'desc'])
  expectTypeOf(strings.get('asc')).toEqualTypeOf<
    'asc' | 'desc' | ('asc' | 'desc')[] | null | undefined
  >()
  // @ts-expect-error: not an enum member
  strings.set('other')
  const numbers = defineEnumParser([1, 2])
  // @ts-expect-error: not a numeric enum member
  numbers.set(3)
  const array = defineArrayParser(PARAM_PARSER_FLOAT)
  expectTypeOf(array.get('1,2')).toEqualTypeOf<number[] | undefined>()
  expectTypeOf(array.set).toBeCallableWith([1, 2])
  // @ts-expect-error: array items must be numbers
  array.set(['1'])
})

it('infers JSON function and Standard Schema output', () => {
  const fn = defineJsonParser(value =>
    typeof value === 'number' ? value : undefined
  )
  expectTypeOf(fn.get('1')).toEqualTypeOf<number | null | undefined>()
  const schema = defineJsonParser(z.object({ count: z.number() }))
  expectTypeOf(schema.get('{}')).toEqualTypeOf<
    { count: number } | null | undefined
  >()
  // @ts-expect-error: JSON output follows the schema
  schema.set({ count: '1' })
})

it('keeps equality optional on parsers and all helper results', () => {
  const parser: ParamParser<number, string> = { get: Number, set: String }
  const raw = defineParamParserRaw<number, number, string>({
    get: Number,
    set: String,
  })
  const hash = defineHashParamParser<number>({ get: Number, set: String })
  const lifted = defineParamParser<number>({ get: Number, set: String })
  expectTypeOf(parser.eq).toEqualTypeOf<
    ((a: number, b: number) => boolean) | undefined
  >()
  expectTypeOf(raw.eq).toEqualTypeOf<
    ((a: number, b: number) => boolean) | undefined
  >()
  expectTypeOf(hash.eq).toEqualTypeOf<
    ((a: number, b: number) => boolean) | undefined
  >()
  expectTypeOf(lifted.eq).toEqualTypeOf<
    | ((a: number | number[] | null, b: number | number[] | null) => boolean)
    | undefined
  >()
})

it('registers builtin data types by name', () => {
  expectTypeOf<ParamParserTypeOf<'float'>>().toEqualTypeOf<number>()
  expectTypeOf<ParamParserTypeOf<'index'>>().toEqualTypeOf<number>()
  expectTypeOf<ParamParserTypeOf<'hex'>>().toEqualTypeOf<number>()
  expectTypeOf<ParamParserTypeOf<'date'>>().toEqualTypeOf<Date>()
  expectTypeOf<ParamParserTypeOf<'datetime'>>().toEqualTypeOf<Date>()
  expectTypeOf<ParamParserTypeOf<'timestamp'>>().toEqualTypeOf<Date>()
  expectTypeOf<ParamParserTypeOf<'json'>>().toEqualTypeOf<unknown>()
})
