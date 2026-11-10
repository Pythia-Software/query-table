# PostgreSQL metric and computed-column execution

`backends/go` executes v3 query requests over PostgreSQL 12+ with `QueryDatasetV3{Dialect: "postgres"}`. The module is dependency-free: the host supplies the driver, connection pool, authorized source SELECT, deadlines, and any retained snapshot binding. A successful browser preview is not evidence of server support; advertise the dataset's actual `Capabilities()`.

The v1/v2 standalone compilers and their request types were removed in this release. Every row, metric, grouped-row and distinct-value request is now a `QueryRequestV3` executed by `QueryDatasetV3` (see [the SQLite guide](backend-sqlite.md) for the shared request contract).

## Integration entrypoints

- `DecodeQueryRequestV3(body)` decodes one bounded (2 MiB) request object, rejects unknown properties and stage keys other than `select`, `where`, `orderBy`, `limit` and `offset`, and requires the `now` evaluation clock.
- `QueryDatasetV3.ExecuteIn(ctx, tx, request, options)` validates the version/profile/revision/token/snapshot envelope once, then executes inside the caller's transaction. `Execute(ctx, db, request, options)` owns a REPEATABLE READ transaction and refuses requests that carry a `snapshot`.
- `NewQueryV3Handler(db, authorize)` serves POST requests: `authorize` returns the trusted dataset and `PlanOptions` (nil denies), the body is capped at 2 MiB, execution runs under a 30-second deadline, and `PlanDiagnostic` errors return 400, timeouts 504, cancellation 408 and other failures 500.
- `DescribeComputedPartialIn(ctx, tx, ids, options)` is the computed-field handshake. It returns a `ComputedDescription` whose `execution` advertises only healthy transitive graphs (field keys `@computed/id`, revision keys bare IDs) and whose `diagnostics` reports the rest, at most 64 IDs.
- `SourcePlan(ctx, request, options)` returns the narrow source projection, transitive base inputs and summary plans without reading anything except definitions.

`QueryRequestV3` carries `version: 3`, `profile`, `now`, `source` and `result` stages, optional `grouping`, `rows`, `metrics`, `expectedRevisions`, `planToken`, `snapshot`, opaque `hostState`, and optional `distinct`. `result.limit` must be 1 through `MaxRows` even for metric-only requests. `AggSpec` retains `id/op/field/groupBy` and adds `expression`, `expressionY`, `scope`, `sort`, `groupLimit`, `distribution`, `dateGrouping`, `where`, and `minCount`. Requests carry no client diagnostics (an unknown `diagnostics` key is `invalid_query`); errors are coded, see [Error codes](errors.md). Presentation properties have no SQL or fingerprint effect; `display.kind: scatter` is retained only to reject a missing second expression. Explicit `expressionY` is always paired, and explicit `distribution` selects a distribution reduction. The frontend computation projection removes inactive saved alternatives.

```go
schema, err := querytable.LoadSchema(schemaJSON)
if err != nil { return err }
// This is a host assertion about the trusted SQL binding, never a client flag.
for _, name := range []string{"id", "total_ms"} {
    f := schema.Fields[name]
    f.ExpressionNumeric = true
    schema.Fields[name] = f
}

dataset := querytable.QueryDatasetV3{
    Schema: schema, Dialect: "postgres",
    SourceSQL: `SELECT id,total_ms,platform FROM runs WHERE tenant_id=$1`,
    SourceArgs: []any{authorizedTenant},
    Scope: authorizedScope, Dataset: authorizedDataset,
}
request, err := querytable.DecodeQueryRequestV3(body) // after the host's own body cap
if err != nil { return err }

tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
if err != nil { return err }
defer tx.Rollback()
result, err := dataset.ExecuteIn(ctx, tx, request, querytable.PlanOptions{
    Identity: actorDatasetSchemaAndSnapshotIdentity,
})
if err != nil { return err }
if err = tx.Commit(); err != nil { return err }
// Encode result (QueryResultV3) as the response body.
```

Grouped requests and calendar metrics create temporary tables, so the transaction must permit TEMP DDL (do not open it `ReadOnly`). Every scratch table is dropped before a nil return.

