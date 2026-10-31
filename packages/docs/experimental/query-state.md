# Query state

::: warning Experimental
Query state requires the [experimental router](./router-resolver.md). It is not production-ready. The API can change.
:::

`useQueryParam()` and `useQueryParams()` connect parsed query params to writable Vue state. They reuse the route's query matchers, parsers, and defaults. State changes immediately. URL updates are batched and rate-limited, with optional debounce per key.

Updates are shallow by default. They update browser history and the router's confirmed route without running navigation guards, route loaders, `afterEach`, or `scrollBehavior`. Both `useRoute()` and query bindings reflect the committed query. Set `shallow: false` to use normal router navigation instead. Methods wait for every key covered by the call, through shallow commit or full navigation settlement.

## Declare the query params

Enable the experimental resolver and generated route types. For example, a file-based route can declare:

```vue
<script setup lang="ts">
import { useQueryParam, useQueryParams } from 'vue-router/experimental'

definePage({
  params: {
    query: {
      q: { default: '' },
      page: { parser: 'int', format: 'value', default: 1 },
      tags: { format: 'array', default: () => [] },
    },
  },
})

const {
  state: q,
  pending,
  update,
} = useQueryParam('/search', 'q', {
  debounce: 250,
})
const { state: query, patch } = useQueryParams('/search')

function applyNow() {
  return update(q.value, { debounce: 0 })
}
</script>

<template>
  <input v-model="q" @keyup.enter="applyNow" />
  <p v-if="pending">Updating…</p>
  <p>Page {{ query.page }}</p>
  <button @click="patch({ page: 1, tags: [] })">Reset filters</button>
</template>
```

With a fixed resolver, declare `MatcherPatternQueryParam` instances in the record's `query` array. Query matchers from parent records are included. The binding key is the parsed param name, not its URL key. Fixed-resolver matchers support URL-key aliases. This API does not add alias syntax to `definePage()`.

Both composables take an exact route name. A parent name does not match an active child. Generated types exclude path and hash keys.

## State and controls

`useQueryParam(name, key, options?)` returns:

- `state`, a writable computed ref for the parsed value.
- `update(value, options?)`, which writes one parsed state value.
- `reset(options?)`, which restores the schema default.
- `clear(options?)`, which removes the URL key regardless of its default.
- `pending`, a read-only computed ref for queued and active writes to the key.

`useQueryParams(name, options?)` returns a reactive `state` object and `patch(values, options?)` instead of `update()`. Its `reset()` and `clear()` affect all declared query keys. To clear one key, use a single-key binding.

Controls are separate from state, so fields named `patch`, `reset`, or `clear` are valid query keys. Use `toRefs(state)` when individual refs are needed.

All assignments and methods accept parsed state values. Nested arrays and plain objects are read-only. Replace the whole value instead of changing it in place:

```ts
query.tags = [...query.tags, 'vue']
```

Custom class instances are outside the deep-immutability guarantee. Bindings to the same route and key share optimistic state. Serialization does not replace the supplied value with a parsed round trip. After the batch settles, state reconciles with the committed route. A lossy serializer can therefore change the displayed value at that point.

Equal parsed values retain their computed identity where the parser equality contract permits it. The default comparison supports primitives, `NaN`, `Date`, arrays, and plain objects. Rich values such as `Map` and `Set` need a parser `eq` function.

A retained inactive binding reads schema defaults. Writes through it reject without navigating.

## Options and scheduling

Call options override composable options.

| Option           | Default                          | Behavior                                           |
| ---------------- | -------------------------------- | -------------------------------------------------- |
| `shallow`        | `true`                           | Skip the navigation pipeline for query commits.    |
| `history`        | `'replace'`                      | Use `'push'` to add a history entry.               |
| `debounce`       | `0`                              | Wait after the latest write to this key.           |
| `throttle`       | Browser safety interval          | Increase the minimum interval between URL batches. |
| `clearOnDefault` | Matcher setting, normally `true` | Omit values equal to the schema default.           |

