# PostgreSQL metric and computed-column compiler

`backends/go` supplies an additive, dependency-free PostgreSQL 12+ planning API. It does **not** implement a metric HTTP endpoint, execute queries, negotiate frontend transport support, authorize datasets, or create snapshots. A successful browser preview is not evidence of server support. Hosts must implement and advertise their actual service capabilities.

Existing `Compile`, `CompileAt`, `CompileAggregation`, query decoding, and computed-column storage remain available. `CompileAggregation` refuses modern expressions, paired measures, distributions, shown-row scope, and result ordering/limits rather than silently executing a different v1 request. Explicit schema aggregate restrictions apply to v1 too.

## Integration entrypoints

- `CompileRowExpression(ctx, source, schema, options)` validates an unsaved row expression and returns a value/error SQL projection. It never persists a definition.
- `CompileRowsV2(ctx, ServerQueryV2, schema, options)` validates the version/profile/revision/token envelope and delegates to row planning. Nonempty tokens require `PlanOptions.ValidatePlanToken`; the host callback must verify actor, dataset, profile, snapshot and expiry.
- `CompileComputedRows(ctx, query, schema, options)` resolves selected and hidden sort dependencies, then globally orders and paginates.
- `CompileMetrics(ctx, MetricQuery, schema, options)` compiles a v2 batch. Each metric is one SQL statement, including distribution stages. Paired X/Y use the same grouped relation.
- `CompileExecution(ctx, rowQuery, metricQuery, schema, options)` compiles both using one reference time and cached authoritative definition graph, returning the union of resolved revisions. Supply identical table filters/order/window to both inputs when they describe the same view.

`MetricQuery` mirrors the core computation request: `version: 2`, `where`, `orderBy`, `limit`, `offset`, `metrics`, and `diagnostics`, plus optional `profile`, `expectedRevisions`, `planToken`, and `snapshot`. `AggSpec` retains `id/op/field/groupBy` and adds `expression`, `expressionY`, `scope`, `sort`, `groupLimit`, and `distribution`. Nonempty client diagnostics are rejected. Presentation properties have no SQL or fingerprint effect; `display.kind: scatter` is retained only to reject a missing second expression. Explicit `expressionY` is always paired, and explicit `distribution` selects a distribution reduction. The frontend computation projection removes inactive saved alternatives.

```go
schema, err := querytable.LoadSchema(schemaJSON)
if err != nil { return err }
// This is a host assertion about the trusted SQL binding, never a client flag.
for _, name := range []string{"id", "total_ms"} {
    f := schema.Fields[name]
    f.ExpressionNumeric = true
    schema.Fields[name] = f
}

// Begin a read-only REPEATABLE READ transaction using the host's SQL driver.
resolver := querytable.SQLComputedDefinitionResolver{
    Tx: tx, Scope: authorizedScope, Dataset: authorizedDataset,
}
options := querytable.PlanOptions{
    SourceSQL: `SELECT id,total_ms,platform FROM runs WHERE tenant_id=$1`,
    SourceArgs: []any{authorizedTenant},
    Resolver: resolver,
    ExpectedRevisions: expectedRevisions, // plain IDs, including transitive refs
    Identity: actorDatasetSchemaAndSnapshotIdentity,
    Now: requestReferenceTime,
}
plan, err := querytable.CompileMetrics(ctx, query, schema, options)
if err != nil { return err }
for _, metric := range plan.Metrics {
    rows, err := tx.QueryContext(ctx, metric.SQL, metric.Args...)
    // Scan/map typed results, check budgets and errors, and close rows.
    // Return one batch response after all requested plans succeed.
    _ = rows
    if err != nil { return err }
}
```

`SourceSQL` must be a trusted authorized SELECT. Its output is aliased `r`; v2 schema bindings must refer to that namespace, such as `r.total_ms`. Do not reuse a binding to an outer alias absent from this source. `SourceArgs` occupy `$1..$N`; planner parameters follow. User values and formula literals are bound parameters. Source SQL, schema expressions, and actor/snapshot identity must never come from unvalidated request input. Trusted bindings must themselves be exception-free and correctly typed; the planner cannot make arbitrary host SQL safe.

A host may instead implement `DefinitionResolver`, backed by its own authorized catalogue snapshot. `SQLComputedDefinitionResolver` uses the existing store table and the supplied transaction, resolving only referenced IDs. Canonical source is parsed independently; client ASTs and formula SQL are never accepted. Each reached ID needs a matching `ExpectedRevisions[id]`, or planning fails with `definition_changed`. Cycles, missing definitions, unsupported transitive dependencies, language/version mismatches, and graph limits fail explicitly. Labels never become aliases.

