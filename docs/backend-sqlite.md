# SQLite + Go integration

The dependency-free `github.com/Pythia-Software/query-table/backends/go` module
supports SQLite 3.38+ with JSON functions. The application supplies the driver,
connection pool, authorized dataset scope, HTTP endpoints, and deadlines.
`modernc.org/sqlite` is exercised against real SQLite in `backends/sqlite-tests`;
other drivers can register the same function descriptors.

## Supported boundary

- Readable and compact v1 row queries, AND/OR predicates, null-exclusive negation,
  scalar comparisons, literal substring/prefix/suffix matching, Unicode code-point
  length, Go/RE2 regex filtering and capture-group sorting.
- JSON text-array membership, exact or case-insensitive, including ANY/ALL/NONE/
  EMPTY compositions from the existing set-filter editor.
- Multi-column sorting, explicit NULL ordering, schema defaults, and stable ID ties.
- Count + page, autocomplete with `hasMore`/`hasNull`, scalar field statistics,
  and six basic aggregates: count, count_distinct, sum, avg, min, max.
- Scoped computed-definition persistence with atomic revision checks.
- A distinct `qt-sqlite-v1` v2 expression profile: composed aggregate formulas,
  paired X/Y metrics, all-matching and shown-row scopes, computed SELECT/ORDER BY,
  final group sorting and top-N, exact MEDIAN, box plots/histograms, and
  transaction-based execution.

The v1 entry points remain deliberately strict. Use `DecodeSQLiteQuery` for v1
row bodies and `SQLiteAggregationRequest` for basic aggregation bodies; they
reject v2 envelopes instead of silently discarding modern settings. Use
`ServerQueryV2`, `MetricQuery`, and `SQLiteV2Dataset` for v2 requests.
Compact row bodies preserve `s` selection tuples and legacy `c` selections.
Basic aggregation requests reject unresolved top-level diagnostics, including
residual client-only filters, during decoding and execution.
Do not advertise `qt-postgres-v1` for SQLite. Selected-row scopes, computed
filters, and automatic cross-request snapshots
are outside the SQLite profile and are rejected explicitly.
Apply your own body-size cap and reject trailing JSON values at the HTTP boundary.

## Shared schemas

Read SQLite bindings explicitly; there is no fallback to Postgres expressions:

```json
{
  "name": "runs",
  "idField": "id",
  "defaultSort": [{"field":"started_at","dir":"desc"}],
  "fields": [
    {"name":"id","label":"ID","type":"text",
     "bindings":{"sqlite":{"expr":"r.id"}}},
    {"name":"labels","label":"Labels","type":"textarray",
     "bindings":{"sqlite":{"expr":"r.labels"}}},
    {"name":"started_at","label":"Started","type":"datetime",
     "bindings":{"sqlite":{"expr":"r.started_at","datetimeFormat":"utc-millis"}}}
  ]
}
```

```go
schema, err := querytable.LoadSQLiteSchema(document)
```

`sort.field` uses the target field's storage kind and datetime convention.
Direct Go schemas can supply `SQLiteSortField` alongside the target `SortExpr`.

The JSON metaschema accepts both `bindings.sqlite` and `bindings.postgres` in a
single field. The frontend loader drops SQL bindings. The existing generator
also supports SQLite:

```sh
query-table-codegen runs.schema.json --go runs_schema.go \
  --go-package catalog --dialect sqlite
```

Expressions, FROM/JOIN trees, base predicates, and binding conventions are
trusted host configuration. Never construct any of them from request input.
The compiler enforces filter/sort/aggregate allowlists; values are bound with
anonymous `?` placeholders. Reserve SQL aliases beginning `_qt_` for the adapter.

## Register functions before opening connections

Register every descriptor returned by `SQLiteFunctions()` on every physical
connection. For modernc, its package-level deterministic registration applies
when new connections are opened:

```go
for _, function := range querytable.SQLiteFunctions() {
    function := function
    err := sqlite.RegisterDeterministicScalarFunction(
        function.Name, int32(function.Arity),
        func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
            return function.Call(args)
        },
    )
    if err != nil { return err }
}
```

