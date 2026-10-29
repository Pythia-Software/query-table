# Metric dashboards

Metrics are query-local definitions in `QueryState.aggregations`. They round-trip through query encoding, saved queries, and explicitly enabled URL/storage synchronization. Existing `{ id, op, field, groupBy, label }` definitions continue to work. No new runtime dependency is required.

## Authoring and rendering

```tsx
import { useQueryTable } from "@pythia-software/query-table-react";
import { QueryBuilder, MetricsPanel } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

const table = useQueryTable({ schema, clientRows: completeDataset });
// Render in your component:
<QueryBuilder api={table} fields={table.computed.catalogue} metricTheme={metricTheme} />
<MetricsPanel api={table} aggregations={table.aggregations} fields={table.computed.catalogue}
  theme={metricTheme} locale="en-US" />
```

The **Edit metrics** action opens a transactional workbench. Apply commits the whole draft as one undoable query change; Cancel leaves the query unchanged. Conflicting external metric changes require reopening the editor. Computation previews are debounced, cancellable, and separate from the row request. Controllers may omit `preview` and still save valid drafts. Changing names, formatting, palette, dimensions, legend settings, or card order does not rerun reductions. Numeric size and bin inputs retain incomplete typing and apply bounds on blur or Enter; Escape cancels the pending input.

The desktop editor has independently resizable metric, expression/settings, reference, and preview panes, plus a modal resized by dragging its corner. The reference pane uses compact Type / Name / ID rows (Type / Name / Signature for functions), with full details on hover. Native selects switch between metric editing and dashboard layout, and between fields and functions. The formula input is a native textarea with diagnostics and cursor-aware reference insertion. It uses the existing formula compiler and worker infrastructure, with no CodeMirror or chart package.

Grouping supports up to 20 fields. Automatic/table display uses a pivot for exactly two grouping fields and a flat table for three or more. Other displays include scalar value, list, horizontal/vertical bars, line, pie, ring, scatter, box plot, and histogram. Chart points expose keyboard and hover tooltips. Escape dismisses an open tooltip; another Escape reaches the enclosing dialog. Combined Other pie/ring slices and list rows expose totals but cannot open a single-group inspector. The always-visible **Edit** button opens the metric workbench when `MetricsPanel` receives `api`; the workbench also offers dashboard layout. Hover pencils open an individual metric; custom hosts can instead provide `onEditMetric` and `onEditDashboard`. Configured decimal precision applies to both pie/ring values and their percentage shares. Pie/ring require valid nonnegative numeric shares; invalid chart data is explained rather than drawn misleadingly.

Dashboard layout supports wrapped pointer and keyboard reordering, card selection, inline names, and whole-rem desired/minimum widths and heights (including sizes below 8rem). Raising a minimum raises the desired dimension. Canvas presets and an editable width simulate available space. Card actions appear on hover or keyboard focus, including navigation back to that metric's editor. Very small cards may need scrolling for labels or raw data.

## Definitions

```ts
const ratio: AggregationClause = {
  id: "success-rate",
  op: "count", // legacy fallback; expression defines modern computation
  expression: "SUM([successful]) / NULLIF(SUM([attempted]), 0)",
  groupBy: ["platform"],
  scope: "allMatching",
  sort: [{ key: "value", dir: "desc", nulls: "last" }],
  groupLimit: 12,
  label: "Success rate",
  display: {
    kind: "bar-horizontal",
    valueLabel: "Success rate",
    format: { kind: "percent", decimals: 1 },
  },
  layout: { widthRem: 22, heightRem: 12, minWidthRem: 14, minHeightRem: 6 },
};
```

