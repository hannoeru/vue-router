# Query state

::: warning Experimental
Query state requires the [experimental router](./router-resolver.md). It is not production-ready. The API can change.
:::

`useQueryParam()` and `useQueryParams()` connect parsed query params to Vue state. They use the route's existing query matchers and parsers. Do not declare a second parser or default in the composable.

::: warning Query-only runtime shape, broader static type
The current `RouteMap` combines path, query, and hash params. The composables use its value types, but TypeScript cannot filter it to query keys. In particular, the multi-param object's type can claim that a path param exists when it is absent at runtime. Non-query writes are rejected at runtime. See [Current limits](#current-limits).
:::

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

With a fixed resolver, use `MatcherPatternQueryParam` in the record's `query` array. The composable key is the **parsed param name**, not its URL key. For example, a matcher with param name `page` and URL key `p` is accessed with `useQueryParam(name, 'page')`.

## One query param

The result is a writable ref. Use it directly with `v-model`:

```vue
<script setup lang="ts">
import { useQueryParam } from 'vue-router/experimental'

const q = useQueryParam('/search', 'q', { debounce: 250 })
</script>

<template>
  <input v-model="q" />
</template>
```

The ref also supports tuple destructuring:

```ts
const [page, { pending, update, flush, reset }] = useQueryParam(
  '/search',
  'page'
)

page.value = 2
await update(3, { history: 'push' })
await flush()
await reset()
```

- `pending` is a readonly computed ref. It stays true while the param is queued or its navigation is in progress.
- `update(value, options?)` returns `Promise<void>`. It settles when the write's navigation settles. Several writes to the same param before a flush use the last value; all their promises settle with that navigation.
- `flush()` sends all queued query-state writes for this router without waiting for their debounce or throttle limits.
- `reset(options?)` writes the matcher's default. With no default, it writes `undefined` to remove an optional param. Resetting a required param without a default rejects the promise and leaves the URL unchanged.

A navigation that a guard aborts or cancels settles normally, as `router.push()` does. The optimistic value then returns to the committed route value. A thrown parser or navigation error rejects `update()` and removes the optimistic value. Ref assignments cannot return promises; use `update()` when you must handle errors.

## Several query params

`useQueryParams()` returns a reactive writable object. Only declared **query params** are enumerable. Path and hash params are not included.

```ts
import { toRefs } from 'vue'
import { useQueryParams } from 'vue-router/experimental'

const query = useQueryParams('/search', { history: 'replace' })
const { q, page, tags } = toRefs(query)

query.page = 2
q.value = 'vue'
await query.$patch({ page: 1, tags: ['router', 'vue'] })
await query.$reset()

query.$pending // boolean, not a ref
```

`$patch()` preserves other query params. `$reset()` resets all declared query params to their matcher defaults. Both methods return `Promise<void>` and accept per-call options. `$pending` covers all queued or in-progress query-state writes for the route. The three `$` controls are not enumerable, so `toRefs()` returns only query fields.

Replace arrays and objects to schedule a write. In-place changes such as `query.tags.push('vue')` do not schedule URL updates:

```ts
query.tags = [...query.tags, 'vue']
```

## Options

Both composables accept the same options. Options on `update()`, `reset()`, `$patch()`, or `$reset()` override the composable options for that call.

| Option           | Default                          | Behavior                                                                                                                                                                                                               |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history`        | `'replace'`                      | Use `'push'` to add a history entry. If any queued write requests push, the batch uses push.                                                                                                                           |
| `debounce`       | `0`                              | Wait this many milliseconds after the latest write to this param. State changes immediately.                                                                                                                           |
| `throttle`       | `0`                              | Minimum interval in milliseconds between URL writes to this param. The first write does not wait.                                                                                                                      |
| `scroll`         | `false`                          | False suppresses the legacy scroll callback and automatic scroll restoration for the batch. True permits the router's normal scroll policy; it does not force a particular position. Any true request in a batch wins. |
| `clearOnDefault` | Matcher setting, normally `true` | Omit a value equal to the default from the URL. Set false to write the default explicitly.                                                                                                                             |

If both debounce and throttle are set, a write waits until both limits permit it. All writes in the same tick are batched. When several params are queued, the shortest remaining wait triggers one navigation for **all** queued params. For example, an immediate page change also flushes a pending debounced search change.

If two composable calls write the same param with different wait settings, the shortest remaining wait wins. Each call's latest write resets its own debounce deadline. The last written value is used, regardless of which deadline triggers the batch.

State is shared per router. Two components that bind the same route and param see the same optimistic value before the URL changes. Reads use parsed `route.params` with a shared optimistic overlay. Arrays and objects use structural equality unless the parser supplies `eq`; equal values keep stable computed identities.

A partial update keeps the current path, hash, other parsed params, and undeclared raw query keys. Declared query fields are serialized through their route matchers, including clear-on-default behavior.

## Navigation and scope disposal

Call these composables in component setup or an active effect scope. Each call has its own effect scope. Scope disposal flushes queued writes and clears their timer. Explicit `flush()` can be awaited before disposing a scope when completion matters.

Programmatic `router.push()`, `replace()`, `go()`, `back()`, and `forward()` flush queued query state before starting the requested navigation. This prevents a delayed update from cancelling the destination navigation.

::: warning Native browser history traversal
The browser's Back or Forward button moves history before the router receives the pop event. Query state cannot safely write the previous entry at that point. Pending queued writes are **cancelled**, their promises reject with an error, and their optimistic values and timer are cleared. They are not flushed. The destination navigation is not replaced by a delayed query update. Use the router's `back()` or `forward()` method if pending writes must be flushed first.
:::

`pending` and `$pending` describe query-state writes, not data-loader activity. Use [`useIsDataLoading()`](../data-loaders/) for the global loading state of navigation data loaders. Query-state navigation still runs guards and data loaders; there is no shallow-routing mode.

## Current limits

- Use the exact active route name. Updating an inactive route is rejected. A retained composable reads its matcher defaults while that route is inactive, not params from another route. Passing a parent route name while a child route is active is not supported.
- Values and names use the same `RouteMap` types as `useRoute(name)`. The current route map does not identify whether a param came from the path, query, or hash. Thus TypeScript can offer non-query keys; the composables reject those keys at runtime. The multi-param object's static type has the same limitation, although its runtime keys are query-only.
- Query state currently requires `MatcherPatternQueryParam` matchers, including query matchers inherited from parent records. Arbitrary custom `MatcherPatternQuery` implementations are not supported.
- Nested array or object mutation is not a URL write. Assign a new value instead.
- There is no Nuxt adapter or new macro API.
