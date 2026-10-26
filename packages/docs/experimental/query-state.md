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

The result contains a plain writable ref named `state` and separate controls. The ref works with `v-model`:

```vue
<script setup lang="ts">
import { useQueryParam } from 'vue-router/experimental'

const {
  state: q,
  pending,
  update,
  flush,
  reset,
} = useQueryParam('/search', 'q', { debounce: 250 })
</script>

<template>
  <input v-model="q" />
</template>
```

```ts
const { state: page, update, flush, reset } = useQueryParam('/search', 'page')

page.value = 2
await update(3, { history: 'push' })
await flush()
await reset()
```

- `pending` is a readonly computed ref. It stays true while the param is queued or its navigation is in progress.
- `update(value, options?)` returns the batch's settlement promise. Writes in one pending batch share this promise. The last value written to each param wins.
- `flush()` sends all queued query-state writes for this router without waiting for debounce or throttle limits.
- `reset(options?)` writes the matcher's default. With no default, it writes `undefined` to remove an optional param. Resetting a required param without a default rejects the promise and leaves the URL unchanged.

### Write results

`update()`, `patch()`, `reset()`, and `flush()` preserve navigation outcomes. A successful write or a no-op resolves with `undefined`. An aborted or cancelled router navigation resolves with the `NavigationFailure` returned by `router.push()` or `router.replace()`. Pending edits cancelled before navigation resolve with `{ cancelled: true }`. The exported result type is `QueryStateResult = void | NavigationFailure | { readonly cancelled: true }`. Cancellation is not a parser error.

A failed navigation removes the optimistic value and restores the committed route value. Parser, validation, or navigation errors that escape the matcher reject the promise. Optional parser failures still use matcher defaults, as they do during ordinary navigation. Ref assignments cannot return promises. Use `update()` to handle errors or inspect navigation outcomes.

## Several query params

`useQueryParams()` returns `{ state, patch, reset, flush, pending }`. The reactive writable `state` object contains only declared query values. Controls have a separate namespace, so a query field named `$patch` is valid.

```ts
import { toRefs } from 'vue'
import { useQueryParams } from 'vue-router/experimental'

const {
  state: query,
  patch,
  reset,
  flush,
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

Nested arrays and objects are readonly. In-place changes such as `query.tags.push('vue')` cannot change committed route params. Replace the top-level value to schedule a write:

```ts
query.tags = [...query.tags, 'vue']
```

## Options

Both composables accept the same options. Options on `update()`, `patch()`, and `reset()` override the composable options for that call.

| Option           | Default                          | Behavior                                                                                                                                                                      |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history`        | `'replace'`                      | Use `'push'` to add a history entry. If any queued write requests push, the batch uses push.                                                                                  |
| `debounce`       | `0`                              | Wait this many milliseconds after the latest write from this binding. State changes immediately.                                                                              |
| `throttle`       | `0`                              | Minimum interval in milliseconds between URL writes to this param. The first write does not wait.                                                                             |
| `scroll`         | `false`                          | False suppresses the legacy scroll callback and automatic scroll restoration for the batch. True permits the router's normal scroll policy. Any true request in a batch wins. |
| `clearOnDefault` | Matcher setting, normally `true` | Omit a value equal to the default from the URL. Set false to write the default explicitly.                                                                                    |

Wait values must be nonnegative finite numbers, or `Infinity`. Negative values and `NaN` are rejected. `Infinity` disables automatic settlement until an explicit `flush()` or cancellation.

If both debounce and throttle are set, a write waits until both limits permit it. All writes in the same tick are batched. The **highest remaining wait** wins across queued fields and bindings. An immediate page write does not pull a delayed search edit forward. It waits with the batch. Use `patch()` for an atomic multi-field edit, or `flush()` to send the pending batch explicitly.

Each binding's latest write can extend its debounce deadline, but a shorter per-call wait does not bring an existing deadline forward. The last written value is used regardless of which binding has the highest wait.

The scroll option applies only to that navigation attempt. Later ordinary navigations use their own scroll policy.

State is shared per router. Two components that bind the same route and param see the same optimistic value before the URL changes. Reads use parsed `route.params` with a shared optimistic overlay. The default structural comparison supports primitives, `NaN`, `Date`, arrays, and plain objects. Values that contain `Map`, `Set`, typed arrays, or other rich types need a parser `eq` function. Equal values keep stable computed identities.

A partial update keeps the current path, hash, other parsed params, and undeclared raw query keys. Declared query fields are serialized through their route matchers, including clear-on-default behavior. Changing a default changes the meaning of old links that omit that field.

## Navigation and scope disposal

Call these composables in component setup or an active effect scope. Scope disposal flushes queued writes. Explicit `flush()` can be awaited before disposal when completion matters.

External navigation cancels pending edits instead of flushing them, even when the destination uses the same route. This applies to programmatic navigation and native Back or Forward traversal. Cancelled edits clear their optimistic values and timer. They do not start another navigation on the old route.

A guard can start a child `router.push()` or `router.replace()` before its first `await`, then await that navigation. Navigation origin is scoped to the synchronous guard invocation. If a guard first awaits other work, return a redirect location afterward instead of starting and awaiting a child navigation. Do not await query-state `flush()` from a guard running in that same query commit.

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
