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

Aggregate formulas reduce row expressions and then compute once per group. `SUM([x]) / SUM([y])` is a ratio of sums, not an average of row ratios. Use `NULLIF` for an intentionally nullable denominator. Nested aggregates and bare row references outside reductions are invalid. `COUNT()`, `COUNT(expr)`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`, and `MEDIAN` retain scalar semantics. `MEDIAN` accepts numeric expressions, ignores nulls, and averages the middle two values for even populations; an empty population returns null. `PERCENTILE(expr, p)` is the exact-linear percentile of the same population: `p` must be a number literal from 0 to 1 (`PERCENTILE([latency], 0.9)`; a field, formula or out-of-range `p` is a formula error). Sort the group's non-null samples, take position `(n-1)*p`, `lower = floor(position)` and `fraction = position - lower`, then return `(1-fraction)*a + fraction*b` for the samples `a` at `lower` and `b` at `min(lower+1, n-1)`, in IEEE double arithmetic in that order, clamped to `[a, b]`. `PERCENTILE([x], 0)` and `PERCENTILE([x], 1)` are the minimum and maximum; `PERCENTILE([x], 0.5)` equals the box median and, in the local engine and on SQLite, `MEDIAN([x])` bit for bit. DuckDB (`median`) and PostgreSQL (`percentile_cont(0.5)`) compute `MEDIAN` natively as `a + (b-a)/2`, which can differ from it in the last bit. Nulls are ignored, an empty population returns null, and an invalid sample fails the reduction as for `MEDIAN`. Several `PERCENTILE` terms over the same input share one sort per group in every engine, so `PERCENTILE([gap], 0.95) - PERCENTILE([gap], 0.5)` sorts each group once; `MEDIAN` shares that sort locally and on SQLite, while DuckDB and PostgreSQL reduce it with their native median aggregate. Both are available in aggregate formulas, not the legacy `AggOp` selector. Servers advertise `PERCENTILE` with the `metricPercentiles` capability; `toQueryRequestV3` refuses a request that needs it from a server without it. The local expression compiler also supports its documented row functions; each server profile advertises a narrower subset.

`sort` is a stable multi-term order over `value`, scatter `y`, `count`, distribution `samples`, or `group0`, `group1`, etc. Each term has ascending/descending direction and optional null placement. `groupLimit` (1–10,000) applies after reductions, formulas, `minCount`, and sorting. Results expose total group count/coverage so truncated charts can be identified. An Other bucket (`other` on the result) is the exact remainder of the groups `groupLimit` omits; see [Other remainders](#other-remainders).

Scatter stores the primary reduction in `expression` and the second in `expressionY`, with `display.kind: "scatter"`. Each typed group tuple produces one X/Y pair from the same population. Format X/Y independently through `xFormat`/`yFormat`, and label them through `xLabel`/`yLabel`.

Box and histogram definitions use `distribution: { kind, input, ... }`, where `input` is a numeric **row** expression, not an aggregate formula. Box options select `whiskers: "minmax" | "tukey" | "percentile"`; optional `display.boxMean` shows a mean marker. Histograms use `bins` (2–30). Quartiles interpolate at `(n-1)*p`. Tukey whiskers end at observed in-fence values; both outlier tails are retained in a bounded sample with a total outlier count. Percentile whiskers (`whiskers: "percentile"`, `whiskerProbabilities: [lo, hi]` with `0 ≤ lo < 0.25` and `0.75 < hi ≤ 1`, default `[0.1, 0.9]`) end at the exact-linear `lo` and `hi` percentiles, which are interpolated values rather than observed samples. The summary echoes them as `whiskerProbabilities`, `outlierCount` counts the samples strictly outside the whiskers and `outliers` is always empty; the chart marks only the minimum and maximum beyond them. Options of another kind or whisker mode (`whiskers` on a histogram, `whiskerProbabilities` without percentile whiskers, `probabilities` on a box) are inactive alternatives: every engine ignores them, so the editor keeps them when the chart kind changes.

A quantile curve uses `distribution: { kind: "quantiles", input, probabilities }` with 1–101 strictly increasing probabilities in [0, 1] (the editor's default is 0, 0.01, …, 1). Each bucket carries `{ kind: "quantiles", summary: { n, probabilities, values } | null }`: `values[i]` is the exact-linear percentile at `probabilities[i]`, and the summary is null for a group without numeric samples. The bucket `value` (for sorting and labels) is the exact-linear median, or null. Display it with `display.kind: "quantiles"`, a cumulative chart with one line per group (x the value, y the probability). Over a cyclic slot's occurrences, a box or a quantile curve summarises the occurrence values. Servers advertise these with `boxPercentileWhiskers` and `quantileDistributions`; `toQueryRequestV3` refuses them for a server without the capability. Histograms derive shared equal-width edges from the full scoped population before ranking/limiting groups; the final upper bound is inclusive. Constants and empty populations have explicit results. Distribution response types are exported by core.

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

Executors advertise support explicitly: `queryCapabilities.metricFilters` and
`queryCapabilities.metricMinCount`. A distinct or summed minimum also needs
`queryCapabilities.metricMinCountMeasures`. A clause that uses an unadvertised
control gets its own error result (`metricPopulationError` names it); the other
metrics in the batch still run, and the control is never silently dropped. The bundled
DuckDB, Go SQLite, Go PostgreSQL and Go v3 executors advertise all of them, and
`ExecuteV2Rows` runs them in memory.

The metric editor exposes **Only rows where…** (the table's filter chips scoped
to the metric) under *Data scope*, and **Minimum per group** with a
**Counting** choice (rows, distinct values of a field, or the sum of a numeric
field) under *Ordering & limits*. Cards note "N groups hidden (fewer than M
rows)", or "(fewer than 5 distinct Conversation values)" and "(fewer than 10
total Calls)". `metricMinCount`, `metricMinCountMeasure` and
`metricMinCountText` read either form.

## Intervals for rates and shares

A ratio metric can carry a confidence interval, so a bar of 15 turns at 40% and
a bar of 128 turns at 4.7% no longer look equally certain:

```ts
// Share of turns with an event, with a Wilson 95% interval per group.
const turnsWithEvent: AggregationClause = {
  id: "turn-share", op: "count", groupBy: ["prompt_length"],
  expression: "COUNT_DISTINCT(IF([events]>0,[turn_id],NULL)) / NULLIF(COUNT_DISTINCT([turn_id]), 0)",
  interval: { kind: "proportion" },
  display: { kind: "bar-horizontal", format: { kind: "percent", decimals: 1 } },
};
// Events per 1,000 messages read, with an exact Poisson 90% interval.
const eventRate: AggregationClause = {
  id: "per-thousand", op: "count", groupBy: ["model"],
  expression: "SUM([events]) / NULLIF(COUNT_DISTINCT([message_id]) / 1000, 0)",
  interval: { kind: "rate", level: 0.9 },
};
```

Every bucket with a numeric value then has `lower` and `upper`, in the value's
own units: after any constant scaling such as `/1000` or `100*`. `level` is
0.5 to 0.9999 and defaults to 0.95; levels outside that range would round the
quantile probabilities to 0 or 1.

An interval is an annotation: turning it on never changes a bucket's value,
error, ranking, `minCount`, `groupLimit` or Other remainder.

- **The metric must be a ratio.** The expression is one SUM, COUNT or
  COUNT_DISTINCT (the numerator) over another (the denominator), multiplied or
  divided only by positive number literals, with `NULLIF(x, 0)` allowed around
  either part and parentheses anywhere: `A/B`, `A/NULLIF(B,0)`,
  `100*A/B`, `A/(B/1000)` and `A/NULLIF(B/1000,0)` all qualify. Any other shape
  (an AVG, a difference, a third aggregate, a negative or zero constant, a
  plain `op`/`field` metric), an unknown kind or a level out of range is a
  clause error with the `metric_interval` code in every engine. Write a mean of
  a 0/1 flag as
  `SUM([flag]) / COUNT([flag])` to give it an interval.
- **`proportion`** is a share of units that have a property: the numerator
  counts some of the units the denominator counts (0 ≤ numerator ≤
  denominator). The interval is the Wilson score interval for numerator
  successes in denominator trials. It is 0 at the bottom when the numerator is
  0 and 1 at the top when every unit counts.
- **`rate`** is a count over an exposure. The interval is the exact (Garwood)
  Poisson interval for the numerator count, divided by the denominator: the
  gamma quantiles at (1 − level)/2 with shape numerator and at (1 + level)/2 with
  shape numerator + 1. A zero count has a lower bound of 0.
- **Exact parts.** Bounds come from the exact numerator and denominator each
  engine already reduces for the value, never from the rounded value. A group
  with an error, or without a value (a zero denominator under `NULLIF`, an
  empty calendar interval), has no interval; an error always takes precedence.
  A zero denominator without `NULLIF` is the usual division error.
- **Counts only.** The numerator counts events or units, so it must be a
  nonnegative integer; a proportion's denominator must be an integer at least
  as large, while a rate's exposure may be fractional. A group whose parts are
  outside this domain keeps its value and gets `intervalError:
  "interval_domain"` instead of bounds, so a wrong kind is visible without
  changing the chart. This rejects the common misuse, a SUM of amounts such as
  revenue or durations, but the engine cannot know units: `proportion` on a
  share is meaningful only when the SUM counts units.
- **Totals and Other.** A grand total (`groupBy: []`) is one bucket like any
  other. Groups hidden by `minCount` have no bucket. When `groupLimit` omits
  groups of a ratio whose parts are SUM or COUNT, the Other remainder pools
  each part and carries bounds from the pooled parts (see
  [Other remainders](#other-remainders)); COUNT_DISTINCT parts have none.
- **Windows and shares.** A window total pools each part over the window
  before the interval is computed, so a 7-day point's interval covers its 7
  days of counts; a mean per interval has no interval. A share
  (`share: "total"` or `"group0"`) is a proportion of its total: use
  `kind: "proportion"`, and the interval is computed from the bucket's sum or
  count and the total it is divided by. These are planned on the client from
  plain metrics like the window or share itself, so the server needs no
  interval support for them. Occurrence means, distributions and scatters
  refuse an interval.

**What the intervals assume.** Both methods treat the counted units as
independent: Bernoulli trials for Wilson, Poisson events for Garwood. They
describe sampling noise under that assumption only. Clustered or over-dispersed
data makes them too narrow: events that cluster within a message (a rate of
`SUM([events]) / COUNT_DISTINCT([message_id])`), or turns that cluster within
sessions or users (a share of turns). `kind` names the quantity and picks the
method today; a later optional `method` (Jeffreys, Clopper–Pearson, an
over-dispersed rate) can be added without changing these defaults.

Executors advertise support as `queryCapabilities.metricIntervals`. The local
engine, DuckDB, and the Go SQLite and PostgreSQL executors (`QueryDatasetV3`)
all compute intervals and return the same bounds; the shared cases are in
`schema/fixtures/metric-intervals.json`. `toQueryRequestV3` refuses a clause
with an interval when a server does not advertise it, and the metric executor
gives that clause its own error, so a host on an older server sees an
explicit "does not support metric intervals" rather than bars without them.
`metricRatioParts`, `metricIntervalBounds` and `applyMetricInterval` are
exported for hosts that compute their own buckets.

## Other remainders

When `groupLimit` omits groups, the result's `other` bucket (no keys) is
their exact remainder, in every engine:

- **A single SUM or COUNT**: the sum of the omitted values. A SUM group with no
  values adds nothing; an omitted group with an error means there is no
  remainder.
- **A ratio of SUM or COUNT parts** (the shapes an interval accepts, such as
  `SUM([failures]) / NULLIF(SUM([calls]), 0)` or `100 * COUNT() / SUM([n])`):
  each part is summed over the omitted groups and the formula is evaluated on
  the pooled parts, so Other is the remainder's own rate, not an average of
  the omitted rates. The expression's own semantics apply to the pooled parts:
  a pooled denominator of 0 gives no value under `NULLIF(denominator, 0)` and a
  division error without it, and `NULLIF(ratio, 0)` nulls only a zero result. An error in a part means there is no
  remainder. With `interval`, Other has `lower` and `upper` from the pooled
  parts.

`count` is the omitted groups' rows. Groups hidden by `minCount` are never part
of Other, and empty calendar fill-ins add nothing. Other is not computed for
distinct counts (including a ratio with a COUNT_DISTINCT part, which do not add
across groups), averages (whose remainder could be pooled like a ratio's;
not computed yet), extrema, medians, distributions, scatters, or windowed and
share results. The local engine, DuckDB and the Go SQLite and PostgreSQL
executors compute it. Nothing in a request depends on it and there is no
capability flag: clients key off whether `other` is present. A limited result
without it (`groupCount` larger than the buckets) has no remainder the
executor could compute. The UI pools additive metrics into Other rows and
slices itself, and a list with `showOther` shows a ratio's returned `other`
(with its interval) when the display drops no further groups;
`metricOtherRemainder` is exported for hosts that rank and limit buckets
themselves.

## Population scope

- `allMatching` (default): all rows matching the query filters, excluding the table limit/offset.
- `shownRows`: the current ordered page, including limit/offset. Virtualization and selection do not define the population.

Remote all-matching metrics execute on the server and return bounded metric
results. Local mode accepts `clientRows` already available in memory; the
controller never downloads a population for aggregation. Shown-row metrics may
use the committed page.
With a transport, each metric batch is one `fetchQueryV3` request with
`rows: false`, including calendar metrics, metrics over grouped results and
shown-row clauses (the server pages the same ordered result). Unsupported
features fail explicitly; an all-matching metric never falls back to an
incomplete page. See the [host integration guide](host-integration-next-release.md).

Without a transport, shown-row metrics reduce the committed page when all required inputs are present. Regex inputs use workers. Automatic local evaluation waits in a loading state while that page is being prepared; a failed page ends that wait and surfaces the row error. Applying such metrics adds their input dependencies to row projections. A draft referencing an unloaded field explains that the author must select it.

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
the existing execution selection. Metric requests use the overrides and appear
in `requestActivity`. Query restoration,
activation, and query validation still apply before metric execution.

`metricRowsReady(query)` defaults to true and adds a host gate to the hook's
internal committed-page readiness. It gates local shown-row results and
previews, including purely local tables. Unavailable previews reject; losing
readiness clears current results and cancels local work. Previews that become
obsolete reject with `AbortError`. With a metric transport every clause,
shown-row ones included, executes on the server with its snapshot semantics and
does not depend on this local-page gate; a separate metric service should only
be used for shown-row clauses if it can share the displayed page's snapshot.

Engine selection is per clause: legacy aggregates, including `count_distinct`, retain their existing coercion and grouping behavior even alongside composed formulas or scoped metrics. Legacy empty-text keys share the NULL bucket, matching `is_null` drilldown. Typed datetime grouping converts `Date` objects to ISO keys. The typed local engine gives each metric an independent operation budget (10 million by default); row and retained-memory limits still apply separately. An expensive metric cannot consume another metric's allowance. Direct field aggregate inputs read only their own binding; complex row formulas retain the full dependency input path. Both paths use the formula runtime for type/null/date checks and preserve operation accounting and safe-number validation before reduction. Null-only SUM groups contribute zero to an exact additive Other remainder, with their rows included in its count.

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
- A date-grouped key adds `>= start` and `< next`, using the clause's interval,
  `every` and timezone (`metricDateNext`), encoded as ISO instants (`…Z`). Filters
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
  queryCapabilities, // the server's v3 handshake, metricFilters/metricMinCount included
  fetchQueryV3: (request, signal) => postQuery(request, signal),
};
```

