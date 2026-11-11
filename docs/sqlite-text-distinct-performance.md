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
existing result/reduction reuse. When EXPLAIN proves all inputs are stored
reads and every member has a compact native plan, those smaller native
reductions are retained instead of staging the population. Computed inputs/filters, measured minimums,
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
go test -v -run '^$' -bench '^BenchmarkLabelTrendAlternating$' -benchtime=4x -benchmem
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

### Alternating control on the integrated implementation

To reduce process and scheduling differences, `BenchmarkLabelTrendAlternating`
compares the retained legacy SQL path with shared input on one immutable database
in one process. A test-driver hook declines shared-input DDL before execution
for the control; it then runs the ordinary v1.0.5 typed reduction statements.
No source read is performed by that declined statement. This is an additional
SQL-path control, not a second installed module version. Both paths still count,
validate and verify every native bucket. Order alternates between pairs.

| Path | First wall / CPU | Subsequent median wall / CPU |
| --- | --- | --- |
| Legacy typed SQL | 8.438 / 8.567 s | 8.396 / 8.420 s |
| Shared input | 6.561 / 5.498 s | 6.233 / 5.513 s |

The alternating median improved **25.8% in wall time** and **34.5% in CPU time**.
The four-execution means were 8.392 / 6.139 s wall and 8.382 / 5.482 s CPU
(legacy / shared). A separate calibration fixture precedes these four pairs.

- legacy wall: `8.438278, 8.396362, 7.768917, 8.964510`;
  CPU: `8.566808, 8.419640, 8.089851, 8.451605`.
- shared wall: `6.561093, 5.126256, 6.233126, 6.635363`;
  CPU: `5.497947, 5.229268, 5.513365, 5.686482`.

### Separate-version repetitions

The following serial runs use separately compiled v1.0.5 and integrated v1.0.6
binaries, identical modernc/fixtures, and no driver fault hook. Under the later
changing machine load, CPU work decreased while wall medians increased. These
wall figures do **not** establish an end-to-end latency improvement; they are
reported alongside the alternating control rather than selecting faster runs.
Small fixtures used 50 executions, measured earlier in the session.

| Workload | Version | First wall / CPU | Subsequent median wall / CPU |
| --- | --- | --- | --- |
| 972,298 observations | 1.0.5 | 15.342 / 9.402 s | 14.460 / 9.563 s |
| 972,298 observations | 1.0.6 | 9.781 / 6.048 s | 16.368 / 6.289 s |
| Selective: 21,604 observations | 1.0.5 | 2.645 / 2.576 s | 3.246 / 2.606 s |
| Selective: 21,604 observations | 1.0.6 | 5.719 / 1.966 s | 4.546 / 1.883 s |
| Small: 4,000 observations | 1.0.5 | 38.309 / 37.950 ms | 32.655 / 34.701 ms |
| Small: 4,000 observations | 1.0.6 | 22.793 / 22.587 ms | 30.425 / 28.811 ms |
| Small selective: 88 observations | 1.0.5 | 18.954 / 19.189 ms | 18.478 / 15.036 ms |
| Small selective: 88 observations | 1.0.6 | 8.807 / 7.851 ms | 13.102 / 8.610 ms |

Full-fixture CPU median fell 34.2%; the selective CPU median fell
27.7%. CPU sums all threads and can exceed wall time for a short execution.

Full-fixture final repetitions (seconds, first then three subsequent):

- v1.0.5 wall: `15.341857, 17.376245, 14.459723, 13.404681`;
  CPU: `9.401982, 9.437225, 9.570146, 9.562821`.
- v1.0.6 wall: `9.780711, 13.223745, 16.368077, 19.818278`;
  CPU: `6.047924, 6.025331, 6.289122, 6.295699`.
- Selective v1.0.5 wall: `2.645411, 3.015084, 3.245959, 4.025920`;
  CPU: `2.576309, 2.424251, 2.685030, 2.605736`.
- Selective v1.0.6 wall: `5.718775, 4.546017, 2.942051, 5.163670`;
  CPU: `1.965918, 1.933536, 1.733064, 1.883189`.

The final native references took 3.481 / 2.859 s in the baseline process and
4.059 / 2.103 s in the candidate process (day/family, then day). They omit the
executor's validation/response contract and are not alternative implementations.

| Work per full executor execution | 1.0.5 | 1.0.6 |
| --- | ---: | ---: |
| Authorized-source reads, including population count | 3 | 2 |
| Datetime scalar calls | 5,833,788 | 3,889,192 |
| Text field checks | 9,722,980 | 2,916,894 |
| Allocated Go bytes (`B/op`) | 1,184,864,674 | 538,580,034 |
| Go allocations (`allocs/op`) | 62,239,059 | 27,236,079 |

Allocated bytes fell 54.5%; text checks fell 70%. The selective fixture reduces
checks from 216,040 to 64,812. Counters and the single-evaluation test establish
reduced work independently of scheduling. Alternating `B/op` describes a pair
of executions, while the separate-version figures above describe one execution.

The labeled CPU profiles contain five full and five selective executions
(calibration plus final repetitions). Filter `phase=executor` to exclude source
generation and native references. SQLite `_sqlite3MemMalloc` flat samples fell
from 18.27 s to 6.38 s; `_sqlite3VdbeExec` cumulative samples fell from 48.94 s to
30.43 s. Input materialization and callback allocation were reduced; grouping
sorts and independent distinct sets remain. Earlier allocation profiles located
most Go allocation in modernc scalar argument/string conversion and datetime
formatting, motivating fewer validations and filters.

A second benchmark uses 40,000 observations, 18 different top-N/sort consumers
and a day-only denominator. The initial implementation (`81c84c6`) repeated
19 reductions: first 1.041 s; subsequent 1.192, 1.145, 1.379 s (median 1.192 s).
The corrected implementation executes two: first 0.232 s; subsequent 0.216,
0.204, 0.354 s (median 0.216 s). Every returned bucket matches the native
reference. Minimum-count variants and mixed aggregate fusion have separate
regression tests.

Raw logs, CPU profiles and text summaries are attached to the
[v1.0.6 release](https://github.com/Pythia-Software/query-table/releases/tag/v1.0.6).
The changing shared-machine wall times are an explicit limitation. The
alternating control and lower CPU/allocation/callback work support the executor
improvement; no production latency forecast is made.

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
