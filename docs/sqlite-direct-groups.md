# SQLite grouped execution after 0.9.3

The aligned 0.9.4 release adds a compiler-owned direct reduction to ordinary
`QueryDatasetV3.Execute` / `ExecuteIn`. Hosts keep the authorized source and
original V3 request; there is no precomputed input, request rewrite or new API.

## Eligibility and guarantees

Plain COUNT, numeric COUNT(field), SUM, AVG, MIN, MAX and COUNT_DISTINCT with
text/enum keys can share V2's guarded integer reducer. The complete request
first passes `SourcePlan`, including aggregate policies, revisions, token and
snapshot checks and compiler budgets. EXPLAIN must resolve the narrow source
to the existing closed stored-column opcode allowlist. Functions, including
functions inside views, expressions, virtual tables and unknown opcodes retain
the general executor.

The reduction proves INTEGER/NULL storage and exact absolute totals within
9,007,199,254,740,991. Nonnegative checked SUMs combine storage and bounds proofs;
signed inputs retain the absolute-total check. Declined domains and statement
failures fall back to exact general execution. Fractions, unsafe/cancelling
integers, numeric-looking TEXT, invalid storage, computed inputs, formulas,
representatives and samples keep its numeric results and diagnostics.

The direct statement also counts source rows, measures the same narrow UTF-8
value payload, and validates source text identities. Text/enum keys validate
once per exact BINARY group; NULL and empty keys remain distinct. Input is
bounded by population budget plus one, and staged output by group budget plus
one. Any population, byte or group budget failure returns no partial result.
There is no complete source copy. SQLite's internal sorting space remains
host-managed, including disk spill; the byte budget describes value payload,
not all engine scratch.

The ordinary group finalizer still produces identities/schema, HAVING, stable
tie ordering, result paging and both metric scopes. Source paging never changes
membership. All work uses the caller's snapshot. Scratch ownership precedes
DDL and cleanup errors prevent success. Commit only nil-error executions;
roll back failures. The [0.9.3 lifecycle contract](sqlite-performance-handoff.md)
and ownership boundary are unchanged.

## Portable measurements

From `backends/sqlite-tests`:

```sh
go test -run '^$' -bench V3UsageGroups -benchtime=3x -benchmem -count=3
go test -run '^$' -bench 'CrossFieldV2/grouped=.*/(batch|guarded-sql|native)$' -benchtime=3x -benchmem -count=3
go test -run '^$' -bench V3SimpleGrouping -benchtime=3x -benchmem -count=3
```

Measured 2026-10-21: Apple M3 Ultra, 96 GiB RAM, macOS 15.7.3, Go 1.27.1,
modernc SQLite v1.59.0; one reused connection to a temporary file database.
Each benchmark discards one warmup then times three operations. These are
medians of three runs. Final V3 runs experienced heavy shared-machine load
(load average reached 119 on 28 logical CPUs), so wall times are not a latency
guarantee. CPU is process user+system time, including Go/driver
work. Allocations are Go allocations. No unit test asserts latency.

`V3UsageGroups` reproduces the consumer shape: 50,000 authorized facts, text ID,
five day keys, provider and nine integer fields. n0 is the sum of eight
`(ordinal+i)%7` category counts. A denied tenant row stays outside the source;
the codex filter matches 30,000 rows. COUNT/SUM/AVG produce a two-group page,
COUNT over matching groups and SUM(messages) over shown groups. Source limit
1/offset 100 still yields total 50,000, five groups and 20,000 shown messages.

The `general` test driver declines EXPLAIN, selecting the existing typed
executor for exactly the same authorized source, arguments and request. The
ordinary candidate needs no host intervention.

| V3 usage execution | Wall ms/op | CPU ms/op | Go MB/op | Allocs/op | TEMP high water |
|---|---:|---:|---:|---:|---:|
| General, 50,000 rows | 1,080.3 | 445.9 | 29.38 | 2,005,291 | 1,613,824 B |
| Ordinary direct, 50,000 rows | 310.9 | 84.9 | 3.32 | 204,373 | 16,384 B |
| Bare SQL, 50,000 rows | 118.4 | 39.0 | 0.002 | 55 | 0 B |
| General, provider filtered | 347.4 | 241.7 | 17.82 | 1,205,099 | 970,752 B |
| Ordinary direct, provider filtered | 98.9 | 49.0 | 2.16 | 124,370 | 16,384 B |
| Bare SQL, provider filtered | 43.0 | 20.8 | 0.002 | 59 | 0 B |