`fetchQueryV3` is a host implementation, not a provided HTTP endpoint (the Go
`NewQueryV3Handler` serves it). Every remote operation is one `QueryRequestV3`:
row pages, metric batches (`rows: false`), grouped results, filter suggestions
(`distinct`, see `toDistinctRequestV3`), single-row lookups (`toRowRequestV3`)
and field statistics (`toFieldStatsRequestV3`). Hosts must reject diagnostics,
validate request shape independently, authorize inputs, and return a
`QueryResultV3` with matching metric IDs; `validateQueryResultV3` checks it on
the client. See [backend integration](backend-metrics.md) for SQL, limits, and mapping.

Server-computed SELECT and global sorting require `useQueryTable({ ..., computedExecution })`. Obtain `ComputedExecution` from the host's authoritative handshake: profile, plan token, resolved definition revisions, and per-field select/sort/measure/group capabilities. Queries reference `@computed/<id>`; sources are resolved by the server's authorized catalogue. Do not invent capabilities based on browser compilation.

Server SELECT is opt-in for each advertised field. Fields without SELECT capability still project their base dependencies and evaluate in browser workers on the returned page. A mixed projection can display browser-only formulas beside server values. Browser-only definition edits do not invalidate the server page. Unavailable global sorts and computed grouping remain explicit diagnostics; they never fall back to sorting or grouping the local page.

