# Go + PostgreSQL metrics playground

Run from the repository root:

```sh
npm install
npm run demo:postgres
```

Open **http://localhost:5179/postgres**. The existing small client demo remains
at `/`. Requires Node 22+, Go 1.25+, and PostgreSQL command-line tools (16 or 17
is recommended). The launcher discovers Homebrew PostgreSQL or `PG_BIN`.

The launcher uses PostgreSQL on `/tmp:5432` when available and creates a dedicated
`query_table_metrics_demo` database. Otherwise it initializes a private cluster
under `.context/postgres-demo/pgdata` on port 55439. Ctrl+C stops owned processes;
seeded data is retained. An already running Vite server on 5179 is reused.
The API listens only on `127.0.0.1:5180`.

## Real data and execution

The first launch creates 500,000 deterministic records (about 141 MB including
indexes). These represent six weeks of runs, with skewed durations, outliers,
missing values, three operating systems, result statuses, and 24 workers.
The browser receives a page of 100 rows rather than downloading the population.

Twenty initial cards cover counts, page-only counts, ratios, temporal values,
pie/ring charts, bars, lines, scatter, lists, two-key pivot tables, three-key
tables, box plots, histograms, and computed-field grouping/aggregation. The
metric editor and dashboard layout editor use the production UI. Edits persist
in browser storage and shareable query URLs. **Restore demo dashboard** restores
the starter configuration. The backend supports up to 20 metrics per request;
remove an existing card before adding one to this full starter dashboard.

Rows execute `CompileRowsV2`; metrics execute `CompileMetrics`; computed columns
use the SQL definition store/resolver from the Go library. Select expressions
and sorting execute in PostgreSQL before pagination. Row sidecars bind computed
values to row IDs. All requests import one retained exported PostgreSQL MVCC
snapshot, including the canonical computed definitions. Saving a computed
column refreshes that snapshot and its revisions; other open tabs may need to
reconnect afterward. Base records remain fixed throughout the session.

The only new third-party runtime dependency is the PostgreSQL driver in the
separate `demo/server` Go module. Published query-table libraries gain none.
Charts and editors continue to use the dependency-light production UI.

## Loading experiments

Use **Database delay** and **Response delay**, each 0–5,000 ms, or the presets.
Then click **Refresh data** or change a query. Settings affect the next request.

- Database delay executes a real cancellable `pg_sleep` once per HTTP request.
- Response delay waits after SQL has completed and its transaction has closed.
- The activity panel shows pending/completed/aborted/error states, real SQL time,
  both configured delays, and statement counts. Expand **Latest timing for each
  metric** for individual SQL/planner durations, stage counts, and SQL sizes.
  Cards show their loading state
  while a new request is pending.
- Query changes cancel obsolete requests through Vite, Go, and PostgreSQL.

The response delay simulates added connection latency, not bandwidth throttling
or streamed packets. The demo distributes a dashboard across up to four parallel
requests, each with at most five initial cards and the same exported snapshot.
Delays apply once per shard. Sibling requests are canceled if a shard fails.
The backend executes each shard's plans sequentially; the activity panel makes
this fan-out and each card's costs visible. No sampling or fabricated results
are used.

The Go planner evaluates select-only formulas after pagination, while computed
sort fields remain global. Guarded row stages retain only columns needed later;
numeric-domain intermediates are evaluated once. Histogram bins are counted in
one grouped sample pass using their exact emitted edges. Full-population complex
formulas and exact distributions still cost more than simple count cards.

The seeded schema has indexes for timestamp, day, platform, result, worker,
duration, and the numeric ID expression. C-collation text indexes match the v2
planner's text bindings. Startup refreshes planner statistics after adding them.
Indexes help selective queries; they do not eliminate scans for all-row metrics.

The host bounds concurrent requests to four, individual statements to 60 seconds,
requests to three minutes, response payloads to 8 MB, row pages to 1,000, and group
populations to 10,000. Exact box plots accept at most one million scoped input
rows. Card-local SQL/validation errors appear on the affected metric.

## Dataset options

```sh
QT_DEMO_ROWS=1000000 npm run demo:postgres
PG_BIN=/path/to/postgres/bin npm run demo:postgres
QT_DEMO_DATABASE_URL='postgresql:///scratch_database?host=/tmp' npm run demo:postgres
```

`QT_DEMO_ROWS` accepts 1,000–2,000,000. Changing the count regenerates only the
`qt_demo.runs` table. Use a dedicated scratch database for a custom connection:
startup creates/updates the `qt_demo` schema and its canonical computed-column
store. Keep the same count to preserve records and saved computed definitions.
Connection credentials remain in the launcher/server environment.

## Verification

With the demo running:

```sh
npm run test:postgres-demo
cd demo/server
go test ./...
go vet ./...
QT_DEMO_TEST_DATABASE_URL='postgresql:///query_table_metrics_demo?host=/tmp&port=5432' go test -race ./...
```

The browser integration checks the 20-card initial state, actual counts,
distribution and scatter payloads, fractional filters, computed sorting over
two pages, both latency stages, proxy cancellation, snapshot mismatch rejection,
metric editing, and refresh persistence. It saves a screenshot under
`.context/postgres-demo/dashboard.png`. Optional Go integration tests import a
snapshot after its creator's context is canceled and check refresh repair and
fractional numeric semantics. These tests do not seed or modify DB records.

To reproduce the SQL latency profiles (read-only, against a running seeded DB):

```sh
cd demo/server
QT_DEMO_PROFILE=1 QT_DEMO_TEST_DATABASE_URL='postgresql:///query_table_metrics_demo?host=/tmp&port=5432' go test -run TestProfileLatency -v
```

This writes generated SQL and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` artifacts
for rows, computed throughput, ratios, and histograms under
`.context/postgres-demo/`. It compares JIT settings as a diagnostic; JIT was not
the bottleneck in the observed plans. Leave artificial delays at zero when
measuring SQL performance.

Simulated response latency starts after the database transaction, execution slot, and snapshot read lock have been released. A server deadline returns a JSON HTTP 504 to connected clients. Computed-definition saves return the committed revision even if snapshot renewal fails; stale execution remains blocked until bootstrap/list repairs the snapshot.
