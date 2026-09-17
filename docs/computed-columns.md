# Reusable computed SELECT columns

The SELECT editor combines a column catalogue, draft column ordering, value-frequency browsing, and a formula workbench. Open it through **Edit columns** in `QueryBuilder`, or mount the exported `SelectColumnEditor` yourself. Column layout is applied as one undoable query change. Saving a shared definition is a separate action and is not undone by cancelling layout changes or undoing a query.

## Persistence and identity

A query stores only an ID reference and its presentation settings:

```json
{"select":[{"field":"job_name"},{"field":"@computed/job_prefix","width":180}],"where":[],"orderBy":[],"limit":100,"offset":0}
```

`@computed/` is a reserved field-name namespace. This retains the existing SELECT, URL, saved-query, resize, and drag/drop representations. Do not use the namespace for backend schema fields. Width/order belong to a query. Label/source belong to the shared definition:

```json
{
  "id":"job_prefix",
  "label":"Job prefix",
  "revision":"3",
  "expression":{
    "language":"qt-expr",
    "version":1,
    "source":"LEFT([job_name], 3)"
  }
}
```

Source is canonical, not a saved AST. The browser parses, checks types, resolves references, and constructs an evaluation plan. Revision is an opaque store-issued optimistic concurrency token, not a pinned query revision: every query uses the latest definition available to the client. Missing or invalid definitions remain visible as error columns instead of silently disappearing.

Pass one stable `ComputedColumnStore` instance to every table that shares a catalogue:

```tsx
import { httpComputedColumnStore } from "@pythia-software/query-table-core";

// Construct outside render (or memoize). The host owns authentication/CSRF.
const computedColumnStore = httpComputedColumnStore("/api/computed-columns");
const api = useQueryTable({ schema, transport, computedColumnStore });
```

The store is independent of the existing saved-query `StorageAdapter`:

- `list(dataset, signal)` returns the complete authorized catalogue, including source definitions. IDs in queries are resolved against this catalogue before row requests are built.
- `save(dataset, column, expectedRevision)` creates when the expected revision is `null`; updates require a matching revision. A conflict must reject without overwriting.
- Optional `subscribe(dataset, listener)` invalidates mounted tables when definitions change. The provided adapters notify all tables sharing the same adapter instance after a save. Host applications can implement subscriptions with their existing event stream for immediate cross-session updates.
- Catalogues reload on window focus and through `api.computed.reload()` / the editor's Reload action. Cross-session edits are not pushed automatically by the HTTP adapter.

Without a store, the hook uses a non-durable in-memory catalogue for that mounted hook. `memoryComputedColumnStore()` can also be shared between tables. The package does not silently persist source or data in local storage. For durable production use, configure the HTTP adapter or implement the interface with your existing database API.

## Optional PostgreSQL implementation

`backends/go/computed_store.go` supplies `SQLComputedColumnStore`, `ComputedColumnsDDL`, and `NewComputedColumnsHandler`. It uses `database/sql` and PostgreSQL placeholders; the application supplies a PostgreSQL driver and connection.

1. Apply `ComputedColumnsDDL` through the application's normal migration mechanism.
2. Mount the handler at the HTTP adapter's URL.
3. Supply the required authorization callback. It must check dataset access, read/write permissions, and CSRF for cookie-authenticated writes, then return a stable tenant/user scope. The scope is never taken from a request parameter.

```go
repository := querytable.SQLComputedColumnStore{DB: db}
handler := querytable.NewComputedColumnsHandler(repository, authorizeComputedColumns)
mux.Handle("/api/computed-columns", handler)
```

The protocol is `GET /api/computed-columns?dataset=runs` → `ComputedColumn[]` and `PUT` to the same URL with `{ "column": ..., "expectedRevision": "3" }` → the updated definition. HTTP 409 indicates a revision conflict. A create sends `expectedRevision: null`. SQL creates and updates use atomic revision checks; the primary key is `(scope, dataset, id)`.