The imports are `database/sql/driver`, the query-table Go module, and
`modernc.org/sqlite`. Do this once at host startup, before opening any connection;
do not ignore registration errors. Retain one descriptor set. It includes
NULL-aware Unicode lowercasing, suffix/length operations, regex operations,
JSON-array validation, datetime conversion, and numeric guards. Built-in SQLite
functions and collations are not replaced. The regex LRU retains at most 128
patterns; patterns are limited to 10,000 bytes. Function text inputs are bounded
to 1 MiB of valid UTF-8; exceeding the bound fails the query.

Drivers with connection-local registration need a connection hook rather than
one `db.Exec` on an arbitrary pooled connection. The shipped compiler/store
remain driver-independent; no driver is imported into their module.

## Execute an authorized dataset

```go
dataset := querytable.SQLiteDataset{
    Schema: schema,
    FromSQL: "FROM runs r",
    BaseWhereSQL: "r.tenant_id = ?",
    BaseArgs: []any{authorizedTenant},
    MaxLimit: 1000,
    MaxGroups: 2000,
}
rows, err := dataset.Rows(ctx, db, query)
values, err := dataset.Distinct(ctx, db, "labels", "bug", 50)
metrics, err := dataset.Aggregations(ctx, db, request)
stats, err := dataset.FieldStats(ctx, db, []string{"duration_ms"})
```

`Rows` includes the ID field even if it is hidden and returns `{rows,total}`.
Zero row limit defaults to 100. Zero host caps default to 10,000 rows and 2,000
metric groups. Exceeding a cap is an error. A metric group limit never silently
changes the meaning of a result. Empty ungrouped populations return a bucket
with count 0 and NULL reductions (COUNT returns 0); empty grouped populations
return no buckets.

Each operation uses a short transaction, including all statements in a metric
batch. To share one snapshot between multiple operations, begin a transaction
and use `RowsIn`, `DistinctIn`, `AggregationsIn`, and `FieldStatsIn`. The caller
owns the transaction and must finish it promptly. These methods do not import
or export Postgres snapshot tokens.

Hosts with optimized FROM trees, counts, search indexes, or rollup tables can
use `CompileSQLiteWhere`, `CompileSQLiteDistinct`, and
`CompileSQLiteAggregation` directly. `CompileSQLite` returns SELECT, WHERE,
ORDER BY and argument fragments. `WhereArgs` and `OrderArgs` allow a count query
to omit ORDER parameters; `Args` is their concatenation. Capture one
`SQLiteOptions.Now` for all related relative-time compilations. If bypassing the
executor, the host also owns result validation, group limits, and typed mapping.
A rollup optimization must enforce the same source and result guards; checking
only a final rollup sum is insufficient to detect unsafe inputs that cancel.

## Data and semantic conventions

Use STRICT tables or equivalent ingestion validation. Bind numeric fields to
native INTEGER/REAL values, booleans to INTEGER 0/1, text/enums to TEXT, and
textarrays to JSON arrays containing strings only. `Rows` rejects unexpected
storage types and malformed selected arrays. Membership/nullity treats NULL,
empty, malformed, and non-text arrays as empty; malformed data is never passed
to `json_each` unchecked. Autocomplete expands arrays into individual values.
An empty string satisfies scalar `is_null`, matching the filter editor; it is
still a distinct text value and a present value for basic COUNT, as in core v1.
NULL text compares like `""` for text equality/inequality. Explicit negation
excludes empty/null source values. Raw text sorting retains empty strings.

Text equality, grouping, and distinctness use BINARY ordering, independent of
a column's NOCASE collation. Sorting uses ordinal UTF-8 order, not browser
locale ordering. Case-insensitive matching uses Go `strings.ToLower`, not
SQLite's ASCII-only `lower`; its Unicode rules need not be identical to
JavaScript's contextual lowercasing or ICU case folding. Regex uses Go/RE2;
lookbehind and backreferences are rejected. Invalid regexes are errors, and an
unmatched capture is NULL. Captures sort as text, even for numeric source fields.
These are explicit SQLite semantics, not a claim of universal browser/Postgres
locale or regex parity.

