# Query state

::: warning Experimental
Query state requires the [experimental router](./router-resolver.md). It is not production-ready. The API can change.
:::

`useQueryParam()` and `useQueryParams()` connect parsed query params to Vue state. They use the route's existing query matchers and parsers. Do not declare a second parser or default in the composable.

## Declare the query params

For example, a file-based route can declare these query params:

```vue
<script setup lang="ts">
definePage({
  params: {
    query: {
      q: { default: '' },
      page: { parser: 'int', default: 1 },
      tags: { format: 'array', default: () => [] },
    },
  },
})
</script>
```

With a fixed resolver, use `MatcherPatternQueryParam` in the record's `query` array. The composable key is the **parsed param name**, not its URL key. A matcher with param name `page` and URL key `p` is accessed with `useQueryParam(name, 'page')`.

Generated route types identify query keys separately from path and hash keys. A binding uses the exact active route name, not its descendants. This differs from `useRoute(name)`.

## One query param

The result contains a writable computed ref named `state` and separate controls. The ref works with `v-model`:

```vue
<script setup lang="ts">
import { useQueryParam } from 'vue-router/experimental'

const {
  state: q,
  pending,
  update,
  reset,
} = useQueryParam('/search', 'q', { debounce: 250 })
</script>

<template>
  <input v-model="q" />
</template>
```

```ts
const { state: page, update, reset } = useQueryParam('/search', 'page')

page.value = 2
await update(3, { history: 'push' })
await reset()
```

- `pending` is a readonly computed ref. It stays true while the param is queued or its navigation is in progress.
- `update(value, options?)` returns that write's settlement promise. Writes committed in one batch settle with the same navigation result. Superseded writes to one key settle with the replacement that is eventually committed.
- `reset(options?)` writes the matcher's default. With no default, it writes `undefined` to remove an optional param. Resetting a required param without a default rejects the promise and leaves the URL unchanged.

### Write results

`update()`, `patch()`, and `reset()` preserve navigation outcomes. A successful write or a no-op resolves with `undefined`. An aborted or cancelled router navigation resolves with the `NavigationFailure` returned by `router.push()` or `router.replace()`. Pending edits cancelled before navigation resolve with `{ cancelled: true }`. The exported result type is `QueryStateResult = void | NavigationFailure | { readonly cancelled: true }`. Cancellation is not a parser error.

A failed navigation removes the optimistic value and restores the committed route value. Parser, validation, or navigation errors that escape the matcher reject the promise. Optional parser failures still use matcher defaults, as they do during ordinary navigation. Ref assignments cannot return promises. Their rejected writes use Vue's error handling without an unhandled promise rejection. Use `update()` to handle errors or inspect navigation outcomes. A successful redirect counts as success but can change the requested query value.

## Several query params

`useQueryParams()` returns `{ state, patch, reset, pending }`. The reactive writable `state` object contains only declared query values. Controls have a separate namespace, so query fields named `patch` or `reset` are valid.

```ts
import { toRefs } from 'vue'
import { useQueryParams } from 'vue-router/experimental'

const {
  state: query,
  patch,
  reset,
  pending,
} = useQueryParams('/search', { history: 'replace' })
const { q, page, tags } = toRefs(query)

query.page = 2
q.value = 'vue'
await patch({ page: 1, tags: ['router', 'vue'] })
await reset()

pending.value
```

`patch()` validates the whole patch before it queues any field. A rejected patch commits nothing. It preserves other query params. `reset()` resets all declared query params to their matcher defaults. Both accept per-call options. `pending` covers all queued or in-progress query-state writes for the route.

Nested arrays and plain objects are readonly. Custom class instances are outside this guarantee. In-place changes such as `query.tags.push('vue')` cannot change committed route params. Replace the top-level value to schedule a write:

```ts
query.tags = [...query.tags, 'vue']
```

## Options

Both composables accept the same options. Options on `update()`, `patch()`, and `reset()` override the composable options for that call.

| Option           | Default                          | Behavior                                                                                                   |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `history`        | `'replace'`                      | Use `'push'` to add a history entry. If any write in a committed batch requests push, the batch uses push. |
| `debounce`       | `0`                              | Wait this many milliseconds after the latest write to the same URL key. State changes immediately.         |
| `clearOnDefault` | Matcher setting, normally `true` | Omit a value equal to the default from the URL. Set false to write the default explicitly.                 |

`debounce` must be finite and non-negative. Negative values, `NaN`, and `Infinity` are rejected. An explicit `debounce: 0` removes the composable's debounce for that call.

