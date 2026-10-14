# Integrating the next Query Table release

This guide covers consumers moving from the 0.6.0 release to the next source
release. Existing row transports remain compatible. The v3 query executor is an
opt-in capability for grouped result rows and calendar metrics; URL/query state
still uses the `2j.`/`2d.` codec and immutable `@code` references.

## Choose an execution mode

| Mode | Rows and metrics | Source guarantee | Metadata and item loading |
| --- | --- | --- | --- |
| Existing transport | Existing v1/v2 backend paths | Host backend owns paging | Existing transport |
| `clientRows` | Local execution over data already in memory | Caller supplies the local dataset | Optional host item loader |
| `fetchQueryV3` + `queryCapabilities` | SQLite/PostgreSQL backend execution | One authorized transaction per request, bounded narrow staging | Existing transport |

Use the backend executor for remote grouping and aggregation. Return only
result pages and bounded metric buckets over the network. `clientRows` is for
data already available locally, such as embedded fixtures or a local file;
do not download a remote population to feed it. A server page cannot substitute
for a complete local dataset. Source paging does not truncate groups. Execution order is source WHERE,
grouping and summaries, HAVING, result ordering, result offset/limit. All-matching
metrics reduce the groups after HAVING; shown-row metrics reduce the group page.

### Backend contract

`Transport.fetchQueryV3` accepts `QueryRequestV3` and returns `QueryResultV3`.
`toQueryRequestV3` owns projection/validation, and `validateQueryResultV3` checks
the clock, schema, profile, revision envelope, snapshot/token binding and row
identities. Capability negotiation must precede execution. The standard
controller and grouped-column preview use this transport automatically.

The Go adapter exports `QueryDatasetV3`, `DecodeQueryRequestV3` and
`NewQueryV3Handler`. Set `Dialect` to `sqlite` or `postgres`; provide the trusted
schema, authorized source SELECT, bound arguments, tenant scope and dataset.
SQLite needs the existing `SQLiteFunctions` and `SQLiteV2Functions` registered
on each physical connection. PostgreSQL uses its native exact reductions.

```go
dataset := querytable.QueryDatasetV3{
    Dialect: "sqlite", Schema: schema,
    SourceSQL: "SELECT * FROM authorized_runs WHERE tenant=?1",
    SourceArgs: []any{authorizedTenant},
    Scope: authorizedScope, Dataset: "runs",
    ComputedGroupable: approvedGroupIDs,
    ComputedFilterable: approvedFilterIDs,
    MaxRows: 10000, MaxGroups: 2000, MaxPopulation: 250000,
    MaxStagingBytes: 64 << 20, MaxSamplesPerGroup: 100000,
}
result, err := dataset.Execute(ctx, db, request, querytable.PlanOptions{})
```

`Execute` owns the transaction and rolls back on failure. `ExecuteIn` joins a
host-owned transaction and drops its temporary tables before returning success.
The caller must roll back after failure. PostgreSQL callers should use a
REPEATABLE READ transaction for shared execution. Retained data snapshots require
`ExecuteIn` and the host's `ValidateSnapshot` binding; a query snapshot code does
not pin dataset contents. A combined rows/metrics request executes both inside
the same transaction. Separate controller requests need a host snapshot binding
when identical dataset contents across those requests are required.

The defaults are 10,000 result rows, 2,000 groups, 250,000 matching source rows,
64 MiB of staged values and 100,000 exact samples per group. Budgets fail rather
than returning partial groups. The convenience HTTP handler has a 2-MiB request
budget and a 30-second deadline. Its authorization callback must select the
dataset from trusted host state and enforce dataset access and CSRF policy.
Malformed requests and execution diagnostics return HTTP 400. Infrastructure
failures return a fixed HTTP 500 message; timeouts return a fixed HTTP 408 message.
Use your own endpoint when source preparation, enrichment, search coverage or
per-request fact granularity needs host-specific handling.

`SourcePlan` exposes projected fields, transitive `BaseFields`, the resolved
revision envelope and result schema. Hosts staging enriched/map populations can
load those base inputs plus stable identity, then compile/execute against that
authorized source. Source and result aliases remain separate. Item endpoints can
lazy-load full records; unreferenced long text need not enter grouping staging.
The executor checks the narrow source's row count and UTF-8 value/error bytes
before copying it into a temporary table. `MaxStagingBytes` measures that payload;
database storage overhead and query scratch space use the host's database limits.

### Server execution example

Use `withServerExecution` from [server-execution.tsx](../examples/server-execution.tsx)
to add the v3 query endpoint to your existing row, item and metadata services.
Keep the transport and storage objects stable. The controller sends query
configuration and receives result pages and metric buckets; it has no bulk
population loader or automatic download fallback. Unsupported server operations
remain editable and report an error.

## Computed fields and regex

Canonical keys remain `@computed/<id>` references, never uploaded formula source.
The host resolves transitive definitions and checks revisions inside the same
authorized transaction. `ComputedGroupable` and `ComputedFilterable` are separate
allowlists; omitted filtering permission stays closed. `sourceExecutionSchema`
builds the grouping catalogue from the healthy handshake rather than assuming
the base schema contains every computed field.
Computed predicates now remain in normalized and encoded query state. Hosts
must validate their execution capabilities; unapproved predicates stay editable
and fail exact grouping/metric execution rather than widening the population.

`DescribeComputedPartialIn` returns healthy execution capabilities and per-ID
diagnostics without hiding broken definitions in the full store catalogue. Both
`SQLiteV2Dataset` and `QueryDatasetV3` provide this API; the latter supports the
PostgreSQL profile too. Infrastructure/context failures fail the request.
`DescribeComputedIn` retains its all-or-error behavior. Hosts can keep the full
catalogue editable while advertising only valid transitive graphs.

