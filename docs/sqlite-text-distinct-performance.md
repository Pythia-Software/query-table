# SQLite text distinct metric batches

Version 1.0.6 shares filtered, validated inputs for exact text `COUNT_DISTINCT`
metrics across different grouping lists. A `[day,family]` count and a `[day]`
count each reduce the shared observations independently. Overlapping labels
therefore never inflate the denominator.

## Investigation and implementation

The synthetic fixture contains 486,149 messages and 972,298 observations, with
two overlapping families per message. It reproduces the request clock,
RFC3339 interval, narrow authorized source and host limits from the Labels
latency investigation. No Pharos checkout or private data is needed.

The v1.0.5 statements use the ordinary typed reduction path. Their integer
planner's `EXPLAIN` proof declines the datetime filter's function calls; it does
**not** execute and fail a speculative full-population reduction. The ordinary
plans read the source for the population count and for each metric. They create
five population-sized typed CTE stages across the two metrics, validating both
the value and error projection of every consumed text field. The two distinct
counts also need independent grouping sorts and distinct sets.

Homogeneous text-distinct batches prefer this SQL path over speculative
streamed reduction. An integration probe of the separately merged streaming
planner read 698,330 observations before its 128 MiB retained-state guard
declined, then repeated execution through SQL. It made 5,285,852 datetime calls
and allocated 847,076,016 Go bytes in that run. Selecting the shared SQL input
directly avoids that discarded scan. Mixed dashboard clauses continue to use
the streamed planner when eligible.

The new path retains the compiler's source-projection and filter boundaries,
including window bindings evaluated before result or metric filters. It
materializes one narrow raw projection, then one TEMP input table
with one validation error sidecar per field. Both metrics read that table, using
`CASE` to null invalid values and grouping by the value/error pair just as the
ordinary compiler does. The compiler's original post-reduction stages still
handle bucket diagnostics, minimum counts, ordering, limits and group budgets.
No counts are approximated, rolled up from family totals or cached across
requests. Top-N, sort and minimum-count variants also reuse a bounded grouped
reduction over that input. Existing fusion of different aggregate leaves stays
on its original path, avoiding duplicated grouping in mixed aggregate batches.

Only independently compiled, bare text/enum `COUNT_DISTINCT` metrics over the
same all-matching population and identical metric filters are eligible. There
must be at least two different reductions; identical reductions keep the
existing result/reduction reuse. Computed inputs/filters, measured minimums,
paired expressions, sampled metrics and shown-row scopes keep their existing
paths. Source, arguments, authorization and snapshot are fixed for the lifetime
of this execution-local cache. Hidden expected revisions are checked before
any shared statement runs.

A shared statement error disables the optimization and returns to ordinary
per-metric execution. Field diagnostics remain separate, so a corrupt family
key cannot contaminate the day-only metric. TEMP ownership is registered before
DDL; savepoint rollback forgets new tables and later siblings recreate them.
Cancellation stays a request error. Every input table is dropped before returning
the caller's transaction. Ungrouped metrics retain the existing direct-execution
budget semantics; this change adds no population cutoff or silent truncation.

## Repeat the experiment

Use Go 1.26 or later (the modernc test driver requires it). The executor module
itself continues to support its declared Go version.

```sh
cd backends/sqlite-tests
go test -run '^(TestLabelTrend|TestTextDistinct)' -count=1
go test -run '^$' -bench '^BenchmarkLabelTrend$' -benchtime=4x -count=1 -benchmem \
  -cpuprofile /tmp/label-trend.cpu -memprofile /tmp/label-trend.mem
go tool pprof -top -tagfocus=phase=executor /tmp/label-trend.cpu
go tool pprof -top -alloc_space /tmp/label-trend.mem
QT_LABEL_MESSAGES=2000 go test -run '^$' -bench '^BenchmarkLabelTrend$' \
  -benchtime=50x -count=1 -benchmem
go test -run '^$' -bench '^BenchmarkLabelTrendMixed$' -benchtime=4x -benchmem
```

For a before/after comparison, copy only `label_trend_benchmark_test.go` and the
SQLite test module's `go.mod`/`go.sum` into a disposable v1.0.5 checkout, so both
versions use modernc v1.61.0 and exactly the same fixture and benchmark. Run the
two binaries serially. Keep setup/native references outside the execution timer.
The native statements use the same registered datetime conversion and immutable
database and compare every bucket key and exact distinct count. They omit the
executor's validation and response contract, so they are a reference, not an
alternative implementation. The selective case retains 21,604 observations.

Go's benchmark calibration runs a separate one-iteration fixture before the
final four-iteration fixture. Report the first execution of the final fixture
and the median of its subsequent three executions separately. Small fixtures
use 50 final executions and the subsequent 49 for the median. Process CPU is
also logged per execution. CPU profiles label executor work separately from
fixture generation and native references. Allocation profiles cover the whole
benchmark process, while `B/op`/`allocs/op` exclude setup and verification.

## Measurements

Recorded November 11, 2026 UTC (November 10, America/Denver), on an Apple M3
Ultra, darwin/arm64, Go 1.27.1, modernc.org/sqlite v1.61.0, in-memory SQLite with
`temp_store=MEMORY`. Data generation and index construction are untimed. This
was a shared development machine with other processes active: repeated timings
are local observations, not an idle-machine latency guarantee or a production
forecast.