Numeric reductions validate numeric storage, finite values, and integral inputs
within ±9,007,199,254,740,991 (except COUNT, which observes presence). Returned
row numbers and numeric reduction outputs have the same finite/safe-integer
guards. Invalid numeric samples fail the operation; they do not silently become
zero. SQLite integer SUM can fail with integer overflow; floating accumulation
uses SQLite's arithmetic and can differ from Postgres or browser reduction
order. The v1 adapter does not claim the Postgres v2 numeric profile or exact
decimal accounting. Counts refer to complete populations, not page size.

Datetime bindings select a storage convention:

| `datetimeFormat` | Storage and comparison |
| --- | --- |
| omitted / `rfc3339` | RFC3339 (including offsets/fractions) or date-only text; normalized for comparisons and sorting |
| `utc-millis` | Trusted fixed-width `YYYY-MM-DDTHH:mm:ss.SSSZ` text; compares/sorts on the original expression so an index can be used |
| `unix-seconds` | Numeric seconds since Unix epoch |
| `unix-millis` | Numeric milliseconds since Unix epoch |

Row datetime output is UTC RFC3339; autocomplete returns normalized UTC text.
Supported dates are years 0000–9999. Noncanonical `utc-millis` selected values
are rejected. Between-millisecond filter boundaries preserve exact equality and
inequality semantics without wrapping indexed columns. Normalize ingestion
before choosing this mode. Normalizing arbitrary RFC3339 per row costs CPU and
can prevent a plain timestamp index from serving an ORDER BY. Use a validated
canonical column or matching expression index for frequent operations. Require
a unique, non-NULL, nonempty scalar ID across the complete FROM/JOIN result;
the executor also rejects duplicate IDs within a returned page.

## V2 formulas and computed execution

Enable the profile by registering **both** `SQLiteFunctions()` and
`SQLiteV2Functions()` scalar descriptors, plus `SQLiteV2Aggregates()`.
The production module still imports no database driver. For modernc, supplement
its scalar registration with this ordinary-aggregate bridge:

```go
type aggregateBridge struct { fn querytable.SQLiteAggregateFunction }
func (a *aggregateBridge) Step(_ *sqlite.FunctionContext, v []driver.Value) error {
    return a.fn.Step(v)
}
func (a *aggregateBridge) WindowValue(_ *sqlite.FunctionContext) (driver.Value, error) {
    return a.fn.Value()
}
func (a *aggregateBridge) WindowInverse(_ *sqlite.FunctionContext, _ []driver.Value) error {
    return errors.New("query-table aggregates do not support sliding windows")
}
func (a *aggregateBridge) Final(_ *sqlite.FunctionContext) { a.fn = nil }

for _, descriptor := range querytable.SQLiteV2Aggregates() {
    descriptor := descriptor
    err := sqlite.RegisterFunction(descriptor.Name, &sqlite.FunctionImpl{
        NArgs: int32(descriptor.Arity), Deterministic: true,
        MakeAggregate: func(sqlite.FunctionContext) (sqlite.AggregateFunction, error) {
            return &aggregateBridge{fn: descriptor.New()}, nil
        },
    })
    if err != nil { return err }
}
```

All registrations must finish before opening connections. Each aggregate group
gets independent state. Do not reuse one aggregate across groups/connections or
register these descriptors as sliding window functions.

Numeric bindings used by v2 expressions, projections, and sorting opt into the
bounded profile through trusted schema metadata:

```json
{"name":"duration_ms","label":"Duration","type":"number",
 "bindings":{"sqlite":{"expr":"r.duration_ms","expressionNumeric":true}},
 "aggregate":{"groupable":false,"ops":["count","sum","avg","min","max","median"]}}
```

`LoadSQLiteSchema` and SQLite codegen preserve this opt-in and aggregate policy.
Formula types are checked strictly. Arrays remain available for ordinary row
projection and filters, but are not formula operands or metric group keys.
Supported scalar operators are arithmetic, comparisons, boolean logic, IF,
COALESCE, NULLIF, IS_NULL, and ABS. Text ordering comparisons are rejected;
text equality, distinctness, extrema, and group ordering use BINARY collation.
Aggregate leaves are COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, and MEDIAN.
Nested reductions and row fields outside reductions are rejected. Aggregate
allowlists apply through every transitive computed dependency. Base numeric/date
grouping requires explicit `aggregate.groupable`; computed grouping requires a
host allowlist. Regex filters and base-field capture sorting use the v1 RE2
semantics. Computed sorts cannot use regex extraction. Alternate sort bindings
must identify their target through `sort.field` / `SQLiteSortField`.

