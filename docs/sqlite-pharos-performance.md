# SQLite performance on the real Pharos catalog

Measured 2026-11-07 against adapter baseline
`0ae0f78bbd985c4b06aa7536a18e8bab131fbf60` and Pharos source
`a9f395209d9712d9ec681660b1e0b09cc7a64532`. These are local development
changes; consuming them in Pharos requires the normal aligned release upgrade.

## Data and workload selection

The isolated library is `/Volumes/euclid/pharos-dev-sqlite-performance`.
It was created from `/Volumes/euclid/Pharos` using Pharos's `tools/dev.py`
destination validation and refresh implementation. The catalog used SQLite's
backup API with a read-only source connection, including committed WAL data.
Capture/preserved files used APFS clones. The copy has the `.pharos-dev` marker
and development configuration with sync disabled. Its private configuration and
records are not included in this repository. No server is left running.

| Snapshot property | Value |
|---|---:|
| Catalog file bytes | 110,637,600,768 (about 103 GiB) |
| Raw `tool_calls` | 1,899,334 |
| Calls after mirrored-work exclusion | 1,240,973 |
| `tool_usage_daily` | 85,664 |
| `tool_mirror_workspaces` | 6,414 |
| Raw call date range | 2025-08-09–2026-11-07 |

Pharos's `internal/archive/tool_table.go` defines two particularly useful
populations: raw tool calls and the daily Tools summary. The raw dataset uses
optional joins, page indexes, a covering analytics index, timestamp buckets,
and `workspace_id NOT IN (SELECT workspace_id FROM tool_mirror_workspaces)`.
Dashboard cards request counts, durations and formula metrics; grouped tables
combine provider/tool/status dimensions, summary formulas and representative
rows. Daily summaries offer a smaller population but include fractional token
values. Host cubes, native reducers and generation caches provide separate
accelerators; these measurements exercise the reusable adapter without them.

`BenchmarkPharosSQLite` reproduces those query shapes with narrow stored-column
projections and the actual mirrored-work exclusion. Raw queries use the existing
`tool_calls_analytics_idx` covering index. They do not traverse unused joins,
load transcript bodies or scan the whole 103 GiB file. The formula-batch case
uses twenty variations of `SUM(duration_ms)+constant` to exercise shared leaves;
it is a workload-shaped stress case rather than a captured dashboard request.
Calendar grouping uses months in `America/Denver`. Representative rows select
the longest duration per provider. All requests have a fixed clock and a
50-row result limit, with full-population aggregates.

## Retained implementation changes

* **Use guarded integer reductions for singleton metrics, identical-input
  batches and aggregate-leaf formulas.** COUNT, numeric COUNT(field), SUM,
  AVG, MIN, MAX and COUNT_DISTINCT leaves can reuse native SQLite reductions
  after proving INTEGER/NULL storage and safe exact totals over the complete
  consumed population. Final formulas, lazy error sidecars, minCount, ordering
  and independent metric errors remain in the original compiled consumers.
  Decimal and unsupported domains retain the general exact reducer. Newly
  eligible paths require stored-source inspection so a failed speculation
  cannot repeat an opaque host expression.