Rows return a versioned response with execution identity; computed values are inline in each row under `@computed/<id>` (or `{ computedError }`). The controller validates identities and revisions before committing values. The full request revision envelope is retained for the backend to validate every reached transitive dependency; browser-only catalogue entries need not appear in the response revisions. The controller suppresses stale values when definitions change. Local computed columns continue to use browser workers; global sorting is available only with a matching server capability/revision envelope. Hidden computed sort dependencies are ordered before pagination.

Hosts own authorization, endpoint implementation, execution budgets, cancellation, and row/metric snapshot consistency. Forwarding `snapshot` or a plan token alone does not establish consistency: bind and enforce it on the service, with a shared transaction/snapshot where needed. Go's `CompileExecution` shares catalogue resolution and reference time; the host still executes and maps results. Advertise only capabilities implemented by the deployed service.

## Output formatting

`format`, `xFormat`, and `yFormat` use `MetricValueFormat`. Output types are `number`, `percent`, `currency`, `duration`, `date`, `time`, or `datetime`. Formatting changes labels, tooltips, and table cells; reductions and sorts retain original typed values.

Currency needs an ISO 4217 code: `{ kind: "currency", currency: "USD" }` shows `$1,234.50`, using the currency's own minor units (`¥1,235`) unless `decimals` is set. Number and currency also take `notation: "compact"`, the locale's compact notation for large amounts and token totals: `{ kind: "number", notation: "compact" }` shows `1.2K` and `3.4M` in English and `1,2 Mio.` in German, and compact currency shows `$1.2M`. With compact notation `decimals` is a maximum (default 1) rather than an exact count. A currency format without a valid code shows **Invalid format** with the reason rather than guessing a currency. The metric editor offers Currency under Output type, with its code, and a Compact checkbox for Number and Currency; leaving Decimals empty (Auto) keeps the currency's own digits or compact's single digit. The formats travel in links, saved queries and the Go link codec like the other formats; link normalisation keeps `currency` only on currency formats and `notation` only on number and currency formats, and drops the default `notation: "standard"`.

