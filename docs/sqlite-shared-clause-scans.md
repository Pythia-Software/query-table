# SQLite: sharing a request's metric scan

The Go V3 executor can answer an eligible metric-only request with one streamed
read of its authorized SQLite source. The read supplies `total` and
`sourceTotal`, as well as every clause. Automatic stored-source sharing is
available in 1.0.7 without host API or request changes. Numeric keys and the
optional deterministic-source assertion below extend it in the next release.

## Eligible requests

Use `rows: false` and at least two `allMatching` metrics over stored fields
or the host-declared deterministic bindings described below.
The clauses may have different `groupBy` keys and `where` filters. Supported
reductions are COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, MEDIAN, PERCENTILE,
and box, histogram and quantile distributions over a numeric field. Expressions
must be a single reduction of a field, or COUNT(). Existing schema aggregate
policies still apply. Group keys are text, enum, boolean or number fields.
Numeric keys require the schema's existing `Groupable: true` opt-in. Equal
INTEGER and REAL values share a group, including signed zero; keys and their
sort order match the per-clause SQL executor. Unsafe integer keys and numeric
storage outside the reducer's exact domain retain SQL execution.

Scalar calendar clauses with `includeEmpty: false` may use a datetime first
key, `every` and an IANA `timeZone`, including cyclic slots. Calendar buckets
are computed once per configuration per row, using the existing calendar
implementation, with adjacent rows reusing the current interval's boundaries.
Counts, distinct counts and several percentiles can share that calendar
population. Quantile distributions with dateGrouping retain the existing
unsupported-clause diagnostic; this change does not extend that API.

The reducer shares state by group keys and clause filter, and shares samples
and their sort across percentiles/distributions of the same field in a cohort.
Clause predicates remain compiled SQL. Typed group identity remains binary,
including on a source column declared COLLATE NOCASE.

Homogeneous text `COUNT_DISTINCT` clauses over the same field and filters but
different grouping sets use the [shared SQL input](sqlite-text-distinct-performance.md).
That path avoids a discarded speculative scan when large distinct sets exceed
the streamed reducer's retained-memory bound.

Scalar-only batches with identical populations retain existing SQL fusion;
distribution-only batches retain the existing distribution scan. Requests
using a host `PopulationCounter`, shown-row metrics, rows, `@computed/` inputs,
composed formulas, paired expressions, intervals, empty calendar fills, or
limited SUM results use their existing execution path. Limited SUM results
retain SQL's exact floating accumulation behavior for the Other bucket.

## Deterministic host sources and calendar bindings

Numeric keys and the following host option are new after 1.0.7. A Go host may
set `QueryDatasetV3.SQLiteSharedMetricsSource = true` to certify that its
`SourceSQL`, schema bindings and predicate relations are deterministic and
side-effect-free within the authorized transaction. This allows eligible
batches to share sources that the stored-source proof cannot accept, including
stored rows combined with derived rows by `UNION ALL` and host SQL expressions
such as `pharos_zoned_time(requested_at, zone)`.

The executor projects bindings over the authorized source before applying
request predicates, then materializes the narrow matching population inside
its shared statement. Window bindings retain their original source population;
SQLite can still flatten row-local scalar projections as in the SQL executor.
Each matching row's projected values are reused by clause filters and reducers.
Generated column aliases keep case-sensitive schema names distinct, and the
projection retains each binding's SQLite affinity for clause comparisons.
Request predicates use the projected bindings and may also evaluate scalar
bindings they reference. The total comes from the same read. No public request
or npm API changes are required. The host option defaults to false, retaining the
automatic stored-source proof and its refusal to speculate over opaque SQL.

To group calendar cells by both a period and an hour, expose separate bound
fields and use ordinary `groupBy`, for example:

```go
yes := true
d.SQLiteSharedMetricsSource = true
d.Schema.Fields["day"] = qt.FieldSpec{
    Name: "day", Kind: qt.FieldText,
    Expr: "date(r.requested_at,'localtime')",
    Groupable: &yes, ServerFilter: true, Sortable: true,
}
d.Schema.Fields["hour_of_day"] = qt.FieldSpec{
    Name: "hour_of_day", Kind: qt.FieldNumber,
    Expr: "CAST(strftime('%H',r.requested_at,'localtime') AS INTEGER)",
    ExpressionNumeric: true, Groupable: &yes,
    ServerFilter: true, Sortable: true,
}
// Both COUNT_DISTINCT and quantiles can group by:
// []string{"model", "day", "hour_of_day"}
```

SQLite's `localtime` uses the server's local zone. For a viewer's IANA zone,
bind equivalent period/hour expressions using the host's deterministic zoned
time function, with the same fixed zone in both expressions. These are trusted
schema fields, not `@computed/` formulas. This option does not extend the
single-key `dateGrouping` API or enable date-grouped quantile distributions.

The assertion permits fallback to evaluate the source again if an input,
retained-state limit, or calendar budget cannot be handled by the shared
reducer. Do not enable it for volatile functions, side effects, or changing
zone configuration. Host SQL exceptions fall back to the original executor
to recover totals, healthy sibling clauses, and error precedence. Revision,
token and snapshot checks still run before source evaluation.