The server stores source as text. It never interprets it, compiles it to SQL, or executes it. Existing row/aggregate endpoints need no formula support. The frontend selects the required backend inputs, including hidden fields, using the existing row transport. Definition deletion is deliberately not exposed by the editor: removing a displayed column removes its query reference, preserving reusable definitions and other queries.

## Editor and preview semantics

The lazy-loaded CodeMirror editor provides highlighting, field/function completions, signature hints, inline diagnostics, and function documentation. The function browser wraps the current expression in a selected function for experimentation. Regex extraction results expose a match inspector with highlighted input and capture groups.

The row-count control accepts 1–10,000 rows. A preview starts at the first row matching the current filters in the current sort order, independently of table pagination. Server mode fetches batches of at most 500 through `Transport.fetchRows`, following offsets until the requested count or reported total is reached. Transports must honor the requested projection, sort, offset, and cancellation signal; ordinary server page-size caps are supported. Concurrent dataset mutations can change an offset-based sample; use snapshot-consistent transport requests if your application requires that guarantee.

- Formula editing groups by the complete typed tuple `(input values, output value/error)` and counts occurrences.
- Catalogue browsing groups by the output value/error alone, including computed columns, so different inputs producing the same value share one frequency row.
- Counts/percentages describe only the processed sample, not an estimate of the entire dataset. The UI labels sample versus complete filtered set, total rows, null results, errors, and unique combinations.
- Null and errors are distinct. Null/error filters and pagination over frequency groups help inspect unusual results.
- A new draft cancels obsolete fetches and terminates its worker. Preview work never updates the committed table query, pagination, or history.

Render-only schema fields can be selected but cannot be formula inputs. Developer-defined derived fields need both an accessor and explicit backend `source.dependencies`; accessors are trusted application code, evaluated before values are sent to the worker.

## Language version 1

Field references use canonical schema names in brackets: `[job_name]`. Escape a closing bracket as `]]`. Function names and keywords are case-insensitive; field names are exact. Strings are double-quoted JSON string literals. Numbers are finite IEEE-754 values. Literals include `TRUE`, `FALSE`, and `NULL`.

Supported infix operators are `+ - * / %`, `= != <> < <= > >=`, `AND OR NOT`, `IN (...)`, and `BETWEEN ... AND ...`. Arithmetic precedes comparisons, comparisons precede AND, and AND precedes OR. Parentheses override precedence. `NOT` negates a comparison; unary `+`/`-` bind more tightly than multiplication.

| Category | Functions |
| --- | --- |
| Text | LEFT, RIGHT, SUBSTRING, LENGTH, LOWER, UPPER, TRIM, LTRIM, RTRIM, REPLACE, LPAD, RPAD, SPLIT_PART, CONCAT, CONCAT_WS |
| Matching | CONTAINS, STARTS_WITH, ENDS_WITH, REGEX_TEST, REGEX_EXTRACT, REGEX_REPLACE |
| Numbers | ABS, ROUND, FLOOR, CEIL, TRUNC, POWER, SQRT, CLAMP, LEAST, GREATEST |
| Conditions | IF, IFS, SWITCH, COALESCE, NULLIF, IS_NULL, IS_EMPTY, IFERROR |
| Conversion | TO_TEXT, TO_NUMBER, TO_BOOLEAN, TO_DATETIME |
| Arrays | SPLIT, JOIN, ARRAY_LENGTH, ARRAY_CONTAINS, ARRAY_GET, ARRAY_UNIQUE, ARRAY_SORT |
| UTC dates | YEAR, MONTH, DAY, HOUR, WEEKDAY, DATE_TRUNC, DATE_ADD, DATE_DIFF, FORMAT_DATE |

The exported `FORMULA_FUNCTIONS` registry contains signatures, arity, documentation, argument types, and return types. UI help and type checking use that registry.

Rules worth knowing:

