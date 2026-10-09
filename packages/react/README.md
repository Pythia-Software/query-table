# @pythia-software/query-table-react

Headless React hooks for query-table: query state, fetching, URL/storage sync,
selection, saved queries, aggregations, and column interactions.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react react
```

## Example

```tsx
import { useQueryTable } from "@pythia-software/query-table-react";

function Orders({ schema, rows }) {
  const table = useQueryTable({ schema, clientRows: rows });
  return <p>{table.total ?? 0} orders</p>;
}
```

`table.selection.replace(ids)` atomically makes any iterable of stable row IDs
the complete selection, including IDs outside the displayed page.
`table.selection.retain(ids)` atomically intersects the current selection with
an iterable. Both operations reset the Shift-click range anchor.

Without `transport.fetchDistinctValues`, `table.filterValues(field, search)`
uses `clientRows` for autocomplete. For `textarray` fields it suggests individual
array elements, deduplicated and matched case-insensitively by substring. Local
suggestions are capped at 50 values, with `hasMore` indicating additional matches.

## Privacy defaults

URL synchronization and durable browser storage are disabled by default. Set
`syncUrl: true` only when raw filter values are safe to place in browser
history, referrers, logs, analytics, bookmarks, and screenshots. Pass
`localStorageAdapter()` explicitly only when cleartext persistence on the device
is appropriate; sensitive applications should use an access-controlled server
`StorageAdapter`.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for transport and schema examples.

## Shared computed column definitions

Pass a stable `computedColumnStore` (for example, `httpComputedColumnStore("/api/computed-columns")` from core) to `useQueryTable`. `api.computed` exposes the catalogue, compile/preview, save with revision checking, and reload operations. Queries store only `@computed/<id>` SELECT references. Local evaluation uses browser workers. With `fetchRowsV2` and an authoritative `computedExecution` envelope, computed SELECT and global sorting run on the server and values attach through validated stable-row-ID sidecars. Without a store, definitions are in memory for the mounted hook. See the repository’s `docs/computed-columns.md` for the complete integration contract and PostgreSQL adapter.

### Canonical keys and unavailable filters

`useQueryTable` accepts two optional pure callbacks:

- `canonicalizeQuery(query)` returns a query with external aliases resolved. It must
  not throw. The returned query drives evaluation, sharing, and saved state.
- `validateQuery(query)` may throw an actionable error before row or metric execution.
  Both local and server transports honor it, including restored queries. Rejection
  clears results/totals while retaining the query so the user can repair its filters.

Memoize these callbacks and change their identity when external validation metadata
changes. Return immutable query values from the canonicalizer. No callback is required
for ordinary tables; the existing execution behavior remains the default.

For native set editors, use core's `mapSetFilterValues(query.where, (field, key) =>
canonicalKey)` inside `canonicalizeQuery` to update aliases in both the existing
predicates and their editor identity. Leave unrecognized/deleted keys unchanged
and reject them through `validateQuery` so users can repair the selected tags.

## Metric execution and drafts

`api.aggregations.preview(clauses, signal)` evaluates a draft without modifying the query. `replace(clauses, expected?)` commits the entire dashboard as one undoable change and can reject a stale editor baseline. Presentation-only changes reuse computation. Advanced remote execution uses `fetchMetrics` plus explicit v2 `metricCapabilities`; v1 transports continue to support representable simple metrics. All-matching scope requires the complete client dataset or a server metric service. Shown-row fallback uses committed inputs and reports missing dependencies.

See [the metrics integration guide](../../docs/metrics.md) for scopes, cancellation, worker-isolated regex, capability negotiation, computed revisions, and snapshot requirements.
