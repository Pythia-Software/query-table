# SQLite: sharing a request's metric scan

The Go V3 executor can answer an eligible metric-only request with one streamed
read of its authorized SQLite source. The read supplies `total` and
`sourceTotal`, as well as every clause. No host API, request format, dependency
patch or persistent cache is required. This change is available in 1.0.7.

## Eligible requests

Use `rows: false` and at least two `allMatching` metrics over stored fields.
The clauses may have different `groupBy` keys and `where` filters. Supported
reductions are COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, MEDIAN, PERCENTILE,
and box, histogram and quantile distributions over a numeric field. Expressions
must be a single reduction of a field, or COUNT(). Existing schema aggregate
policies still apply. Group keys are stored text, enum or boolean fields.

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
using a host `PopulationCounter`, shown-row metrics, rows, computed inputs,
composed formulas, paired expressions, intervals, empty calendar fills, or
limited SUM results use their existing execution path. Limited SUM results
retain SQL's exact floating accumulation behavior for the Other bucket.

## Validation and bounds

The normal request validation and revision/snapshot checks run before the scan.
Each clause is compiled to validate its filters, types, ordering and aggregate
policy before the row reducer is selected. SQLite EXPLAIN proves that the host
source and every reached binding read stored values; opaque host expressions
decline without executing them.

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
temporary relation or shared cache is retained by the streamed path.
When a shared statement with clause-filter flags fails, its speculative state
is discarded and the SQL executor reestablishes the total and isolates each
clause. A failing filter therefore cannot discard healthy sibling metrics.
Cancellation, request diagnostics and failures in shared reads without clause
filters still fail the request directly.

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

Parity tests compare complete results against the existing SQL executor and
cover binary keys, clause filters, empty/all-null populations, invalid and
unsafe values, DST transitions, multiple-interval buckets, cyclic slots,
minimums, top-N, and group/sample/population/byte limits. Release publication
and a consuming application's normal version bump are separate steps.