Eligible writes in one event-loop tick share a navigation. Each key has its own debounce. An immediate page write does not wait for a delayed search edit or commit it early. A new write to the same key restarts its debounce and replaces its queued value. The latest write supplies serialization options, including `clearOnDefault`.

`patch()` schedules its supplied values as one atomic group with one deadline. Overlapping queued groups merge and use the latest required deadline. Each key retains the deadline of its latest write. Replacing all delayed keys with immediate writes makes the group eligible immediately. Unrelated groups keep their own deadlines.

Writes received during navigation wait for that navigation to settle and form a later batch. An older batch cannot clear a newer optimistic value.

Query writes use the app's normal `scrollBehavior`. To skip query-only scrolling, compare `to.path` with `from.path` in that callback. There is no query-state scroll option, throttle, or public `flush()`.

State is shared per router. Two components that bind the same route and param see the same optimistic value before the URL changes. Reads use parsed `route.params` with a shared optimistic overlay. The default structural comparison supports primitives, `NaN`, `Date`, arrays, and plain objects. Values that contain `Map`, `Set`, typed arrays, or other rich types need a parser `eq` function. Equal values keep stable computed identities.

A partial update keeps the current path, hash, and unrelated raw query keys, including declared fields that were not written. Updated fields are serialized through their route matchers, including clear-on-default behavior. Changing a default changes the meaning of old links that omit that field.

## Navigation and scope disposal

Call these composables in component setup or an active effect scope. Scope disposal makes that binding's own queued writes eligible immediately. Other bindings keep their own debounce timing. A merged atomic group still waits for its other delayed keys. A binding does not flush a replacement write owned by another binding. This flush is internal.

External navigation includes programmatic navigation and browser Back or Forward traversal. When external navigation begins, a route-name change cancels all queued edits for the old route. For the same route name, only edits to query keys changed by the navigation are cancelled. The comparison uses normalized raw values at each matcher's URL key in the committed route, not optimistic state or parser equality. External redirect targets also run this check.

Surviving edits keep their optimistic values and wait for the external navigation to settle. They then commit on top of the new route's query. Writes accepted during external navigation also wait. They survive on the same route unless a later redirect target conflicts. For example, a debounced search edit survives a sidebar link that changes `tags` but leaves the committed `q` unchanged. A link that changes `q` cancels that search edit.

Cancelled writes resolve with `{ cancelled: true }`. If a navigation conflicts with part of a queued patch, its promise resolves as cancelled, but its non-conflicting keys remain queued. If the external navigation is aborted, cancelled edits are not restored. Surviving edits commit on top of whichever route is committed. An already active query navigation settles through the normal router result or rejection.

A guard can start a child `router.push()` or `router.replace()` before its first `await`, then await that navigation. Navigation origin is scoped to the synchronous guard invocation. If a guard first awaits other work, return a redirect location afterward instead of starting and awaiting a child navigation.

`pending` describes query-state writes, not data-loader activity. Use [`useIsDataLoading()`](../data-loaders/) for the global loading state of navigation data loaders. Query-state navigation still runs guards and data loaders. There is no shallow-routing mode.

A client fetch keyed on optimistic state can run on every keystroke, even when URL writes are debounced. Debounce the returned state used by the fetch, or key the fetch on committed `route.params`.

## Server rendering

Reads use the route's parsed values and defaults during SSR. Writes without a browser window or inside Vue's SSR context are no-ops. Their promises resolve without changing the request URL, leaving pending state, or creating timers. This includes SSR with `createMemoryHistory()`. Memory history alone does not identify SSR because client applications can also use it. Create a separate router for each request.

## JSON validation

`defineJsonParser()` passes parsed JSON to its validator. Return the accepted value, including `null`, to keep it. Return `undefined` for invalid input so the query matcher's default applies.

```ts
import { defineJsonParser } from 'vue-router/experimental'

const nullableNumber = defineJsonParser(value =>
  value === null || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined
)
```

JSON parsing alone does not validate application data. For example, JSON text `1e999` parses as `Infinity`. Validate finite numbers and each required field. JSON text `null` is distinct from an absent or bare query key. See [parser edge cases](./param-parsers.md#query-value-edge-cases).

## Current limits

- Updating an inactive route is rejected. A retained binding reads its matcher defaults while inactive. Passing a parent route name while a child route is active is not supported.
- Query state requires `MatcherPatternQueryParam` matchers, including query matchers inherited from parent records. Arbitrary custom `MatcherPatternQuery` implementations are not supported.
- There is no Nuxt adapter or new macro API.