```go
v2 := querytable.SQLiteV2Dataset{
    Schema: schema,
    SourceSQL: "SELECT * FROM runs WHERE tenant_id = ?1",
    SourceArgs: []any{authorizedTenant},
    Scope: authorizedScope, Dataset: "runs",
    ComputedGroupable: map[string]bool{"category": true},
    MaxRows: 1000, MaxGroups: 2000, MaxPopulation: 250000,
}
capabilities := v2.Capabilities() // version 2, qt-sqlite-v1, distributions:true

// Decode these envelopes at the host's bounded JSON/HTTP boundary.
var rowRequest querytable.ServerQueryV2
var metricRequest querytable.MetricQuery
result, err := v2.ExecuteV2(ctx, db, &rowRequest, &metricRequest,
    querytable.PlanOptions{Identity: trustedActorDatasetSchemaIdentity})
```

`SourceSQL` is always an authorized SELECT exposing every schema binding's
column aliases. Its parameters use numbered `?1` through `?N` for `SourceArgs`;
compiler parameters start after them. Schema expressions contain no parameters.
This differs from the anonymous `?` fragments in the v1 API. No client source,
SQL, scope, or definition text is trusted.

Either request may be nil. Combined requests must carry the same filters,
ordering, window, revision envelope, and token/snapshot binding. All plans are
validated before execution. Definition resolution, the bounded count, the row
page, and every metric run in the same short transaction. Use `ExecuteV2In`
when a host already owns that transaction. `PlanOptions.Resolver` can override
the built-in scoped `SQLiteComputedDefinitionResolver`, but it must resolve
canonical definitions in that same snapshot.

`result.Rows` matches `FetchRowsResultV2`: `{version:2,rows,total,computed,execution}`.
Computed values are separate sidecars indexed by stable row ID, with **bare
computed IDs** inside `values`, e.g. `values.duration.value`; per-value row errors
are `{code:"divide_by_zero"}`. `result.Metrics` matches the existing aggregation
result wire format: `{metrics:[{id,buckets,scope,processedRows,groupCount,coverage}]}`.
Metric bucket `error`/`yError` are strings. X and Y share one grouped population;
null measures never realign buckets. Group counts are computed before the final
sort/top-N. Returned coverage is exact for the requested scope, including when
only the highest-ranked groups are returned; no additive `other` is invented
for ratios, medians, or distinct counts.

Default execution budgets are 10,000 page rows, 2,000 total groups, and 250,000
matching source rows. The population check reads at most budget+1 matching rows
before sorting/formulas. A source SELECT with its own expensive joins/sorts
still needs host indexes and a context deadline. Exceeding any executor budget
fails the entire request. A top-N limit cannot hide an exceeded group budget.
Standalone compilers do not enforce these executor budgets; their callers own
population/result limits and typed mapping.

For the initial computed handshake, call `DescribeComputedIn(ctx, tx, ids, opts)`
in an authorized transaction. It validates the current canonical definitions,
cycles, types, and transitive graph, and returns capabilities with every reached
revision. Its field keys use `@computed/id`, and revision keys use bare IDs.
Pass that envelope to React's `computedExecution`, the metric capabilities to
`metricCapabilities`, and map transport callbacks to `result.Rows` and
`result.Metrics`. Later requests require the expected revision of every reached
definition; the executor additionally checks and echoes the complete supplied
handshake, including currently hidden definitions. A revision change requires
refreshing the handshake; nothing silently falls back to client evaluation.

Tokens remain host responsibilities. A nonempty planToken requires
`ValidatePlanToken`, and a nonempty snapshot requires `ValidateSnapshot` to
bind the active transaction. After validation, row responses echo those bindings.
`ExecuteV2` refuses snapshot tokens because a newly opened transaction cannot
retain another request's snapshot. Only `ExecuteV2In` can use a genuinely retained
host transaction. Fingerprints bind profile, SQL, arguments, reached revisions,
and the supplied trusted identity; they are neither signatures nor promises of
cross-request data stability.

