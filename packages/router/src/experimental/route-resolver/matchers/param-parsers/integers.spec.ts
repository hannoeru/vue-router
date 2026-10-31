import { describe, expect, it } from 'vitest'
import { PARAM_PARSER_INT } from './integers'

describe('PARAM_PARSER_INT', () => {
  describe('get() - Single Values', () => {
    it('parses valid integer strings', () => {
      expect(PARAM_PARSER_INT.get('0')).toBe(0)
      expect(PARAM_PARSER_INT.get('1')).toBe(1)
      expect(PARAM_PARSER_INT.get('42')).toBe(42)
      expect(PARAM_PARSER_INT.get('-1')).toBe(-1)
      expect(PARAM_PARSER_INT.get('-999')).toBe(-999)
      expect(PARAM_PARSER_INT.get('2147483647')).toBe(2147483647)
    })

    it('parses numbers with leading/trailing whitespace', () => {
      expect(PARAM_PARSER_INT.get(' 42')).toBe(42)
      expect(PARAM_PARSER_INT.get('42 ')).toBe(42)
      expect(PARAM_PARSER_INT.get(' 42 ')).toBe(42)
    })

    it('parses whitespace strings as zero', () => {
      expect(PARAM_PARSER_INT.get(' ')).toBe(0)
      expect(PARAM_PARSER_INT.get('  ')).toBe(0)
      expect(PARAM_PARSER_INT.get('\n')).toBe(0)
      expect(PARAM_PARSER_INT.get('\t')).toBe(0)
    })

    it('parses valid scientific notation as integers', () => {
      expect(PARAM_PARSER_INT.get('1e5')).toBe(100000)
      expect(PARAM_PARSER_INT.get('1e2')).toBe(100)
      expect(PARAM_PARSER_INT.get('2.5e10')).toBe(25000000000)
      expect(PARAM_PARSER_INT.get('1.5e2')).toBe(150)
    })

    it('returns null for null values', () => {
      expect(PARAM_PARSER_INT.get(null)).toBe(null)
    })

    it.each([
      '1.5',
      '3.14159',
      '0.1',
      '-2.5',
      '1e-1',
      '1e-2',
      'abc',
      '12abc',
      'abc12',
      'true',
      'false',
      'NaN',
      'Infinity',
      '-Infinity',
      '',
    ])('returns undefined for invalid integer %j', value => {
      expect(PARAM_PARSER_INT.get(value)).toBeUndefined()
    })
  })

  describe('get() - Array Values', () => {
    it('parses arrays of valid integer strings', () => {
      expect(PARAM_PARSER_INT.get(['0', '1', '42', '-1', '-999'])).toEqual([
        0, 1, 42, -1, -999,
      ])
      expect(PARAM_PARSER_INT.get(['2147483647'])).toEqual([2147483647])
    })

    it('handles empty arrays', () => {
      expect(PARAM_PARSER_INT.get([])).toEqual([])
    })

    it.each([
      ['42', '1.5'],
      ['3.14159'],
      ['42', 'invalid'],
      ['1', '12abc'],
      ['true', 'false'],
      ['1', ''],
      ['', '2'],
    ])('returns undefined for arrays with invalid items %j', (...values) => {
      expect(PARAM_PARSER_INT.get(values)).toBeUndefined()
    })

    it('filters out null values from arrays', () => {
      expect(PARAM_PARSER_INT.get(['1', null, '3'])).toEqual([1, 3])
      expect(PARAM_PARSER_INT.get([null])).toEqual([])
      expect(PARAM_PARSER_INT.get(['42', null, null, '7'])).toEqual([42, 7])
    })
  })

  describe('set() - Single Values', () => {
    it('converts integers to strings', () => {
      expect(PARAM_PARSER_INT.set(0)).toBe('0')
      expect(PARAM_PARSER_INT.set(1)).toBe('1')
      expect(PARAM_PARSER_INT.set(42)).toBe('42')
      expect(PARAM_PARSER_INT.set(-1)).toBe('-1')
      expect(PARAM_PARSER_INT.set(-999)).toBe('-999')
      expect(PARAM_PARSER_INT.set(2147483647)).toBe('2147483647')
    })

    it('returns null for null values', () => {
      expect(PARAM_PARSER_INT.set(null)).toBe(null)
    })
  })

  describe('set() - Array Values', () => {
    it('converts arrays of integers to arrays of strings', () => {
      expect(PARAM_PARSER_INT.set([0, 1, 42, -1, -999])).toEqual([
        '0',
        '1',
        '42',
        '-1',
        '-999',
      ])
      expect(PARAM_PARSER_INT.set([2147483647])).toEqual(['2147483647'])
    })

    it('handles empty arrays', () => {
      expect(PARAM_PARSER_INT.set([])).toEqual([])
    })
  })
})