The existing `V3SimpleGrouping` baseline on 0.9.3 measured 379 ms wall,
395 ms CPU, 29.85 MB and 2,278,556 allocations/op before heavy load. The final
candidate measured 179 ms wall, 74.7 ms CPU, 3.31 MB and 204,384 allocations/op.
Those wall times span different machine loads; use the same-run general/direct
comparison above and CPU/allocations to assess the change. The earlier copy
ablation measured about 17 ms for already typed rows; removing that copy alone
cannot account for the reduction in CPU.

TEMP high water is `temp.page_count * temp.page_size`; it excludes transient
CTE/sorter storage and does not measure disk bytes written. Bare SQL omits
storage/encoding/numeric proofs, budgets, revisions, identities, schema,
response mapping and result metric payloads. It is only a cost lower bound.

Statement timings include execution, row stepping and close, but exclude Go
compilation/mapping. In the final unfiltered runs, general typed source
preflight/projection took about 682 ms wall and grouping 281 ms. Direct source
proofs/bytes/grouping fuse into one approximately 306 ms wall statement and
cannot be independently timed. EXPLAIN took 0.09 ms, identity/group finalization
1.8 ms and result metrics 0.6 ms (general: 1.1 ms). Cleanup fell from about 1 ms
to 0.06 ms. These phase wall times include scheduler delays under contention.
Remaining SQL includes staged validation and result reads. The benchmark prints
each category alongside full wall/CPU cost.

## Residual V2 cost

V2 retains 0.9.3 sharing, error isolation, final formulas, sorting, top-N,
minCount and scope/window handling. Its arithmetic was not weakened. A trial
sharing row-domain checks with native SUMs showed no consistent grouped benefit
and was discarded. The ten-card COUNT + nine SUM fixture measured:

| V2 execution | Scalar wall / CPU ms | Grouped wall / CPU ms |
|---|---:|---:|
| Full adapter | 48.3 / 48.5 | 98.0 / 94.8 |
| SQL with storage/bounds/key proofs | 39.6 / 39.6 | 102.1 / 89.4 |
| Bare SQL | 17.1 / 16.7 | 48.1 / 47.5 |

Grouped wall time varied under contention; the guarded row does not establish
that the adapter is faster than its reduction. Full adapter allocations are
about 0.96/1.19 MB and 7,221/8,839 allocations for scalar/grouped batches.
Guarded SQL omits compilation, population preflight, revision verification,
savepoints, mapping and scratch lifetime. Bare SQL additionally omits value
proofs. No generation bounds/count cache is used. Much of the residual cost
pays for checking arbitrary authorized values each execution; generation
caches remain a host guarantee, not a library assumption.

Tests count submitted reductions and source-function evaluations separately;
neither measures physical scans. The V3 opaque-source test verifies the same
function evaluations as the general executor; EXPLAIN performs none. Existing
V2 reuse, exact decimal, lazy-branch and independent-error suites still apply.

## Consumer decision

The unmodified published 0.9.3 Pharos baseline `19ad3109` was reproduced using
Node 24.22.0, Go 1.26.8 and modernc SQLite 1.39.1. Full HTTP medians:

| Workload | Host accelerator | Ordinary 0.9.3 |
|---|---:|---:|
| V2 scalar | 14.6 ms | 44.4 ms |
| V2 grouped | 29.7 ms | 64.0 ms |
| V2 provider filtered | 31.8 ms | 67.6 ms |
| V3 grouped page and metrics | 35.5 ms | 343.8 ms |

These include existing host staging/transaction policy. This release does not
drop host tables, change connection settings or add another cleanup hook.
Measure the host policy migration separately. Portable results materially
reduce V3's gap, but do not establish host-comparable V2 latency. Delete host
accelerators only after consumer parity/performance acceptance. Upgrade normal
published artifacts together; do not patch installed packages or module caches.

See [preview transport migration](computed-columns.md#modern-row-transports)
for the independent frontend change.