SQLite source regex predicates use the existing bounded Go/RE2 backend profile
and are advertised as `regexSourceFilters`. PostgreSQL and complete local
grouping retain explicit rejection. Regex aggregate formulas remain unsupported;
do not evaluate them on the UI thread as a fallback. Local computed grouping can
use host-approved, materialized canonical values with explicit schema bindings;
the local dataset must already contain every approved value and its dependency inputs.

## Calendar semantics

V3 calendar metrics support hour/day/Monday-week/month/year, IANA timezones,
observed/query/custom ranges and empty buckets. Repeated hours have distinct UTC
keys, and partial hours at transitions such as Lord Howe remain separate. NULL
timestamps remain a NULL bucket. Empty COUNT/COUNT_DISTINCT/SUM buckets are zero;
AVG and other scalar formulas retain the local empty-bucket semantics. Filling
and sorting occur before top-N, and filling obeys the group budget.

The engine buckets the rows supplied by the host. It does not invent hourly
observations from daily facts. Choose an hourly source or reject that request
when your dataset's granularity requires it. SQLite/PostgreSQL retain their
documented numeric profiles: exact decimal AVG can differ from browser AVG by a
last double rounding step; integer counts/sums, exact MEDIAN and typed keys keep
their existing precision checks.

Grouped rows and metrics share their source population's evaluation clock. Ordinary v3 requests capture a fresh clock when execution begins, including
explicit previews; merely exposing the v3 transport does not enable strict local
metric semantics for ordinary legacy queries.

## Router and query links

Give mounted tables distinct top-level `queryParameter` values. This option does
not enable item views or inject a Detail column. It takes precedence over the
legacy `itemDetails.queryParameter`, which remains a compatibility fallback;
the default is `q`.

After a host `pushState` update, call `table.restoreLocation(location.href)`.
Absolute URLs and relative router strings such as `/tools?q_tools=…`, `?q_tools=…`
or `#table` are accepted; relative locations use the browser's current URL as a base.
The promise is cancellable with an `AbortSignal` and supersedes older resolution.
`table.restoration` exposes `resolving`, `ready` or `error`, plus `ready` and the
error itself. Use that readiness to gate host query work. `active: false`
pauses row/metric execution and URL synchronization for hidden mounted views.
Reactivation preserves query state and undo/redo history. An initially inactive
controller restores on its first activation; call `restoreLocation` for actual
router navigation after that.
Unrelated parameters and hash-only navigation preserve query/undo state. See
[multi-table-router.tsx](../examples/multi-table-router.tsx).

Use `decodeQueryStrict` for an inline token, and `createQueryLinkService.resolve`
or controller restoration for a URL that can contain references. Do not manually
decode base64 JSON, or call `decodeQuery('@code')` and treat its fallback as a
restored query. Missing, duplicate or corrupt links preserve the incoming URL
and block execution until repaired or reset. A grouped rolling-window recipe
edits `grouping.source.where`; top-level WHERE is HAVING.

## Save, Share, Bookmark and item views

Use stable `StorageAdapter`/snapshot-cache objects. `api.links.local` supports
local navigation without a server write. Explicit Save/Share/Bookmark uses
`api.links.create` or `api.links.snapshot` to promote immutable state first.
Persist the returned snapshot association in the named query/bookmark. Updating
a named query must atomically preserve its ID/name/default selection while
replacing state and snapshot association; it must not overwrite old snapshots.

`QuerySnapshotHttpError` retains status/code and a bounded server reason. The Go
quota sentinel maps to HTTP 507; existing links and same-code retries still work
at quota. `ValidateQuerySnapshot`, `SQLQuerySnapshotStore.SaveIn` and `ResolveIn`
let hosts enforce row/byte quotas inside their own serialized transaction. A
failed save keeps the previous named query/default and retries the same code.
See [URL state and saved links](url-state-and-saved-search-design.md).

Item loaders should return full records independently of table SELECT/search.
Keep object relationships host-authorized and bounded. Render grouped rows with
`api.schema`, `api.visibleFields` and `api.rowId`; source-record actions/renderers
must check `!api.query.grouping`. Source inspection remains on
`api.grouping.source`. Field display configuration does not change query types.
Table renderer overrides, named/field renderers, `display`, then plain fallback
retain that precedence. Property-specific overrides still take precedence in
item views. See [item properties](object-properties.md) and
[cell displays](cell-displays.md).

## Working in two checkouts

Build the packages once, install their external runtime dependencies in the
consumer, and link core/react/ui/codegen to the intended worktree. Bundle with
esbuild `--preserve-symlinks` so React resolves through the consumer's dependencies.
Run package watchers with `--watch --no-clean`; a clean watcher can temporarily
remove `dist` while a dependent watcher reads it. Schema edits still require
regeneration. `npm ci` removes local links, so relink afterward.

Before release, run `npm run package:check` to install packed artifacts into a
clean consumer and check exports/types without local links. Pin reviewed source
archives with provenance while the new exports are unpublished, or move to the
published version once it exists; an unchanged registry 0.6.0 pin does not contain
the new APIs. A browser/native bookmark copies a URL, not the local cache, so use
an explicit durable Bookmark action for portable references.

`npm run test:sqlite` includes the browser/backend grouping and calendar parity
fixtures. To run the PostgreSQL transaction, grouping, calendar and quota tests,
set `QT_TEST_POSTGRES` to a disposable database and run `npm run test:postgres`.
The fixtures create isolated schemas and remove them after each test.