Delays must be finite and non-negative. `Infinity` is not a manual-commit mode. `debounce: 0` bypasses debounce, not the shared browser safety interval.

The safety interval follows nuqs v2.10.2. It is 50 ms normally, 120 ms for detected Safari 17 or later, and 320 ms for older Safari or detection fallback. These are library defaults, not browser guarantees. A lower `throttle` cannot bypass the interval.

The first ready batch does not wait an extra interval. Later intervals start when the previous query-state batch settles, rather than at URL dispatch as in nuqs. This prevents a slow guard followed by a fast navigation from producing adjacent history writes.

Each URL key has its own debounce. Ready keys share a throttle batch. The latest queued value wins, and superseded callers follow the replacement. The latest options replace an unfinished debounce's options. Among requests retained in a ready batch, `shallow: false` wins, push wins, and the highest throttle interval wins. A full request retained for the same ready key also keeps its full-navigation intent when a later shallow value replaces it.

A key that returns to debounce leaves the ready batch. Its previous options do not affect unrelated ready keys. Unlike nuqs's separate debounce and throttle queues, this queue retains only the latest not-yet-started value per key.

`patch()` is not a transaction. An immediate page replacement can commit while a search value from the same earlier patch remains debounced. There are no merged atomic groups.

Shallow and full batches use one serial queue. A shallow URL write queued behind an active full navigation waits for that navigation and the remaining safety interval. Its optimistic state still changes immediately. This prevents an older full navigation from overwriting a newer shallow commit. An older completion cannot remove a newer optimistic value. Each batch preserves the current path, hash, and unrelated raw query keys, including declared fields that were not written.

A true URL no-op resolves immediately when its keys have no pending work. No-op detection compares serialized URL values, not only parsed equality. Writing default page 1 removes an explicit `?page=1` when clear-on-default applies.

URL debounce does not debounce a fetch that watches optimistic state. Debounce that fetch separately or watch committed `route.params`. Shallow updates change reactive route state, so user watchers and their network requests can still run.

Shallow commits also skip the built-in `ScrollRestoration` plugin's automatic restore. Manual `scroll()` calls still work. `onRouteRendered` still runs when a shallow route update renders the view; only automatic scroll restoration opts out. Back and Forward use normal router navigation, including guards, loaders, scroll behavior, and automatic restoration. Traversal is not shallow merely because an entry came from a shallow push.

## Defaults and removal

Reading a default never writes it to the URL.

`reset()` restores the default and follows `clearOnDefault`. With `clearOnDefault: false`, it can write the default explicitly. Reset removes an optional key that has no default.

`clear()` removes the URL key even with `clearOnDefault: false`. Optimistic state becomes the matcher's value for an absent key. This includes defaults and array absence rules. Clearing or resetting a required key without a default rejects.

Omitted patch fields are unchanged. Explicit `undefined` fields are also unchanged. Use `clear()` for removal. `null` is parser data where supported, not a universal removal marker.

Before enqueueing a multi-key call, the engine serializes every supplied value. A serialization error rejects without a partial enqueue. Accepted serialized values are retained until commit, so later input mutation cannot change their URL output. URL parsing still follows the matcher's existing fallback rules. Setters do not parse a serialized round trip as validation.

## Results and errors

Methods return `Promise<QueryStateResult>`:

```ts
import { isNavigationFailure } from 'vue-router'
import type { QueryStateResult } from 'vue-router/experimental'

async function applyFilters() {
  try {
    const result: QueryStateResult = await patch({ page: 1, tags: ['vue'] })
    if (isNavigationFailure(result)) {
      // Navigation was aborted, cancelled, or duplicated.
    } else if (result && 'cancelled' in result) {
      // Queued work was dropped before navigation.
    }
  } catch (error) {
    // Handle unexpected serialization or navigation errors.
  }
}
```