Aggregate formulas reduce row expressions and then compute once per group. `SUM([x]) / SUM([y])` is a ratio of sums, not an average of row ratios. Use `NULLIF` for an intentionally nullable denominator. Nested aggregates and bare row references outside reductions are invalid. `COUNT()`, `COUNT(expr)`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`, and `MEDIAN` retain scalar semantics. `MEDIAN` accepts numeric expressions, ignores nulls, and averages the middle two values for even populations; an empty population returns null. It is available in aggregate formulas, not the legacy `AggOp` selector. The local expression compiler also supports its documented row functions; each server profile advertises a narrower subset.

`sort` is a stable multi-term order over `value`, scatter `y`, `count`, distribution `samples`, or `group0`, `group1`, etc. Each term has ascending/descending direction and optional null placement. `groupLimit` (1–10,000) applies after reductions, formulas, `minCount`, and sorting. Results expose total group count/coverage so truncated charts can be identified. An Other bucket is available only when the engine can derive an exact additive remainder; ratios are not treated as additive.

Scatter stores the primary reduction in `expression` and the second in `expressionY`, with `display.kind: "scatter"`. Each typed group tuple produces one X/Y pair from the same population. Format X/Y independently through `xFormat`/`yFormat`, and label them through `xLabel`/`yLabel`.

Box and histogram definitions use `distribution: { kind, input, ... }`, where `input` is a numeric **row** expression, not an aggregate formula. Box options select `whiskers: "minmax" | "tukey"`; optional `display.boxMean` shows a mean marker. Histograms use `bins` (2–30). Quartiles interpolate at `(n-1)*p`. Tukey whiskers end at observed in-fence values; both outlier tails are retained in a bounded sample with a total outlier count. Histograms derive shared equal-width edges from the full scoped population before ranking/limiting groups; the final upper bound is inclusive. Constants and empty populations have explicit results. Distribution response types are exported by core.

Legend placement for pie, ring, and scatter is `left`, `right`, `top`, `bottom`, or `none`. List options are `showBars`, `useGroupColors`, and `showValues`. These affect presentation only. Saved inactive alternatives can be retained during editing; the computation projector sends only the active scalar, scatter, or distribution definition.

## Metric filters and minimum group size

Two clause fields change which rows and groups one metric reduces, without
changing the table's rows or any other metric:

```ts
const errorKinds: AggregationClause = {
  id: "error-kinds",
  op: "count",
  groupBy: ["kind"],
  // "Error kinds among errors only": a pre-group predicate for this metric.
  where: [{ field: "status", op: "=", value: "error" }],
  // Hide kinds observed fewer than 20 times instead of ranking them.
  minCount: 20,
  groupLimit: 10,
};
```

`where` has the table WHERE's shape (terms with optional OR groups and OR of
`{ all: [...] }` conjunctions), field
allowlist, operators per type and relative datetime values, and is ANDed with
the table WHERE before grouping. Relative values resolve against the same
request clock as the table WHERE. Regex operators are unavailable in metric
filters, and remote executors require server-filterable (pushdown) fields; a
residual predicate is an explicit `residual_metric_filter` diagnostic. With
`scope: "shownRows"` the table query selects the page first and the metric
filter narrows rows inside it; it never selects a different page. In grouped
mode metrics run over group rows, so `where` refers to grouped-result fields.
At most 100 predicates are allowed. Use
`where: [{ field, op: "is_not_null", value: "" }]` to exclude the null group.
Unlike `IF(...)` inside an aggregate formula, non-matching rows do not form a
group at all.

`minCount` (an integer from 1 to 1,000,000) drops groups whose row count, after
`where`, is below the threshold. It counts rows in the group regardless of the
metric's operation or formula, including rows whose measure is null. Groups are
removed before sorting, `groupLimit` and Other, so a top-N list still returns N
qualifying groups. Removed groups are reported as `hiddenGroups` on the result
(present whenever `minCount` is set) and are **not** folded into Other:
`groupCount`, `buckets` and `other` describe only the qualifying groups. Folding
them would mix "too small to trust" groups into a remainder that is presented as
exact, so every engine follows this one rule. `minCount` requires at least one
grouping field; on a grand-total metric it is a clause diagnostic rather than
being ignored.

### Minimums over distinct values and sums

`minCount` can also measure each group with a field instead of counting its
rows:

```ts
// API cost by model, hiding models used in fewer than five conversations.
const costByModel: AggregationClause = {
  id: "cost", op: "sum", field: "cost", groupBy: ["model_family"],
  minCount: { min: 5, distinct: "conversation_id" },
};
// Failure rate by tool over daily rollup rows, hiding tools with fewer than
// ten calls in total.
const failureRate: AggregationClause = {
  id: "failures", op: "count", groupBy: ["tool_name"],
  expression: "SUM([failures]) / SUM([call_count])",
  minCount: { min: 10, sum: "call_count" },
};
```

`{ min, distinct: field }` keeps a group when it has at least `min` distinct
non-null values of `field`, exactly as `COUNT_DISTINCT([field])` counts them: a
model with 40 records in 3 conversations is hidden, one with 6 records in 6
conversations is kept. `{ min, sum: field }` keeps a group when
`SUM([field])` reaches `min`. Nulls add nothing, so a group whose values are all
null sums to 0; `field` must be numeric, and summing a text field is a clause
diagnostic. A plain number keeps its meaning (rows), and an object needs `min`
and exactly one of `distinct` and `sum`. The field must be a schema field (not
a computed one) whose aggregate policy allows `count_distinct` or `sum`. It may
be different from the metric's own measure, and need not be shown anywhere.

Everything else is as for a row minimum: hidden groups leave before sorting,
`groupLimit` and Other and are reported as `hiddenGroups`, kept groups' values
are unchanged, the measure is counted after the metric's `where`, and empty
calendar fill-ins are never hidden. A group whose measure is an error (an
unsafe sum, or an invalid stored value) is kept so the error stays visible.
With a `window`, a summed minimum is summed over the point's window; distinct
values cannot be combined across intervals, so a distinct minimum with a window
is a clause diagnostic. Shares compare the minimum per bucket. Distributions
(box and histogram) currently accept only row minimums; a measured minimum on
a distribution is a clause diagnostic on every engine.

The Go and SQL executors compute the measure in the same grouped pass as the
metric, sharing an identical aggregate (`SUM([call_count])` in the failure-rate
example) and fused or cross-field reductions with sibling metrics.

- **Calendar grouping.** `includeEmpty` fills empty buckets after `minCount`
  selects the observed groups, and those empty buckets are never hidden or
  counted. An observed bucket below the threshold is hidden and leaves a gap; it
  is not replaced by an empty bucket. An `observed` range still spans the dates
  of hidden buckets.
- **Distributions.** `where` filters box and histogram samples, so histogram
  edges come from the filtered population. `minCount` hides box cohorts (and
  histogram groups) by their row count; like `groupLimit`, it does not change
  the shared histogram extent.
- **Execution metadata.** `processedRows` remains the scope population before
  the metric's own filter. Host group budgets count hidden groups too.

Executors advertise support explicitly: `metricCapabilities.filters` and
`metricCapabilities.minCount` for v2 transports, and
`queryCapabilities.metricFilters` and `queryCapabilities.metricMinCount` for the
v3 executor. A distinct or summed minimum also needs
`metricCapabilities.minCountMeasures` or
`queryCapabilities.metricMinCountMeasures`. A clause that uses an unadvertised
control gets its own error result (`metricPopulationError` names it); the other
metrics in the batch still run, and the control is never silently dropped. The
v1 `fetchAggregations` endpoint never receives either field. The bundled
DuckDB, Go SQLite, Go PostgreSQL and Go v3 executors advertise all of them, and
`ExecuteV2Rows` runs them in memory.

The metric editor exposes **Only rows where…** (the table's filter chips scoped
to the metric) under *Data scope*, and **Minimum per group** with a
**Counting** choice (rows, distinct values of a field, or the sum of a numeric
field) under *Ordering & limits*. Cards note "N groups hidden (fewer than M
rows)", or "(fewer than 5 distinct Conversation values)" and "(fewer than 10
total Calls)". `metricMinCount`, `metricMinCountMeasure` and
`metricMinCountText` read either form.

## Population scope

- `allMatching` (default): all rows matching the query filters, excluding the table limit/offset.
- `shownRows`: the current ordered page, including limit/offset. Virtualization and selection do not define the population.

Remote all-matching metrics execute on the server and return bounded metric
results. Local mode accepts `clientRows` already available in memory; the
controller never downloads a population for aggregation. Shown-row metrics may
use the committed page.
Existing remote advanced metrics use `fetchMetrics` and explicit
`metricCapabilities.version: 2`. A negotiated `fetchQueryV3` executor adds
backend calendar metrics and metrics over grouped results. A legacy
`fetchAggregations` endpoint remains usable for representable v1 metrics.
Unsupported features fail explicitly; an all-matching metric never falls back
to an incomplete page. See the [host integration guide](host-integration-next-release.md).

Shown-row fallback can reduce committed remote rows when all required inputs are present. A V2 transport's `metricCapabilities.shownRows` must be explicitly `true` to execute supported shown-row clauses remotely; false or omitted selects the committed-page fallback. Regex inputs still use workers, and calendar grouping still uses local evaluation unless a V3 executor is selected. Automatic local evaluation waits in a loading state while that page is being fetched; a failed page request ends that wait and surfaces the row error. Applying such metrics adds their input dependencies to row projections. A draft referencing an unloaded field explains that the author must select/refresh it or use a snapshot-capable metric service. It never refetches current IDs and claims that newer values belong to the displayed snapshot.

### Independent remote metrics

Hosts that fetch a coarse server window themselves can pass it as `clientRows`
for local refinement, sorting and paging, while a separate transport evaluates
the entire authorized `allMatching` population. The metric transport's row
methods are never called by the row pipeline:

```tsx
const table = useQueryTable({
  schema,
  clientRows: fetchedWindow.rows,
  metricTransport,
  metricExecution: metricHandshake,
  metricRowsReady: query =>
    !externalLoading &&
    fetchedWindow.origin === currentOrigin &&
    fetchedWindow.requestKey === windowRequestKey(query, requestedWindowSize),
});
```

In this example the host records the origin and request key alongside each
fetched window; `windowRequestKey` identifies its query and requested window
size. Keep those checks tied to the window that actually supplied `clientRows`.
Keeping the same rows reference during an external fetch does not establish
readiness for a new query or origin. Rerender the hook when loading, origin, or
readiness changes, and treat supplied rows and handshakes as immutable.

`metricTransport` defaults to `transport`; supplying it alone leaves the hook in
client row mode. `metricExecution` provides authoritative computed capabilities,
revisions, plan token, and snapshot for metrics. When omitted, metrics retain
the existing execution selection. Both V2 metrics and negotiated V3 metric
requests use the overrides and appear in `requestActivity`. Query restoration,
activation, and query validation still apply before metric execution.

`metricRowsReady(query)` defaults to true and adds a host gate to the hook's
internal committed-page readiness. It gates local shown-row results and
previews, including purely local tables. Unavailable previews reject; losing
readiness clears current results and cancels local work. Previews that become
obsolete reject with `AbortError`. Remote all-matching requests execute
independently, including in mixed dashboards; combined results retain the
original clause order once both populations are ready. Native V2 shown-row
execution with `shownRows: true` and negotiated V3 execution keep their server
snapshot semantics and do not depend on this local-page gate.

To migrate from a local patch, replace its custom hook options with these
supported options and rerun consumer regressions against the matching package
versions before removing the patch. A separate HTTP metric query should not
advertise `shownRows: true` unless it can share the displayed page's snapshot.

A rows-only transport falls back to `clientRows` when a complete client dataset is supplied. Engine selection is per clause: legacy aggregates, including `count_distinct`, retain their existing coercion and grouping behavior even alongside composed formulas or scoped metrics. Legacy empty-text keys share the NULL bucket, matching `is_null` drilldown. Typed datetime grouping converts `Date` objects to ISO keys. The typed local engine gives each metric an independent operation budget (10 million by default); row and retained-memory limits still apply separately. An expensive metric cannot consume another metric's allowance. Direct field aggregate inputs read only their own binding; complex row formulas retain the full dependency input path. Both paths use the formula runtime for type/null/date checks and preserve operation accounting and safe-number validation before reduction. Null-only SUM groups contribute zero to an exact additive Other remainder, with their rows included in its count.

Regex row expressions are limited to shown-row local evaluation and execute in terminable workers with bounded input. All-matching regex, regex group formulas, and server regex metric expressions are unsupported. Remote global execution rejects residual filters and unsupported sorts rather than reducing a different population.

With [row-producing GROUP BY](grouping.md), both scopes target grouped rows
after HAVING. Source WHERE runs before grouping; source pagination and metrics
do not define this population. Grouped views use typed semantics for all metric
definitions, including shorthand aggregates, and preserve null versus empty-text
keys. Local shown-row evaluation preserves the table's input order for sort
ties; it does not add a hidden identity sort.

## Drilldown

`MetricsPanel` and `MetricCard` accept `onInspect(bucket, clause)`. It fires
from chart marks, list rows, pivot and flat-table values, value cards, box-plot
cohorts and histogram bins, by click, Enter or Space. Inspectable elements get
`role="button"` and the `qt-metric-inspectable` class (chart marks keep
`qt-metric-mark`); synthetic Other rows are never inspectable. Without
`onInspect` nothing changes. A histogram bin passes a bucket with the cohort's
`keys`, the bin's `count`, and client-only `bin: { min, max, inclusiveMax }`.

`inspectBucketQuery(query, bucket, clause, schema)` turns that into the query
for the underlying records, or `null` when no exact query exists:

```ts
<MetricsPanel api={table} aggregations={table.aggregations} fields={fields}
  onInspect={(bucket, clause) => {
    const next = inspectBucketQuery(table.query, bucket, clause, schema);
    if (next) table.setQuery(next);
  }} />
