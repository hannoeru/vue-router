/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { RouterLink, createMemoryHistory } from '../index'
import { experimental_createRouter, normalizeRouteRecord } from './router'
import { createFixedResolver } from './route-resolver/resolver-fixed'
import { MatcherPatternPathStatic } from './route-resolver/matchers/matcher-pattern'
import { MatcherPatternQueryParam } from './route-resolver/matchers/matcher-pattern-query'
import { PARAM_PARSER_INT } from './route-resolver/matchers/param-parsers'

function setup(clearOnDefault = true) {
  const router = experimental_createRouter({
    history: createMemoryHistory(),
    resolver: createFixedResolver([
      normalizeRouteRecord({
        name: 'search',
        path: new MatcherPatternPathStatic('/search'),
        query: [
          new MatcherPatternQueryParam(
            'page',
            'p',
            'value',
            PARAM_PARSER_INT,
            1,
            false,
            clearOnDefault
          ),
          new MatcherPatternQueryParam('sort', 's', 'value', {}, 'asc'),
        ],
        components: {},
      }),
    ]),
  })
  return router
}

describe('query defaults and relative navigation', () => {
  it('clears defaults on push and resolve', async () => {
    const router = setup()
    await router.push({ name: 'search', params: { page: 1, sort: 'asc' } })
    expect(router.currentRoute.value.fullPath).toBe('/search')
    expect(router.currentRoute.value.params).toEqual({ page: 1, sort: 'asc' })
    expect(router.resolve({ name: 'search', params: { page: 1 } }).href).toBe(
      '/search'
    )
  })

  it('keeps defaults when clearOnDefault is false', async () => {
    const router = setup(false)
    await router.push({ name: 'search', params: { page: 1 } })
    expect(router.currentRoute.value.fullPath).toBe('/search?p=1')
  })

  it('merges relative params and clears stale owned raw query keys', async () => {
    const router = setup()
    await router.push('/search?p=4&s=desc&unknown=keep#results')
    await router.push({ params: { page: 7 } })
    expect(router.currentRoute.value.fullPath).toBe(
      '/search?unknown=keep&p=7&s=desc#results'
    )
    expect(router.currentRoute.value.params).toEqual({ page: 7, sort: 'desc' })
    await router.replace({ params: { page: 1 } })
    expect(router.currentRoute.value.query).toEqual({
      s: ['desc'],
      unknown: ['keep'],
    })
    expect(router.currentRoute.value.hash).toBe('#results')
  })

  it('keeps explicit raw query values unless an explicit param replaces them', async () => {
    const router = setup()
    expect(
      router.resolve({ name: 'search', query: { p: ['5'] } }).fullPath
    ).toBe('/search?p=5')
    await router.push('/search?p=4')
    await router.push({ query: { p: ['5'] } })
    expect(router.currentRoute.value.params.page).toBe(5)
    expect(
      router.resolve({ params: { page: 1 }, query: { p: ['5'] } }).fullPath
    ).toBe('/search')
  })

  it('does not inherit params for named locations', async () => {
    const router = setup()
    await router.push('/search?p=4&s=desc')
    await router.push({ name: 'search', params: { page: 7 } })
    expect(router.currentRoute.value.params).toEqual({ page: 7, sort: 'asc' })
  })

  it('clears defaults in RouterLink hrefs', async () => {
    const router = setup()
    await router.push('/search')
    const wrapper = mount(RouterLink, {
      props: { to: { name: 'search', params: { page: 1 } } },
      slots: { default: 'Search' },
      global: { plugins: [router] },
    })
    expect(wrapper.attributes('href')).toBe('/search')
    wrapper.unmount()
  })

  it('uses structural equality for defaults and parser equality when present', () => {
    const array = new MatcherPatternQueryParam(
      'tags',
      'tag',
      'array',
      {},
      () => ['vue']
    )
    expect(array.build({ tags: ['vue'] })).toEqual({})
    const json = new MatcherPatternQueryParam(
      'filter',
      'f',
      'value',
      {},
      () => ({ a: [1], b: 2 })
    )
    expect(json.build({ filter: { b: 2, a: [1] } })).toEqual({})
    const custom = new MatcherPatternQueryParam<number, 'page'>(
      'page',
      'p',
      'value',
      {
        eq: (a: number, b: number) => Math.floor(a) === Math.floor(b),
      },
      1
    )
    expect(custom.build({ page: 1.5 })).toEqual({})
    expect(custom.build({ page: 1.5 }, { clearOnDefault: false })).toEqual({
      p: '1.5',
    })
  })
})