A numeric metric's value is labelled by the first of these that applies:

1. NULL is `—`; a value or group error shows the error.
2. An explicit `display.format` on the metric (including for counts).
3. An expression metric, whose units may differ from any field, uses the card's shared decimals.
4. COUNT and COUNT_DISTINCT are integer counts.
5. If the metric is in the measure's units, the measure field's numeric `display` (`number` with `decimals` or compact notation, `percent`, `currency` or `duration`) becomes its default format. Shares (`share`) are ratios and a box or histogram over another input measures something else, so neither takes the measure's display (or its `duration_ms`/`byte_size` renderer).
6. Otherwise the card's shared decimals. Values (not chart labels) of a measure rendered with the built-in `duration_ms` or `byte_size` keys use that renderer; other renderers, including host-registered keys, are table-cell presentations and are not used for metrics.

Steps 2 and 5 apply wherever the value appears: scalar values, lists, tables and pivots, chart value axes, bar and slice labels, tooltips, box statistics and pie totals. To show a money or token measure the same way everywhere, declare `display: { kind: "currency", currency: "USD" }` or `display: { kind: "number", notation: "compact" }` on the field; table cells keep a registered `render`, which resolves before `display`.

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

Use the same instance-scoped theme on QueryBuilder and MetricsPanel. Typed dimension/value identities keep Linux the same color across charts and distinguish numeric `1` from string `"1"`. A stable domain gives explicit palette order; unknown values hash deterministically. `overrides: [{ value, color }]` pins individual assignments, and `identity` lets equivalent field names share an identity. No global registry or data-arrival order affects colors. Finite palettes may reuse colors; use domains/overrides when uniqueness matters. Marks grouped by several keys (pie, donut, bar, box, list) are colored by their whole key, using the first field's layer: two keys drawn in one chart take different colors while the palette has room, and otherwise a key's color depends only on the theme and its values. Scatter charts color by their first key, which names the series. Line charts color by their second key.