The baseline is v1.0.5 (`279284c`); the candidate is the v1.0.6 executor.
The driver, fixture and benchmark source are identical between them.

| Workload | Version | First wall / CPU | Subsequent median wall / CPU |
| --- | --- | --- | --- |
| 972,298 observations | 1.0.5 | 11.480 / 8.384 s | 9.154 / 7.847 s |
| 972,298 observations | 1.0.6 | 5.287 / 5.013 s | 5.805 / 4.965 s |
| Selective: 21,604 observations | 1.0.5 | 3.354 / 2.437 s | 2.789 / 2.400 s |
| Selective: 21,604 observations | 1.0.6 | 1.633 / 1.557 s | 1.577 / 1.511 s |
| Small: 4,000 observations | 1.0.5 | 38.309 / 37.950 ms | 32.655 / 34.701 ms |
| Small: 4,000 observations | 1.0.6 | 22.793 / 22.587 ms | 30.425 / 28.811 ms |
| Small selective: 88 observations | 1.0.5 | 18.954 / 19.189 ms | 18.478 / 15.036 ms |
| Small selective: 88 observations | 1.0.6 | 8.807 / 7.851 ms | 13.102 / 8.610 ms |

The full subsequent median improved **36.6% in wall time** and **36.7% in
process CPU time**. The selective medians improved 43.5% and 37.0%, respectively.
CPU sums all threads and can exceed wall time for a short execution. Small
fixtures use 50 final executions (first plus 49 subsequent), reducing timing
noise in these short requests.

Full-fixture final repetitions (seconds, first followed by three subsequent):

- v1.0.5 wall: `11.480326, 10.534629, 9.153607, 8.557882`;
  CPU: `8.384422, 7.960275, 7.846690, 7.733341`.
- v1.0.6 wall: `5.286675, 5.804986, 5.292302, 6.988664`;
  CPU: `5.012976, 5.054127, 4.964856, 4.923413`.
- Selective v1.0.5 wall: `3.354033, 2.789358, 3.083750, 2.278834`;
  CPU: `2.437179, 2.399938, 2.453371, 2.272924`.
- Selective v1.0.6 wall: `1.632555, 1.576803, 1.505825, 1.924052`;
  CPU: `1.557066, 1.510969, 1.494391, 1.624944`.

The final full-fixture native references took 3.648 / 1.975 s in the baseline
process and 2.458 / 1.433 s in the candidate process (day/family, then day).
They illustrate machine variation and the remaining grouping/distinct work;
these raw statements do not provide equivalent diagnostics or execution budgets.

| Work per full executor execution | 1.0.5 | 1.0.6 |
| --- | ---: | ---: |
| Authorized-source reads, including population count | 3 | 2 |
| Datetime scalar calls | 5,833,788 | 3,889,192 |
| Text field checks | 9,722,980 | 2,916,894 |
| Allocated Go bytes (`B/op`) | 1,184,933,902 | 538,593,822 |
| Go allocations (`allocs/op`) | 62,239,420 | 27,235,967 |

Allocated bytes fell 54.5%; text checks fell 70%. The selective fixture also
reduces checks from 216,040 to 64,812. The callback counters and single-evaluation
test establish reduced work independently of wall time.

The labeled CPU profiles include five full and five selective executions
(calibration plus final repetitions), excluding source generation and native
references when filtered with `-tagfocus=phase=executor`. In that selection,
SQLite's `_sqlite3MemMalloc` flat samples fell from 17.45 s to 6.55 s, while
`_sqlite3VdbeExec` cumulative samples fell from 38.50 s to 25.35 s. Input
materialization and driver callback allocation were reduced; grouping sorts
and independent distinct sets remain. Initial allocation profiles likewise
located most Go allocation in modernc scalar argument/string conversion and
datetime formatting, motivating fewer validations and source filters rather
than changes to distinct-count semantics.

A second benchmark uses 40,000 observations, 18 different top-N/sort consumers
and a day-only denominator. The initial implementation (`81c84c6`) repeated
19 reductions: first 1.041 s; subsequent 1.192, 1.145 and 1.379 s (median
1.192 s). The corrected implementation executes two reductions: first 0.232 s;
subsequent 0.216, 0.204 and 0.354 s (median 0.216 s). Every returned bucket
matches the native reference. Minimum-count variants and mixed aggregate
fusion are checked separately by regression tests.

Raw benchmark logs, CPU profiles and their text summaries are attached to the
[v1.0.6 release](https://github.com/Pythia-Software/query-table/releases/tag/v1.0.6).
Preliminary profiled runs had widely varying wall time under contention,
despite lower CPU work and allocations. The table above uses the corrected
implementation and serial repetitions with per-execution CPU measurements.

The full fixture returned 360 day/family buckets and 90 day buckets with exact
agreement against both native references. Focused parity tests additionally
cover duplicate membership within a family, overlap across families, binary
collation, NULL/empty text and grouping keys, empty/scalar populations, corrupt
storage/UTF-8/oversized operands, inherited field errors, source arguments,
source/metric filters, scopes, reordered grouping lists, minimum counts, group
limits, rollback, partial CTAS failure, cancellation and stale revisions.
Regression tests also cover window-derived bindings with both filter scopes,
18 distinct top-N/sort/minimum-count consumers plus a denominator, and mixed
COUNT/COUNT_DISTINCT aggregate fusion. The first two regressions fail on the
initial optimization commit (`81c84c6`) and pass on the release implementation.
