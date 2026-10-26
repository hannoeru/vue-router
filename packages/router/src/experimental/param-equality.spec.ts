import { describe, expect, it } from 'vitest'
import { isSameParamValue } from './param-equality'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import {
  defineArrayParser,
  defineParamParser,
  defineParamParserRaw,
  PARAM_PARSER_DATE,
  PARAM_PARSER_DATETIME,
  PARAM_PARSER_TIMESTAMP,
  PARAM_PARSER_INT,
  PARAM_PARSER_JSON,
} from './route-resolver/matchers/param-parsers'

describe('param equality', () => {
  it.each(['array', 'object'])(
    'handles deeply nested parsed JSON %s values',
    kind => {
      const depth = 50000
      const open = kind === 'array' ? '[' : '{"value":'
      const close = kind === 'array' ? ']' : '}'
      const json = open.repeat(depth) + '0' + close.repeat(depth)
      const first = PARAM_PARSER_JSON.get(json)
      const second = PARAM_PARSER_JSON.get(json)
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(isSameParamValue(first, first)).toBe(true)
      expect(isSameParamValue(first, second)).toBe(false)
      expect(PARAM_PARSER_JSON.eq?.(first, second)).toBe(false)
      expect(PARAM_PARSER_JSON.set(first)).toBeUndefined()
      const matcher = new MatcherPatternQueryParam(
        'filter',
        'f',
        'value',
        PARAM_PARSER_JSON,
        first
      )
      expect(matcher.equals(first, second)).toBe(false)
      expect(matcher.build({ filter: second })).toEqual({ f: undefined })
    }
  )

  it.each([
    [null, null, true],
    [undefined, undefined, true],
    [false, false, true],
    [false, 0, false],
    [1, 1, true],
    ['1', 1, false],
    [NaN, NaN, true],
    [NaN, 0, false],
  ])('compares primitives %s and %s', (a, b, expected) => {
    expect(isSameParamValue(a, b)).toBe(expected)
  })

  it.each([
    ['date', PARAM_PARSER_DATE],
    ['datetime', PARAM_PARSER_DATETIME],
    ['timestamp', PARAM_PARSER_TIMESTAMP],
  ] as const)('compares %s parser outputs by timestamp', (_name, parser) => {
    const input = new Date('2026-10-25T00:00:00.000Z')
    const first = parser.get(parser.set(input))
    const equal = parser.get(parser.set(new Date(input.getTime())))
    const different = parser.get(
      parser.set(new Date('2026-10-26T00:00:00.000Z'))
    )
    expect(first).toBeInstanceOf(Date)
    expect(equal).not.toBe(first)
    expect(isSameParamValue(first, equal)).toBe(true)
    expect(isSameParamValue(first, different)).toBe(false)
    expect(parser.eq?.(first, equal)).toBe(true)
    expect(parser.eq?.(first, different)).toBe(false)
    const matcher = new MatcherPatternQueryParam(
      'value',
      'v',
      'value',
      parser,
      first
    )
    expect(matcher.build({ value: equal })).toEqual({})
    expect(matcher.build({ value: different })).not.toEqual({})
  })

  it('compares parsed nested JSON without depending on property order', () => {
    const first = PARAM_PARSER_JSON.get(
      '{"filter":{"tags":["vue","router"],"active":true},"page":1}'
    )
    const equal = PARAM_PARSER_JSON.get(
      '{"page":1,"filter":{"active":true,"tags":["vue","router"]}}'
    )
    const different = PARAM_PARSER_JSON.get(
      '{"page":1,"filter":{"active":true,"tags":["router","vue"]}}'
    )
    expect(PARAM_PARSER_JSON.eq?.(first, equal)).toBe(true)
    expect(PARAM_PARSER_JSON.eq?.(first, different)).toBe(false)
    const matcher = new MatcherPatternQueryParam(
      'filter',
      'f',
      'value',
      PARAM_PARSER_JSON,
      first
    )
    expect(matcher.build({ filter: equal })).toEqual({})
    expect(matcher.build({ filter: different })).not.toEqual({})
  })

  it('compares parsed arrays by their length, order and values', () => {
    const parser = defineArrayParser(PARAM_PARSER_INT)
    expect(parser.eq?.(parser.get('1,2'), parser.get('1,2'))).toBe(true)
    expect(parser.eq?.(parser.get('1,2'), parser.get('2,1'))).toBe(false)
    expect(parser.eq?.(parser.get('1,2'), parser.get('1'))).toBe(false)
    expect(
      isSameParamValue([[1, 2], { tags: ['vue'] }], [[1, 2], { tags: ['vue'] }])
    ).toBe(true)
    expect(
      isSameParamValue([[1, 2], { tags: ['vue'] }], [[1, 3], { tags: ['vue'] }])
    ).toBe(false)
    const matcher = new MatcherPatternQueryParam(
      'ids',
      'id',
      'array',
      PARAM_PARSER_INT,
      [1, 2]
    )
    expect(matcher.build({ ids: [1, 2] })).toEqual({})
    expect(matcher.build({ ids: [2, 1] })).toEqual({ id: ['2', '1'] })
  })

  it('compares plain custom parser outputs structurally', () => {
    const parser = defineParamParser({
      get: value => ({ name: value, parts: value.split('-') }),
      set: (value: { name: string; parts: string[] }) => value.name,
    })
    const first = parser.get('vue-router')
    const equal = parser.get('vue-router')
    const different = parser.get('vue-core')
    const matcher = new MatcherPatternQueryParam(
      'value',
      'v',
      'value',
      parser,
      first
    )
    expect(matcher.equals(first, equal)).toBe(true)
    expect(matcher.equals(first, different)).toBe(false)
    expect(matcher.build({ value: equal })).toEqual({})
  })

  it('clears a NaN default from a custom numeric parser', () => {
    const parser = defineParamParser({ get: Number, set: String })
    const matcher = new MatcherPatternQueryParam(
      'number',
      'n',
      'value',
      parser,
      NaN
    )
    expect(matcher.equals(NaN, NaN)).toBe(true)
    expect(matcher.equals(NaN, 1)).toBe(false)
    expect(matcher.build({ number: parser.get('invalid') })).toEqual({})
    expect(matcher.build({ number: 1 })).toEqual({ n: '1' })
  })

  it('uses explicit equality for collection-valued custom parsers', () => {
    const parser = defineParamParserRaw<Set<string>>({
      get: value =>
        new Set(
          value == null
            ? []
            : Array.isArray(value)
              ? value.filter((item): item is string => item !== null)
              : [value]
        ),
      set: value => [...value],
      eq: (a, b) => a.size === b.size && [...a].every(value => b.has(value)),
    })
    const matcher = new MatcherPatternQueryParam(
      'tags',
      'tag',
      'array',
      parser,
      () => new Set(['vue'])
    )
    expect(matcher.equals(new Set(['vue']), new Set(['vue']))).toBe(true)
    expect(matcher.equals(new Set(['vue']), new Set(['router']))).toBe(false)
    expect(matcher.build({ tags: new Set(['vue']) })).toEqual({})
    expect(matcher.build({ tags: new Set(['router']) })).toEqual({
      tag: ['router'],
    })
  })
})