To color bars, boxes and list rows grouped by several keys by one of their keys
instead, name it in `colorBy`. A group then takes that key's color: its
`overrides`, `domain` slot or NULL color, so one kind keeps its color on every
bar. Values with neither take the next color no other value of the key uses in
the same chart while the palette has room (by typed value, not arrival order),
so give the key a `domain` or `overrides` when its colors must also match across
charts. A key matches by field name or by its dimension's `identity`:

```ts
const metricTheme: MetricTheme = {
  layers: [{ id: "kinds", colors: ["#3979c3", "#288577", "#9864b4"] }],
  dimensions: {
    family: { layer: "kinds", overrides: [{ value: "Missing tool", color: "var(--event-friction)" }] },
  },
  colorBy: "family", // or a priority list: ["family", "platform"]
};
```

The theme's `colorBy` is the host default: it applies to every chart whose
`groupBy` contains a listed field; with a list, the first listed field present
wins. A chart can choose its own key with `display.colorBy`, which takes
precedence and is saved with the chart in query links and saved views. The
metric editor offers it as **Colour by** for bar, box and list charts grouped by
two or more keys, with **Whole group (theme default)** clearing it:

```ts
{ id: "events", op: "count", groupBy: ["repository_name", "family"],
  display: { kind: "bar-horizontal", colorBy: "family" } }
```

