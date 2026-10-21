# SQLite reductions and caller-owned transactions

For the subsequent 0.9.4 work, see [direct V3 grouping, measurements and residual
V2 costs](sqlite-direct-groups.md). The lifecycle contract below still applies.

This records the Query Table side of the 2026-10-21 Pharos handoff against
Query Table mainline `835b71a` and Pharos `b454ffe`. The changes are prepared
for the aligned 0.9.3 Go/npm release. They are not a claim that either host
accelerator can already be deleted.

## Cross-field V2 scalar metrics (QT-14)

`SQLiteV2Dataset.ExecuteV2` and `ExecuteV2In` now share reductions across scalar
metrics with the same population, scope, metric predicates and grouping.
Independent compilation still validates every member and its aggregate policy.
A combined compiler plan supplies aggregate columns to each original plan using
compiler-owned expression identities; row aliases and parameter positions are
not assumed to match. Each original formula, error sidecar, minCount, ordering,
top-N, fingerprint and response mapping remains independent. Sampled reducers
and paired metrics keep their existing paths. Combined compiler budgets and
statement failures fall back to the individually validated plans.

For plain COUNT, SUM, AVG, MIN, MAX and COUNT_DISTINCT over numeric base fields,
compatible `allMatching` metrics can use a speculative integer reduction. Every
consumed value must have INTEGER/NULL storage and each field/group's absolute
total must fit 9,007,199,254,740,991. A checked SUM substitutes a REAL zero for
any declined input; an INTEGER/NULL aggregate result therefore proves that all
inputs met its domain. A nonnegative plan can prove the absolute bound directly
from that checked SUM, without a separate absolute-total aggregate. Signed
integers use an additional absolute-total guard. Fractions and unsupported
storage retain the general exact decimal path. In particular, numeric-looking
TEXT is never accepted through SQLite's automatic SUM coercion.

The executor asks SQLite to EXPLAIN the authorized narrow input in the current
transaction. A closed allowlist of simple stored-column/index/filter operations
permits a direct reduction without copying the raw input. Functions (including
functions hidden inside views), virtual tables, scalar subqueries, arithmetic,
sorting and unknown opcodes retain materialization. Inspection failure retains
the conservative path; it never authorizes SQL or replaces a value guard. Opaque
host expressions still evaluate once within an eligible reduction.

Text/enum keys use BINARY grouping, so the exact string/NULL value can be
validated once per group. Boolean storage still validates every row: SQLite's
numeric grouping can merge INTEGER 1 and REAL 1.0. No column declaration,
sample, cached bound or host trust flag replaces a storage/numeric guard.

If any guard declines, the general exact decimal reduction runs instead. This
includes REAL values, invalid storage, excessive absolute totals, unsafe or
cancelling integers, unsupported key types, computed inputs, inherited error
sidecars, row formulas and shown-row windows. General fusion still applies to
eligible scalar formulas and computed fields. A fast-path failure does not
turn into a sibling metric's error. Source authorization, the population
preflight, revisions, group budgets and cancellation remain enforced.

No API or request change is needed. Hosts should batch compatible cards into
one ordinary metric request, upgrade the Go module and all npm packages to the
same published release, and run their own parity and cost tests before deleting
a bypass. Do not replace a published dependency with these source files.

## Portable measurements

Run from `backends/sqlite-tests`, using the checked-in synthetic fixtures:

```sh
go test -run '^$' -bench CrossFieldV2 -benchtime=3x -benchmem -count=3
go test -run '^$' -bench V3SimpleGrouping -benchtime=3x -benchmem -count=3
go test -run '^$' -bench SQLiteScratchLifecycle -benchtime=3x -benchmem -count=3
```

The fixture has 50,000 authorized rows, nine integer fields, NULL/empty text
keys, five groups, and a denied tenant row. There are no host indexes, cubes or
private catalogs. V2 compares ten independent cards in one transaction, the
combined adapter batch, guarded SQL alone, and native SQL. The guarded SQL
ablation isolates the strict storage/numeric proofs from compilation, population
preflight, savepoints, consumer mapping and scratch lifecycle. It is a cost
breakdown, not another supported executor. The native query intentionally omits
the adapter's validation and budgets: it is a lower bound on cost, not a
semantically equivalent replacement. Every benchmark includes one untimed
warmup. CPU is process user+system time; allocation counts include Go compiler,
driver and reducer work. Wall times are sensitive to other work on the machine.

`temp-bytes-highwater` is SQLite TEMP database page_count × page_size on the
reused connection. It does not include transient CTE B-trees or prove how many
bytes SQLite wrote to disk. Correctness tests count submitted reduction
statements and source-function evaluations separately from population checks;
neither number is called a physical table-scan count. No test asserts latency.

### V2 before/after

