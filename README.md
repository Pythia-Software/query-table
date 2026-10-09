# <img src="assets/brand/query-table-icon.svg" width="48" height="48" alt=""> query-table

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An opinionated, schema-driven data table for backend-filtered datasets.

`query-table` gives you a full-featured table UI — filtering, multi-sort, row
selection, saved queries, and optional shareable URL state — that stays
customizable through a declarative **field schema** and a small set of adapters.
One schema drives both the frontend (column rendering, which operators are
offered, what's sortable) and the backend (the exact SQL it's allowed to emit).
Define it once; both ends consume it.

> Naming: the package family is **`query-table`**. Use `query_table` where
> dashes are illegal (Go identifiers), and `querytable` where neither is allowed.

---

## Real-data demo

Run `npm run demo:postgres` and open [the PostgreSQL playground](http://localhost:5179/postgres)
for 500,000 records, 20 seeded metrics, the Go backend, and adjustable latency.
See [setup and loading experiments](docs/postgres-demo.md).

## Install

Choose the highest-level package you need:

```bash
# Framework-agnostic query and schema primitives
npm install @pythia-software/query-table-core

# Headless React state and orchestration
npm install @pythia-software/query-table-core @pythia-software/query-table-react react

# Complete React UI
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react react-dom
```

For the Go SQL compiler:

```bash
go get github.com/Pythia-Software/query-table/backends/go
```

For schema generation:

```bash
npm install --save-dev @pythia-software/query-table-codegen
```

For native macOS apps, add this repository as a Swift package and use
`QueryTableUI` with `QueryTableCore` (macOS 14+). The native frontend uses the
same schema and backend query contracts. Run the sample with
`swift run --package-path native/macos QueryTableDemo`. See the
[native integration guide](native/macos/README.md) for setup and compatibility
boundaries.

All npm packages are ESM-only and include bundled JavaScript, declarations,
source maps, package documentation, and the MIT license. Node.js 22 or newer is
supported by the published packages.

---

## Design decisions

1. **Standalone packages.** Consumers can use the framework-agnostic core,
   headless React hooks, or the complete UI package.
2. **Schema source of truth = JSON Schema.** Field schemas are JSON documents
   validated against `schema/query-table.schema.json`. SQL/backend details live
   in a per-backend `bindings` block, so non-Go/non-SQL backends can bind the
   same schema later. Codegen projects a document into a TS catalog and a Go schema.
3. **Multi-sort** via header menu on column headings (set/append/prepend, asc/desc), plus
   an ordered, reorderable sort list in the QueryBuilder. State is `orderBy: SortClause[]`.
4. **Private by default.** Saved queries use non-durable memory and URL sync is
   disabled unless a consumer explicitly supplies `localStorageAdapter()` or
   sets `syncUrl: true`. Query tokens are base64url-encoded, not encrypted, and
   may contain raw filter values.
5. **View state lives in the query.** Visible columns, their order, and their
   widths are part of `QueryState`, so explicitly shared URLs reproduce a view.
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
   @pythia-software/query-table-core  (TS FieldDef[])        backends/go  (Go Schema / FieldSpec)
        QueryState · encode/decode · applyQuery · adapters
              │                                          │
              ▼                                          ▼
   @pythia-software/query-table-react  (headless hooks)        Compile(WireQuery, Schema)
        useQueryTable · useSelection ·            → parameterized SQL
        useSelect · useSavedQueries               (allowlist = injection boundary)
              │
              ▼
   @pythia-software/query-table-ui  (the gold-standard components, themeable)
        DataTable · QueryBuilder · FieldPicker · CellMenu · SelectionToolbar
```

Take only what you need: drop-in `@pythia-software/query-table-ui`, or `@pythia-software/query-table-react` with
your own markup, or just `@pythia-software/query-table-core` for the wire types in another stack.

### Packages

| Package | What it is | Depends on |
|---|---|---|
| `@pythia-software/query-table-core` | Pure TS. `QueryState`, `FieldDef`, encode/decode, client-side `applyQuery`, adapter interfaces. No React, no DOM. | — |
| `@pythia-software/query-table-react` | Headless hooks that own query state, URL/storage sync, fetch orchestration, selection, columns. No markup. | core, react (peer) |
| `@pythia-software/query-table-ui` | The opinionated components. Themeable via CSS variables **or** a `classNames` slot map (Tailwind-friendly). | core, React hooks, React + React DOM (peers) |
| `backends/go` | `querytable` Go module: compiles a `WireQuery` to parameterized SQL against a schema allowlist. | — |
| `@pythia-software/query-table-codegen` | CLI and JS API that emit the TS catalog + Go schema from a JSON schema document. | core |
| `demo` | Runnable Vite playground over an in-memory dataset, for seeing UI changes live and manual testing. | core, react, ui |
| `native/macos` | Native SwiftUI/AppKit frontend, Swift query contracts, HTTP/local transports, formula runtime, and sample app. | macOS 14+ |

React is a **peer dependency `>=18 <20`**. The UI package also peers on React
DOM in the same version range.

Run the playground with `npm run demo` (serves http://localhost:5179). See
[`demo/README.md`](demo/README.md), including the headless drag-and-drop
regression check (`node demo/dnd-test.mjs`).

---

## The contracts at a glance

```ts
// what data + how to view it — reads like the SQL it compiles to
interface QueryState {
  select:  SelectColumn[];   // ordered visible columns + per-column width; [] = schema defaults
  where:   WhereTerm[];      // WHERE in conjunctive normal form: AND of terms (see below)
  orderBy: OrderByClause[];  // multi-sort, priority = array order
  limit:   number;
  offset:  number;
  aggregations?: AggregationClause[]; // optional dashboard metrics (see below); omitted = none
}
```

The WHERE clause is **conjunctive normal form**: `where` is the AND of its
terms, where each term is either a single predicate or an `{ any: [...] }` OR
group. A flat list of predicates (the common case, and the legacy shape) is all
one-predicate terms, so old `?q=` tokens and saved queries decode unchanged.

```ts
type WhereClause = { field: string; op: FilterOp; value: string; negated?: boolean };
type WhereTerm   = WhereClause | { any: WhereClause[] };
```

Any predicate can be **negated**. Ops with a complement flip to it
(`>=`→`<`, `=`→`!=`, `is_null`→`is_not_null`, `matches_regex`→`not_matches_regex`);
ops without one (`contains`/`starts_with`/`ends_with`/`includes`) carry a
`negated` flag. `negateClause(clause, allowedOps?)` returns the negation, and the
CellMenu lays candidate filters out as positive/negative pairs. NOT is
null-exclusive: a NULL value satisfies neither a predicate nor its negation.

```ts
const query: QueryState = {
  ...EMPTY_QUERY,
  where: [
    // (status = "done" OR status = "shipped") AND NOT (name contains "wip")
    { any: [
      { field: "status", op: "=", value: "done" },
      { field: "status", op: "=", value: "shipped" },
    ] },
    { field: "name", op: "contains", value: "wip", negated: true },
  ],
};
```

Sort terms can optionally extract a regex match before comparison:

```ts
const sorted: QueryState = {
  ...EMPTY_QUERY,
  where: [{ field: "name", op: "matches_regex", value: "^build-\\d+$" }],
  orderBy: [
    { field: "name", dir: "asc", extract: { regex: "build-(\\d+)" }, nulls: "last" },
  ],
};
```

Extraction returns the first capture group when the pattern has one, otherwise
the whole match. A non-match is `NULL`, so the term's normal `nulls` setting
controls its placement. Patterns are case-sensitive and use the executor's
regex dialect (JavaScript for local rows, PostgreSQL for the bundled Go
backend); use the common syntax subset when a query must run in both places.

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
reaches SQL text; values and regex patterns are always bound parameters. Every
type allows `is_null`/`is_not_null` (bool included) — any column can be NULL.

See `schema/query-table.schema.json` for the authoritative document format and
`schema/examples/runs.schema.json` for a worked schema validated against the
meta-schema and loadable by both the TypeScript and Go loaders.

---

## Metric dashboards

Metrics are saved with the query and edited in a transactional, resizable workbench. Build composed group formulas such as `SUM([x]) / NULLIF(SUM([y]), 0)`, sort the resulting groups, choose all matching rows or the displayed page, and arrange compact cards into a dashboard.

Displays include values, tables (two-group pivots and multi-group flat tables), lists, bars, lines, pie/ring charts, paired-measure scatterplots, box plots, and histograms. Names, axis labels, temporal output units/patterns, legends, list bars, and whole-rem desired/minimum card sizes are configurable. Caller-supplied palette layers keep the same typed category consistent across charts. The implementation uses native inputs, SVG, Intl, and the existing worker infrastructure, with no new runtime dependencies.

Existing simple `AggregationClause` definitions and v1 aggregation transports remain supported. Advanced remote metrics require an explicitly advertised v2 metric transport. Server-computed SELECT and global sorting use an authoritative profile/revision/capability handshake and stable-row-ID sidecars. The Go library compiles validated, parameterized PostgreSQL plans; hosts provide authorized endpoints, execution, result mapping, and snapshot consistency.

See [the production metrics guide](docs/metrics.md) for definitions, React/UI usage, scopes, formatting, palette customization, and transports, and [the PostgreSQL compiler guide](docs/backend-metrics.md) for backend integration. The [approved playground](docs/mockups/metric-playground.html) and [design notes](docs/metric-playground-design.md) preserve the original design reference. The demo starts with a varied, persistent production dashboard.

The Go module also supports SQLite row queries, Unicode/RE2 filters, JSON arrays, autocomplete, and revision-safe computed storage. Its distinct `qt-sqlite-v1` v2 profile adds composed formulas, paired metrics, shown-row scope, computed projection/sorting, exact median and box plots, shared-edge histograms, and transaction-based execution. See [the SQLite integration guide](docs/backend-sqlite.md) for registration, capabilities, numeric limits, and Pharos cutover guidance.

---

## Status

| Package | State | Verified by |
|---|---|---|
| `@pythia-software/query-table-core` | **implemented** | unit tests (`vitest`) + `tsc --noEmit` |
| `backends/go` | **implemented** | `go test` + `go vet`; loads the example doc |
| `@pythia-software/query-table-react` | **implemented** | unit tests + `tsc --noEmit` |
| `@pythia-software/query-table-ui` | **implemented** | unit tests + `tsc --noEmit` |
| `@pythia-software/query-table-codegen` | **implemented** | unit tests, CLI tarball test, and generated TS/Go output checks |

Package tarballs are checked with Publint, Are the Types Wrong, a clean consumer
install, native Node ESM imports, TypeScript NodeNext resolution, CSS export
resolution, and an installed codegen CLI invocation.

---

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and release checks,
[RELEASING.md](RELEASING.md) for the maintainer release procedure,
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. User-visible
changes are recorded in [CHANGELOG.md](CHANGELOG.md).

### Reusable computed columns

The SELECT editor supports column ordering, value-frequency browsing, and reusable browser-evaluated formulas. Definitions can be stored in your database and referenced by ID across saved queries. See the [computed columns guide](docs/computed-columns.md) for the formula language, preview behavior, persistence adapter, and optional PostgreSQL implementation.

Datetime comparisons can store signed duration operands such as `-1h` or
`+8d2h10m`. The server resolves these against its execution time and binds the
resulting timestamp using the existing operator. See [relative datetime operands](docs/relative-time.md).