A saved `display.colorBy` that names a key the chart no longer groups by is
kept but ignored: the chart falls back to the theme's key, or to whole-group
colors, without an error. Key colors apply only to marks that carry their own
label. Pie and ring slices, which are told apart by color alone, keep
whole-group colors under either setting (histograms take a single grouping key).
Other groupings, single keys, scatter and line charts are unaffected. Legends list each whole key with the color drawn for it, so
several entries can share a color; hover cards and the Other bucket are
unchanged. Neither setting is sent to the server.

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

### Buckets of several intervals

`every` (an integer 1–1,000; omitted means 1; for hours one of 1, 2, 3, 4, 6,
8, 12 or 24) groups several calendar intervals into one bucket, such as 3-, 6-
or 12-hour periods, fortnights or quarters:

```ts
dateGrouping: { field: "at", interval: "hour", every: 6, timeZone: "America/New_York",
  includeEmpty: true, range: "query" }
```

A bucket is keyed by its start instant, as one interval is. Anchors are fixed,
independent of the query range, so the same rows always fall in the same
buckets and results stay cache-stable:

- **Hours.** `every` must divide a day: 1, 2, 3, 4, 6, 8, 12 or 24. Buckets
  start at local wall-clock hours that are multiples of `every` within each
  local day in the grouping zone: 00:00, 06:00, 12:00 and 18:00 for
  `every: 6`, also in a half-hour zone such as Asia/Kolkata. The restriction
  keeps hour buckets aligned to local days, so changing `timeZone` reshapes
  every hour count the same way. Any other count is refused (`date_grouping`
  for a metric, `grouping` for a group key, and a diagnostic in links); use
  `interval: "day"` with `every` for longer spans. Elapsed-hour blocks (such
  as 5-hour periods counted from the epoch) could be added later as an explicit
  opt-in if a host needs them; accepting more values then is
  backward-compatible. A daylight-saving change makes its bucket longer or
  shorter: both occurrences of a repeated hour fall in the same bucket, and a
  bucket whose start hour is skipped starts at the transition, as hourly
  floors do. Buckets always partition the timeline: in the rare zone whose
  fall-back repeat contains a bucket boundary (the two-hour repeat of
  Antarctica/Troll with `every: 2`), the instants after the later bucket's
  start belong to that bucket.