### V2 numeric contract

The SQLite profile checks native storage and finite numeric inputs in the range
zero or ±[1e-300,1e100]. Formula failures produce per-value diagnostics; IF,
COALESCE, AND, and OR propagate only errors from the consumed branch. Source
NULL remains distinct from an error. SUM/AVG accumulate exact rationals of the
shortest decimal representation of each finite sample, then round the final
result to IEEE double. Row arithmetic checks the decimal intermediate and
returns the IEEE operation result. These semantics are deterministic but do not
promise arbitrary-precision accounting or identical browser accumulation order.
Numeric metric samples/results reject integral doubles outside MAX_SAFE_INTEGER;
COUNT observes presence without that metric-only restriction. SUM also rejects
an absolute sample sum above MAX_SAFE_INTEGER, even if cancellation would make
the final sum small. MEDIAN sorts exact samples and uses a linear midpoint for
even populations. More than `SQLiteMaxMedianSamples` (100,000) non-null samples
per group yields a `resource_limit` metric error, never an approximation.

Wrong storage types, invalid/noncanonical datetime bindings, text over 100,000
UTF-8 bytes, unsafe integers, range errors, and division by zero remain explicit.
Selected invalid base fields fail row decoding. Datetime filters retain v1
storage conventions; formulas normalize datetime values to UTC. Arrays cannot
enter formulas. Box plots and histograms are described below.

### Box plots and histograms

`SQLiteV2Aggregates()` now includes `qt_v2_box` and `qt_v2_histogram`, and
`SQLiteV2Functions()` includes the shared-edge helper. The same registration
loops pick up these descriptors; no additional driver dependencies are required.
`Capabilities().Distributions` is true. Both distributions accept numeric row
formulas, including canonical computed fields, and honor allMatching/shownRows,
transitive revision/measure policy, null/error diagnostics, and host limits.

```go
request := querytable.MetricQuery{
    Version: 2, Profile: querytable.SQLiteExpressionProfile,
    Metrics: []querytable.AggSpec{
        {ID: "duration_box", GroupBy: []string{"status"},
         Distribution: &querytable.MetricDistribution{
             Kind: "box", Input: "[duration_ms]", Whiskers: "tukey",
         }},
        {ID: "duration_histogram", GroupBy: []string{"status"},
         Distribution: &querytable.MetricDistribution{
             Kind: "histogram", Input: "[duration_ms]", Bins: 10,
         }},
    },
}
result, err := v2.ExecuteV2(ctx, db, nil, &request, querytable.PlanOptions{})
```

Boxes return `MetricBoxDistribution` with a nullable `MetricBoxSummary`:
min, q1, median, q3, max, mean, observed low/high endpoints, sample count, whisker
mode, outliers, and total outlier count. Quartiles use the core's exact-linear
IEEE interpolation, with rounding before addition and clamping to adjacent
samples. Mean uses the SQLite profile's exact decimal AVG and may differ by
roundoff from browser accumulation. Whiskers default to minmax; Tukey uses
1.5×IQR fences and actual observed endpoints. Responses retain all outliers up
to 20; larger populations retain the first 10 and last 10 sorted outliers while
reporting the full count. `SQLiteMaxBoxSamples` is 100,000 non-null samples per
group. Exceeding it yields a `resource_limit` bucket error rather than sampling.
The scalar `value` used for box sorting is the median.

Histograms return `MetricHistogramDistribution` with edges, per-bin counts, and
non-null sample count. Bins default to 10 and accept 2–30; histogram grouping
supports at most one key, matching the core contract. Edges derive from the
entire scoped population before any group sort or top-N, so every group's bins
are comparable. Bins include their lower bound and exclude their upper bound,
except the final bin includes the maximum. Constant populations return one
point interval `[v,v]`; empty/all-null populations return empty edges/counts.
A group containing only nulls still receives the global edges and zero counts
when other groups have samples. Histogram state retains only bin counters,
without the box/median sample cap. Host population and group limits still apply.
Collapsed floating-point edges return `histogram_precision`; unsafe generated
edges return `unsafe_integer`. A global input/extent error invalidates every
histogram group, even if top-N would omit its originating group. The scalar
`value` used for histogram sorting is the sample count.