```

- The clause's own `where` terms come first, so the records match the metric's
  population. Groups hidden by `minCount` have no bucket to inspect.
- Each `groupBy` key adds `=`; a null key adds `is_null`. Legacy aggregates
  put empty text in the NULL bucket, and `is_null` matches empty text locally,
  so the two agree. Typed metrics keep an empty-text key distinct and drill to
  `= ""`. Local filters treat NULL and empty text alike for both operators, so
  with `clientRows` either drill returns both groups; the bundled backend
  distinguishes them.
- A date-grouped key adds `>= start` and `< next`, using the clause's interval
  and timezone (`metricDateNext`), encoded as ISO instants (`…Z`). Filters
  compare instants, so a date-only source value is read as UTC midnight; group
  date-only columns in UTC to keep drilldown on the same day.
- An hour-of-day or day-of-week slot selects its occurrences inside the date
  bounds, or returns `null` without bounds (see
  [Hour of day and day of week](#hour-of-day-and-day-of-week)).
- A histogram bin adds `>= min` and `< max` (`<= max` for the final bin) on the
  distribution input. The input must be a single numeric field reference; a
  computed expression returns `null`. A box cohort is its group keys.
- Grouped queries: metrics run over group rows, so the terms are added to the
  top-level `where` (HAVING). Pass the source schema or the group schema.
- `scope: "shownRows"` returns `null`: re-filtering re-pages the population. An
  additive Other remainder (no keys) returns `null`. Excluding the shown groups
  would be exact only with null-safe negation of every key, so it is not built.
- Keys on unknown, unfilterable or `textarray` fields return `null`.

Existing terms are kept, terms already present are not repeated, and `offset`
resets to 0. For grouped rows, see `groupSourceQuery` in [grouping](grouping.md).

## Transport and server computed fields

```ts
const transport: Transport<Row> = {
  fetchRows: fetchLegacyRows,
  metricCapabilities: {
    version: 2, expressions: true, shownRows: true,
    distributions: true, computedFields: true, profile: "qt-postgres-v1",
    filters: true, minCount: true, minCountMeasures: true, // only if the service executes them
  },
  fetchMetrics: (request, signal) => fetchMetricBatch(request, signal),
  fetchRowsV2: (request, signal) => fetchComputedRows(request, signal),
};
```

These methods are host implementations, not provided HTTP endpoints. `toMetricQuery` produces a validated v2 request with diagnostics, scope/window, active definitions, and an optional computed execution envelope. Hosts must reject diagnostics, validate request shape independently, authorize inputs, and return an `AggregationResult` with matching metric IDs. The Go compiler accepts this contract; see [backend integration](backend-metrics.md) for SQL, limits, and mapping.

Server-computed SELECT and global sorting require `useQueryTable({ ..., computedExecution })` plus `fetchRowsV2`. Obtain `ComputedExecution` from the host's authoritative handshake: profile, plan token, resolved definition revisions, and per-field select/sort/measure/group capabilities. Queries reference `@computed/<id>`; sources are resolved by the server's authorized catalogue. Do not invent capabilities based on browser compilation.

Server SELECT is opt-in for each advertised field. With a v2 handshake, fields without SELECT capability still project their base dependencies and evaluate in browser workers on the returned page. A mixed projection can display browser-only formulas beside server sidecars. Browser-only definition edits do not invalidate the server page. Unavailable global sorts and computed grouping remain explicit diagnostics; they never fall back to sorting or grouping the local page.

Rows return a versioned response with execution identity and computed sidecars keyed by stable row ID and plain computed definition ID. The controller validates identities and revisions for server-selected and hidden server-sort fields before committing values. The full request revision envelope is retained for the backend to validate every reached transitive dependency; browser-only catalogue entries need not appear in the response revisions. The controller suppresses stale values when definitions change. Local computed columns continue to use browser workers; global sorting is available only with a matching server capability/revision envelope. Hidden computed sort dependencies are ordered before pagination.

Hosts own authorization, endpoint implementation, execution budgets, cancellation, and row/metric snapshot consistency. Forwarding `snapshot` or a plan token alone does not establish consistency: bind and enforce it on the service, with a shared transaction/snapshot where needed. Go's `CompileExecution` shares catalogue resolution and reference time; the host still executes and maps results. Advertise only capabilities implemented by the deployed service.

## Output formatting

`format`, `xFormat`, and `yFormat` use `MetricValueFormat`. Output types are `number`, `percent`, `duration`, `date`, `time`, or `datetime`. Formatting changes labels, tooltips, and table cells; reductions and sorts retain original typed values.

Duration units are milliseconds (default), seconds, minutes, hours, or days. Human style turns 84,000 seconds into `23h20m`; long and clock styles are also available. Custom patterns use `{d}`, `{h}`, `{hh}`, `{m}`, `{mm}`, `{s}`, `{ss}`, `{ms}`. Hours are total hours unless the pattern includes `{d}`.

Calendar inputs accept strict ISO dates/times/timestamps, epoch seconds/milliseconds, and time-only seconds/milliseconds of day. Timestamps require an explicit offset; civil dates/clocks do not shift between timezones. UTC is the default; specify an IANA timezone or `local`. Human labels use `Intl`; custom calendar patterns support `YYYY`, `MMMM`, `MMM`, `MM`, `DD`, `ddd`, `HH`, `hh`, `mm`, `ss`, `SSS`, `A`, `Z` and `[literal text]`. Invalid units, dates, patterns, or unsafe precision produce visible formatting errors, preserving the raw value. Public helpers include `formatMetricOutput`, `validateMetricFormat`, and `metricTimestamp`.

## Caller palettes and styling

```ts
const metricTheme: MetricTheme = {
  layers: [
    { id: "platforms", colors: ["#3979c3", "#288577", "#9864b4"] },
    { id: "outcomes", colors: ["#288577", "#c45e68"] },
  ],
  dimensions: {
    platform: { layer: "platforms", domain: ["Linux", "Windows", "macOS"] },
    result: { layer: "outcomes", domain: ["pass", "fail"] },
  },
  tokens: { accent: "var(--brand-accent)", grid: "var(--brand-border)" },
};
```

Use the same instance-scoped theme on QueryBuilder and MetricsPanel. Typed dimension/value identities keep Linux the same color across charts and distinguish numeric `1` from string `"1"`. A stable domain gives explicit palette order; unknown values hash deterministically. `overrides: [{ value, color }]` pins individual assignments, and `identity` lets equivalent field names share an identity. No global registry or data-arrival order affects colors. Finite palettes may reuse colors; use domains/overrides when uniqueness matters. Marks grouped by several keys (pie, donut, bar, box, histogram, list) are colored by their whole key, using the first field's layer: two keys drawn in one chart take different colors while the palette has room, and otherwise a key's color depends only on the theme and its values. Scatter charts color by their first key, which names the series. Line charts color by their second key.

CSS tokens cover accent, text, muted, grid, surface, other, null, and error. `MetricClassNames` exposes root/card/title/plot/axis/grid/legend/mark slots. `MetricCard` can render standalone with a clause and result/buckets; `MetricsEditor` can be opened directly with `{ api, fields, onClose, initialMetricId?, theme?, locale? }`. Palette information belongs to the caller and is not serialized into shared query data.


The stopwatch beside Auto-Update toggles request activity in `QueryBuilder`. The headless `api.requestActivity` tracks transport calls, elapsed time, errors and cancellation, retaining the latest 100 calls in memory. It does not retain query arguments or result payloads. `clear()` removes completed entries while keeping pending calls. Hosts can render `RequestActivity` independently or supply additional backend diagnostics through `QueryBuilder.requestActivityDetails`. A transport may internally issue several network requests; this view measures its overall method call.

Chart settings under Display → Scale & bounds configure `display.xScale` and `display.yScale` with `{ mode: "linear" | "log", min?: number, max?: number }`. Bounds are expressed in raw result units, independent of label formatting. Scatter, line and histogram support both axes; horizontal bars, box plots and list bars use X, vertical bars use Y. Pie/ring proportions and categorical axes do not have numerical scales. Omitted bounds follow the returned data. Log axes use positive values only, report omitted nonpositive values, and break lines at omitted points. A box containing nonpositive samples is omitted as a whole on a log axis; histogram intervals with nonpositive endpoints are omitted. Configured bounds clip plotted marks without changing aggregates, bin edges, counts or tooltip values. Settings persist with the query and do not change the computation sent to the backend.

Scatter X/Y formats and histogram X formats are independent of the main value format retained from other displays. Set `xFormat`/`yFormat` explicitly to format these coordinates. Custom Time patterns default to `HH:mm:ss`; duration labels omit a negative sign when the displayed units are all zero.

With explicit `dateGrouping`, calendar group labels honor temporal `xFormat`
options, such as `{ kind: "date", style: "custom", pattern: "MMM DD" }`.
Without calendar grouping, group labels show raw keys; a retained scatter or
histogram X format does not apply to these keys. Coordinates retain raw values.

When the first grouping field is a groupable `datetime`, Grouping settings offer
an optional calendar interval (hour/day/week/month/year), the cyclic hour of
day and day of week (see below) and **Include empty dates**. The definition stores `dateGrouping`, for example:

```ts
dateGrouping: {
  field: "enqueued_at", interval: "day", timeZone: "America/Denver",
  includeEmpty: true, range: "query",
}
```

Calendar boundaries use `timeZone`, an explicit IANA timezone (UTC by default);
weeks begin Monday. Timestamp values retain their absolute instants, while
date-only values represent local calendar dates. For example, `2026-10-02T02:00:00Z`
groups into October 1 in America/Denver. Calendar progression follows local
boundaries across daylight-saving changes: days can be 23 or 25 hours, missing
hours are skipped, and repeated hours have distinct instant keys. Fractional
offset changes can create partial-hour buckets. The local engine uses the
side-effect-free `temporal-polyfill` dependency for timezone calendar operations.

Query range completion requires conjunctive lower and upper date filters on
this field. Without both bounds there is no finite range to fill, so the metric
reports an error naming the missing bound. When the query has no bounded date
filter, use `range: "observed"` (fill from the first to the last populated
interval) or `range: "custom"` with `start` and `end`:

```ts
dateGrouping: { field: "enqueued_at", interval: "day", includeEmpty: true, range: "observed" }
```

Bounds inside an OR group, including a branch of an OR of conjunctions, do not
count, nor do filters on other fields.
Query filters retain their absolute timestamp semantics, including
UTC interpretation of date-only filter values; grouping does not rewrite them.
An exclusive upper bound exactly at a local boundary does not create the next
bucket; partial local intervals are included. Observed range completes from the
first to last populated interval. Custom range uses inclusive `start` and `end`
ISO dates/timestamps and must contain all observed buckets; use query filters to
narrow the population. Date-only custom bounds use the grouping timezone, and a
date-only custom end includes the whole local day, also
for hourly groups. Single date groupings can fill an entirely empty bounded
range. Additional grouping fields complete each observed series.

Calendar group labels on charts, lists, and metric tables use the grouping
timezone, overriding any retained `xFormat.timeZone` so labels match the
computation. Other temporal `xFormat` options still apply; hourly defaults and
line/bar tooltips include UTC offsets to distinguish repeated hours. Output
formatting timezone controls for measures remain independent of grouping.
Grouping requires an explicit named zone; `local` is not accepted because saved
definitions must compute the same buckets for every viewer.

Direct COUNT, COUNT_DISTINCT, and SUM use zero for generated empty buckets. AVG,
extrema, and composed expressions (including ratios) have null values there.
Populated buckets retain their existing null/error semantics. Completion runs
before result sorting and limits, within the normal metric budgets, and does
not add records to the table. Clearing or changing the first grouping field
clears its date settings.

`partialIntervals: "exclude"` keeps only whole intervals: it leaves out an
interval that the query's (or the metric's own) conjunctive date bounds cut
short, and any interval that has not ended by the evaluation clock, such as
today. The excluded rows leave the metric, so they never appear as a short
first or last bucket, and completion does not refill those intervals as empty.
When no interval is whole the result has no buckets.

Calendar metrics execute on the v3 backend, locally on datasets already in
memory, or over committed shown rows. Legacy v1/v2 server execution rejects date
grouping explicitly. An unsupported server operation never triggers a population
download. Settings are
serialized with the query and participate in metric computation identity.


### Windows, running values and shares

A calendar metric can show each point as a trailing window or a running value,
and any grouped sum or count can be shown as a share:

```ts
const cacheShare: AggregationClause = {
  id: "cache-share",
  op: "count",
  expression: "SUM([cache_read]) / NULLIF(SUM([input]), 0)",
  groupBy: ["at", "model"],
  dateGrouping: { field: "at", interval: "day", includeEmpty: true,
    range: "query", partialIntervals: "exclude" },
  window: { periods: 7 },          // or { periods: "all" } for a running value
};
const modelShare: AggregationClause = {
  id: "model-share", op: "sum", field: "tokens", groupBy: ["at", "model"],
  dateGrouping: { field: "at", interval: "day", includeEmpty: true, range: "query" },
  window: { periods: 7 },
  share: "group0",                 // each model's part of the day's total
};
```

- **Window total** (`reduce: "total"`, the default). Each point is the metric
  over every row of its trailing `periods` intervals (2–1,000), or of every
  interval so far with `"all"`. Aggregates are rebuilt from per-interval
  parts: SUM, COUNT, MIN and MAX merge, and AVG is SUM / COUNT of its input, so
  `SUM([a]) / SUM([b])` pools its parts instead of averaging each interval's
  ratio. COUNT_DISTINCT and MEDIAN cannot be merged across intervals and are
  refused, because one value can occur in several intervals.
- **Mean per interval** (`reduce: "mean"`). The mean of the per-interval
  values of a single SUM, COUNT or COUNT_DISTINCT; empty intervals count as 0.
  For a distinct count this is the mean of daily counts, so a user active on
  two days counts on each. Ratios and averages are refused: they would weight
  every interval equally.
- **Partial windows.** A window needs every interval, so it requires
  `includeEmpty: true`. Points whose window starts before the first interval
  have no value unless `partial: "include"`, which uses the intervals
  available (and divides a mean by their number). Widen the query range to
  give early points a full window. Each windowed bucket reports the rows in
  its window as `count` and the intervals it combined as `intervals`. Rows
  without a date keep their own bucket and are not windowed.
- **Shares.** `share: "group0"` divides each bucket by the total of its first
  grouping key, such as one day over every series; `share: "total"` divides by
  the total over all groups. Shares need an additive measure (a single SUM or
  COUNT) and are fractions, so pair them with a percent format. The
  denominator is the same measure grouped by fewer keys, so groups past
  `groupLimit` still count. With a window, both are windowed before dividing.
  A share of the total cannot be windowed.
- **Ordering and limits.** `sort`, `groupLimit` and `minCount` apply to the
  combined buckets; `minCount` counts the rows in a point's window, and a
  summed minimum sums its field over the window. Windowed and share results
  have no Other remainder.
- **Drilldown.** `inspectBucketQuery` opens a windowed point's whole window,
  or every interval up to the point for a running value.

These options are computed from plain metrics. `planMetricSeries(query,
schema, { now })` returns plain metric queries, each within the 20-metric
budget with one clause's parts in the same query, and a `combine` function
for their results; `executeMetrics` and `evaluateMetrics` call it, so every
engine supports them. A host that sends metric requests itself calls it the
same way. Servers never receive these fields: `toMetricQuery` and
`toQueryRequestV3` report an `unexpanded_series` diagnostic instead.

### Hour of day and day of week

Two cyclic intervals profile a typical day or week. Each bucket is a slot of
the cycle rather than a date:

- `interval: "hourOfDay"` keys each record by its local wall-clock hour, `0`
  to `23`;
- `interval: "dayOfWeek"` keys it by its local ISO weekday, `1` (Monday) to
  `7` (Sunday).

The slot is the one the record's timestamp occupies in `dateGrouping.timeZone`.
Across a spring-forward change the skipped hour has no records that day; across
a fall-back change both 01:00 hours fall in slot `1`. Fractional offsets such as
`Asia/Kolkata` (+05:30) use the local hour, so 03:45Z is slot `9`. Keys are
numbers in every engine, and rows without a date keep a `null` bucket.

```ts
const byHour: AggregationClause = {
  id: "by-hour", op: "count", groupBy: ["at", "provider"],
  dateGrouping: { field: "at", interval: "hourOfDay",
    timeZone: "America/New_York", includeEmpty: true, range: "query" },
  display: { kind: "line" },
};
```

- **Grouping.** Slots combine with other `groupBy` fields. `includeEmpty`
  adds all 24 or 7 slots for each observed series, whatever the date range, so
  `range`, `start` and `end` do not apply to the slots. Direct COUNT,
  COUNT_DISTINCT and SUM fill-ins are 0; other expressions have no value.
  `minCount`, `hiddenGroups`, `sort`, `groupLimit` and shares work as for
  calendar intervals, and the default order is slot number. Windows need a
  timeline and are refused. Pooled box and histogram distributions are refused
  as for calendar intervals; use occurrences below.
- **Whole intervals.** `partialIntervals: "exclude"` keeps only the whole hours
  (`hourOfDay`) or days (`dayOfWeek`) inside the date bounds.
- **Engines.** The local engine (`evaluateMetrics`, `applyAggregations`), the
  v3 executor of the Go module (SQLite and PostgreSQL) and DuckDB compute
  slots, and their buckets match for the same rows. Servers advertise
  `QueryCapabilitiesV3.calendarCycles`; `toQueryRequestV3` reports a diagnostic
  without it. As for calendar intervals, the v1/v2 metric protocols
  (`/metrics`) reject date grouping.
- **Labels.** Charts, lists and tables label slots "09:00" and the locale's
  short weekday ("Mon"); tooltips use "09:00–10:00" and "Monday"
  (`metricCycleLabel`). Line charts order slots by number. The metric editor
  offers **Hour of day** and **Day of week** under Date interval.

#### Per-occurrence statistics

A slot pools every record that falls in it. To describe a *typical* Monday,
first total each Monday, then summarise those totals. Set
`dateGrouping.occurrence`:

```ts
const typicalWeekday: AggregationClause = {
  id: "typical-weekday", op: "count", groupBy: ["at"],
  dateGrouping: { field: "at", interval: "dayOfWeek", timeZone: "Europe/Berlin",
    includeEmpty: true, range: "query",
    occurrence: { interval: "day", includeEmpty: true } },
  distribution: { kind: "box", input: "" },  // optional
  display: { kind: "box" },
};
```

- **Occurrences.** `occurrence.interval` is one calendar `"day"` or `"hour"`
  of the slot (`hourOfDay` occurs hourly, so it needs `"hour"`). The metric is
  evaluated once per occurrence, with any expression: counts, sums, distinct
  counts, ratios and medians.
- **Whole occurrences only.** Occurrences the date bounds cut short, and the
  occurrence still in progress, are left out, using the same boundary as
  `partialIntervals: "exclude"`. "Last 30 days" opened at 14:00 drops the
  partial first and last dates. `partialIntervals: "include"` is refused.
- **Idle occurrences.** With `occurrence.includeEmpty: true` an occurrence
  without rows counts as 0 for a direct COUNT, COUNT_DISTINCT or SUM, and has
  no value for other expressions such as ratios and averages, so it is not a
  sample. Their range is the clause's `range` (`"query"` needs a lower date
  bound; the clock ends it), `"observed"` or `"custom"`. `false` counts only
  occurrences with rows.
- **Values.** Without a distribution, a slot's `value` is the **mean of its
  occurrence values**. With `distribution: { kind: "box" }` the bucket carries a
  box over the occurrence values and `value` is their median, as for every
  box; `whiskers` applies and `input` is not used. Histograms are refused.
  `count` is the slot's rows over its counted occurrences, so `minCount` counts
  rows, and `occurrences` is the number of samples. A slot without any sample
  has no value.
- **Execution.** `planMetricSeries` runs one calendar metric per occurrence
  clause (`interval: occurrence.interval`, whole occurrences only) and folds it
  into slots, so every engine with calendar grouping supports it, including
  the Go v3 executor, without server changes. Servers never receive
  `occurrence`; unexpanded clauses get the `unexpanded_series` diagnostic. An
  hourly occurrence over a year is 8,760 calendar groups per series, and they
  count against the engine's group budget.

#### Drill-down

`inspectBucketQuery` selects exactly one slot's records with ordinary
predicates. Inside the date field's conjunctive bounds (narrowed to whole
occurrences or whole intervals when the clause uses them), the slot's
occurrences are disjoint ranges r1…rk. The query adds `>= r1.start`,
`< rk.end` and, for each gap, an OR group `< ri.end` or `>= ri+1.start`.
Adjacent ranges, such as a repeated fall-back hour, merge. It returns `null`
when the query has no lower or upper bound on the date field, or when the
ranges would take the query past its 100-predicate budget (about 48
occurrences, such as hour 09:00 over seven weeks). A `null` slot key drills to
`is_null` as usual.

### Compact chart integration

`MetricCard compact` uses one shared axis for all visible box rows, with
30px rows and an axis based on the full observed ranges. It honors `xScale`,
keeps sampled outliers and actual extrema visible, and reports nonpositive
log-axis omissions. Sparse interpolated quartiles can exceed observed Tukey
inliers; visual whiskers meet the quartile edge while tooltips retain the
observed endpoints. This affects rendering only, not TypeScript/Go reductions
or the serialized metric protocol.

Chart tooltip state is isolated from plot rendering; hover/focus changes do not
rebuild axes or reformat marks. Tooltips show each mark's actual series color,
including multi-series lines. Compact histogram hovers give interval counts
without repeating the whole population; full views retain that context.
Compact top/bottom composition legends align category/value/share fields in
two columns. Hosts may set `--qt-metric-legend-columns: 1` or style the existing
legend class hook for a narrower cover. Dataset-specific cohort thresholds,
model palettes, conversation lineage, zero-retention policies, headlines,
sparklines, and review forms remain host responsibilities.
