import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineHashParamParser,
  defineParamParser,
  defineParamParserRaw,
} from './define-param-parser'
import { normalizeParamParser } from './standard-schema'
import { MatcherPatternQueryParam } from '../matcher-pattern-query'
import { MatcherPatternHashParam } from '../matcher-pattern-hash'
import { PARAM_PARSER_INT } from './integers'
import {
  PARAM_PARSER_FLOAT,
  PARAM_PARSER_INDEX,
  PARAM_PARSER_HEX,
  PARAM_PARSER_DATE,
  PARAM_PARSER_DATETIME,
  PARAM_PARSER_TIMESTAMP,
  PARAM_PARSER_JSON,
  defineEnumParser,
  defineArrayParser,
  defineJsonParser,
} from './data-parsers'

describe('data parsers', () => {
  it.each([
    [PARAM_PARSER_FLOAT, '1.25', 1.25, '1.25'],
    [PARAM_PARSER_FLOAT, '-2e3', -2000, '-2000'],
    [PARAM_PARSER_INDEX, '1', 0, '1'],
    [PARAM_PARSER_INDEX, '8', 7, '8'],
    [PARAM_PARSER_HEX, '0xFF', 255, 'ff'],
  ] as const)('round trips %s with %s', (parser, input, value, output) => {
    expect(parser.get(input)).toBe(value)
    expect(parser.set(value)).toBe(output)
    expect(parser.get(parser.set(value))).toBe(value)
  })

  it.each([
    [
      PARAM_PARSER_FLOAT,
      ['', ' ', 'NaN', 'Infinity', '12abc', '0xff', '1e999'],
    ],
    [PARAM_PARSER_INDEX, ['', '0', '-1', '1.5', '1e2', '9007199254740992']],
    [PARAM_PARSER_HEX, ['', '-ff', 'ffg', '0x', 'ffffffffffffffff']],
    [
      PARAM_PARSER_DATE,
      ['', '2024-02-30', '2023-02-29', '2024-1-01', '2024-01-01T00:00:00Z'],
    ],
    [
      PARAM_PARSER_DATETIME,
      [
        '',
        '2024-02-30T00:00:00Z',
        '2024-01-01',
        '2024-01-01T24:00:00Z',
        '2024-01-01T00:00:00',
      ],
    ],
    [PARAM_PARSER_TIMESTAMP, ['', ' ', '1.5', 'Infinity', '8640000000000001']],
  ] as const)('returns undefined for invalid %s input', (parser, inputs) => {
    for (const input of inputs) {
      expect(parser.get(input)).toBeUndefined()
      expect(parser.get([input])).toBeUndefined()
    }
    expect(parser.get(undefined)).toBeUndefined()
    expect(parser.get(null)).toBeNull()
    expect(parser.set(null)).toBeNull()
  })

  it('round trips UTC dates, ISO datetimes, and millisecond timestamps', () => {
    const date = new Date('2024-02-29T00:00:00.000Z')
    expect(PARAM_PARSER_DATE.get('2024-02-29')).toEqual(date)
    expect(PARAM_PARSER_DATE.set(date)).toBe('2024-02-29')
    const datetime = new Date('2024-02-29T12:34:56.789Z')
    expect(PARAM_PARSER_DATETIME.get('2024-02-29T14:34:56.789+02:00')).toEqual(
      datetime
    )
    expect(
      PARAM_PARSER_DATETIME.get(PARAM_PARSER_DATETIME.set(datetime))
    ).toEqual(datetime)
    expect(
      PARAM_PARSER_TIMESTAMP.get(PARAM_PARSER_TIMESTAMP.set(datetime))
    ).toEqual(datetime)
    expect(PARAM_PARSER_TIMESTAMP.get('-1')).toEqual(new Date(-1))
    expect(PARAM_PARSER_DATE.eq?.(date, new Date(date))).toBe(true)
    for (const parser of [
      PARAM_PARSER_DATE,
      PARAM_PARSER_DATETIME,
      PARAM_PARSER_TIMESTAMP,
    ]) {
      expect(parser.set(new Date(NaN))).toBeUndefined()
    }
  })

  it('handles repeated builtin values', () => {
    expect(PARAM_PARSER_FLOAT.get(['1.5', null, '2.5'])).toEqual([1.5, 2.5])
    expect(PARAM_PARSER_INDEX.set([0, 1])).toEqual(['1', '2'])
    expect(PARAM_PARSER_INDEX.set([-1])).toBeUndefined()
    expect(PARAM_PARSER_FLOAT.set(Infinity)).toBeUndefined()
    expect(PARAM_PARSER_HEX.set(-1)).toBeUndefined()
  })

  it('parses string and numeric enums without coercing unknown values', () => {
    const strings = defineEnumParser(['asc', 'desc'])
    expect(strings.get(strings.set('asc'))).toBe('asc')
    expect(strings.get('ASC')).toBeUndefined()
    expect(strings.get(null)).toBeNull()
    expect(strings.get(undefined)).toBeUndefined()
    const numbers = defineEnumParser([1, 2, 3])
    expect(numbers.get(numbers.set(2))).toBe(2)
    expect(numbers.get('02')).toBeUndefined()
    expect(numbers.get('4')).toBeUndefined()
  })

  it('round trips delimited arrays and rejects invalid items', () => {
    const parser = defineArrayParser(PARAM_PARSER_FLOAT, ';')
    expect(parser.get(parser.set([1.5, 2.5]))).toEqual([1.5, 2.5])
    expect(parser.get('')).toEqual([])
    expect(parser.set([])).toBe('')
    expect(parser.get(undefined)).toBeUndefined()
    expect(parser.get('1;bad;2')).toBeUndefined()
    expect(parser.set([Infinity])).toBeUndefined()
    expect(() => defineArrayParser(PARAM_PARSER_FLOAT, '')).toThrow(TypeError)
    const strings = defineArrayParser(defineEnumParser(['a', 'b,c']))
    expect(strings.set(['b,c'])).toBeUndefined()
  })

  it.each(['aa', 'aba', '::'])(
    'rejects self-overlapping separator %s at definition time',
    separator => {
      expect(() =>
        defineArrayParser(defineEnumParser(['a', 'b']), separator)
      ).toThrow(TypeError)
    }
  )

  it.each(['ab', '->', '😀'])(
    'round trips arrays with unbordered separator %s',
    separator => {
      const parser = defineArrayParser(defineEnumParser(['a', 'b']), separator)
      expect(parser.get(parser.set(['a', 'b']))).toEqual(['a', 'b'])
      expect(parser.get(parser.set([]))).toEqual([])
    }
  )

  it('rejects an ambiguous single empty item but keeps empty arrays', () => {
    const parser = defineArrayParser(defineEnumParser(['', 'a']))
    expect(parser.set([''])).toBeUndefined()
    expect(parser.get(parser.set([]))).toEqual([])
    expect(parser.get(parser.set(['', 'a']))).toEqual(['', 'a'])
  })

  it('rejects the whole repeated value when one item is invalid', () => {
    const repeated = new MatcherPatternQueryParam(
      'values',
      'v',
      'array',
      PARAM_PARSER_FLOAT,
      [10]
    )
    expect(repeated.match({ v: ['1.5', '2.5'] })).toEqual({
      values: [1.5, 2.5],
    })
    expect(repeated.match({ v: ['1.5', 'bad'] })).toEqual({ values: [10] })
    const delimited = new MatcherPatternQueryParam(
      'values',
      'v',
      'value',
      defineArrayParser(PARAM_PARSER_INT),
      [10]
    )
    expect(delimited.match({ v: ['1,2'] })).toEqual({ values: [1, 2] })
    expect(delimited.match({ v: ['1,bad'] })).toEqual({ values: [10] })
    expect(defineArrayParser(PARAM_PARSER_INT).get(['1', '2'])).toBeUndefined()
    const throwing = defineArrayParser(
      defineParamParser<number>({
        get: () => {
          throw new Error('invalid')
        },
        set: String,
      })
    )
    expect(throwing.get('bad')).toBeUndefined()
  })

  it('uses item equality for delimited arrays', () => {
    const item = defineParamParser({
      get: value => ({ name: value }),
      set: (value: { name: string }) => value.name,
      eq: (a, b) => a.name.toLowerCase() === b.name.toLowerCase(),
    })
    const parser = defineArrayParser(item)
    expect(parser.eq?.([{ name: 'A' }], [{ name: 'a' }])).toBe(true)
    expect(parser.eq?.([{ name: 'A' }], [])).toBe(false)
  })

  it('round trips JSON objects, arrays, primitives and null', () => {
    for (const value of [{ a: [1, true] }, [1, 2], 'text', 0, false, null]) {
      expect(PARAM_PARSER_JSON.get(PARAM_PARSER_JSON.set(value))).toEqual(value)
    }
    expect(PARAM_PARSER_JSON.get('{bad')).toBeUndefined()
    expect(PARAM_PARSER_JSON.get(undefined)).toBeUndefined()
    expect(PARAM_PARSER_JSON.set(1n)).toBeUndefined()
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(PARAM_PARSER_JSON.set(cyclic)).toBeUndefined()
    expect(PARAM_PARSER_JSON.eq?.({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it('keeps parsed hash null and applies defaults to invalid hash input', () => {
    const json = new MatcherPatternHashParam('value', PARAM_PARSER_JSON, 42)
    expect(json.match('#null')).toEqual({ value: null })
    expect(json.match('#invalid')).toEqual({ value: 42 })
    expect(json.match('')).toEqual({ value: 42 })
    const number = new MatcherPatternHashParam('value', PARAM_PARSER_FLOAT, 42)
    expect(number.match('#invalid')).toEqual({ value: 42 })
    expect(number.match('')).toEqual({ value: 42 })
  })

  it('validates JSON with a function or Standard Schema', () => {
    const parser = defineJsonParser(value =>
      typeof value === 'number' ? value : undefined
    )
    expect(parser.get(parser.set(42))).toBe(42)
    expect(parser.get('"42"')).toBeUndefined()
    const schemaParser = defineJsonParser(z.object({ count: z.number() }))
    expect(schemaParser.get(schemaParser.set({ count: 2 }))).toEqual({
      count: 2,
    })
    expect(schemaParser.get('{"count":"2"}')).toBeUndefined()
    const throwing = defineJsonParser(() => {
      throw new Error('invalid')
    })
    expect(throwing.get('{}')).toBeUndefined()
    const asyncParser = defineJsonParser(z.string().refine(async () => true))
    expect(asyncParser.get('"value"')).toBeUndefined()
  })

  it('preserves optional equality through parser helpers and normalization', () => {
    const eq = (a: number, b: number) => a === b
    const raw = defineParamParserRaw({ get: Number, set: String, eq })
    expect(raw.eq).toBe(eq)
    expect(normalizeParamParser(raw).eq).toBe(eq)
    const hash = defineHashParamParser({ get: Number, set: String, eq })
    expect(hash.eq).toBe(eq)
    const lifted = defineParamParser({ get: Number, set: String, eq })
    expect(lifted.eq?.(1, 1)).toBe(true)
    expect(lifted.eq?.([1, 2], [1, 2])).toBe(true)
    expect(lifted.eq?.([1], [2])).toBe(false)
    expect(lifted.eq?.(null, null)).toBe(true)
    expect(lifted.eq?.(null, 1)).toBe(false)
    expect(lifted.eq?.(1, [1])).toBe(false)
    expect(defineParamParser({ get: Number, set: String }).eq).toBeUndefined()
  })
})