Distribution buckets include `nullCount` and `inputErrorCount`; nulls are not
errors or numeric zero. Errors clear both scalar value and distribution payload.
The wire union is `MetricDistributionResult`, containing `MetricBoxDistribution`
or `MetricHistogramDistribution`; the existing frontend renders both directly.
Distribution metrics cannot have a paired Y expression. Invalid kinds, bins,
whisker modes, nonnumeric inputs, unsupported groupings, and disabled measures
are rejected during planning. `npm run test:sqlite` additionally compares actual
SQLite response payloads against the core box/histogram algorithms.

### Pharos cutover

The generic v2 APIs are ready for the same release as the SQLite adapter. Pharos
can retain its authorized source selection, trigram/index strategy, rollups, and
HTTP handlers while wiring `fetchRowsV2`, `fetchMetrics`, and the handshake to
this executor. Opt numeric bindings into `expressionNumeric` first, register the
additional descriptors at startup, and advertise the returned profile/capabilities.
Keep optimized rollup paths only where they preserve this profile's sample,
revision, numeric, and snapshot checks. Publish the libraries before upgrading
Pharos's pinned dependencies; the ignored local Go workspace remains a development
overlay, not a released-module dependency. This library change does not itself
activate v2 endpoints in Pharos.

## Connections, cancellation and persistence

For a local, writeable modernc database, an example DSN is:

```go
db, err := sql.Open("sqlite",
    "file:catalog.db?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
```

Configure connection-local busy timeout/foreign keys through the driver DSN or
connection hook. WAL allows concurrent readers and a writer, but SQLite still
permits one writer at a time. Bound pools and serialize writes where appropriate;
do not rely on a busy timeout as a retry policy for every transaction failure.
Close result sets before starting another operation on a single-connection pool.
Do not deploy WAL databases on network filesystems. Long read transactions can
prevent checkpoint progress. Use context deadlines for autocomplete/metrics and
let database failures propagate; the adapter uses context-aware operations and
never retries writes invisibly.

Plain `:memory:` is a separate database per physical connection. Tests should
use a file-backed database, or deliberately retain a shared in-memory connection.

```go
_, err := db.ExecContext(ctx, querytable.SQLiteComputedColumnsDDL)
store := querytable.SQLiteComputedColumnStore{DB: db}
handler := querytable.NewComputedColumnsHandler(store, authorize)
```

Hosts install the DDL explicitly; the adapter never changes a database on its
own. The existing handler requires scope/dataset authorization and write/CSRF
checks. Saves use one atomic INSERT/UPDATE RETURNING statement with a revision
predicate. Only an already-existing create or a stale revision becomes
`ErrComputedConflict`; a locked database remains a database failure.

## Verification and first client

`npm run test:sqlite` runs the separate modernc fixture module with the race
detector and vet. Root Go tests exercise compiler/decoder validation and scalar
semantics without adding runtime dependencies. The fixture module covers
actual SQL, scope isolation, NULL/empty arrays, Unicode/literal searches, sorting,
result mapping, aggregation limits/numeric errors, WAL snapshot consistency,
cancellation, concurrent revision conflicts, v2 lazy formulas/paired scopes,
computed ordering/transitive revisions, exact reductions/distributions, execution budgets,
wire-format sidecars, and held snapshots across concurrent writes. It is included in `npm run check`.

Pharos is the first consumer. It keeps its host-owned trigram search, timestamp
indexes, and rollups, while using shared Go wire types, predicates, autocomplete,
aggregate compilation, and function implementations. Its local map executor
retains host conventions such as empty-text measures and numeric regex sort
captures. Its upgrade tooling installs built npm archives and uses an ignored
Go workspace during development, then upgrades all frontend pins and the tagged
Go module together after publication. See Pharos's `docs/query-table-integration.md`.

References: [JSON support](https://www.sqlite.org/json1.html),
[WAL and concurrency](https://www.sqlite.org/wal.html),
[aggregate arithmetic](https://www.sqlite.org/lang_aggfunc.html),
[modernc registration](https://pkg.go.dev/modernc.org/sqlite).