## Validation and bounds

The normal request validation and revision/snapshot checks run before the scan.
Each clause is compiled to validate its filters, types, ordering and aggregate
policy before the row reducer is selected. Unless the host enables the explicit
assertion above, SQLite EXPLAIN proves that the host source and every reached
binding read stored values; opaque host expressions decline without executing
them.

`minCount`, measured minimums, group limits, exact sample limits, nulls and
input errors retain their existing results. Calendar population limits still
apply. The scan conservatively bounds each calendar clause's typed payload
using all scanned fields plus an ordinal and a calendar key. If that bound
cannot prove the byte budget, the ordinary SQL executor checks the original
clause's exact budget and reports its diagnostic. A conservative fallback is
not a new budget error.

An estimated 128 MiB of retained group, distinct-key and sample state, and
10 million scanned rows, bound speculation. Exceeding either threshold, or
encountering storage the reducers cannot read exactly, discards speculative
state and runs the existing SQL path. Such fallback can read a stored source
again. State lives only within the request's authorized transaction; no
temporary relation or shared cache is retained by the streamed path. The
declared-source path's materialized CTE is statement-local; its database
storage and query scratch remain host-managed, as for ordinary SQL execution.
When a shared statement with clause-filter flags or declared bindings fails,
its speculative state is discarded and the SQL executor reestablishes the
total and isolates each clause. A failing filter therefore cannot discard
healthy sibling metrics.
Cancellation and request diagnostics still fail the request directly. Failures
in automatic stored-source reads without clause filters also fail directly.

## Synthetic Thinking workload

`BenchmarkSharedClauseScans` generates an actual input table of 1,200,001
synthetic rows, including one excluded tenant row. A 30-day range contains
287,999 matching rows, about 90% with timed gaps. It requests 19 clauses:
counts, distinct conversations and quantiles over several grouping sets, an
effort count, a sum, and eight date-grouped scalar clauses, including four
percentiles. The source stores RFC 3339 timestamps and has a timestamp index.

On an Apple M3 Ultra with Go's modernc SQLite v1.59.0 test driver, three warmed
single-iteration runs measured **1.41–1.44 seconds** for the shared request
and **0.49–0.51 seconds** for a hand-written ordered read of model, effort,
conversation and gap values. The benchmark asserts that the shared request
submits exactly one source-reading statement. The SQL comparison declines
only the new shared-scan proof, retaining the previous scalar/distribution
optimizations and calendar executor for the same request; one warmed iteration
measured **54.39 seconds**, about 38 times the shared request. All measurements
use the same generated table and driver.

These are synthetic measurements, not a run against the production Pharos
catalog. They reach the handoff's approximate two-second target here but
remain about 2.9 times this native read, above the requested two-times ratio.
RFC 3339 predicates retain their normal datetime conversion; an index alone
does not make those predicates a native timestamp range. Hosts with canonical
UTC millisecond storage can already declare `datetimeFormat: "utc-millis"`
to use indexed native comparisons under that convention.

Reproduce from `backends/sqlite-tests`:

```sh
go test -run '^TestSharedClause' -count=1
go test -run '^$' -bench '^BenchmarkSharedClauseScans/(shared|native)$' -benchtime=1x -count=3
go test -run '^$' -bench '^BenchmarkSharedClauseScans/sql$' -benchtime=1x -count=1
```

## Synthetic numeric, calendar-cell and derived-source comparisons

`BenchmarkSharedGroupingScans` generates 1,200,000 authorized synthetic rows
plus one excluded tenant row. Each request selects the same 287,999-row month.
The number and derived-source requests contain nine count, distinct-count and
quantile clauses over several grouping sets. The cell request contains two
clauses: distinct conversations and quantiles by model, local day and local
hour, using a fixed UTC−07:00 offset. The derived source combines stored rows
with a derived gap value for every tenth row via `UNION ALL`. MaxGroups is
10,000 to accommodate the calendar cells.

On an Apple M3 Ultra, Go 1.27.1 and modernc SQLite v1.61.0, one warmed measured
iteration per case produced these elapsed request times:

| Request | Shared | Existing SQL | Source-reading statements, shared / SQL |
| --- | ---: | ---: | ---: |
| Numeric depth keys, nine clauses | 1.22 s | 6.29 s | 1 / 11 |
| Model/day/hour cells, two clauses | 1.47 s | 4.18 s | 1 / 3 |
| Stored + derived rows, nine clauses | 1.60 s | 7.28 s | 1 / 11 |

These are synthetic inputs and local measurements, not production Pharos
measurements. Every shared case asserts one source-reading statement and
error-free metric buckets. Separate parity tests compare complete results
against the SQL executor, including a deterministic IANA-zone host function
across Denver's repeated DST hour. Reproduce from `backends/sqlite-tests`:

```sh
go test -run '^$' -bench '^BenchmarkSharedGroupingScans$' -benchtime=1x -count=1
```

Parity tests compare complete results against the existing SQL executor and
cover binary keys, clause filters, empty/all-null populations, invalid and
unsafe values, DST transitions, multiple-interval buckets, cyclic slots,
minimums, top-N, and group/sample/population/byte limits. Release publication
and a consuming application's normal version bump are separate steps.