## Values, errors, and the execution profile

The profile is `qt-postgres-v1`. This identifies a compiler subset, not deployed transport support:

- JSON strings, finite numeric literals, booleans, NULL, escaped bracket references (`[a]]b]`), arithmetic `+ - * /`, comparisons, boolean AND/OR/NOT.
- `IF`, `NULLIF`, `COALESCE`, `IS_NULL`, `ABS`, with strict scalar type checking.
- Metric reductions `COUNT()`, `COUNT(expr)`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`; the SQL planner additionally admits `MEDIAN` as exact continuous percentile reduction. v1 remains unchanged and rejects median.
- Regex, arrays, conversions, dates/functions, `%`, power, arbitrary SQL, and nested aggregates are rejected. v2 regex predicates/sort extraction are also rejected; legacy filter behavior is preserved in v1.

Numeric fields must explicitly set `FieldSpec.ExpressionNumeric`. The shared schema admits `bindings.postgres.expressionNumeric`; both the Go loader and schema code generator preserve this trusted binding flag. The generator also preserves `aggregate.measure`, `aggregate.ops`, and `aggregate.groupable` policy. SQL numeric bindings must hold finite display-arithmetic values. Nonzero magnitudes outside `[1e-300, 1e100]`, NaN, and infinities produce `numeric_range`; zero and NULL are supported. Numeric literals outside that domain fail compilation. This intentionally bounded profile does not claim arbitrary IEEE-double or exact accounting support.

Division emits `divide_by_zero` only for a non-null numerator and zero denominator. `x / NULLIF(y,0)` returns NULL without that error. Strict operators propagate errors. IF and COALESCE select only the logically evaluated error path; AND/OR preserve short-circuit error behavior and three-valued booleans. Physically precomputed branches are safe, so an unused division cannot abort a SQL statement. Null values remain distinct from errors and empty text.

Arithmetic uses native double operations after numeric range guards. Guard conversions pass through PostgreSQL's round-trip text representation to avoid the precision loss of a direct `double precision::numeric` cast. **Use `extra_float_digits >= 1`** (the PostgreSQL 12+ default) so those conversions preserve input precision. SUM/AVG accumulate using PostgreSQL numeric before returning double. Numeric SUM, AVG, MIN, MAX, COUNT_DISTINCT (and the backend-only MEDIAN) reject integral input samples outside ±9,007,199,254,740,991 with `unsafe_integer`, even if cancellation, averaging, an extremum, or distinct cardinality would yield a safe result. Numeric reduction outputs and final scalar/paired metric expression results use the same guard on the returned IEEE double. COUNT observes presence and permits otherwise profile-valid unsafe numeric inputs; its numeric output is still checked. NULL samples remain excluded, and text/date extrema retain their semantics. The safety threshold is a bound SQL parameter. These checks apply at metric boundaries, not inside every row-expression arithmetic operation, and do not change legacy v1 aggregation. Failed reductions retain separate value/error columns: unused IF/COALESCE branches do not observe them, while a consumed error is never treated as an ordinary NULL. IFERROR is not part of this PostgreSQL profile. SUM also conservatively declines an absolute population sum above MAX_SAFE_INTEGER, including cancellation cases that could be safe in some row orders; this prevents claiming sequential browser intermediate-overflow equivalence. Reduction order and floating-point accumulation differ from sequential browser arithmetic: require tolerance-based numeric conformance, do not claim bit-for-bit equality or identical intermediate overflow behavior. Row-expression arithmetic fixtures cover exact integer division, branching and errors.

Text bindings are cast to text with PostgreSQL `C` collation for exact grouping/equality. Values above 100,000 UTF-8 bytes emit `text_range` (a conservative subset of the browser text-size bound). NUL and unpaired-surrogate literals are rejected rather than silently changed. Text ordering comparisons inside formulas are declined with `collation_required`. Text MIN/MAX and final group/row ordering use PostgreSQL C ordering, which agrees with the core metric engine’s ordinal Unicode code-point ordering on valid UTF-8. Hosts should still negotiate this profile rather than substitute a locale collation. Datetime bindings retain the database's typed timestamp semantics; normalize output to the frontend's ISO convention in the adapter. Do not advertise universal locale/timezone equivalence.

`FieldSpec.AggregateOps` is an allowlist: nil uses type defaults, an empty list disables measures. `aggregate.measure:false` loads as an empty list. Explicit operation restrictions propagate through computed dependencies and conditional row-expression inputs. Distributions require measurable inputs; they do not invent box/histogram names in the scalar-op allowlist. `aggregate.groupable` is honored; v2 defaults to text/enum/bool grouping, requiring explicit opt-in for numeric/datetime backend keys. Resolver access controls computed definitions. Computed grouping additionally requires a true entry in the trusted `PlanOptions.ComputedGroupable` ID allowlist, so a definition cannot silently bypass the dataset’s grouping policy.

## Stages, scopes, and result mapping

`SQLPlan` exposes `SQL`, ordered `Args`, inspectable `Stages`, `Dependencies`, `ResolvedRevisions`, `Profile`, `Fingerprint`, `Scope`, and `RequiresSnapshot`. Generated aliases use compiler counters. Equivalent row and aggregate nodes are deduplicated using canonical structural hashes. `SQLPlan.String()` deliberately omits SQL and bound values. Structured `PlanDiagnostic` errors expose code/message/field and an optional byte offset; compiler errors may be wrapped with metric context and support `errors.As`.

Expression/reduction CTEs are materialized deliberately to keep repeated safe value/error expressions from expanding exponentially during PostgreSQL planning. The initial authorized projection stays inlineable so base predicates can push down. This is an execution cost tradeoff: many formula nodes mean many stages and additional intermediate storage. Inspect EXPLAIN under realistic cardinality and enforce timeout/memory limits. This implementation favors bounded, inspectable execution over optimistic optimizer inlining.

Rows execute authorized source → base filters → computed dependency stages → ORDER BY plus stable ID → LIMIT/OFFSET. Hidden computed sorts work. NULL-only computed keys use typed projected aliases for row sorting and metric grouping, preserving stable-ID ties and NULL group keys. Numeric sort errors have NULL values and follow explicit null placement. Alternate `SortExpr` bindings must be expressed as explicit schema sort fields in v2; unsupported alternatives fail instead of changing order. Source rows must have unique stable identities after joins.

`allMatching` metrics reduce the entire filtered relation without the table page limit. `shownRows` uses the same globally ordered window; it requires a positive limit. Virtualization and selection never define scope. Group/result limits happen only after final expressions or statistical reductions. The compiler never silently changes scope or samples data.

Row output uses `column0`, `column0_error`, etc. `SQLPlan.Columns` maps these aliases to original requested field names and types. Metric SQL output uses:

| SQL column | Frontend/result meaning |
| --- | --- |
| `group0`, `group1`, ... | Full typed `keys` tuple, including NULL and empty strings |
| `group0_error`, ... | Explicit computed grouping diagnostics |
| `value`, `error` | Primary scalar value/error |
| `y`, `y_error` | Paired value and `yError` |
| `count` | Total scoped rows in the group |
| `samples`, `null_count` | Distribution valid sample and excluded NULL counts |
| `distribution` | JSON matching core distribution result shapes |
| `group_count` | Total reduced groups before result limit |

Some box-stage statistical columns are also returned for inspection; adapters should select/map the protocol fields above rather than forward arbitrary columns. A group error nulls its scalar output. X/Y errors remain independent. Errors sort after valid groups, then requested value/Y/count/sample/key terms apply; the default is value descending, and complete group tuples break ties. NULL placement is independent of direction. No-group empty input produces one COUNT=0 or nullable scalar/empty-distribution bucket; grouped empty input produces no buckets.

Box results contain `{kind:"box",summary}`. Summary is null for zero numeric samples. Distribution samples are explicitly projected as double precision, including `NULL` and `COALESCE(NULL,NULL)` inputs; these count as excluded NULLs without errors. Exact quartiles use the complete non-NULL sorted double population, method `exact-linear`: zero-based position `(n-1)*p`, `lower=floor(position)`, `fraction=position-lower`, then `(1-fraction)*a+fraction*b`, with the upper sample index clamped to `n-1`. All operations use IEEE double arithmetic in the same order as TypeScript. PostgreSQL `percentile_cont` uses a different interpolation order and must not substitute for these box quartiles. Fence comparisons are exact, without an epsilon: even a one-ULP quartile difference can change outlier membership. Min/max or Tukey whiskers use actual observed endpoints. Tukey outputs exact outlier count and at most 20 values, keeping ten from each tail without duplicating rows. Numeric distribution samples use the same unsafe-integer boundary as metric reductions. Invalid samples carry errors and are excluded from `samples`; they do not increase `null_count`. A group input error suppresses that group's summary. Interpolated quartiles and the mean are checked before returning the summary; observed endpoints, whiskers, and outliers inherit sample validation.

Histograms support zero or one grouping key and 2–30 equal-width bins (default ten). Global extent comes from all scoped values before group ranking/limits. Groups share one edge array; counts include zero bins. Edges use the browser’s double arithmetic order, `min + (max - min) * (i / bins)`, with endpoints pinned to the observed minimum and maximum. Bucket counts at floating boundaries must agree exactly; numeric tolerances do not excuse shifted counts. Lower edges are inclusive, upper edges exclusive except the final maximum. Constants produce `[value,value]` and one count; empty inputs produce empty edges/counts. Unsafe integral edges produce `unsafe_integer`; collapsed floating-point edges produce `histogram_precision`. Any input error invalidates every histogram group because the global extent is unknowable; never present the remaining counts as complete.

## Required service behavior and limits

Each metric's stages are one statement and therefore see one PostgreSQL statement snapshot. Separate row/metric statements require the same repeatable-read transaction or equivalent snapshot. Catalogue consistency and data consistency are distinct. A nonempty requested `snapshot` requires `PlanOptions.ValidateSnapshot`; the callback must verify access/expiry and bind the active transaction to that snapshot. The row and metric protocols preserve this token and reject it when no host validation is provided. Echo the union of resolved revisions and plan identity; bind any reusable plan token to actor/dataset/schema/profile/snapshot and expiry. A fingerprint is not an authorization token. Refresh/retry once on `definition_changed`, then surface persistent churn.

Capture one reference time for relative filters. `CompileMetrics` and `CompileExecution` do this automatically when `Now` is omitted. Hosts compiling independent statements should pass the same `Now` themselves.

Compiler limits include 10,000 source bytes, 2,000 tokens, 512 AST nodes per expression, nesting depth 50, 64 resolved definitions, dependency depth 32, 2,048 expanded row nodes, approximately 500 SQL stages, and 512 schema bindings. Request limits retain 20 metrics, 20 grouping keys, and 20 result sort terms; group limit is at most 10,000. Group limits do not bound scanned rows or total groups.

Box planning materializes a sorted double array per group for exact quartiles and removes it before producing result rows. This requires O(n) sample storage (at least eight bytes per non-NULL sample, plus array/aggregate/sort/CTE overhead); the 20-value outlier response cap and `groupLimit` do not bound this working state. Before executing boxes, hosts must enforce scoped population and group-cardinality budgets in the same authorized snapshot, plus a memory/concurrency budget. Reject populations exceeding those budgets; do not truncate arrays or sample rows. Configure `work_mem`, `temp_file_limit`, and `statement_timeout`, but do not treat `work_mem` as a hard query-memory ceiling: array aggregate transition state is not bounded by that setting. Use admission limits and a process/container memory limit as well. This compiler does not execute SQL or enforce runtime budgets for the host.

The host must bound request bytes, scanned rows, group cardinality, distinct states, statement execution time, working memory, response size, and concurrent previews. Enforce cancellation via `QueryContext`. Check `group_count` before labeling coverage complete, and reject resource exhaustion rather than returning a sampled result. Define `processedRows`, coverage/cap metadata, dataset refresh identity, per-metric execution errors, and any additive Other-bucket behavior in the response adapter; this compiler does not fabricate those values. Avoid combining counts from duplicate joined identities unless that is the declared population.

## Verification

`go test ./...` and `go vet ./...` need no database or third-party packages. Semantic integration fixtures use only an optional `psql` CLI:

```sh
QT_TEST_POSTGRES='host=/your/disposable/socket port=5432 dbname=postgres' go test -race -count=1 ./...
go test -run '^$' -fuzz FuzzExpressionParser -fuzztime 5s -parallel 2
```

The PostgreSQL fixtures exercise guarded and lazy arithmetic, paired ratios, scopes, top-N after final expressions, hidden computed global sort beyond the first page (including NULL-only sorting, grouping, and shown-row windows), transitive revision validation, empty and all-null populations, positive/negative unsafe numeric samples across all reductions (including cancellation, averaging, extrema, distinct cardinality, and COUNT presence), safe boundary and fractional samples, lazy reduction errors, final metric expression overflow, group-local box errors and global histogram errors, distribution shown-row windows, quartiles/Tukey tails (including both fences, one-ULP inside/outside memberships, mirrored decimal boundaries, minmax quartiles, singleton and two-sample populations), shared histogram edges, exact floating-boundary bucket parity, NULL/COALESCE NULL distributions on empty and populated sources, constant populations, precision collapse, and error propagation. Unit fixtures cover injection, schema restrictions, Unicode literal boundaries, cancellation, cycles, source/node limits, and v1 refusal to downgrade modern requests.

The planner prunes unused row bindings through formula stages, filters, and page windows before materialization. Hosts do not need to narrow the schema to avoid copying every column through filtered populations. Tukey box plots reuse each group's exact sorted sample array, scan it once for observed endpoints and outlier counts, and retain at most 20 outlier values through ordinal lookup; they do not rescan the full population for each group. Working sample arrays never appear in the response.