`QueryStateResult` is `void | NavigationFailure | { readonly cancelled: true }`. A call waits until all covered key generations finish, including replacements. A multi-key call can span several batches.

Results use this precedence:

1. Reject for an unexpected error. If several keys throw, use the first in the call's key order.
2. Return the first `NavigationFailure` in that key order.
3. Return `{ cancelled: true }` if any covered queued work was dropped.
4. Otherwise resolve with `undefined`.

A result never arrives while covered work can still commit. Cancellation can include keys that committed in an earlier batch. It does not roll them back. A successful redirect counts as success but can change the requested query. Read the committed route when the final URL matters.

Direct assignment and `v-model` cannot return a promise. Their rejected writes use Vue's normal error handling without an unhandled rejection. Use methods when a component needs to handle errors or outcomes.

`pending` covers query-state work through shallow commit or full navigation settlement, not all data-loader activity. Use [`useIsDataLoading()`](../data-loaders/) for global loader state.

## External navigation and cleanup

An external navigation is any navigation not started by this queue. It cancels all queued work at start, including same-route links, resource changes with the same route name, and Back or Forward. Cancellation stays final if a guard blocks navigation. Pending edits never reapply over the destination.

Writes attempted during external navigation return `{ cancelled: true }` without optimistic changes. Navigation tracking starts with the router, even before the first binding exists. An older unresolved external navigation does not block writes after a newer navigation settles.

External navigation also removes active optimistic values from reads. Their methods and `pending` still wait for the active navigation's actual result or rejection. A redirect to a different location cancels newer queued work from the old location. Explicit `router.push()` or `router.replace()` inside a guard is external, both before and after an await. Returned redirects keep normal router redirect handling.

Do not await a query-state method inside a navigation guard. The method waits for navigation and can create a cycle. Return a redirect location instead. This restriction does not apply to ordinary child `router.push()` calls.

Scope disposal does not flush, shorten, or cancel accepted writes. The router owns them. Router teardown cancels queued work and clears timers.

## Parser and navigation limits

A custom serializer must accept its parsed output. Generated types exclude incompatible keys from single bindings and reject a multi-key binding if any declared query key has an incompatible input type. This checks type compatibility, not whether a serializer is a mathematical inverse.

Standard Schema transforms do not provide an inverse serializer. The router's fallback stringifies values. Use an explicit parser `set` function when stringification cannot represent the parsed value. Nuqs also defaults to `String` when no serializer is supplied. Neither API infers inverse transformations.

Only `MatcherPatternQueryParam` matchers are supported, not arbitrary aggregate query matchers. There is no public arbitrary-path shallow router operation, public `flush()`, or Nuxt adapter.

A shallow batch must resolve to the same route name and complete matched-record chain. Query-sensitive matching can select another record even when the path stays the same. Such a shallow batch rejects without changing the URL or confirmed route. Use `shallow: false` to enter another route through its navigation pipeline. This check occurs at commit time, after ready-key modes and the merged query are known. Serialization before enqueueing is not route validation.

Full batches follow ordinary navigation policy. Query-only updates do not run `beforeEnter` or force a cached loader to reload. The application's scroll policy can scroll on a full query update.

## Server rendering

Reads work during SSR. Writes without a browser window or within Vue's SSR context are no-ops. They resolve immediately without timers, pending state, or URL changes. This includes server rendering with memory history. Memory history alone does not identify SSR because client applications can also use it. Create a separate router for each server request.

## JSON validation

`defineJsonParser()` gives parsed JSON to its validator. Return the accepted value, including `null`, to keep it. Return `undefined` for invalid input so the matcher's default applies.

JSON parsing does not validate application data. For example, JSON text `1e999` parses as `Infinity`. Validate finite numbers and required fields. JSON text `null` differs from an absent or bare query key. See [parser edge cases](./param-parsers.md#query-value-edge-cases).
