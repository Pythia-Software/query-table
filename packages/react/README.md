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

Pass a stable `computedColumnStore` (for example, `httpComputedColumnStore("/api/computed-columns")` from core) to `useQueryTable`. `api.computed` exposes the catalogue, compile/preview, save with revision checking, and reload operations. Queries store only `@computed/<id>` SELECT references; formula evaluation stays in browser workers. Without a store, definitions are in memory for the mounted hook. See the repository’s `docs/computed-columns.md` for the complete integration contract and PostgreSQL adapter.
