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

Grouping supports up to 20 fields. Automatic/table display uses a pivot for exactly two grouping fields and a flat table for three or more. Other displays include scalar value, list, horizontal/vertical bars, line, pie, ring, scatter, box plot, and histogram. Chart points expose keyboard and hover tooltips. Escape dismisses an open tooltip; another Escape reaches the enclosing dialog. Combined Other pie/ring slices expose totals but cannot open a single-group inspector. Hover pencils open an individual metric or the dashboard layout when `MetricsPanel` receives `api`; custom hosts can instead provide `onEditMetric` and `onEditDashboard`. Configured decimal precision applies to both pie/ring values and their percentage shares. Pie/ring require valid nonnegative numeric shares; invalid chart data is explained rather than drawn misleadingly.

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

Aggregate formulas reduce row expressions and then compute once per group. `SUM([x]) / SUM([y])` is a ratio of sums, not an average of row ratios. Use `NULLIF` for an intentionally nullable denominator. Nested aggregates and bare row references outside reductions are invalid. `COUNT()`, `COUNT(expr)`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, and `MAX` retain scalar semantics. The local expression compiler also supports its documented row functions; each server profile advertises a narrower subset.

`sort` is a stable multi-term order over `value`, scatter `y`, `count`, distribution `samples`, or `group0`, `group1`, etc. Each term has ascending/descending direction and optional null placement. `groupLimit` (1–10,000) applies after reductions, formulas, and sorting. Results expose total group count/coverage so truncated charts can be identified. An Other bucket is available only when the engine can derive an exact additive remainder; ratios are not treated as additive.

Scatter stores the primary reduction in `expression` and the second in `expressionY`, with `display.kind: "scatter"`. Each typed group tuple produces one X/Y pair from the same population. Format X/Y independently through `xFormat`/`yFormat`, and label them through `xLabel`/`yLabel`.

Box and histogram definitions use `distribution: { kind, input, ... }`, where `input` is a numeric **row** expression, not an aggregate formula. Box options select `whiskers: "minmax" | "tukey"`; optional `display.boxMean` shows a mean marker. Histograms use `bins` (2–30). Quartiles interpolate at `(n-1)*p`. Tukey whiskers end at observed in-fence values; both outlier tails are retained in a bounded sample with a total outlier count. Histograms derive shared equal-width edges from the full scoped population before ranking/limiting groups; the final upper bound is inclusive. Constants and empty populations have explicit results. Distribution response types are exported by core.

Legend placement for pie, ring, and scatter is `left`, `right`, `top`, `bottom`, or `none`. List options are `showBars`, `useGroupColors`, and `showValues`. These affect presentation only. Saved inactive alternatives can be retained during editing; the computation projector sends only the active scalar, scatter, or distribution definition.

## Population scope

- `allMatching` (default): all rows matching the query filters, excluding the table limit/offset.
- `shownRows`: the current ordered page, including limit/offset. Virtualization and selection do not define the population.

Local mode must receive the complete dataset in `clientRows`. It uses the committed page for shown-row metrics. With a remote transport, advanced metrics require `fetchMetrics` and explicit `metricCapabilities.version: 2`. A legacy `fetchAggregations` endpoint remains usable for representable v1 metrics. Unsupported features fail explicitly; an all-matching metric never falls back to aggregating an incomplete page.

Shown-row fallback can reduce committed remote rows when all required inputs are present. Automatic evaluation waits in a loading state while that page is being fetched; a failed page request ends that wait and surfaces the row error. Applying such metrics adds their input dependencies to row projections. A draft referencing an unloaded field explains that the author must select/refresh it or use a snapshot-capable metric service. It never refetches current IDs and claims that newer values belong to the displayed snapshot.

A rows-only transport falls back to `clientRows` when a complete client dataset is supplied. Engine selection is per clause: legacy aggregates, including `count_distinct`, retain their existing coercion and grouping behavior even alongside composed formulas or scoped metrics. Legacy empty-text keys share the NULL bucket, matching `is_null` drilldown. Typed datetime grouping converts `Date` objects to ISO keys. The typed local engine gives each metric an independent operation budget (10 million by default); row and retained-memory limits still apply separately. An expensive metric cannot consume another metric's allowance. Direct field aggregate inputs read only their own binding; complex row formulas retain the full dependency input path. Both paths use the formula runtime for type/null/date checks and preserve operation accounting and safe-number validation before reduction. Null-only SUM groups contribute zero to an exact additive Other remainder, with their rows included in its count.

Regex row expressions are limited to shown-row local evaluation and execute in terminable workers with bounded input. All-matching regex, regex group formulas, and server regex metric expressions are unsupported. Remote global execution rejects residual filters and unsupported sorts rather than reducing a different population.

## Transport and server computed fields

```ts
const transport: Transport<Row> = {
  fetchRows: fetchLegacyRows,
  metricCapabilities: {
    version: 2, expressions: true, shownRows: true,
    distributions: true, computedFields: true, profile: "qt-postgres-v1",
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

Use the same instance-scoped theme on QueryBuilder and MetricsPanel. Typed dimension/value identities keep Linux the same color across charts and distinguish numeric `1` from string `"1"`. A stable domain gives explicit palette order; unknown values hash deterministically. `overrides: [{ value, color }]` pins individual assignments, and `identity` lets equivalent field names share an identity. No global registry or data-arrival order affects colors. Finite palettes may reuse colors; use domains/overrides when uniqueness matters.

CSS tokens cover accent, text, muted, grid, surface, other, null, and error. `MetricClassNames` exposes root/card/title/plot/axis/grid/legend/mark slots. `MetricCard` can render standalone with a clause and result/buckets; `MetricsEditor` can be opened directly with `{ api, fields, onClose, initialMetricId?, theme?, locale? }`. Palette information belongs to the caller and is not serialized into shared query data.


The stopwatch beside Auto-Update toggles request activity in `QueryBuilder`. The headless `api.requestActivity` tracks transport calls, elapsed time, errors and cancellation, retaining the latest 100 calls in memory. It does not retain query arguments or result payloads. `clear()` removes completed entries while keeping pending calls. Hosts can render `RequestActivity` independently or supply additional backend diagnostics through `QueryBuilder.requestActivityDetails`. A transport may internally issue several network requests; this view measures its overall method call.

Chart settings under Display → Scale & bounds configure `display.xScale` and `display.yScale` with `{ mode: "linear" | "log", min?: number, max?: number }`. Bounds are expressed in raw result units, independent of label formatting. Scatter, line and histogram support both axes; horizontal bars, box plots and list bars use X, vertical bars use Y. Pie/ring proportions and categorical axes do not have numerical scales. Omitted bounds follow the returned data. Log axes use positive values only, report omitted nonpositive values, and break lines at omitted points. A box containing nonpositive samples is omitted as a whole on a log axis; histogram intervals with nonpositive endpoints are omitted. Configured bounds clip plotted marks without changing aggregates, bin edges, counts or tooltip values. Settings persist with the query and do not change the computation sent to the backend.

Scatter X/Y formats and histogram X formats are independent of the main value format retained from other displays. Set `xFormat`/`yFormat` explicitly to format these coordinates. Custom Time patterns default to `HH:mm:ss`; duration labels omit a negative sign when the displayed units are all zero.
