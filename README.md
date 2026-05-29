# query-table

An opinionated, schema-driven data table for backend-filtered datasets.

`query-table` gives you a "gold standard" table UI — filtering, multi-sort, row
selection, saved queries, shareable URL state — that stays customizable through
a declarative **field schema** and a small set of adapters. One schema drives
both the frontend (column rendering, which operators are offered, what's
sortable) and the backend (the exact SQL it's allowed to emit). Define it once;
both ends consume it.

It is the convergence of two sibling tables that drifted apart:
`explo`'s `xplo-perf` DataTable and `xlsx-collect`'s WorkbookTable. This package
is the union of their power-user features, extracted so it can be reused.

> Naming: the package family is **`query-table`**. Use `query_table` where
> dashes are illegal (Go identifiers), and `querytable` where neither is allowed.

---

## Design decisions (locked)

1. **Standalone repo**, published as packages. Three adopting PRs land in parallel:
   this repo (the package), `explo` (xplo-perf adopts it), `xlsx-collect` (adopts it).
2. **Schema source of truth = JSON Schema.** Field schemas are JSON documents
   validated against `schema/query-table.schema.json`. SQL/backend details live
   in a per-backend `bindings` block, so non-Go/non-SQL backends can bind the
   same schema later. Codegen projects a document into a TS catalog and a Go schema.
3. **Multi-sort** via shift-click on headers (primary → append secondary), plus an
   ordered, reorderable sort list in the QueryBuilder. State is `orderBy: SortClause[]`.
4. **Saved queries** default to `localStorage`, with an optional backend store when
   the data layer implements `StorageAdapter`. **The current view always lives in
   the URL** (`?q=` base64url), so reload / back-forward / bookmarks all work, and a
   saved query is just a serialized `QueryState` you load into the URL.
5. **View state lives in the query.** Visible columns, their order, *and their
   widths* are part of `QueryState`. One URL reproduces the same table on any
   device for any user.
6. **Package name** `query-table` / `query_table` / `querytable` as above.

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │  field schema (JSON Schema)  │   ← single source of truth
                    │  schema/*.schema.json        │
                    └──────────────┬──────────────┘
                       codegen     │     codegen
              ┌────────────────────┴────────────────────┐
              ▼                                          ▼
   @query-table/core  (TS FieldDef[])        backends/go  (Go Schema / FieldSpec)
        QueryState · encode/decode · applyQuery · adapters
              │                                          │
              ▼                                          ▼
   @query-table/react  (headless hooks)        Compile(WireQuery, Schema)
        useQueryTable · useSelection ·            → parameterized SQL
        useColumns · useSavedQueries              (allowlist = injection boundary)
              │
              ▼
   @query-table/ui  (the gold-standard components, themeable)
        DataTable · QueryBuilder · FieldPicker · CellMenu · SelectionToolbar
```

Take only what you need: drop-in `@query-table/ui`, or `@query-table/react` with
your own markup, or just `@query-table/core` for the wire types in another stack.

### Packages

| Package | What it is | Depends on |
|---|---|---|
| `@query-table/core` | Pure TS. `QueryState`, `FieldDef`, encode/decode, client-side `applyQuery`, adapter interfaces. No React, no DOM. | — |
| `@query-table/react` | Headless hooks that own query state, URL/storage sync, fetch orchestration, selection, columns. No markup. | core, react (peer) |
| `@query-table/ui` | The opinionated components. Themeable via CSS variables **or** a `classNames` slot map (Tailwind-friendly). | core, react, react (peer) |
| `backends/go` | `querytable` Go module: compiles a `WireQuery` to parameterized SQL against a schema allowlist. | — |
| `tools/schema-codegen` | Emits the TS catalog + Go schema from a JSON schema document. | core |

React is a **peer dependency `>=18`** (xlsx-collect is on 19, explo on 18).

---

## The contracts at a glance

```ts
// what data + how to view it — reads like the SQL it compiles to, all shareable via URL
interface QueryState {
  select:  SelectColumn[];   // ordered visible columns + per-column width; [] = schema defaults
  where:   WhereClause[];    // AND-combined filters
  orderBy: OrderByClause[];  // multi-sort, priority = array order
  limit:   number;
  offset:  number;
}
```

```ts
// one field. `source` says WHAT KIND it is (value origin + server capability);
// filter/sort/select are declarative capability config; `render` + the derived
// `accessor` are the only code-bearing members, kept apart from the config.
type FieldSource<Row, V> =
  | { kind: "backend"; path?: string; synthetic?: boolean }   // a column the server returns & can filter/sort
  | { kind: "derived"; accessor?: (row: Row) => V };          // computed client-side / render-only

interface FieldDef<Row = any, V = unknown> {
  name: string; label: string; type: FieldType;
  source: FieldSource<Row, V>;
  filter?: { enabled?; pushdown?; ops?: FilterOp[]; values?: FilterValues };  // pushdown = predicate pushdown
  sort?:   { enabled?; field?: string };                                       // field = server sort key if ≠ name
  select?: { enabled?; default?; width?; align? };                             // enabled:false = filter-only
  group?: string; aliases?: string[];                                          // picker UX
  render?: string | CellRenderer<Row, V>;                                      // registry key or inline fn
}

// Filter values are AUTOCOMPLETE by default — a backend distinct-value search
// refined per keystroke. `static` is a closed option list; `freeform` opts out.
type FilterValues =
  | { source: "autocomplete" } | { source: "static"; options: string[] } | { source: "freeform" };
```

The backend mirror (`backends/go`) carries `{Expr, Kind, Synthetic}` per field —
the SQL projection of the same schema row. The allowlist is the only thing that
reaches SQL text; values are always bound parameters. Every type allows
`is_null`/`is_not_null` (bool included) — any column can be NULL.

See `schema/query-table.schema.json` for the authoritative document format and
`schema/examples/runs.schema.json` for a worked schema (ported from xplo-perf,
validated against the meta-schema and loadable by both the TS and Go loaders).

---

## Status

| Package | State | Verified by |
|---|---|---|
| `@query-table/core` | **implemented** | 32 unit tests (`vitest`) + `tsc --noEmit`, all green |
| `backends/go` | **implemented** | `go test` + `go vet`, all green; loads the example doc |
| `@query-table/react` | **implemented** | `tsc --noEmit`, clean |
| `@query-table/ui` | **implemented** | `tsc --noEmit`; runtime UX verified during app adoption |
| `tools/schema-codegen` | contract only | the runtime loaders (`loadSchema` / `LoadSchema`) already make the JSON schema work end-to-end without it; codegen is the compile-time optimization |

Known follow-ups: the build emits bundler-style ESM (extensionless relative
imports) — fine for the Next.js consumers, but a `tsup`/NodeNext pass is wanted
before publishing for raw-Node ESM. Then: the three adoption PRs (explo,
xlsx-collect) and the codegen generator.
