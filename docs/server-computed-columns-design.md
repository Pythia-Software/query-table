# Server-backed computed columns

> Design reference preserved from the approved prototype. Production APIs and current integration limits are documented in [Metrics](metrics.md) and [Backend metrics](backend-metrics.md).

Status: design proposal, October 2026. Companion to the [metric playground proposal](metric-playground-design.md). No production API or execution changes are included.

## Dependency and authoring constraints after PR #92

`origin/main` at `2b28794` removes CodeMirror and adds a native textarea editor with suggestions, argument hints, paired delimiters, selection wrapping, and a searchable function library. Keep these improvements. Both the computed SELECT editor and the new metric editor reuse the first-party `FormulaEditor`, helper/catalogue/browser components with an explicit row/metric context; no CodeMirror, separate expression editor, or runtime parser package is added. Extend the existing parsers and shared semantic fixtures for server planning. The UI currently has only the existing TanStack virtualization runtime dependency beyond first-party packages and React peers; this work adds none.

Dashboard presentation (title/value/axis labels, preferred/minimum card dimensions and stable metric order) is query-local saved state. It stays outside SQL planning, execution identities and compute cache keys. Axis labels never become SQL aliases. Same reduced typed results drive compact SVG charts, pivot/table cards and the resizable dashboard canvas. Exactly two grouping keys retain an X/Y pivot; three or more retain the whole tuple within advertised resource limits. Reordering cards or resizing a canvas cannot trigger a remote scan. The current authoring UI is a wider resizable desktop dialog with four resizable panes (metric list, definition, separate field/function reference, live preview), a header view toggle and collapsed settings with summaries. Workbench geometry/section state remains local UI preference and never enters the metric wire plan. Defer mobile authoring; keep responsive dashboard rendering. Review/refine this UI before starting the row-profile compiler/backend phase.

## Recommendation

Keep one expression language and definition catalogue, and add a **server execution profile** for a deliberately small, tested subset. Compile that subset to parameterized PostgreSQL expressions. Server-capable definitions can be selected, sorted, and used as metric measures/group keys. Browser-only definitions, including regex, keep their existing select/preview behavior; they do not become globally sortable in a remote table.

This is a query-planning feature, not a new “sort this page” action. For a remote dataset the order must be:

```text
Authorized source + base filters
  → resolve and evaluate required computed fields
  → supported computed-field filters (later)
  → ORDER BY computed value + stable row identity
  → OFFSET / LIMIT
  → return values, row errors, and resolved definition revisions
```