- No implicit text/number conversion. Branches must have compatible types. Null is compatible with all types.
- Ordinary operations propagate null. Comparisons with null produce null; `IS_NULL` tests it explicitly. `AND`/`OR` use three-valued logic with short-circuiting.
- `IF` chooses its then branch only when its condition is true. `IFS` requires condition/value pairs plus a final fallback. `SWITCH` requires a value, match/result pairs, and a fallback (null matches null).
- `IF`, `IFS`, `SWITCH`, `COALESCE`, and `IFERROR` evaluate lazily. Invalid conversions, division by zero, and invalid arguments produce per-cell errors. `IFERROR` catches expression errors, not worker termination/timeouts.
- `CONCAT_WS` skips null arguments. `IS_EMPTY` accepts null, empty text, or an empty array.
- Text slicing counts Unicode code points (not grapheme clusters); positions are one-based. Negative lengths/indices are errors. Out-of-range split parts/array elements are null.
- Literal text matching is case-sensitive unless its optional third argument is true.
- Regex uses native JavaScript Unicode semantics. Optional flags are `i`, `m`, and `s`; extraction group defaults to 0, the entire match. No match returns null. Replacement replaces all matches and supports `$$`, `$&`, and numbered captures. Prefix/suffix substitutions are unsupported.
- Dates use ISO date-only strings or ISO timestamps with explicit timezone. They are normalized to UTC. Date addition clamps month/year overflow to the last valid day. Weeks start Monday. `DATE_DIFF` measures elapsed whole units (week through millisecond), not calendar-boundary counts. Formatting tokens are `YYYY MM DD HH mm ss`.
- `ROUND` uses JavaScript's `Math.round` tie behavior (toward positive infinity), with -15 through 15 decimal places. This is display arithmetic, not decimal financial arithmetic.

Computed definitions may refer to other definitions as `[@computed/id]`. References are inlined into a typed plan; cycles and excessive graph expansion are rejected. Editing a referenced definition can change a dependent column's type or invalidate it; those errors remain inspectable in the dependent column.

## Execution and limits

Formulas are select-only in both local and server modes. Reserved computed IDs are stripped from WHERE, ORDER BY, and metric/group specs at query normalization, and the local executor also guards against them. Computed fields have disabled filtering, sorting, and aggregation UI capabilities.

Parsing/type checking happen in TypeScript core; evaluation runs in a dedicated browser worker. The default worker contains only the bundled interpreter implementation—formula source is data, never `eval` or `new Function`. Inputs are resolved through the field schema and serialized separately from raw rows. Computed output is rendered as text, never HTML. Raw rows are unchanged.

Budgets include 10,000 source characters, 2,000 tokens, depth 50, 5,000 runtime operations per row, 100,000 output text characters, 10,000 array elements, 2,000 regex-pattern characters, and a 16-million-character input payload per evaluated sample. Workers process 200-row chunks with a two-second watchdog per chunk and a 30-second total evaluation budget. A blocked regex is terminated by the owning thread, not an in-worker timer. These bounds report errors; they do not silently truncate computed values.

The default worker needs `worker-src blob:` under CSP. If that is not appropriate, supply `formulaWorkerFactory: () => new Worker(...)` with a host-built worker. Its message protocol is `{ ast, inputs }` in and `FormulaResult[]` out; import `formulaRuntime` from core in the worker and map it over inputs. A worker failure is surfaced explicitly; the UI never falls back to executing regex on the main thread.

## Verification

`npm run check` covers core formulas, ID serialization, store conflicts, React invalidation/dependency fetching, worker cancellation, and Go HTTP authorization/conflicts alongside the existing suites. `npm run build:demo` builds the production browser bundle.

With the demo running, `npm run test:computed` exercises catalogue counts, configurable samples, layout cancellation, regex inspection, shared edits, ID-only persistence, native regex timeout/recovery, and mobile layout in a real browser. Set `QT_BROWSER_CHANNEL=chrome` to use installed Chrome and `QT_DEMO_URL` to target a production preview.
