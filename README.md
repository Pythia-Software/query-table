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
3. **Multi-sort** via header menu on column headings (set/append/prepend, asc/desc), plus
   an ordered, reorderable sort list in the QueryBuilder. State is `orderBy: SortClause[]`.
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
| `demo` | Runnable Vite playground over an in-memory dataset, for seeing UI changes live and manual testing. | core, react, ui |

React is a **peer dependency `>=18`** (xlsx-collect is on 19, explo on 18).

Run the playground with `npm run demo` (serves http://localhost:5179). See
[`demo/README.md`](demo/README.md), including the headless drag-and-drop
regression check (`node demo/dnd-test.mjs`).

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
  aggregations?: AggregationClause[]; // optional dashboard metrics (see below); omitted = none
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
  group?: string; alias?: string; aliases?: string[];                          // picker UX
  render?: string | CellRenderer<Row, V>;                                      // registry key or inline fn
}

// Filter values are AUTOCOMPLETE by default — a backend distinct-value search
// refined per keystroke. `static` is a closed option list; `freeform` opts out.
// The response may optionally include `hasNull` (boolean), computed once from the
// distinct query, so the WHERE and ORDER BY chips can hide null-specific controls.
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

## Aggregation metrics (the dashboard add-on)

Optional **metrics** pin above the table: each is a single aggregate
(`count`/`count_distinct`/`sum`/`avg`/`min`/`max`) over one measure column,
broken down by zero or more group columns. They turn the query builder into a
lightweight dashboard — and because they live inside `QueryState`, a saved query
*is* a saved dashboard (URL, saved queries, and undo/redo all come for free).

```ts
interface AggregationClause {
  id: string;          // stable; survives a ?q= round-trip
  op: AggOp;           // count | count_distinct | sum | avg | min | max
  field?: string;      // measure column; omit only for count ⇒ COUNT(*)
  groupBy: string[];   // 0 ⇒ one number · 1 ⇒ bars · 2 ⇒ x/y pivot · 3+ ⇒ flat table
  label?: string;
}
```

**Scope is the whole filtered set.** A metric runs as a real server `GROUP BY`
over the *same `WHERE`* as the table, but **without** its `ORDER BY` / `LIMIT` /
`OFFSET` — so it reflects every matching row, not the visible page. It is never a
client-side reduction of the rows already on screen: the measure or group column
is often not even among the visible/selected columns, so it genuinely needs the
database.

Each metric is its own request, kept off the rows pipeline:

- **Transport** gains `fetchAggregations?(req: AggregationRequest)`. `core`
  projects the query with `toAggregationQuery` (pushdown `WHERE` subset + the
  server-capable specs). `clientRows` mode falls back to `applyAggregations`, the
  client mirror, so the demo works with no backend.
- **`backends/go`** adds `CompileAggregation(spec, schema)`, a sibling of
  `Compile` that emits the `SELECT`/`GROUP BY` fragments and reuses `Compile`'s
  `WhereSQL`. The op×type matrix (`AGG_OPS_BY_TYPE` ⇄ Go `aggOpAllowed`) and the
  field-expression allowlist are enforced on both ends, exactly like filters.

```
SELECT <group exprs…>, AVG(vr.total_ms) AS "value", COUNT(*) AS "count"
FROM <caller FROM/JOIN>
WHERE <shared WhereSQL>          -- same filter as the rows query
GROUP BY <group exprs…>          -- no ORDER BY / LIMIT / OFFSET
```

The **`MetricsPanel`** component renders the results (big number · ranked bars ·
pivot · flat table) and the **QueryBuilder** grows a `metrics` row to build them.
Per-field `aggregate: { measure?, groupable?, ops? }` config tunes what the
pickers offer (defaults are type-driven: numbers are measurable, enum/text/bool
are groupable).

> Caveat: a non-pushdown (`pushdown:false`) `WHERE` clause isn't sent to the
> server, so a DB-backed metric is computed over a superset of those rows. Such
> filters are rare; surface them in the UI if your dataset uses them.

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
