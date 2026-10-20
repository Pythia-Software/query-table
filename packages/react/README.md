# @pythia-software/query-table-react

Headless React hooks for query-table: query state, fetching, URL/storage sync,
selection, saved queries, aggregations, and column interactions.

`usePropertyView` controls saved read-only presentations per object type;
`useObjectReferences` batches cancellable relationship lookups. See
[object property views](../../docs/object-properties.md).

## Grouped rows

`useQueryTable({ schema, clientRows })` enables one row-producing grouping stage
for complete local datasets. The standard query builder supplies GROUP BY,
HAVING, aggregate column editing and representative-row ordering. Use
`api.schema`, `api.visibleFields` and `api.rowId` for the active result shape;
set `grouping: false` to opt out. Backend transports currently reject grouped
row queries. See [grouping integration](../../docs/grouping.md) for the query
shape, source-stage controls, saved state and execution boundaries.

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

Row selection supports editable ranges. `selection.toggle(id)` toggles a row
and starts a range; `selection.toggle(id, true)` grows or shrinks it from that
fixed anchor, preserving earlier selections. If the anchor was unchecked,
the range unchecks rows instead, restoring their previous checks when shrunk.
`selection.toggle(id, true, true)` adds the span to the current selection and
commits existing checks before subsequent range adjustments. The existing
one- and two-argument calls remain supported.

Ranges use the current page's complete displayed order, including virtualized
rows outside the viewport. Changes to that order or page reset the active range
while retaining selected IDs; refreshing the same ordered IDs retains it.
Page-wide selection changes, `clear`, `replace`, and `retain` reset the range.
Shift without a valid anchor behaves like an ordinary toggle.

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

With `syncUrl: true`, oversized queries use a browser-local FIFO cache and a
temporary short URL. Configure its size/budget with `links: { cache,
maxUrlBytes }`; the default complete URL budget is 2,000 bytes. Local links
can expire through cache eviction and do not transfer with browser bookmark sync.
Configure `storage.snapshots: httpQuerySnapshotStore("/api/query-snapshots")`
for permanent Save/Share links. `api.links.create()` also supports a host's explicit
Bookmark action. Normal edits never write snapshots to the server. Missing
references fail visibly before rows/metrics execute. See the
[link integration contract](../../docs/url-state-and-saved-search-design.md).

`api.saved.update(id)` persists the current snapshot before replacing the saved
search through `storage.updateNamed`. The adapter must update atomically and
retain the saved ID and default selection; failed updates preserve the original.
Both built-in adapters support updates. For custom adapters, QueryBuilder offers
Update only when `api.saved.canUpdate` is true. Optional last/default storage read
failures fall back to table defaults; explicit broken URL links still block
execution. A single empty `?q=` is treated as an absent query.

Item-detail property views hydrate independently, but synchronize into the
collection query only after URL/saved-query restoration settles. Detail layouts
encoded in the restored query take precedence over stored property views.

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

For host-managed row windows, pass `metricTransport` to fetch metrics separately
while `clientRows` continues through local filtering, sorting, and paging.
`metricExecution` overrides the metric handshake independently of
`computedExecution`. Both default to the existing row transport/execution
selection. Computed grouping choices in `api.computed.catalogue` use the metric
transport and handshake, including definition revisions; row selection,
filtering, sorting, and value access keep their row capabilities.
Use `metricRowsReady(query)` to confirm that the external row window
matches the current query and origin before local shown-row evaluation or
previews. Remote `allMatching` metrics run while that gate is false.

A V2 transport must explicitly advertise `metricCapabilities.shownRows: true`
to execute supported shown-row clauses remotely. False or omitted uses the
committed page, provided its inputs are loaded. See the
[migration example](../../docs/metrics.md#independent-remote-metrics).

Standalone `useAggregations` calls with a complete client dataset derive the
shown page when readiness options are omitted. An explicit `rowsReady: false`
still blocks automatic shown-row evaluation and previews.
