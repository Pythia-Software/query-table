# Query Table DuckDB backend

`@pythia-software/query-table-duckdb` executes Query Table's row, metric, and
version 3 grouped-query contracts with DuckDB SQL. The same TypeScript planner
runs against native DuckDB or DuckDB-Wasm. There is no React, HTTP server, Go,
database driver, or browser dependency in this package.

```ts
import { DuckDBBackend } from "@pythia-software/query-table-duckdb";
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
await connection.run("SET TimeZone='UTC'");
// Create/load an authorized relation with unique, non-null stable identities.
const backend = new DuckDBBackend({
  relation: "authorized_records", schema,
  connection: {
    query: async (sql, args) =>
      (await connection.runAndReadAll(sql, args)).getRowObjectsJS(),
  },
});
const transport = backend.transport();
// useQueryTable({ schema: backend.schema, transport })
```

The `args` value in this structural example must be narrowed to your driver's
parameter types in a TypeScript host. Query operands are strings, numbers,
booleans or null. The backend uses numbered parameters, never interpolated values.
`compileDuckDBRows` also exposes a standalone, parameterized row-query compiler.

For Wasm, pass `fromDuckDBWasmConnection(await db.connect())` as the connection.
Configure Arrow conversion with `castTimestampToDate: true`; retaining bigint
values allows the adapter to reject unsafe integer results. Set the session
timezone to UTC. Call `await backend.drain()` before closing an owned connection.

## Host bindings and trust boundary

The host supplies a `FieldSchema`, a quoted relation name, and optional trusted
`bindings: { fieldName: "SQL expression" }`. Bindings are projected to canonical
field names before execution. A source path is treated as a literal column name.
Use explicit SQL bindings for nested/expression paths.

`loadDuckDBSchema(document)` reads `bindings.duckdb.expr` from JSON schema
documents and returns `{ schema, bindings }`; it rejects missing bindings and
never falls back to PostgreSQL or SQLite SQL. Expressions and the relation must
come from trusted host configuration, not requests. Register a view restricted
to the authorized dataset/tenant before constructing a backend. A schema is an
execution allowlist, not an authentication system.

Use one backend per exclusive connection. It serializes requests and executes
each rows/metrics request inside one transaction. Cancellation prevents queued
requests from starting, discards obsolete results, and rolls back failed work.
An optional driver's `interrupt()` stops an active query. DuckDB-Wasm's
structural adapter does not advertise interruption; active SQL finishes before
the cancelled request rolls back. Separate row/metric requests need a host-owned
immutable dataset for identical contents. `snapshot` binds a request to a
host-supplied dataset version; it does not manufacture a retained snapshot.

## Supported execution profile

The explicitly negotiated profile is `qt-duckdb-v1`.

| Contract | Support |
| --- | --- |
| Rows | projection, all filter operators, AND/OR/NOT, nulls, text sets, multi-sort, null placement, pagination |
| Metadata/items | scalar/array autocomplete with `hasNull`, complete item lookup |
| Regex | bounded RE2 source filtering and regex sort extraction; unsupported RE2 patterns fail |
| Scalar metrics | COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, exact MEDIAN; composed formulas; paired scatter measures |
| Distributions | exact boxes and shared-edge histograms; bounded numeric samples |
| Scope | all matching rows or the ordered result page |
| Grouped rows | source WHERE → GROUP BY and summaries → HAVING → sorting → pagination |
| Representatives | all ROW columns from the same ordered representative, with stable ID tie-breaking |
| Calendar metrics | hour/day/Monday-week/month/year, IANA zones, repeated/partial DST hours, null dates and empty completion |
| Computed definitions | host-resolved static definitions, transitive references, revision/token handshake, select/sort/filter/group/measure |

Formula SQL supports arithmetic/comparisons/three-valued boolean operations,
IF/IFS/SWITCH/COALESCE/NULLIF, text slicing/case/matching/padding, common numeric
functions, scalar conversions, text-array operations and date part/truncation.
`IFERROR`, regex row formulas, `DATE_ADD`, `DATE_DIFF`, and `FORMAT_DATE` are
explicitly unsupported SQL functions in this first profile. They remain
available as browser-only computed columns through the standard frontend worker.
No unsupported filter or aggregate is silently dropped. SQL runtime failures
reject execution; they do not become per-row computed error sidecars. Native
DuckDB string, conversion, floating-point and collation semantics apply within
this profile; `ROUND` uses the frontend's ties-toward-positive-infinity rule.

Dates are ISO strings or native DATE/TIMESTAMP/TIMESTAMPTZ columns. Text arrays
are native VARCHAR[] columns, not serialized JSON. JSON display fields can be
stored as VARCHAR and kept out of sorting/filtering through schema capabilities.
Output numbers must be finite and within JavaScript safe magnitude; integer
driver values outside safe precision are rejected.

## Budgets and results

Defaults: 10,000 result rows, 10,000 groups, 250,000 matching source rows,
64 MiB of source JSON payload, 100,000 exact samples per group, 20 metrics,
100 filter predicates, and 256 KiB SQL statements. Hosts can lower budgets.
Population and payload budgets are checked before source staging; distribution
samples are bounded by that population and their explicit per-group budget.
DuckDB's database memory limit additionally governs scans, joins and scratch
space. Budget failures return errors, not partial populations or approximate
statistics. Metric `groupLimit` is applied after reductions/ranking and reports
total group count and coverage.

For native execution conformance, run `npm run test:duckdb` from the repository.
`npm run test:showcase` exercises the same adapter in browser Wasm over real
Parquet data. The public demo is described in `docs/public-demo.md`.