- **Days.** Groups of `every` local calendar dates counted from 1970-01-01
  (the local date's day number, floor-divided by `every`).
- **Weeks.** Groups of `every` Monday weeks counted from the week of Monday
  1969-12-29.
- **Months.** Groups of `every` months counted from January 1970, so 3, 4 and 6
  give quarters, thirds and halves of the year starting in January.
- **Years.** Groups of `every` years counted from 1970.

Everything that works on intervals works on buckets: `includeEmpty` fills every
bucket of the range; `range: "query"`, `"observed"` and `"custom"` round their
bounds to whole buckets, and `partialIntervals: "exclude"` treats a bucket the
date bounds cut, or that has not ended, as partial; a window's `periods` count
buckets; shares, `sort`, `groupLimit` and `minCount` are unchanged; and
`inspectBucketQuery` selects the bucket's `[start, next)` range. Hour-of-day
and day-of-week slots, and their per-occurrence statistics, are single hours or
days and refuse `every` above 1 with a `date_grouping` diagnostic. Links and
saved state leave out `every: 1`. Charts label a bucket with its range in the
grouping zone: `Jul 04 09:00–12:00 -04:00` for hours, `Jan 01–Jan 03` for days
and weeks (the last day included), `Apr–Jun 2026` for months and `2020–2029`
for years. Metric settings offer an **Every** count beside Date interval (a
choice of 1, 2, 3, 4, 6, 8, 12 or 24 for hours), hidden for slots and reset to
1 when the interval changes.

`metricDateFloor(time, interval, timeZone, every)` and `metricDateNext(time,
interval, timeZone, every)` expose the calendar; they throw a `RangeError`
for an `every` that is not an integer 1–1,000, or that does not divide 24 for
hours (`METRIC_HOUR_EVERY` lists those counts). Go hosts use
`CalendarBucket(instant, interval, every, timeZone)`, which returns a
bucket's start (its key) and the next bucket's start, so they can label or
drill into buckets without reimplementing the anchors. In Go, `Every: 0` is
the omitted value (one interval); an explicit `"every": 0` on the wire is
refused, as the schema and the TypeScript engine refuse it. A server executes `every`
above 1 when its handshake sets `QueryCapabilitiesV3.calendarEvery`;
otherwise `toQueryRequestV3` reports a `capability_unsupported` diagnostic for
that metric. Query Table's Go executor (SQLite and PostgreSQL) and DuckDB
adapter advertise it.

Calendar metrics execute on the v3 backend, locally on datasets already in
memory, or over committed shown rows. Legacy v1/v2 server execution rejects date
grouping explicitly. An unsupported server operation never triggers a population
download. Settings are
serialized with the query and participate in metric computation identity.

### Drawing intervals

When buckets carry `lower` and `upper` (a metric with `interval`), vertical and
horizontal bars draw an error-bar whisker with end caps on each bar that has
finite bounds. Bars never stack (a bucket with several keys is one bar), so
every bounded bar gets its own whisker. Line charts shade a low-opacity band in
the series colour beneath the line, breaking it wherever a point has no bounds;
a bounded point between gaps is drawn as a whisker. The value axis extends to
the drawn bounds, so nothing is clipped by inferred extents. Explicit axis
bounds still clip: a whisker cut by the axis, or a nonpositive lower bound on a
logarithmic axis, runs to the plot edge without a cap and is never shifted.
Whiskers are drawn in the text colour over a wider halo in the surface colour,
so they stay legible over dark bars; `.qt-metric-interval` and
`.qt-metric-interval-halo` can restyle them.

Hover text, tooltips and each mark's accessible label add the interval on its
own line, for example `95% interval 2.2%–9.8%`: the level as a percent (up to
four decimals, so no accepted level reads as 100%), and the bounds in the
metric's value format. A bucket with `intervalError: "interval_domain"` reads
`No interval: needs whole counts, at most the total` (a proportion) or
`No interval: needs a whole, nonnegative count` (a rate). Lists and tables put
the text in the value's title and in visually hidden text read with the value.
A single value shows it beside its row count, as in
`95% interval 2.2%–9.8% · 128 rows`. Compact axis labels and legends never
include it. `display.showIntervals: false` hides whiskers, bands and the
single-value line; hover and screen-reader text remain.

A list with `display.showOther` shows a ratio's `other` remainder as returned
by the engine, including its interval, when the display drops no further groups
(`maxGroups` is unset or keeps every returned group). Ratios cannot be pooled
from displayed values, so a list that truncates groups itself shows no Other.

Host-rendered views can use the same reading: `metricBucketInterval(bucket)`
returns finite, ordered bounds of a bucket without an error, and
`metricIntervalText(clause, bucket, format, { locale, label })` returns the
hover line, with `label` replacing the word "interval".
`formatMetricIntervalLevel(level, locale)` formats a level.

In the metrics editor, **Confidence interval** (after Window & share) sets
`interval.kind` to None, Proportion (Wilson) or Rate (Poisson), and a 90%, 95%
or 99% **Confidence level**; 95% is stored by omitting `level`. A kind that
`validateMetricInterval` rejects for the metric, such as Rate on a share, is
disabled with the reason as its tooltip, and the section is hidden while no
interval is set and no kind applies (for example a plain count). A chosen
interval that has become invalid stays selected and its reason is shown in
the section. Bar and line displays add **Show interval whiskers and bands**,
bound to `display.showIntervals`. Turning the interval off, or choosing a box,
histogram or scatter display, removes the interval and its display setting.

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
  ratio. COUNT_DISTINCT, MEDIAN and PERCENTILE cannot be merged across
  intervals and are refused: one value can occur in several intervals, and an
  order statistic needs the window's own sorted samples.
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
same way. Servers never receive these fields: `toQueryRequestV3` reports an
`unexpanded_series` diagnostic instead.

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
- **One hour or day per slot.** `every` above 1 is refused with a
  `date_grouping` diagnostic, also with `occurrence`; see
  [Buckets of several intervals](#buckets-of-several-intervals).
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
  counts, ratios, medians and percentiles.
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
