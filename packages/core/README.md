# @pythia-software/query-table-core

Framework-agnostic query state, schema contracts, filtering, sorting,
aggregation, serialization, and transport/storage interfaces for query-table.

## Install

```bash
npm install @pythia-software/query-table-core
```

## Example

```ts
import {
  EMPTY_QUERY,
  loadSchema,
  normalizeQueryState,
  toServerQuery,
} from "@pythia-software/query-table-core";

const schema = loadSchema({
  name: "orders",
  idField: "id",
  fields: [
    {
      name: "id",
      label: "Order",
      type: "number",
      bindings: { postgres: { expr: "o.id" } },
    },
  ],
});

const query = normalizeQueryState({ ...EMPTY_QUERY, limit: 50 });
const request = toServerQuery(query, schema);
```

Query state is bounded whenever it crosses the library's URL, storage, or
server-projection boundaries. SQL expressions remain trusted server-side schema
configuration; request values are never SQL fragments.

Text filters include `matches_regex` / `not_matches_regex`. An order term may
set `extract: { regex: "..." }` to compare the first capture group (or the whole
match when there is no capture group); non-matches sort as nulls.

Text fields also support `length_gt`, `length_lt`, and `length_eq` with a
non-negative integer value. Length counts Unicode code points. `length_eq` with
`"0"` matches empty strings but excludes NULL; `length_gt` with `"0"` matches
nonempty strings.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for the complete schema and backend documentation.

## Computed SELECT definitions

Exports include `ComputedColumnStore`, `httpComputedColumnStore`, `memoryComputedColumnStore`, `compileFormula`, `FORMULA_FUNCTIONS`, and `formulaRuntime`. Shared source definitions are versioned separately from queries; query SELECT entries use `{ field: "@computed/<id>" }`. The React package executes the interpreter in a bounded worker. Do not run user regex on the browser main thread. See the repository’s `docs/computed-columns.md` for semantics and persistence details.

For case-sensitive array keys, set `filter: { arrayCaseSensitive: true }` on the
`textarray` field. The default remains case-insensitive. This setting applies to
local filtering and metrics and to PostgreSQL array membership.

Datetime comparisons accept signed elapsed offsets such as `-1h`, `+8d2h10m`,
and `+0s`. Operators and the wire shape are unchanged: values remain relative in
saved queries and requests, and the server resolves them when compiling. Local
executors mirror this behavior and accept an optional clock for deterministic
execution. See [relative datetime operands](https://github.com/Pythia-Software/query-table/blob/main/docs/relative-time.md).

## Local metric resource and precision boundaries

`evaluateMetrics` checks grouping storage before serializing each tuple.
`maxGroupKeyLength` defaults to 65,536 escaped JSON UTF-16 code units per tuple;
`maxGroupBytes` defaults to 16,000,000 estimated bytes per metric. The byte
estimate includes serialized keys, original string payloads (charged per group
even when shared), tuple slots, map/bucket overhead, and 16 bytes per retained
row reference. It also reserves a candidate group and serialization scratch
before lookup, including for duplicate keys. These conservative bounds can
reject a population below its actual heap limit; they are not heap measurements.
Ungrouped rows also consume the row-reference budget. Bounds must be nonnegative
safe integers. Exceeding a bound returns an explicit metric error with no partial
buckets. Existing row, group-count, operation, and distinct-value budgets remain
independent. Group limits apply after evaluation and do not bypass these bounds.
Keys preserve scalar types, and long field values remain valid within the tuple
and byte limits; field values are never truncated.

Numeric SUM, AVG, MIN, MAX and numeric COUNT_DISTINCT samples must be finite and,
when integral, within ±9,007,199,254,740,991. SUM and AVG check each accumulation
step; aggregate results, consumed worker reductions, and final metric expression
results follow the same boundary. Unsafe samples fail even when cancellation,
averaging, or selecting an extremum could produce a safe result. COUNT counts
presence and does not interpret the input's numeric magnitude. Text/date extrema
keep their existing semantics. Distribution samples, percentile outputs, box
summary statistics, and histogram boundaries use the same numeric rule. Invalid
box samples produce group errors; any invalid histogram sample invalidates the
shared extent. NULL remains an excluded sample, not an error. Lazy IF/COALESCE
branches do not observe unused reduction failures; IFERROR can recover from a
numeric failure.

These are IEEE-754 display-arithmetic semantics, **not exact decimal arithmetic**.
Finite nonintegral values (including small/subnormal values) remain supported;
floating-point rounding still applies. `coverage: 'exact'` means the complete
scoped population was processed, not that every arithmetic operation was exact.
Row-expression arithmetic retains the formula engine's own semantics; these
checks apply at sample/reduction/result boundaries, not to every intermediate
formula node.

The Go `qt-postgres-v1` profile requires explicit `ExpressionNumeric` bindings and
restricts nonzero magnitudes to 1e-300–1e100. Its numeric metric sample/reduction/result guards reject unsafe integers, including AVG/MIN/MAX and distributions. COUNT retains presence semantics. It accumulates SUM/AVG through
PostgreSQL numeric and also conservatively bounds SUM's absolute population sum.
Do not claim identical acceptance, intermediate overflow, or bit-for-bit numeric
parity; negotiate the backend profile and compare supported floating results
with tolerances. The host must enforce the negotiated profile and execution budgets.