`SourceSQL` must be a trusted authorized SELECT. Its output is aliased `r`; schema bindings must refer to that namespace, such as `r.total_ms`. Do not reuse a binding to an outer alias absent from this source. `SourceArgs` occupy `$1..$N`; planner parameters follow. User values and formula literals are bound parameters. Source SQL, schema expressions, and actor/snapshot identity must never come from unvalidated request input. Trusted bindings must themselves be exception-free and correctly typed; the planner cannot make arbitrary host SQL safe. The dataset overrides `PlanOptions.SourceSQL`, `SourceArgs`, `Now` (from the request's `now`), `ComputedGroupable` and `ComputedFilterable`.

`PlanOptions.Resolver` defaults to `SQLComputedDefinitionResolver{Tx: tx, Scope, Dataset}`, which uses the existing store table and the execution's transaction, resolving only referenced IDs. A host may instead implement `DefinitionResolver`, backed by its own authorized catalogue snapshot. Canonical source is parsed independently; client ASTs and formula SQL are never accepted. Each reached ID needs a matching `expectedRevisions[id]`, or execution fails with `definition_changed`. Cycles, missing definitions, unsupported transitive dependencies, language/version mismatches, and graph limits fail explicitly. Labels never become aliases.

A request without `grouping` reads `SourceSQL` directly: it counts the matching population (`total` and `sourceTotal`), pages rows with the row compiler when `rows` is true, and runs each metric as its own statement inside a savepoint. No population is copied and `MaxPopulation`/`MaxStagingBytes` do not apply. A grouped request first checks the narrow source projection against `MaxPopulation` and `MaxStagingBytes`, stages it in a temporary table, reduces groups, then applies HAVING, ordering, paging and metrics over the groups. Calendar metrics stage their own bounded scratch relation. A metric's clause-level failure (invalid input, budget or failed statement) is returned as that metric's `error` with empty buckets; sibling metrics and rows still return. Request diagnostics, stale revisions and cancellation fail the request. Computed values appear inline in rows as the value, or `{"computedError": "<code>"}` for a per-cell error.

## Values, errors, and the execution profile

The profile is `qt-postgres-v1` (`ServerExpressionProfile`), which PostgreSQL datasets advertise in `Capabilities().Profile`. It identifies a compiler subset, not deployed transport support:

- JSON strings, finite numeric literals, booleans, NULL, escaped bracket references (`[a]]b]`), arithmetic `+ - * /`, comparisons, boolean AND/OR/NOT.
- `IF`, `NULLIF`, `COALESCE`, `IS_NULL`, `ABS`, with strict scalar type checking.
- Text and array functions `LENGTH`, `TRIM`, `LTRIM`, `RTRIM`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH` (two arguments), `SPLIT` and `ARRAY_LENGTH`; see [Text and array functions](#text-and-array-functions). The SQLite profile also runs `REGEX_TEST`, `REGEX_EXTRACT` and `REGEX_REPLACE`.
- Metric reductions `COUNT()`, `COUNT(expr)`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`; the SQL planner additionally admits `MEDIAN` as exact continuous percentile reduction.
- Regex functions (PostgreSQL), other array formulas and array group keys, other text functions, conversions, dates/functions, `%`, power, arbitrary SQL, and nested aggregates are rejected (`unsupported_function`, `unsupported_regex` or `unsupported_type`). Raw selected text-array fields are supported and mapped as `textarray`; this does not admit array fields into expressions or metric grouping. Regex predicates and sort extraction are also rejected for PostgreSQL (`Capabilities().RegexSourceFilters` is false).

Numeric fields must explicitly set `FieldSpec.ExpressionNumeric`. The shared schema admits `bindings.postgres.expressionNumeric`; both the Go loader and schema code generator preserve this trusted binding flag. The generator also preserves `aggregate.measure`, `aggregate.ops`, and `aggregate.groupable` policy. SQL numeric bindings must hold finite display-arithmetic values. Nonzero magnitudes outside `[1e-300, 1e100]`, NaN, and infinities produce `numeric_range`; zero and NULL are supported. Numeric literals outside that domain fail compilation. This intentionally bounded profile does not claim arbitrary IEEE-double or exact accounting support.

Division emits `divide_by_zero` only for a non-null numerator and zero denominator. `x / NULLIF(y,0)` returns NULL without that error. Strict operators propagate errors. IF and COALESCE select only the logically evaluated error path; AND/OR preserve short-circuit error behavior and three-valued booleans. Physically precomputed branches are safe, so an unused division cannot abort a SQL statement. Null values remain distinct from errors and empty text.

Arithmetic uses native double operations after numeric range guards. Guard conversions pass through PostgreSQL's round-trip text representation to avoid the precision loss of a direct `double precision::numeric` cast. **Use `extra_float_digits >= 1`** (the PostgreSQL 12+ default) so those conversions preserve input precision. SUM/AVG accumulate using PostgreSQL numeric before returning double. Numeric SUM, AVG, MIN, MAX, COUNT_DISTINCT (and the backend-only MEDIAN) reject integral input samples outside ±9,007,199,254,740,991 with `unsafe_integer`, even if cancellation, averaging, an extremum, or distinct cardinality would yield a safe result. Numeric reduction outputs and final scalar/paired metric expression results use the same guard on the returned IEEE double. COUNT observes presence and permits otherwise profile-valid unsafe numeric inputs; its numeric output is still checked. NULL samples remain excluded, and text/date extrema retain their semantics. The safety threshold is a bound SQL parameter. These checks apply at metric boundaries, not inside every row-expression arithmetic operation. Failed reductions retain separate value/error columns: unused IF/COALESCE branches do not observe them, while a consumed error is never treated as an ordinary NULL. IFERROR is not part of this PostgreSQL profile. SUM also conservatively declines an absolute population sum above MAX_SAFE_INTEGER, including cancellation cases that could be safe in some row orders; this prevents claiming sequential browser intermediate-overflow equivalence. Reduction order and floating-point accumulation differ from sequential browser arithmetic: require tolerance-based numeric conformance, do not claim bit-for-bit equality or identical intermediate overflow behavior. Row-expression arithmetic fixtures cover exact integer division, branching and errors.

Text bindings are cast to text with PostgreSQL `C` collation for exact grouping/equality. Values above 100,000 UTF-8 bytes emit `text_range` (a conservative subset of the browser text-size bound). NUL and unpaired-surrogate literals are rejected rather than silently changed. Text ordering comparisons inside formulas are declined with `collation_required`. Text MIN/MAX and final group/row ordering use PostgreSQL C ordering, which agrees with the core metric engine’s ordinal Unicode code-point ordering on valid UTF-8. Hosts should still negotiate this profile rather than substitute a locale collation. Datetime bindings retain the database's typed timestamp semantics; row output is normalized to UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Do not advertise universal locale/timezone equivalence.

### Text and array functions

Both server dialects compile these row functions wherever a row expression is allowed: inside aggregates (`SUM(LENGTH([text]))`), in computed definitions (and so in computed filters, sorts and group keys the host allows), in distribution inputs and in grouped formula summaries. Outside an aggregate they apply to the reduced value (`LENGTH(MAX([text]))`). The result is the browser formula runtime's, checked by the shared fixtures [`schema/fixtures/text-functions.json`](../schema/fixtures/text-functions.json) (local engine, DuckDB, Go SQLite and Go PostgreSQL) and [`schema/fixtures/formula-regex.json`](../schema/fixtures/formula-regex.json):

| Function | Server semantics |
| --- | --- |
| `LENGTH(text)` | Unicode code points (`Array.from(text).length`): an emoji with a skin-tone modifier is 2, `e` plus a combining accent is 2, CJK characters are 1 each. Embedded NUL counts. |
| `TRIM`, `LTRIM`, `RTRIM` | Remove the ECMAScript white space and line terminator set, exactly what `String.prototype.trim` removes: tab, LF, VT, FF, CR, space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. U+0085 and U+180E are kept. |
| `CONTAINS`, `STARTS_WITH`, `ENDS_WITH` | Exact, case-sensitive code point comparison with no normalization; an empty search text matches. The optional `ignoreCase` argument is refused with `unsupported_function`: JavaScript's case mapping is context-sensitive and Unicode-version dependent, and neither database reproduces it. |
| `SPLIT(text, separator)` | The parts of `text.split(separator)`: non-overlapping separators left to right, empty parts kept, `""` gives one empty part, and an empty separator splits UTF-16 code units (`SPLIT("😀", "")` has 2). More than 10,000 parts is the per-row error `array_range` (the browser's "Array result is too large"). |
| `ARRAY_LENGTH(array)` | The number of parts. A text array exists only as `ARRAY_LENGTH(SPLIT(...))`; any other use of one (a result, a branch of `IF`, `COUNT(SPLIT(...))`, `JOIN`, `ARRAY_GET`, a text-array field) is `unsupported_type`. |

NULL arguments return NULL, and a missing text stays distinct from an empty one: `LENGTH("")` is 0, and `ARRAY_LENGTH(SPLIT(TRIM([text]), " "))` is 1 for an empty text but NULL for a missing one. A word count that treats empty text as no words is `IF(TRIM([text]) = "", 0, ARRAY_LENGTH(SPLIT(TRIM([text]), " ")))`. Argument errors propagate as for other strict operators.

SQLite uses native `length`, `trim`/`ltrim`/`rtrim` with the explicit character set and `instr`; NUL-containing text, `SPLIT` counts and the regex functions use the registered `qt_v2_*` descriptors from `SQLiteV2Functions()`, which receive text as BLOBs so a driver cannot cut it at a NUL. PostgreSQL uses `char_length`, `btrim`/`ltrim`/`rtrim` with the same set, `strpos`, `right` and `replace`; the empty-separator count adds one for each supplementary code point.

**Regex functions (SQLite only).** `REGEX_TEST`, `REGEX_EXTRACT` and `REGEX_REPLACE` follow the browser's JavaScript `RegExp` with the `u` flag. The pattern and flags must be text literals. The server translates a validated subset to Go RE2: `.` excludes `\n`, `\r`, U+2028 and U+2029 unless `s` is set, and `\s`/`\S` use the TRIM set above. Patterns whose meaning would differ are refused with `unsupported_regex` rather than approximated:

- lookahead, lookbehind, backreferences, named groups, `\p{...}` and lone surrogate escapes;
- repetition counts above 1,000 (an RE2 limit);
- a quantifier over a subpattern that can match empty text, such as `(?:a*)+` (JavaScript rejects empty iterations; RE2 does not);
- the `m` flag with `^` or `$` (JavaScript also breaks lines at `\r`, U+2028 and U+2029); `m` without anchors has no effect and is accepted;
- with the `i` flag, a non-ASCII literal or range (case folding follows each engine's Unicode version) and `\b`/`\B` (JavaScript's `u`+`i` word set adds U+017F and U+212A);
- for `REGEX_EXTRACT` and `REGEX_REPLACE`, a capture group inside a repeated quantifier, such as `(?:(a)|b)+` (JavaScript clears it on each iteration);
- for `REGEX_REPLACE`, a pattern that can match empty text, such as `a*` (JavaScript keeps an empty match right after a match; RE2 drops it).

Invalid JavaScript patterns and flags are refused too. `REGEX_REPLACE` supports `$$`, `$&` and `$1`–`$99` like the browser; `` $` ``, `$'` and a capture number the pattern does not have are the per-row error `regex_replacement` (raised only where a match occurs). A replacement result above 100,000 UTF-16 code units is `text_range`. A `REGEX_EXTRACT` group that is not an integer from 0 to 100 is `argument_range`. As in the browser, regex is allowed only inside aggregate row expressions. PostgreSQL's regex dialect differs from JavaScript's, so the PostgreSQL profile refuses all three functions with `unsupported_regex`.

The browser client still refuses regex in all-matching metrics and grouped columns it composes (it evaluates regex locally only in an isolated worker), and `Capabilities().RegexAggregateExpressions` stays false, so shown-row regex metrics keep running in that worker. The server functions serve host-defined requests, such as server-side scatter definitions, and computed definitions whose patterns fit the subset.

`FieldSpec.AggregateOps` is an allowlist: nil uses type defaults, an empty list disables measures. `aggregate.measure:false` loads as an empty list. Explicit operation restrictions propagate through computed dependencies and conditional row-expression inputs. Distributions require measurable inputs; they do not invent box/histogram names in the scalar-op allowlist. `aggregate.groupable` is honored; the default is text/enum/bool grouping, requiring explicit opt-in for numeric/datetime backend keys. Resolver access controls computed definitions. Computed grouping additionally requires a true entry in the trusted `QueryDatasetV3.ComputedGroupable` ID allowlist, so a definition cannot silently bypass the dataset’s grouping policy.

## Stages, scopes, and result mapping

`SourcePlan` returns a `SourceDependencyPlan` embedding the source `SQLPlan`, which exposes `SQL`, ordered `Args`, inspectable `Stages`, `Dependencies`, `ResolvedRevisions`, `Profile`, `Fingerprint`, `Scope`, and `RequiresSnapshot`. Generated aliases use compiler counters. Equivalent row and aggregate nodes are deduplicated using canonical structural hashes. `SQLPlan.String()` deliberately omits SQL and bound values. Structured `PlanDiagnostic` errors expose code/message/field and an optional byte offset; compiler errors may be wrapped with metric context and support `errors.As`.

Expression/reduction CTEs are materialized deliberately to keep repeated safe value/error expressions from expanding exponentially during PostgreSQL planning. The initial authorized projection stays inlineable so base predicates can push down. This is an execution cost tradeoff: many formula nodes mean many stages and additional intermediate storage. Inspect EXPLAIN under realistic cardinality and enforce timeout/memory limits. This implementation favors bounded, inspectable execution over optimistic optimizer inlining.

Rows execute authorized source → base filters → computed dependency stages → ORDER BY plus stable ID → LIMIT/OFFSET. Hidden computed sorts work. NULL-only computed keys use typed projected aliases for row sorting and metric grouping, preserving stable-ID ties and NULL group keys. Numeric sort errors have NULL values and follow explicit null placement. Alternate `SortExpr` bindings must be expressed as explicit schema sort fields; unsupported alternatives fail instead of changing order. Source rows must have unique, non-NULL stable identities after joins. PostgreSQL
row planning derives the reachable bindings, including transitive computed
references and hidden filter/sort dependencies, and omits unrelated schema
expressions. Bindings needed only by SELECT are projected after the window.
The bounded page rejoins the same authorized source CTE by raw identity inside
one statement snapshot; text identity comparisons use C collation. This may
read the source twice when PostgreSQL inlines the CTE, but costly SELECT-only
schema bindings run only for page rows. Source SQL that already performs costly
work remains a host concern. Computed sort dependencies still evaluate globally;
NULL placement, stable ties, selected value/error guards, revisions, and the
fingerprint of the full requested computation remain applicable.

`allMatching` metrics reduce the entire filtered relation without the table page limit. `shownRows` uses the same globally ordered window; it requires a positive limit. Virtualization and selection never define scope. Group/result limits happen only after final expressions or statistical reductions. The compiler never silently changes scope or samples data.

PostgreSQL `shownRows` metrics use the same narrow identity window as row SELECT: filter and global sort dependencies run before LIMIT/OFFSET, then the page rejoins the authorized source before projecting measure and grouping bindings. This covers scalar, paired, grouped, box, and histogram plans. Stable unique identities and exception-free trusted bindings remain required.

Stage pass-through columns are selected from downstream liveness before adding the current expression's input references for the preceding relation. Inputs used only by a numeric guard therefore stop at that guard; materialization, guards, lazy branch diagnostics, and ordering are preserved.

Each `AggSpec` produces one `MetricResult` in request order: `id`, `buckets`, `scope`, `processedRows`, `groupCount` (groups kept by `minCount`, before the result limit), `coverage`, optional `error` and, with `minCount`, `hiddenGroups`. A `MetricBucket` carries the full typed `keys` tuple (including NULL and empty strings), `value`/`error`, paired `y`/`yError`, `count` (total scoped rows in the group), and for distributions `distribution`, `nullCount` and `inputErrorCount`.

A group error nulls its scalar output. X/Y errors remain independent. Errors sort after valid groups, then requested value/Y/count/sample/key terms apply; the default is value descending, and complete group tuples break ties. NULL placement is independent of direction. No-group empty input produces one COUNT=0 or nullable scalar/empty-distribution bucket; grouped empty input produces no buckets.

Box results contain `{kind:"box",summary}`. Summary is null for zero numeric samples. Distribution samples are explicitly projected as double precision, including `NULL` and `COALESCE(NULL,NULL)` inputs; these count as excluded NULLs without errors. Exact quartiles use the complete non-NULL sorted double population, method `exact-linear`: zero-based position `(n-1)*p`, `lower=floor(position)`, `fraction=position-lower`, then `(1-fraction)*a+fraction*b`, with the upper sample index clamped to `n-1`. All operations use IEEE double arithmetic in the same order as TypeScript. PostgreSQL `percentile_cont` uses a different interpolation order and must not substitute for these box quartiles. Fence comparisons are exact, without an epsilon: even a one-ULP quartile difference can change outlier membership. Min/max or Tukey whiskers use actual observed endpoints. Tukey outputs exact outlier count and at most 20 values, keeping ten from each tail without duplicating rows. Numeric distribution samples use the same unsafe-integer boundary as metric reductions. Invalid samples carry errors and are excluded from the sample count; they do not increase `nullCount`. A group input error suppresses that group's summary. Interpolated quartiles and the mean are checked before returning the summary; observed endpoints, whiskers, and outliers inherit sample validation.

Histograms support zero or one grouping key and 2–30 equal-width bins (default ten). Global extent comes from all scoped values before group ranking/limits. Groups share one edge array; counts include zero bins. Edges use the browser’s double arithmetic order, `min + (max - min) * (i / bins)`, with endpoints pinned to the observed minimum and maximum. Bucket counts at floating boundaries must agree exactly; numeric tolerances do not excuse shifted counts. Lower edges are inclusive, upper edges exclusive except the final maximum. Constants produce `[value,value]` and one count; empty inputs produce empty edges/counts. Unsafe integral edges produce `unsafe_integer`; collapsed floating-point edges produce `histogram_precision`. Any input error invalidates every histogram group because the global extent is unknowable; never present the remaining counts as complete.

## Metric filters and minimum group size

`AggSpec.Where` is the metric's own predicate (`where` on the wire), using the
same CNF terms, field allowlist, operator/type rules and reference clock as the
table WHERE. It is compiled as a separate filter stage after the table WHERE for
`allMatching`, and after the identity window for `shownRows`, so it narrows the
selected page instead of choosing a different one. Regex predicates fail with
`unsupported_regex`; computed predicates keep the `ComputedFilterable` policy.
`WireQuery.Validate` bounds it to 100 predicates with the usual field-name and
value sizes. The predicate is part of the plan SQL, arguments and fingerprint,
so SQLite reduction reuse and fusion (which key on the stage prefix) and
fingerprint-based result reuse never share results across different filters.

`AggSpec.MinCount` (1–1,000,000; zero means unset) removes reduced groups whose
`count` is below the threshold before ordering and `LIMIT`. It requires at least
one group key (`min_count_grouping`). The final statement LEFT JOINs the kept,
ranked groups to a one-row `hidden_groups` count:

```sql
SELECT k.*, h.hidden_groups
FROM (SELECT COUNT(*) AS hidden_groups FROM groups WHERE count < $n) AS h
LEFT JOIN kept AS k ON 1=1
ORDER BY ... LIMIT ...
```

Every row carries `hidden_groups`. When every group is hidden (or there are
none), the statement returns exactly one row whose `count` is NULL and the
executor emits no bucket. `groupCount` counts only kept groups, while kept plus
hidden groups are checked against `MaxGroups`. Calendar metrics in
`QueryDatasetV3` apply `MinCount` in Go after empty buckets are filled; filled
buckets (count 0) are never hidden or counted, and hidden observed buckets are
not refilled. Hidden groups are not part of any additive Other remainder an
adapter derives.

`QueryDatasetV3` (both dialects) implements both controls and sets `hiddenGroups` on the metric result; `QueryCapabilitiesV3` advertises `metricFilters`/`metricMinCount`/`metricMinCountMeasures`. The frontend refuses those clauses individually when a host does not advertise them.
`AggSpec.MinCount` is a `MetricMinCount` (`Min`, plus `Distinct` or `Sum`), read
from and written as either a number or `{"min":5,"distinct":"conversation_id"}`.

## Required service behavior and limits

A metric's stages are one statement and see one PostgreSQL statement snapshot; the row page, count and every metric of a request run in the execution's REPEATABLE READ transaction. Catalogue consistency and data consistency are distinct. A nonempty requested `snapshot` requires `PlanOptions.ValidateSnapshot`, whose callback must verify access/expiry and bind the active transaction to that snapshot; only `ExecuteIn` can use a genuinely retained host transaction. A nonempty `planToken` requires `PlanOptions.ValidatePlanToken`, which must verify actor, dataset, profile, snapshot and expiry. Both are rejected when no host validation is provided. The result's `execution` echoes the resolved revisions and plan identity; bind any reusable plan token to actor/dataset/schema/profile/snapshot and expiry. A fingerprint is not an authorization token. Refresh/retry once on `definition_changed`, then surface persistent churn.

The request's `now` is the single reference clock for every relative filter in the execution.

Compiler limits include 10,000 source bytes, 2,000 tokens, 512 AST nodes per expression, nesting depth 50, 64 resolved definitions, dependency depth 32, 2,048 expanded row nodes, approximately 500 SQL stages, and 512 schema bindings. Request limits retain 20 metrics, 20 grouping keys, and 20 result sort terms; group limit is at most 10,000. Group limits do not bound scanned rows or total groups.

Executor budgets default to 10,000 page rows (`MaxRows`), 2,000 groups per metric or grouping (`MaxGroups`, explicitly 1–100,000), 250,000 staged source rows (`MaxPopulation`), 64 MiB of staged value payload (`MaxStagingBytes`) and 100,000 exact samples per group for medians and distributions (`MaxSamplesPerGroup`, at most 1,000,000). Request `groupLimit` and result paging do not raise them. Exceeding a row or staging budget fails the request; exceeding a metric's group or sample budget fails only that metric.

Box planning materializes a sorted double array per group for exact quartiles and removes it before producing result rows. This requires O(n) sample storage (at least eight bytes per non-NULL sample, plus array/aggregate/sort/CTE overhead); the 20-value outlier response cap and `groupLimit` do not bound this working state. The executor checks each group's sample count against `MaxSamplesPerGroup` before running a sampled metric, but ungrouped populations are not otherwise bounded. Configure `work_mem`, `temp_file_limit`, and `statement_timeout`, but do not treat `work_mem` as a hard query-memory ceiling: array aggregate transition state is not bounded by that setting. Use admission limits and a process/container memory limit as well.

The host must still bound request bytes, statement execution time, working memory, response size, and concurrent previews, and enforce cancellation through the request context. Avoid combining counts from duplicate joined identities unless that is the declared population.

## Verification

`go test ./...` and `go vet ./...` need no database or third-party packages. Semantic integration fixtures use only an optional `psql` CLI:

```sh
QT_TEST_POSTGRES='host=/your/disposable/socket port=5432 dbname=postgres' go test -race -count=1 ./...
go test -run '^$' -fuzz FuzzExpressionParser -fuzztime 5s -parallel 2
```

The v3 executor's PostgreSQL suite (ungrouped direct execution, grouped staging, distinct values, metric isolation, calendar keys) lives in the separate driver-backed `backends/postgres-tests` module and reads the same `QT_TEST_POSTGRES` DSN.

The PostgreSQL fixtures exercise guarded and lazy arithmetic, paired ratios, scopes, top-N after final expressions, hidden computed global sort beyond the first page (including NULL-only sorting, grouping, and shown-row windows), transitive revision validation, empty and all-null populations, positive/negative unsafe numeric samples across all reductions (including cancellation, averaging, extrema, distinct cardinality, and COUNT presence), safe boundary and fractional samples, lazy reduction errors, final metric expression overflow, group-local box errors and global histogram errors, distribution shown-row windows, quartiles/Tukey tails (including both fences, one-ULP inside/outside memberships, mirrored decimal boundaries, minmax quartiles, singleton and two-sample populations), shared histogram edges, exact floating-boundary bucket parity, NULL/COALESCE NULL distributions on empty and populated sources, constant populations, precision collapse, and error propagation. Unit fixtures cover injection, schema restrictions, Unicode literal boundaries, cancellation, cycles, source/node limits.

The planner prunes unused row bindings at the PostgreSQL source projection and through formula stages, filters, and page windows before materialization. PostgreSQL performance regressions inspect actual correlated SELECT subplan loops at small page sizes, including OFFSET and hidden computed sorts, and the ungrouped v3 suite checks that requests without grouping page and reduce the source without staging it. Hosts do not need to narrow the schema to avoid copying every column through filtered populations. Tukey box plots reuse each group's exact sorted sample array, scan it once for observed endpoints and outlier counts, and retain at most 20 outlier values through ordinal lookup; they do not rescan the full population for each group. Working sample arrays never appear in the response.
