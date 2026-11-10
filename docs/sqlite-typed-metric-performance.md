# SQLite typed metric performance

The guarded native reducer previously accepted only numeric aggregate
operands. A metric such as
`SUM([n])/NULLIF(COUNT_DISTINCT([m])/1000,0)` therefore used the general typed
pipeline when `m` was text, even when its sum used small stored integers.

Text and enum `COUNT(field)` and `COUNT_DISTINCT(field)` now participate in
the existing native reduction alongside integer sums and other supported
leaves. This applies to standalone V3 metrics, compatible metric batches,
grouped formula summaries and summaries over an already staged source.
The original compiler still handles final arithmetic, NULL/error propagation,
ordering, measured `minCount`, `groupLimit` and result envelopes.

## Validation and scope

Every text operand still passes storage, UTF-8 and the 100,000-byte formula
input check. Already staged values reuse their storage/encoding validation,
retain error sidecars and check the formula size limit. Distinct counts
explicitly use `COLLATE BINARY`, including when the source column has a
case-insensitive collation. Numeric sums retain the existing full-population
INTEGER/NULL and safe absolute-total proofs, including signed inputs.
Decimals, invalid values, oversized operands and unsafe totals retain the
general typed reducer and its diagnostics.

Newly eligible metric batches require SQLite's existing EXPLAIN inspection
to prove stored reads before attempting the native reduction. Opaque or
volatile host expressions retain their previous evaluation behavior. The
optimization makes no inference from a declared SQLite column type and
requires no new host declaration or function registration.

Eligible direct grouped requests also use the existing combined source
row/byte budget proofs and group budget checks. They avoid source staging
and its budget preflight. The general staging fallback, including its
preflight, is unchanged. Revision, authorization, snapshot and metric
isolation checks continue through the existing executor.

## Reproduction

`BenchmarkV3TypedMetric` creates a **synthetic** file-backed source with
1,500,000 rows, 120 combinations of two text grouping keys, nonnegative
integer values and text message IDs. Each run includes an untimed warmup.
The metric requests `groupLimit: 200` and `minCount: 2`. A second case requests
the same formula as a grouped summary, including source staging budgets and
group identities. Every returned rate is checked against its expected value.

The native comparison is:

```sql
SELECT g1, g2,
       SUM(n)/NULLIF(COUNT(DISTINCT m COLLATE BINARY)/1000.0,0)
FROM events
GROUP BY g1 COLLATE BINARY, g2 COLLATE BINARY;
```

This SQL omits typed errors, population counting, budgets and result envelopes;
it is a cost floor. The benchmark uses one connection and a 128 MiB main
page cache. It does not change the host's connection settings.

```sh
cd backends/sqlite-tests
go test -run '^$' -bench '^BenchmarkV3TypedMetric$' -benchtime=1x -count=3
```

To select the consumer's modernc version without changing the checked-in
test module:

```sh
mkdir -p ../../.context
cp go.mod ../../.context/typed-metric-v161.mod
cp go.sum ../../.context/typed-metric-v161.sum
go mod edit -modfile=../../.context/typed-metric-v161.mod -require=modernc.org/sqlite@v1.61.0
go test -mod=mod -modfile=../../.context/typed-metric-v161.mod \
  -run '^$' -bench '^BenchmarkV3TypedMetric$' -benchtime=1x -count=3
```

## Measurements

Measured 2026-11-10 on an Apple M3 Ultra, Go 1.27.1, modernc SQLite v1.61.0.
The baseline uses the reducer from `58dc17d` (1.0.3) with the same benchmark.
These are local synthetic measurements, not timings from the Pharos catalog
itself. No production latency claim or published release is established by
these results.

Means of three timed operations per case, with one untimed warmup for each
operation. Baseline and candidate were run serially after the race suite
finished, with the same fixture and modernc version. The baseline binary used
a Go source overlay containing the original reducer; no installed dependency
or consumer repository was patched.

| Workload | 1.0.3 wall s/op | Candidate wall s/op | 1.0.3 CPU s/op | Candidate CPU s/op |
|---|---:|---:|---:|---:|
| Grouped metric | 7.417 | 3.105 | 7.417 | 3.131 |
| Grouped formula summary | 10.344 | 4.076 | 10.935 | 4.170 |
| Handwritten SQL | 2.857 | 2.756 | 2.826 | 2.751 |

The metric is 2.39x faster than baseline and takes 1.13x the candidate run's
handwritten SQL time. The grouped summary is 2.54x faster and takes 1.48x
the handwritten SQL time. Candidate wall samples were 3.087–3.118 s for the
metric, 4.050–4.116 s for grouping and 2.720–2.795 s for native SQL. These
samples meet the approximately 1.5x target on this synthetic workload;
they are not a statistical guarantee for other sources or machine load.

## Correctness checks

The backend Go and SQLite integration suites pass, including full race runs
and `go vet`. Additional parity tests compare the native plan with execution
that deliberately declines stored-source inspection. They cover binary text
groups and distinct values, NULL/zero sums, signed and fractional values,
unsafe input and accumulated sums, invalid storage/UTF-8, embedded NULs,
oversized formula operands, enums, staged values, error sidecars, count and
measured minimums, group limits, row/byte/group budgets and scratch cleanup.
Opaque multi-field count batches keep the same host function evaluation count.
The new parity tests also pass with modernc v1.61.0 through the isolated test
module above.