If a low value is on row 101, sorting the first 100 downloaded rows cannot find it. Moving evaluation to a Go loop after `fetchRows` has the same flaw. SQL pushdown lets the database consider every row in scope before selecting the page. PostgreSQL supports ordering by expressions and output aliases; stable ties still require a row-identity term. [PostgreSQL ORDER BY documentation](https://www.postgresql.org/docs/current/queries-order.html).

## Existing constraints in this repository

- `ComputedColumn` in `packages/core/src/computed.ts` stores source, ID, label, and an opaque revision. Queries refer to `@computed/id`; they intentionally do not store source.
- `useComputedColumns.ts` compiles in the browser, fetches hidden dependencies, runs a worker after rows arrive, and builds derived fields with sorting/filtering/aggregation disabled.
- `normalizeQueryState` strips computed IDs from filters/sorts/metrics; `toServerQuery` strips client-only fields and requests dependencies. These guards must become capability-aware; simply enabling a picker will still lose the sort before execution.
- `backends/go/computed_store.go` stores definitions but does not parse or execute them. `Compile` in `backends/go/compile.go` can already select/sort trusted schema SQL expressions, but does not resolve reusable user-authored definitions.
- `Transport.fetchRows` returns raw rows and has no negotiated computed-value/status/revision envelope. This is a versioned transport extension, not a frontend-only adjustment.

Trusted host-defined synthetic SQL fields remain supported. User definitions must pass a separate parser, type checker, capability check, and dependency resolver before producing equivalent trusted compiler nodes. Never copy user source into `FieldSpec.Expr`.

## Start with a small profile

| Expressions | Initial decision | Why |
| --- | --- | --- |
| Typed literals, bracketed backend field references, arithmetic `+ - * /`, comparisons, boolean AND/OR/NOT | Include | Covers useful ratios, differences, scores, and conditional metrics. Arithmetic/null/error behavior still needs explicit lowering. |
| IF, NULLIF, COALESCE, IS_NULL, ABS | Include | Makes conditional aggregates and guarded arithmetic useful without broad runtime emulation. |
| Dependencies on other server-capable computed definitions | Include, with graph limits | Reuse without duplicating formulas. Capability propagates through the whole graph. |
| LOWER/UPPER, substring, dates, conversions, ROUND, `%`, POWER | Add individually after conformance fixtures | JS/SQL Unicode, locale, conversion, timezone, rounding, and overflow differ. “There is a SQL function” is not a sufficient compatibility test. |
| Regex, arrays, native accessors, render-only inputs, arbitrary SQL, volatile functions | Browser-only or unavailable | Outside this release's server profile. Existing regex behavior remains in isolated browser workers. |
| Aggregates inside a computed SELECT definition | Reject | A computed column produces one value per input row; metric context reduces rows. |

Do not auto-change formula source, language version, or numerical semantics to make it server-capable. A profile/version advertises a proven execution subset of the existing language. Preserve browser-only definitions while showing exactly which node/dependency prevents server execution. Local complete datasets can still sort computed fields in a worker, before local pagination; that separate path is exact only when every relevant row is locally available.

PostgreSQL integral division truncates; `round(numeric)` and `round(double precision)` also have different tie rules, neither a universal replacement for JS `Math.round`. Explicitly choose numeric casts and implement/test admitted functions. [PostgreSQL mathematical functions](https://www.postgresql.org/docs/current/functions-math.html).

## Compiler and planner

The authoritative backend loads only referenced definitions and their transitive dependencies from the authorized `(scope, dataset)` catalogue. It independently parses canonical source to a typed AST, validates backend schema fields, checks function capability, detects cycles, enforces expansion/source/depth budgets, and produces a typed expression plan. An AST sent by a browser may be a hint but is never executable authority.

Use one semantic vocabulary for row expressions and metric aggregate arguments; TS and Go implement independent parsers/evaluators/lowerers against shared conformance fixtures. The Go compiler should expose a planning layer rather than hide everything inside existing `Compile` fragments. Hosts need the computed dependency stages, projection aliases, error channels, bound argument ordering, row/metric scope windows, and sort plan to integrate their FROM/JOIN.

Resolve the union of SELECT, ORDER BY, and metric dependencies; a field can be sorted while hidden. Assign internal aliases by compiler node identity, never by a label or source string. Chain dependent aliases through derived-table/CTE stages: a SELECT alias generally cannot be referenced by another expression in the same SELECT list. These stages express dependency order, but are not a promise that PostgreSQL will evaluate each expression exactly once; the optimizer may inline them. Deduplicate immutable expression nodes and inspect plans before adding materialization fences.

Each potentially failing expression lowers to **value + error**. Guard division, for example, with CASE and a safe divisor, emitting a `divide_by_zero` error flag for non-null zero denominators. `x / NULLIF(y,0)` emits NULL without that error. Propagate errors through strict operators and preserve lazy IF/COALESCE behavior. Avoid an unguarded exception that aborts the entire SELECT. Finite overflow/input-range behavior must also be guarded or excluded by schema/profile bounds; do not claim arbitrary double arithmetic is total merely because division is guarded. Do not admit `%`, numeric conversions, or other additional failure paths until their lowering is tested.

For a first implementation, the value/error pair is an internal SQL plan type, not a public database function requirement. Numeric inputs use the same finite, display-arithmetic domain as the current interpreter; exact-decimal accounting remains out of scope. Text comparison uses the negotiated versioned collation. NULL and empty string remain distinct. For backend schemas that cannot guarantee eligible numeric inputs, decline the affected server capability or fail explicitly; do not pretend a permissive SQL cast matches the strict interpreter.

### Query shape

This illustrative SQL is the safe-expression happy path, not the complete error-emitting compiler:

```sql
WITH scoped AS (
  SELECT r.id, r.platform, r.useful_ms, r.total_ms
  FROM runs r
  WHERE <authorized predicates AND compiled base filters>
), evaluated AS (
  SELECT scoped.*,
    useful_ms::double precision /
      NULLIF(total_ms::double precision, 0) AS c_share
  FROM scoped
)
SELECT id, platform, c_share
FROM evaluated
ORDER BY c_share DESC NULLS LAST, id ASC
LIMIT $1 OFFSET $2;
```

LIMIT belongs after evaluation/order, not inside `scoped`. Without snapshot consistency, later OFFSET pages can shift as rows change; stable identity ties prevent ambiguous ordering but cannot prevent concurrent-data drift. Snapshot tokens/keyset pagination are optional future transport improvements, not prerequisites for a stable sort of one response.

Group metrics reuse the same `evaluated` relation **before** table pagination for allMatching, or its ordered page window for shownRows:

```text
SELECT: [@computed/share] = [useful_ms] / NULLIF([total_ms], 0)
Metric: AVG([@computed/share]) GROUP BY [platform]     // average row shares
Metric: SUM([useful_ms]) / SUM([total_ms])             // ratio of sums
```

These are intentionally different metrics. The shared compiler enables reuse; it must not rewrite one into the other. A server-capable text/date/bool result can also become a grouping key when the dataset permits it. Initial UI chooses saved server-capable computed definitions as keys; defer a second arbitrary “group expression” editor.

## Revision and consistency contract

Keep the present **latest-definition** meaning of `@computed/id` for saved queries. Avoid introducing immutable history/pinned versions just to ship sorting. Each *execution*, however, binds one coherent set of resolved revisions:

1. Client submits dataset/query and expected revisions for every referenced computed definition, including transitive dependencies. IDs can appear in sort/metric specs even if absent from SELECT.
2. Backend resolves the authorized graph in one catalogue snapshot and compares expected revisions. Missing/inaccessible/invalid fields produce explicit diagnostics; revision mismatch returns `definition_changed` before execution, never silently runs a new definition with an old client label/type.
3. Client refreshes catalogue, shows “Definition changed · results refreshed,” revalidates the query, and retries once. Persistent churn surfaces an actionable stale-definition state, not an unbounded retry loop. If a type/capability change invalidates sorting/grouping, retain the clause with a diagnostic rather than remove it.
4. Rows and metrics use one short-lived resolved-plan token or submit the same expected revision set. A plan token is actor/dataset/schema/profile-bound, expires, and does not bypass permissions. Echo resolved revisions and the plan fingerprint in every response. Catalogue consistency and data-snapshot consistency are distinct guarantees.

For in-memory browser definitions with no server catalogue, full remote execution is unavailable. Do not upload draft/source as an implicit new definition just to run a sort. Durable hosts either use the provided authorized store or supply a trusted definition resolver for their catalogue. Previewing an unsaved expression uses a dedicated authorized preview request with source validated on the server; it does not publish a definition. Shared **Save definition** remains separate from applying column layout and from query undo.

Transport-level cache keys include actor/dataset/schema revision, language/profile version, expanded definition revisions, effective filters, row sort/window, and data refresh/snapshot. Name/format/layout changes do not invalidate arithmetic. Computed value payloads must echo their plan identity so the browser never mixes new definitions with old values or overwrites server values by reevaluating them using an unrelated local revision.

## Frontend behavior and API changes

In the column editor, every definition shows **Server-backed · sortable** or **Browser-only · display on this page**, with a short reason on unsupported definitions. These describe capabilities, not a manual client/server switch. The user should not need to pick an execution engine. Saving a definition runs server plan validation to obtain capabilities/type; existing stored definitions can be analyzed lazily. Missing/old transports remain browser-only.

Remote sorting is offered only for a server-capable definition under the current dataset/profile. The header sort cycle is the same as a backend field, includes explicit null placement, and resets the page to zero. Errors always rank after valid values and nulls in both directions; the compiler adds status sorting before value/null terms, then schema identity tiebreaks. This applies even when the computed field is hidden. A browser-only sort attempt through a saved URL/programmatic query returns a visible unsupported clause; it must not silently fall back to sorting the current page.

First release: enable SELECT + ORDER BY + metric measure/grouping for admitted definitions. Leave computed-field WHERE and distinct-value suggestions disabled until the filter/count pipeline is implemented. This is an explicit product boundary. A later filter phase must apply computed predicates before total counts, page LIMIT, and all-row aggregates; calculating a predicate after paging is not correct.

Conceptual response extension:

```ts
type ComputedExecution = {
  profile: "qt-pg-row-v1";
  planToken: string;
  resolvedRevisions: Record<string, string>;
  fields: Record<string, { type: string; select: boolean; sort: boolean;
    measure: boolean; group: boolean; reason?: string }>;
};
type RowComputedValues = Record<string,
  { value: number | string | boolean | null; error?: { code: string } }>;
// fetchRowsV2 returns rows with stable row identity, computed values keyed by
// @computed/id, resolved execution metadata, and ordinary total/snapshot info.
```

Exact public shapes need a compatibility review. Keep values and error objects separate from raw row fields rather than colliding with host-owned properties; consumers can map the separate payload into computed-cell accessors. The server derives capabilities, it does not accept them as authorization from the client. Update core normalization, projection, schema capabilities, React evaluation ownership, Go decoding/planning, schema codegen, URL/storage migration, row refresh, previews, and transport docs together.

## Performance and implementation order

Start with query-time expressions. This produces correct global sorting, but a new expression may still need to evaluate/sort a large filtered set. Return ordinary pending/cancelled/error states and apply host query deadlines. Sorting a limit of 100 is not a guarantee that only 100 expressions are computed.

For frequently used stable definitions, hosts can add expression indexes or materialized/generated values after measuring plans. Those are opt-in database operations, not automatic consequences of a user saving a formula. Expression indexes can speed retrieval but add write maintenance cost. An edited definition may invalidate the usefulness of an index; parameterized literals and exact expression matching also matter. [PostgreSQL expression-index documentation](https://www.postgresql.org/docs/current/indexes-expressional.html).

Recommended order: (1) shared typed row-profile compiler and conformance fixtures; (2) authoritative catalogue resolution/revision handshake and SELECT values; (3) global ORDER BY and hidden dependency support; (4) reuse the row plan inside metrics; (5) narrowly extend text/date functions and computed predicates. Keep chart rendering independent so the modal and displays can be reviewed while backend integration progresses.

Acceptance: a lowest/highest computed value beyond the original page appears on the first sorted page; equal values have stable identity ties; hidden computed sort works; SELECT/ORDER BY use the same revision; invalid dependency/type changes are visible; zero/null/error/overflow cases match the admitted interpreter profile; latest-definition edits cancel stale requests; authorization/cycles/budgets/injection are enforced server-side; sorting a browser-only regex is rejected; local complete-dataset sorting runs before slicing; metric shown/all scope shares the correct computed relation.
