import { describe, expect, it } from 'vitest'
import { stringifyQuery } from '../query'
import { experimental_normalizeQuery, experimental_parseQuery } from './query'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import {
  MatcherPatternPathDynamic,
  MatcherPatternPathStatic,
} from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { MatcherPatternHashParam } from './route-resolver/matchers/matcher-pattern-hash'

describe('safe param dictionaries', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'round trips the query key %s',
    key => {
      const resolver = createFixedResolver([
        {
          name: 'search',
          path: new MatcherPatternPathStatic('/search'),
          query: [new MatcherPatternQueryParam(key, key, 'value')],
        },
      ])
      const initial = resolver.resolve(`/search?${key}=old`)
      expect(Object.hasOwn(initial.params, key)).toBe(true)
      expect(initial.params[key]).toBe('old')
      const updated = resolver.resolve({ params: { [key]: 'new' } }, initial)
      expect(updated.fullPath).toBe(`/search?${key}=new`)
      expect(updated.params[key]).toBe('new')
      expect(Object.keys(updated.query)).toEqual([key])
      expect(Object.getPrototypeOf(updated.query)).toBeNull()
      expect(resolver.resolve('/search').params[key]).toBeUndefined()
    }
  )

  it.each(['__proto__', 'constructor'])('round trips the path key %s', key => {
    const path = new MatcherPatternPathDynamic(
      /^\/item\/([^/]+)$/,
      { [key]: [] },
      ['item', 1]
    )
    const params = path.match('/item/value')
    expect(Object.hasOwn(params, key)).toBe(true)
    expect(params[key]).toBe('value')
    expect(Object.getPrototypeOf(params)).toBeNull()
    expect(path.build(params)).toBe('/item/value')
    expect(path.build(Object.create({ [key]: 'hidden' }))).toBe(path.build({}))
  })

  it('serializes and normalizes only own query keys', () => {
    const query = Object.assign(
      Object.create({ inherited: ['hidden'], 0: ['hidden'] }),
      {
        own: ['visible'],
      }
    )
    Object.defineProperty(query, '__proto__', {
      value: ['data'],
      enumerable: true,
    })
    expect(stringifyQuery(query)).toBe('own=visible&__proto__=data')
    const normalized = experimental_normalizeQuery(query)
    expect(Object.keys(normalized)).toEqual(['own', '__proto__'])
    expect(normalized.__proto__).toEqual(['data'])
    expect(Object.getPrototypeOf(normalized)).toBeNull()
    expect(experimental_parseQuery(stringifyQuery(query))).toEqual(normalized)
  })

  it.each(['__proto__', 'constructor', 'inherited'])(
    'ignores inherited values for %s',
    key => {
      const matcher = new MatcherPatternQueryParam(key, key, 'value')
      const inherited = Object.create({ [key]: 'hidden' })
      expect(matcher.match(inherited)[key]).toBeUndefined()
      expect(matcher.build(inherited)).toEqual({})
      expect(matcher.match({})[key]).toBeUndefined()
      expect(matcher.build({})).toEqual({})
      const hash = new MatcherPatternHashParam(key)
      expect(hash.build(inherited)).toBe('')
      expect(hash.build({})).toBe('')
      expect(hash.build(hash.match('#visible'))).toBe('#visible')
    }
  )
})
