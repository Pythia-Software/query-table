# Signed duration operands for datetime comparisons

A datetime comparison value can be an absolute timestamp or a signed elapsed
offset relative to the server's execution time. The WHERE shape and operator
set are unchanged:

```ts
const query: QueryState = {
  ...EMPTY_QUERY,
  where: [
    { field: "created_at", op: ">=", value: "-7d" },
    { field: "created_at", op: "<", value: "+0s" },
    { field: "due_at", op: "<=", value: "+8d2h10m" },
  ],
};
```

The first two predicates describe the interval from seven days before execution
up to execution, with the usual `>=` and `<` boundaries. They remain two ordinary
predicates. `+8d2h10m` means an elapsed offset of eight days, two hours, and ten
minutes. `-8d2h10m` subtracts that whole duration. `+0s` or `-0s` refers to the
execution instant.

## Duration syntax

A duration requires a leading `+` or `-` followed by one or more integer/unit
components without whitespace. Units are lowercase `ms`, `s`, `m` (minutes), `h`,
`d`, and `w`. Components may repeat or appear in any order; their magnitudes are
summed, and the leading sign applies to the entire sum. Zero and leading zeros
are accepted. `+1h1h` and `+120m` both mean two hours.

A day is exactly 24 elapsed hours and a week is exactly seven elapsed days.
Timezone and daylight-saving changes do not affect duration arithmetic. Calendar
months/years, fractions, internal signs, whitespace, and natural-language phrases
are unsupported. Use `+90m` to express one and a half hours.

All durations are bounded to ±8,640,000,000,000,000 milliseconds, the portable
local datetime range. Multiplication, compound summation, and the resulting
instant are checked for overflow. Actual database timestamp limits still apply.
Invalid signed values on datetime fields are errors; they never fall through to
string comparison. Number/bool coercion is unchanged, and text operands such as
`"-1h"` remain literal strings.

## Execution and SQL

Clients preserve the original signed value in `QueryState`, URLs, saved queries,
and server requests. They do not convert it to a fixed timestamp before sending
it. There are no new wire fields or filter operators.

Go `Compile` captures the server clock once for the entire compilation. For each
datetime comparison, it parses a signed value, adds the elapsed offset to that
clock, and binds the resulting UTC timestamp as the existing comparison's `$N`
parameter. The schema-defined column expression remains unchanged, preserving
normal datetime index usage. Duration text never enters SQL; the database does
not parse user strings or perform calendar-interval arithmetic. The captured
server clock retains its precision, including for a zero offset.

For handlers compiling row, count, and metric statements separately, capture one
server clock and use `CompileAt(query, schema, startIndex, now)` for each. This
keeps related statements on the same time boundaries. The clock is an execution
input owned by the server, rather than a query parameter supplied by the client.

Resolve offsets on every execution. Do not reuse previously bound timestamp
arguments when re-running a saved relative query. SQL plans may be reused with
fresh arguments; result caches need an appropriate TTL or execution-time key.
Refresh remains the consumer's existing mechanism for re-running a query.

## Local mirrors and verification

TypeScript local filtering and native `LocalQueryTransport` mirror the same
signed-duration semantics for client-only data. They capture one local clock per
execution and prepare operands before scanning rows. TypeScript `applyQuery`,
`applyAggregations`, and `matchesClause` accept optional `{ now: epochMillis }`
for reproducible local execution; `coerceValue("datetime", value, now)` also
accepts an explicit clock. Swift's local transport accepts an injected `now`
closure. These local clock inputs never change server requests.

`parseRelativeDuration` (TypeScript) and `RelativeTime.parseDuration` (Swift)
return an offset in milliseconds or `null`/`nil` for invalid or absolute values.
Invalid datetime filter values throw even with no rows or under an OR/negated
predicate. Local datetime comparisons use actual instants; NULL/invalid row
values do not match, including under negation.

Shared grammar fixtures in `schema/fixtures/relative-time.json` exercise
TypeScript, Go, and the native executable checks. Existing operator allowlists,
absolute datetime values, CNF grouping, and URL encodings continue to work.
