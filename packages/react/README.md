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

## Privacy defaults

URL synchronization and durable browser storage are disabled by default. Set
`syncUrl: true` only when raw filter values are safe to place in browser
history, referrers, logs, analytics, bookmarks, and screenshots. Pass
`localStorageAdapter()` explicitly only when cleartext persistence on the device
is appropriate; sensitive applications should use an access-controlled server
`StorageAdapter`.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for transport and schema examples.