* **Accept indexed membership probes during stored-source inspection.**
  SQLite EXPLAIN's `Found` and `NotFound` instructions are read-only index
  membership probes. Accepting them unlocks direct groups for Pharos's normal
  mirrored-work exclusion. Function calls, virtual tables and unknown
  instructions still decline the closed allowlist. This follows SQLite's
  [opcode definitions](https://www.sqlite.org/opcode.html#Found).
* **Allow eligible formula summaries in direct V3 groups.** Their aggregate
  leaves use the same guarded reducer. Full request validation, source byte
  and population budgets, identity checks, HAVING, result paging and both
  metric scopes retain the ordinary executor's behavior.
* **Reuse the authorized population count for plain COUNT().** Ungrouped
  `allMatching` COUNT() without its own predicate, grouping, paired expression,
  distribution or measured minimum consumes the count already obtained in the
  same transaction. The compiler still applies minCount and the result envelope.
* **Assign bounded calendar keys in one SQL update.** Canonical staged UTC
  timestamps sort in instant order. Compute exact Go timezone boundaries once
  and use a balanced CASE tree to assign keys within SQLite, instead of
  transferring and rebinding every timestamp in 400-row batches. NULLs stay
  NULL. At most 256 boundaries and 511 parameters are used. Wide or unsuitable
  ranges fall back to the existing per-row algorithm. Both paths use the same
  calendar floor/next/slot functions, including DST and skipped civil dates.
* **Stage SQLite calendar rows with an INTEGER PRIMARY KEY ordinal.**
  INSERT SELECT supplies unique row ordinals without a full-source
  ROW_NUMBER wrapper and extra ordinal index. Payload columns have no affinity
  so the typed projection's storage classes survive. PostgreSQL keeps its
  existing window strategy. Scratch registration, budget checks and cleanup
  ownership are preserved.

These changes do not introduce a persistent cache, create main-database
indexes, change host connection PRAGMAs or assume declared types prove values.
All execution stays in the caller's transaction and authorized source.

## First-pass measurements

Apple M3 Ultra, 96 GiB RAM, macOS 27.0.1, Go 1.27.1,
modernc SQLite module v1.59.0 in the adapter fixture module. The separate
Pharos integration tests select its v1.61.0 through a disposable Go workspace.
The Python SQLite version in the snapshot manifest is not the Go engine version.

The benchmark opens the main database read-only, uses one connection, FILE
temporary storage, a 32 MiB main page cache and 256 MiB mmap. Each case discards
one untimed warmup. Baseline cells are one timed operation; candidate cells
are the mean of three timed operations. Runs shared the machine with other
work, so these observations are not stable latency guarantees or statistically
controlled speedup estimates. CPU is process user+system time. JSON serialization
and result hashing are included. These are adapter executions, not HTTP timings.

| Workload | Baseline wall s/op | Candidate wall s/op | Baseline CPU s/op | Candidate CPU s/op |
|---|---:|---:|---:|---:|
| COUNT() | 1.874 | 0.918 | 1.871 | 0.920 |
| Scalar SUM(duration) | 2.812 | 1.955 | 2.815 | 1.957 |
| SUM(duration) by provider metric | 4.298 | 2.743 | 4.301 | 2.550 |
| Twenty formula metrics by provider | 4.100 | 3.019 | 4.211 | 2.773 |
| Provider groups with COUNT/SUM | 9.654 | 2.462 | 10.141 | 2.435 |
| Provider groups with average formula | 9.791 | 2.225 | 10.241 | 2.250 |
| Provider/tool/status groups (312) | 17.259 | 3.483 | 17.530 | 3.541 |
| Calendar month groups (17) | 268.700 | 19.191 | 245.132 | 17.187 |
| Daily summary, integer duration groups | 0.094 | 0.095 | 0.102 | 0.100 |
| Daily summary, fractional token groups | 1.572 | 1.371 | 1.143 | 1.178 |

The calendar result reflects two independently measured improvements: boundary
assignment first reduced wall time to about 33.7 seconds, then ordinal staging
reduced it to 19.2 seconds. Daily summaries show no clear CPU improvement; the
fractional case deliberately exercises exact fallback.

| Workload | Baseline Go allocations/op | Candidate Go allocations/op | Baseline Go MB/op | Candidate Go MB/op |
|---|---:|---:|---:|---:|
| Scalar SUM | 7,034,552 | 1,698 | 76.5 | 0.22 |
| Provider groups | 52,540,904 | 4,967,064 | 884.4 | 119.7 |
| Provider/tool/status groups | 92,421,084 | 5,128,943 | 1,380.5 | 121.0 |
| Calendar months | 733,022,782 | 61,425,234 | 4,202.1 | 1,340.7 |

These are cumulative Go allocations, not peak resident memory, SQLite scratch
space or disk bytes written. The large calendar allocation total is still a
meaningful remaining cost.

Bare SQL lower-bound runs measured count, count+sum, provider groups and
provider/tool/status groups at 1.180, 2.270, 2.541 and 4.897 wall seconds/op;
CPU was 1.019, 1.242, 1.741 and 3.263 seconds/op. They omit adapter validation,
exact arithmetic guards, budgets, identities, revisions and result envelopes.
Scheduling and different statement counts affect these comparisons; faster
adapter wall samples do not establish that the adapter beats bare SQL.

In the first pass, an experimental representative identity reduction using COUNT(DISTINCT) and
conditional MAX did not produce a convincing wall improvement (35.37 seconds
baseline versus 37.05 seconds for the trial), so it was removed. Representative
rows retained the original window implementation in that pass. That path was measured
separately: one timed operation took 171.82 wall / 41.98 CPU seconds, with the
same result hash. The large wall/CPU gap and unchanged representative algorithm
illustrate the different shared-machine conditions in this later run; no
representative speedup or isolated performance regression is established.
The follow-up below uses a different representation of the identity check and
retains it after fresh measurements.

CPU profiles were dominated by SQLite B-tree/page access and system calls
(roughly 84–86% of sampled flat CPU). Typed staging and representative sorting
remain expensive. For broad analytic queries, the next useful areas are
reducing typed datetime conversion/materialization and representative windows;
fractional exact reductions need their own profiling. Pharos's existing
covering indexes, selective time ranges and host rollups remain valuable.

## Correctness and validation

All eleven workload result hashes match the original adapter: rows, metrics,
source population and result totals. The benchmark also checks that each
repetition returns the same hash, without printing source records. The retained
representative rerun is checked against the same baseline hash.

Additional fixtures compare optimized and forced-general execution for signed,
fractional, unsafe, text and NULL inputs; lazy formulas; measured minCount;
indexed IN/NOT IN sources; malformed storage; and opaque expression evaluation
counts. Calendar tests compare bounded assignment with forced wide-range
fallback through Denver DST, Lord Howe, Adelaide and Apia transitions, retaining
sub-millisecond timestamps, NULLs and calendar metric/group parity. Scratch
lifetime, budgets and cancellation tests continue to pass. Representative
fixtures also check invalid identities outside the chosen row.

First-pass validation completed: backend Go tests/race/vet; full SQLite tests/race/vet;
retained representative/calendar/date-grouping race tests; TypeScript SQLite
typecheck and parity tests (1,470 tests); package builds; and focused Pharos V3,
metric/full-scan and usage parity tests against the development overlay.
The full SQLite race run took 461 seconds; a separate retained-path race run
passed after the representative trial was reverted. Pharos production source,
installed dependencies and module caches were not patched.

## Follow-up: expensive staged queries

The second pass freezes the first-pass source in
`.context/sqlite-performance/round2-base/` and measures the same unchanged
catalog. `round2-before.txt` records one timed operation per expensive shape;
`round2-final.txt` records three timed operations per shape. Both discard a
warmup. The same shared-machine limitations apply. Optional `QT_PHAROS_PHASES=1`
reports statement categories, including row stepping and warmup time; it never
logs SQL arguments or records. Final benchmark timings omit phase instrumentation.

Additional retained changes:

* **Inline cheap source validation after proving the raw source is stored.**
  The executor inspects the actual projection and source predicates using
  EXPLAIN, then recompiles only the narrow source projection with existing
  bounded inlining rules. It retains typed storage, encoding and byte checks.
  Functions, views hiding functions, virtual tables and computed projections
  keep their original evaluation boundaries. Token/snapshot callbacks and
  computed resolvers are not invoked again by this recompile.
* **Avoid datetime JSON on the common valid path.** The new
  `qt_v2_datetime_value` descriptor returns the same canonical timestamp directly;
  `qt_v2_datetime_error` is called only for a nonnull input that did not yield a
  timestamp. Both share the original decoder, including empty strings,
  malformed storage, unix fractions and UTC canonicalization. The value remains
  materialized once per source execution. Register the complete current
  `SQLiteV2Functions()` list at connection startup when adopting the change.
* **Reduce integer summaries from already-staged rows.** Calendar and
  representative queries can use the guarded reducer after staging, including
  canonical datetime keys. Error sidecars must all be NULL for the native result
  to be consumed; otherwise the original reduction runs. A bounded probe may
  reject a fractional domain or skip the nonnegative attempt, but never proves
  acceptance: complete storage and exact-total checks still cover every row.
  A failed direct proof is not repeated over the same staged domain.
* **Keep one representative ranking window.** A separate narrow grouped
  relation proves `COUNT(DISTINCT typed_id)=COUNT(*)` for every typed key/error
  tuple. This catches missing and duplicate IDs even outside the chosen rows.
  The rank-one rows join those proofs without carrying payloads through the
  previous three identity windows. Ordering, descending ID ties, NULL behavior,
  case-sensitive IDs and group error distinctions remain unchanged. PostgreSQL
  retains its previous strategy.

| Expensive shape | First-pass code rerun wall s/op | Follow-up wall s/op | Before CPU s/op | After CPU s/op |
|---|---:|---:|---:|---:|
| Calendar months | 15.982 | 14.032 | 16.072 | 13.208 |
| Representative rows | 23.926 | 17.808 | 24.263 | 18.054 |
| Fractional daily summaries | 1.286 | 0.667 | 1.117 | 0.729 |

The follow-up reduced observed CPU by about 18%, 26% and 35% respectively.
Calendar Go allocation volume fell from 1,341.8 to 870.2 MB/op and allocation
count from 61.43 to 45.50 million/op. Relative to the original adapter before
either pass, calendar CPU fell from 245.13 to 13.21 seconds/op. Other direct
group and scalar shapes keep their previous plans; their final timings vary
under machine and I/O load, and no further improvement is claimed for them.

All eleven final result hashes match the original adapter and the frozen
first-pass source. The comparison script asserts this across repetitions.
New fixtures also compare optimized and forced-general execution for all four
datetime storage modes, invalid/empty/NULL values, integer and fractional staged
summaries, long keys and unused negotiated computed revisions. The complete
revision envelope survives source recompilation even when its definitions are
not reached by the narrow projection.

Final follow-up validation passed: backend Go tests/race/vet; full SQLite
tests/race/vet (425.866 seconds for the race suite); SQLite TypeScript typecheck
and all 1,470 parity/frontend tests across 125 files; and focused Pharos V3,
metric/full-scan and usage parity tests with the updated function descriptors.
Evidence is in `round2-checks.txt` and `round2-pharos-final.txt`.

Remaining cost includes complete source validation/normalization and copying,
the representative's sort and exact identity proof, and general decimal
reductions for fractional domains. Host rollups and selective indexed source
filters still avoid work that a full-population adapter execution must perform.

The bounded-source, transaction, cancellation and cleanup guarantees remain in
force. There is no new persistent cache or host PRAGMA change. Follow-up logs,
frozen source, intermediate experiments and the hash-checked comparison are
under `.context/sqlite-performance/round2-*` and `comparison-round2.json`.

## Frequent-query follow-up

This pass prioritizes recurring UI interactions: page loads and page changes,
exact-ID detail lookups, filter-value suggestions while typing, and small card
batches. Pharos's `web/src/index.tsx` configures a 100 ms query debounce;
Query Table's `packages/react/src/useQueryTable.ts` issues rows requests as
filters, sorts and paging change and V3 distinct requests for autocomplete.
Pharos's `web/src/query-previews.ts` already caches previews for 60 seconds and
batches compatible small metric requests. Those host optimizations remain in
place.

There is no measured UI request-frequency distribution in this snapshot. Its
3,030 MCP calls are primarily conversation retrieval (1,714
`get_conversation_messages`, 256 `browse_site`, 201 excerpts and 171 message
searches; only 60 `query_statistics`). These counts do not measure Query Table
UI traffic. The selected workloads therefore reflect repeated source-code
paths, rather than an asserted ranking of production query frequency.

`BenchmarkPharosFrequent` uses the same isolated catalog: 1,240,973 eligible raw
calls and 85,664 daily summaries. It requests 50-row pages with timestamp
descending/ID ascending ordering, uses the host's existing page/analytics
indexes, and reproduces its timestamp and exact-ID candidate pushdown in
`SourceSQL`. Optional `QT_PHAROS_SCHEMA` loads the frozen Pharos schema to
include the full catalog's planning overhead; unused bindings become NULL as
the host's compact projection does. Requests use the actual `utc-millis`
timestamp convention, a fixed clock, and hash the entire result envelope.

Retained changes:

* **Compile SQLite pages once against their complete source dependencies.**
  `SourcePlan` has already validated the full catalog and discovered transitive
  computed, predicate and hidden-sort dependencies. Narrowing before the page
  compilation removes its previous full-schema compile and narrow recompile.
  Base-only COUNT and source projection planning similarly avoid unrelated
  fields and sort bindings. Computed source/filter paths retain graph
  discovery, and the complete negotiated revision envelope is preserved.
* **Search complete stored value counts for bounded text/enum autocomplete.**
  A single grouped scan supplies case-sensitive value counts and the NULL
  bucket. Go lowercases and searches those distinct strings with the same
  Unicode operation as `qt_lower`, then applies count-descending/value-byte
  ordering and the requested limit. This removes row-by-row lowercase calls
  and obtains `hasNull` without the previous separate source query.
* **Decline when the original executor is required.** A closed EXPLAIN
  allowlist proves the relevant raw bindings and predicates read stored
  values; the actual grouping sorter must use BINARY collation. Computed,
  opaque, array and unsupported-collation inputs retain the original path.
  The complete grouped result must fit 4,096 groups and 8 MiB of accumulated
  strings. A 64-row probe can reject a broad domain early, but cannot accept
  or truncate results. Invalid UTF-8, embedded NULs and searched values above
  the scalar function's size limit also fall back, preserving the original
  driver behavior and errors. Builder stage snapshots keep declined attempts
  from pruning the fallback's source bindings. Memory lives only in the
  current request and transaction.

The comparison freezes the preceding implementation under `round3-base/`.
Both builds discard a warmup. The baseline has one timed operation per case;
the candidate has three, except exact-ID lookup, which has 100 in each build.
The initial lookup experiment omitted the host's ID pushdown and is discarded;
`round3-lookup-before.txt` and `round3-lookup-after.txt` are authoritative for
that case. These are adapter timings including serialization, on a shared
machine. CPU and allocation changes are more informative than noisy wall times.

| Recurring shape | Before wall ms/op | After wall ms/op | Before CPU ms/op | After CPU ms/op | Before Go bytes/op | After Go bytes/op |
|---|---:|---:|---:|---:|---:|---:|
| First page | 1,081.3 | 1,049.1 | 1,041.4 | 1,024.6 | 657,688 | 291,370 |
| Next page | 1,062.8 | 1,124.7 | 1,026.4 | 1,039.3 | 655,720 | 292,069 |
| Recent page | 57.4 | 59.0 | 56.8 | 57.4 | 666,600 | 296,698 |
| Exact-ID lookup | 1.54 | 0.58 | 1.81 | 0.83 | 564,017 | 160,341 |
| Provider options, no search | 4,207.6 | 2,581.5 | 3,023.2 | 1,792.4 | 512,488 | 292,528 |
| Provider autocomplete | 2,855.3 | 2,247.9 | 2,751.4 | 1,675.4 | 49,294,496 | 305,410 |
| Tool autocomplete | 2,719.3 | 2,556.2 | 2,551.7 | 1,864.1 | 57,695,024 | 309,666 |
| Status autocomplete | 2,424.1 | 1,528.6 | 2,401.8 | 1,451.5 | 43,051,744 | 281,501 |
| Daily summary page | 1,084.0 | 584.0 | 236.0 | 288.9 | 4,396,192 | 4,352,197 |
| Recent dashboard cards | 117.3 | 114.6 | 115.9 | 114.4 | 1,078,744 | 802,440 |

Exact-ID lookup used about 54% less CPU and 72% fewer allocated bytes. Searched
provider/tool/status suggestions used about 39%/27%/40% less CPU and over 99%
fewer allocated bytes; their allocation counts fell from 3.73/4.46/3.73 million
to 1,986/2,853/1,976 per request. Page planning allocated roughly 56% fewer
bytes, but its exact full-population COUNT still dominates execution. No broad
page latency gain is claimed. The summary-page wall reduction lacks a CPU
improvement, so it is not counted as a retained speedup. Unchanged card reducers
remain near their prior CPU time.

All ten full-envelope hashes match the frozen preceding implementation.
Optimized-versus-general fixtures cover Unicode/case, literal substring
searches, NULL/empty values, no matches, opaque evaluation counts, NOCASE
collation, malformed UTF-8, embedded NULs, oversized text, and a domain whose
first 64 rows hide more than 4,096 later values. Ordinary stored searches also
assert that row-level `qt_lower` calls disappear. Existing page/source suites
exercise hidden sorting, computed dependencies/revisions, scopes, source errors,
cancellation and budgets.

Final validation passed: backend Go race tests and vet; full SQLite race tests
(409.002 seconds) and vet; SQLite TypeScript typecheck; all 1,470
frontend/parity tests across 125 files; and focused Pharos V3,
metric/full-scan and usage parity tests (6.274 seconds). Evidence is in
`round3-backend-checks.txt`, `round3-checks.txt`, `round3-sqlite-tests.txt` and
`round3-pharos.txt`. The comparison script verifies all ten full-envelope
hashes, including the corrected lookup benchmark.

PR preparation also passed the complete `npm run check` gate: generated-wire
verification, all package builds and source/example/demo typechecks, the root
Vitest suite, backend Go tests/vet, and the SQLite race/vet/typecheck/parity
suite. Its log is `pr-checks.txt` in the local artifact directory.

No persistent result/count cache, main-database index, host PRAGMA or production
dependency change was added. Remaining autocomplete cost includes exact
full-population counting and grouping. Cross-request reuse would need a
host-owned data-generation and authorization key to preserve snapshot and
scope semantics; it is not inferred by the adapter.

## Reproduction and artifacts

From `backends/sqlite-tests`, point the opt-in benchmark at an isolated snapshot
created by Pharos `tools/dev.py`; the harness requires its `.pharos-dev` marker.
It never initializes or migrates the main database. Allow several minutes per
full run, especially for the original calendar implementation.

```sh
QT_PHAROS_CATALOG=/Volumes/euclid/pharos-dev-sqlite-performance/catalog/catalog.sqlite3 \
  go test -run '^$' -bench '^BenchmarkPharosSQLite/' -benchtime=3x -benchmem -v

QT_PHAROS_CATALOG=/Volumes/euclid/pharos-dev-sqlite-performance/catalog/catalog.sqlite3 \
  go test -run '^$' -bench '^BenchmarkPharosSQLiteNative/' -benchtime=3x -benchmem

# Frequent shapes; QT_PHAROS_SCHEMA is optional and points at the frozen
# Pharos schemas/tool_calls.schema.json to include full-catalog planning cost.
QT_PHAROS_CATALOG=/Volumes/euclid/pharos-dev-sqlite-performance/catalog/catalog.sqlite3 \
QT_PHAROS_SCHEMA=/path/to/pharos/schemas/tool_calls.schema.json \
  go test -run '^$' -bench '^BenchmarkPharosFrequent$' -benchtime=3x -benchmem -v
```

For baseline comparison, export the baseline commit into a clean disposable
directory, copy only `backends/sqlite-tests/pharos_benchmark_test.go` from this
change, and run the same command against the same snapshot. Do not overwrite
the working tree or alter Pharos's installed dependencies.

Local, gitignored artifacts are under `.context/sqlite-performance/`:

* `snapshot.json`: data counts, source path and commit provenance.
* `real-baseline-initial.txt`, `real-candidate-final.txt`: measured workloads
  and result hashes. The latter includes the discarded representative trial;
  use `real-representative-retained.txt` for that workload instead.
* `real-native.txt`: bare SQL cost floors.
* `comparison.json`, `summarize.py`: parsed results with cross-build hash checks.
* `real-candidate-initial.cpu`, `real-candidate-final.cpu`, corresponding
  benchmark binaries and `candidate-sample.txt`: CPU/native profiles.
* `pharos-source/`, `pharos.work`, test/build logs: disposable integration
  checkout and validation evidence. The original `~/gbdubs/pharos` is unchanged.
* `round3-frequency.json`: available MCP counts and the UI-frequency limitation.
* `round3-before.txt`, `round3-after.txt`, `round3-lookup-before.txt`,
  `round3-lookup-after.txt`: frequent-query measurements; the dedicated lookup
  files supersede the initial lookup timings.
* `summarize-round3.py`, `comparison-round3.json`: all ten full-envelope hash
  comparisons and timings against the frozen preceding implementation.
* `round3-checks.txt`, `round3-backend-checks.txt`, `round3-pharos.txt`:
  final race/vet/typecheck, frontend/parity and consumer validation logs.

The snapshot is intentionally frozen for repeatability. Refresh it explicitly
through Pharos's development tooling before measuring newer data.