Medians of three runs of three timed operations on the same Apple M3 Ultra,
Go 1.25 and modernc SQLite 1.59.0. “Before” is mainline `835b71a` with the same
benchmark fixture. Wall latency varied with other work on this host; process
CPU and allocations give the more stable comparison.

| Shape / execution | Wall ms/op | CPU ms/op | Go MB/op | Allocs/op |
|---|---:|---:|---:|---:|
| Scalar independent, candidate | 435 | 436 | 22.58 | 1,805,312 |
| Scalar batch, before | 381 | 383 | 22.25 | 1,804,494 |
| Scalar batch, initial candidate | 110 | 105 | 0.93 | 7,002 |
| Scalar batch, follow-up | 114 | 54 | 0.96 | 7,221 |
| Scalar native SQL, candidate fixture | 19 | 18 | 0.002 | 51 |
| Grouped independent, candidate | 1,103 | 1,084 | 56.72 | 5,179,445 |
| Grouped batch, before | 1,203 | 1,036 | 56.21 | 5,178,537 |
| Grouped batch, initial candidate | 253 | 165 | 2.87 | 177,138 |
| Grouped batch, follow-up | 101 | 95 | 1.20 | 8,839 |
| Grouped native SQL, candidate fixture | 46 | 46 | 0.003 | 95 |

The initial candidate (`3cd14ec`) cut batch CPU by approximately 3.7× scalar /
6.3× grouped. The follow-up applies the generic lessons from the host reducer:
prove multiple invariants with one checked aggregate, validate exact text keys
at the group boundary, and materialize only sources whose resolved programs
need it. CPU falls to about 54/95 ms: approximately 7.1× scalar / 10.9× grouped
relative to mainline. Grouped allocation counts fall another 20× versus the
initial candidate. Follow-up wall times were affected by host contention; the
CPU reduction should not be read as a measured scalar wall-time improvement.
The reduced TEMP table high water is 8,192 bytes;
the baseline reports zero TEMP database pages because its intermediate work
uses transient CTE storage, which this counter does not measure. The candidate
still costs more than bare SQL. These numbers support the library optimization,
not an assertion that Pharos's cached/indexed host reducer is redundant.

A same-run comparison after the follow-up measured these median CPU costs:

| Execution | Scalar ms/op | Grouped ms/op |
|---|---:|---:|
| Bare native SQL | 16.5 | 46.6 |
| SQL with strict storage/bounds/key proofs | 39.2 | 81.7 |
| Complete adapter batch | 54.5 | 90.0 |

This locates much of the remaining cost in the value proofs, rather than
compilation or per-card mapping. It does not prove those costs cannot improve.
The host's narrower nonnegative reducer motivated the aggregate-level proof;
the library retains an explicit storage guard because SUM can coerce numeric
TEXT. Source-generation caches remain host-owned and were not used in this
probe.

### V3 raw-source staging investigation

`BenchmarkV3SimpleGrouping` uses the same authorized source for ordinary V3 and
native SQL: text keys, COUNT, COUNT(field), SUM and AVG. It additionally measures
typed SourcePlan evaluation plus copying (`source-copy`), and a copy of already
typed rows (`typed-copy`). The latter isolates the cost of copying values from
the much larger cost of evaluating their typed projection.

On an Apple M3 Ultra, Go 1.25, modernc SQLite 1.59.0, the initial three-run
measurement gave approximately 439 ms CPU for ordinary execution, 162 ms for
projection plus copy, **19 ms for copying already typed rows**, and 33 ms for
bare SQL. Ordinary execution's TEMP high water was 1.32 MB. The 2.63 MB
`typed-copy` high water includes the retained normalized fixture and its copy.

Copying alone was about 4% of ordinary CPU in this fixture. The 162 ms number
must not be attributed entirely to copying: it includes validation and typed
expression evaluation. This supports keeping the general staging strategy for
now. A direct plan would need to reduce validation/projection work too, while
preserving byte guards, source totals, errors, expensive-expression reuse and
snapshot semantics. Simply substituting a view or rereading the source would
not establish that. There is no new direct V3 API in this change, and this
measurement does not justify removing Pharos's `nativeGroupedRows`.

The existing V3 SQLite parity suites continue to cover NULL/empty groups,
HAVING, tie ordering, paging, metrics over matching/shown groups, authorization,
revisions, representatives, expensive inputs and execution budgets.

## Supported SQLite scratch lifetime

A successful `ExecuteV2In` or `QueryDatasetV3.ExecuteIn` returns after dropping
its own scratch tables and indexes. Tables created for speculative reductions
are registered **before** DDL: an interrupted CTAS can leave an empty table.
Cleanup uses an independent, bounded context. Cleanup errors are returned;
V3 previously discarded errors from DROP, including its representative-row
table. No cleanup hook is necessary. Objects owned by the host are untouched.

