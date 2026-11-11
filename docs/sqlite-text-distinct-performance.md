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

The new path materializes one narrow raw projection, then one TEMP input table
with one validation error sidecar per field. Both metrics read that table, using
`CASE` to null invalid values and grouping by the value/error pair just as the
ordinary compiler does. The compiler's original post-reduction stages still
handle bucket diagnostics, minimum counts, ordering, limits and group budgets.
No counts are approximated, rolled up from family totals or cached across
requests.

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
  -benchtime=4x -count=1 -benchmem
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
and the median of its subsequent three executions separately. Process CPU is
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
| 972,298 observations | 1.0.6 | 6.294 / 4.977 s | 5.052 / 4.875 s |
| Selective: 21,604 observations | 1.0.5 | 3.354 / 2.437 s | 2.789 / 2.400 s |
| Selective: 21,604 observations | 1.0.6 | 1.340 / 1.432 s | 1.632 / 1.502 s |
| Small: 4,000 observations | 1.0.5 | 34.370 / 35.679 ms | 33.970 / 35.677 ms |
| Small: 4,000 observations | 1.0.6 | 19.330 / 20.813 ms | 19.248 / 20.505 ms |
| Small selective: 88 observations | 1.0.5 | 10.746 / 11.865 ms | 10.350 / 11.327 ms |
| Small selective: 88 observations | 1.0.6 | 11.914 / 10.019 ms | 7.346 / 8.333 ms |

The full subsequent median improved **44.8% in wall time** and **37.9% in
process CPU time**. The selective medians improved 41.5% and 37.4%, respectively.
CPU sums all threads and can exceed wall time for a short execution.

Full-fixture final repetitions (seconds, first followed by three subsequent):

- v1.0.5 wall: `11.480326, 10.534630, 9.153607, 8.557882`;
  CPU: `8.384422, 7.960275, 7.846690, 7.733341`.
- v1.0.6 wall: `6.293647, 4.843321, 6.764285, 5.052175`;
  CPU: `4.977323, 4.813112, 4.931125, 4.874981`.
- Selective v1.0.5 wall: `3.354033, 2.789358, 3.083750, 2.278834`;
  CPU: `2.437179, 2.399938, 2.453371, 2.272924`.
- Selective v1.0.6 wall: `1.339683, 1.351995, 1.631974, 1.740283`;
  CPU: `1.432476, 1.432417, 1.501920, 1.541321`.

The final full-fixture native references took 3.648 / 1.975 s in the baseline
process and 2.113 / 1.281 s in the candidate process (day/family, then day).
They illustrate machine variation and the remaining grouping/distinct work;
these raw statements do not provide equivalent diagnostics or execution budgets.

| Work per full executor execution | 1.0.5 | 1.0.6 |
| --- | ---: | ---: |
| Authorized-source reads, including population count | 3 | 2 |
| Datetime scalar calls | 5,833,788 | 3,889,192 |
| Text field checks | 9,722,980 | 2,916,894 |
| Allocated Go bytes (`B/op`) | 1,184,933,902 | 538,559,818 |
| Go allocations (`allocs/op`) | 62,239,420 | 27,235,819 |

Allocated bytes fell 54.5%; text checks fell 70%. The selective fixture also
reduces checks from 216,040 to 64,812. The callback counters and single-evaluation
test establish reduced work independently of wall time.

The labeled CPU profiles include five full and five selective executions
(calibration plus final repetitions), excluding source generation and native
references when filtered with `-tagfocus=phase=executor`. In that selection,
SQLite's `_sqlite3MemMalloc` flat samples fell from 17.45 s to 6.38 s, while
`_sqlite3VdbeExec` cumulative samples fell from 38.50 s to 24.89 s. Input
materialization and driver callback allocation were reduced; grouping sorts
and independent distinct sets remain. The initial allocation profiles likewise
located most Go allocation in modernc scalar argument/string conversion and
datetime formatting, motivating fewer validations and source filters rather
than changes to distinct-count semantics.

Raw benchmark logs, CPU profiles and their text summaries are attached to the
[v1.0.6 release](https://github.com/Pythia-Software/query-table/releases/tag/v1.0.6).
An initial profiled run had worse candidate wall time under contention, despite
lower CPU work/allocations. The serial repeat above adds per-execution CPU
measurements rather than treating that noisy first run as a stable speedup.

The full fixture returned 360 day/family buckets and 90 day buckets with exact
agreement against both native references. Focused parity tests additionally
cover duplicate membership within a family, overlap across families, binary
collation, NULL/empty text and grouping keys, empty/scalar populations, corrupt
storage/UTF-8/oversized operands, inherited field errors, source arguments,
source/metric filters, scopes, reordered grouping lists, minimum counts, group
limits, rollback, partial CTAS failure, cancellation and stale revisions.
