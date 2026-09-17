# @pythia-software/query-table-core

Framework-agnostic query state, schema contracts, filtering, sorting,
aggregation, serialization, and transport/storage interfaces for query-table.

## Install

```bash
npm install @pythia-software/query-table-core
```

## Example

```ts
import {
  EMPTY_QUERY,
  loadSchema,
  normalizeQueryState,
  toServerQuery,
} from "@pythia-software/query-table-core";

const schema = loadSchema({
  name: "orders",
  idField: "id",
  fields: [
    {
      name: "id",
      label: "Order",
      type: "number",
      bindings: { postgres: { expr: "o.id" } },
    },
  ],
});

const query = normalizeQueryState({ ...EMPTY_QUERY, limit: 50 });
const request = toServerQuery(query, schema);
```

Query state is bounded whenever it crosses the library's URL, storage, or
server-projection boundaries. SQL expressions remain trusted server-side schema
configuration; request values are never SQL fragments.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for the complete schema and backend documentation.

## Computed SELECT definitions

Exports include `ComputedColumnStore`, `httpComputedColumnStore`, `memoryComputedColumnStore`, `compileFormula`, `FORMULA_FUNCTIONS`, and `formulaRuntime`. Shared source definitions are versioned separately from queries; query SELECT entries use `{ field: "@computed/<id>" }`. The React package executes the interpreter in a bounded worker. Do not run user regex on the browser main thread. See the repository’s `docs/computed-columns.md` for semantics and persistence details.