The host may **commit a successful query transaction** after the call returns
nil. TEMP DDL and cleanup do not end the main database snapshot: definitions,
source guards, grouping and result reads all use the caller's same transaction.
The transaction must allow TEMP DDL; do not turn on `PRAGMA query_only` for this
execution. The query is read-only with respect to the main source, but the
adapter cannot prevent unrelated host code from writing in the transaction.

```go
conn, err := db.Conn(ctx)
if err != nil { return err }
defer conn.Close()

// Configure connection-local storage/cache policy before BeginTx, if needed.
// Prefer a stable policy on an appropriate dedicated connection or pool.
tx, err := conn.BeginTx(ctx, nil)
if err != nil { return err }
defer tx.Rollback()

result, err := dataset.ExecuteIn(ctx, tx, request, options)
if err != nil { return err } // Roll back, including after cancellation/cleanup failure.
if err := tx.Commit(); err != nil { return err }
// Publish/use result only after the commit succeeds.
_ = result
```

Use the analogous pattern with `SQLiteV2Dataset.ExecuteV2In`. A metric's
clause-level error is part of a successful V2 result after its savepoint has
been restored; a non-nil execution error requires rollback. SQLite interruption
can abort a transaction. Do not assume a cancelled transaction remains usable,
and do not commit other host operations after an execution/cleanup error.

The adapter never changes `temp_store`, temp cache sizes or other PRAGMAs. The
host still owns leases, pools, deadlines and restoring any settings it changes.
Changing `temp_store` destroys existing temporary objects and can cause schema
work, so it should not be a routine cleanup mechanism. File-backed storage and
small temp caches remain supported; byte, population, group and sample guards
are unchanged. TEMP page counts alone do not verify actual disk spill.

`TestSQLiteScratchCommitLifecycle` runs staged grouping and representatives on
one reused connection with 578 schema objects under FILE and MEMORY storage,
checks that no adapter objects/settings leak, preserves a host-owned TEMP table and
commits each successful request. Cleanup-failure injection and cancelled staged
requests verify rollback and subsequent connection reuse. Existing WAL snapshot
tests cover reads across a concurrent writer. The lifecycle benchmark compares
commit, rollback and cancellation, includes the next catalog query, and reports
its latency separately. The driver does not expose sqlite3_stmt_status's
REPREPARE counter, so these are latency/CPU observations, not schema-reload counts.

On the same machine, the 20,000-row lifecycle fixture with 578 additional
schema views and a 32 KiB FILE temp cache measured about 133 ms CPU for a
successful committed request, 133 ms with rollback and 110 ms for cancellation
during group-table creation. The next catalog read was about 41 microseconds
after commit, 1.03 ms after rollback and 1.07 ms after cancellation/rollback.
These are workload-specific observations, with warmup excluded. TEMP high water after commit was 471,040 bytes. Zero pages
after rollback does not mean the request performed no temporary work.

Pharos must separately change its unconditional rollback and per-request PRAGMA
lifecycle before it can benefit from successful commits. This does not change
Pharos's connection policy or approve committing any failed query transaction.

## Host integration gate

Use Pharos's explicit local-development workspace mechanism for prepublication
parity testing; leave its release pins and installed packages unpatched. Run
`TestNativeMetricsMatchTheAdapter`,
`TestNativeMetricsMatchTheAdapterOnPharosDatasets`, and
`TestQueryV3NativeGroupsMatchGeneralExecution` against the candidate library.
All three named parity tests passed on Pharos `b454ffe` against this candidate,
using its documented local Go workspace. Release pins and installed npm packages
were left unchanged. A disposable 50,000-row, nine-integer-column SQL probe in
that checkout, with the same authorized source and no cubes/indexes, measured
the native host reducer at 24.5 ms scalar / 50.2 ms grouped and ordinary adapter
execution at 60.7 ms / 93.5 ms after the follow-up (three warm wall-time samples). The adapter was
called directly with nativeMetrics disabled; these timings do not include the
full HTTP/host transaction lifecycle or generation-bound caches. This confirms
remaining overhead of roughly 2.5× scalar / 1.9× grouped on that fixture;
the initial candidate's roughly 3× gap was not an irreducible generality cost.
No host bypass is deleted here.
The reproducible upstream benchmark is the checked-in counterpart; the
throwaway host probe is not required to run it.

Before deleting a bypass, measure full host SQL requests with nativeMetrics
disabled, host cubes disabled and the same authorized source. The portable native SQL timings do not replace that
comparison. After publication, pin the matching release and run Pharos's full Go
and frontend gates before deleting only the proven redundant host reductions.

Publication uses the existing aligned release workflow in [RELEASING.md](../RELEASING.md):
merge a reviewed release-ready change to main, run the clean-checkout gate, and
publish the root tag plus its automatically aligned Go module tag. This document
and the benchmarks are not evidence of registry publication or host migration.
