# Distribution metrics: box plots and histograms

> Design reference preserved from the approved prototype. Production APIs and current integration limits are documented in [Metrics](metrics.md) and [Backend metrics](backend-metrics.md).

Status: working local prototype and implementation proposal. No production transport, SQL compiler, or exported API is changed. The synthetic dashboard now includes both displays.

A distribution summarizes **row values**, not already-reduced group values. In the editor choose Box & whisker or Histogram, then edit **Values to summarize**: `[total_ms]`, or `[useful_ms] / NULLIF([total_ms], 0)`. The existing first-party numeric row language handles arithmetic and conditions. `SUM([total_ms])` is not a distribution input: summing destroys the spread. The existing scalar formula is retained when switching displays, and the distribution's row expression is retained for switching back. Shown/all-matching scope, typed grouping tuples, saved labels, duration/percent output formats, card size, palette and tooltips continue to apply.

## Box & whisker

Each group returns `min, q1, median, q3, max, mean, n`, plus actual whisker endpoints and optional bounded outlier markers. Five-number statistics describe the population; mean is the optional sixth marker. Q1/median/Q3 use exact continuous linear interpolation: for sorted samples, position `(n−1)·p`, interpolating adjacent values. For `[0,10,20,30]`, these are `7.5,15,22.5`. This definition must be part of the protocol, rather than allowing SQL dialects to silently choose different quartile methods.

The default **Minimum / maximum** whiskers give an honest five-number summary. **1.5 × IQR** uses fences `q1−1.5·(q3−q1)` and `q3+1.5·(q3−q1)`. Whiskers end at the most extreme *observed values within* those fences. Fence values themselves are not whisker endpoints. Points outside the whiskers are outliers. Display the exact outlier count; the mockup draws at most 20 representative extreme markers, keeping both tails, and discloses that cap in tooltips. The mean marker can be hidden without recomputation. Never interpret a p5/p95 chart as a Tukey box plot: that would be a separate named whisker mode.

Boxes support full grouping tuples, with the first dimension supplying the categorical color. A group with zero numeric samples has no box, not a zero-valued box. One sample or a constant group produces coincident quartiles/whiskers; the renderer retains a visible mark. The shared value axis uses all ranked visible summaries before the height-driven drawing cap, so hiding a row for lack of space does not change that scale. View data retains the selected group results. Tooltips show full group keys, six statistics, actual whisker endpoints, sample/NULL counts and outlier counts. Sorting uses raw median, numeric sample count, total group row count or keys; group limits apply after statistics are computed.

## Histogram

Start with **2–30 equal-width bins** and frequencies (row counts). A histogram with no grouping summarizes all scoped values; optionally group by one key to compare up to six series side by side. The renderer discloses the series cap; View data retains the ranked series. Arbitrary tuple histograms, density, logarithmic bins, weighted populations, custom boundaries, automatic bin heuristics and cumulative curves can follow later without blocking this version.

Determine min/max from all valid scoped values **before group ranking or a display limit**. Return one ordered edge array shared by every group. Bin counts include zero bins. Lower edges are inclusive and upper edges exclusive, except the final upper edge, which includes the scoped maximum. Changing group sorting/limit never moves edges or loses observations. All-equal values form one point interval with all samples in it, not an artificial spread. Empty distributions have no edges. Reject bin counts whose edges collapse due to numeric precision. For each group, `sum(counts) = n`. A bin tooltip reports full category, interval inclusion, row count, sample count and excluded NULL count. Value formatting affects bin boundaries; frequency ticks remain row counts, never duration/percent labels.

Box group errors remain explicit; the prototype excludes an errored group's partial values rather than displaying a misleading partial box. Histogram input errors fail the shared request because the complete global extent is unknowable. Production should preserve that behavior, or return an explicit partial/error status that disables claims of complete coverage. Never silently derive global edges from only successful groups. NULL inputs are excluded with a per-group count; invalid/nonfinite numeric values use the error channel. Frontend presentation must not coerce text into numeric samples or guess units.

## Backend plan

These are structured reductions of one row projection. They need a distribution result type alongside scalar and paired-measure results, rather than packing arrays into scalar formula values. A tentative contract:

```ts
type DistributionRequest = {
  kind: "distribution";
  input: ValidatedRowExpression; // resolved fields/computed definitions, no user SQL
  groupBy: ResolvedGroupKey[];
  scope: MetricRowScope;
  reduction:
    | { kind: "box"; quantiles: [0.25, 0.5, 0.75]; method: "continuousLinear";
        whiskers: "minmax" | "tukey"; outlierLimit: number }
    | { kind: "histogram"; bins: { kind: "equalWidth"; count: number } };
};
// Each result has full typed group keys, totalRows, numericCount, nullCount,
// value/error status, method/precision and snapshot/revision identity.
// Box: min/q1/median/q3/max/mean, low/high, outlierCount, outlierValues.
// Histogram: sharedEdges, intervalClosure, per-group counts, coverage status.
```

Reuse the proposed server-computed-column row projection: dataset authorization and shared predicate → resolve definitions → evaluate validated numeric row expression once → grouped statistical reduction. Row limits apply only for shown scope. Group/result limits follow reduction; they never truncate the input population. Formatting, legend position, mean visibility, colors and card geometry stay outside compute keys. Whisker mode, histogram bins, input expression, scope and groups change the prototype computation key. Production can cache sufficient statistics separately to derive min/max or Tukey display variants where the returned data is sufficient; five-number statistics alone cannot recover Tukey endpoints/outlier counts.

The current Go `CompileAggregation` emits a single scalar aggregate and rejects `median`; distribution support requires an explicit new compiler/result contract. Do not infer support from the successful browser preview. Advertise capabilities for exact continuous percentiles, histogram binning, computed numeric inputs, Tukey endpoints/outlier counts, resource budgets and snapshot consistency. Unsupported displays remain editable with a concrete capability error; never fall back from all-matching to shown rows or label an approximation as exact.

For PostgreSQL, multiple percentile fractions can be reduced with one ordered-set aggregate. Combine that with MIN/MAX/AVG/COUNT in a single grouped statement, instead of separate client requests for each statistic. [PostgreSQL aggregate documentation](https://www.postgresql.org/docs/current/functions-aggregate.html). Maintain a separate group inventory and NULL/error counters so groups with no valid numeric values survive the response.

Tukey mode needs an additional stage after quartiles: join each full typed tuple to its row values, reduce observed in-fence endpoints and outlier counts, and select bounded outlier samples. Histogram auto extent similarly needs scoped min/max followed by bin assignment and grouped counts. These stages can be SQL CTEs/subqueries inside one statement. [PostgreSQL `width_bucket` documentation](https://www.postgresql.org/docs/current/functions-math.html) describes lower-inclusive/upper-exclusive boundaries, so the compiler must explicitly keep `value = maximum` in the final bin and special-case zero extent. Use parameterized bin count/validated ASTs, not interpolated user expressions.

If a backend needs several statements, the UI should still make **one batched metric request**, with each subplan using the same predicate, numeric projection, definition revisions and snapshot. Execute extent → counts or quartiles → whiskers in a repeatable snapshot/transaction; a changing dataset between stages can otherwise produce impossible bins or whiskers. Merge subplan results by full typed group tuple, preserving NULL keys and missing/error groups, never by position or display label. PostgreSQL can normally use staged statements or a single statement; no independent frontend query per percentile, group, or bin is needed.

Exact percentiles require ordering the population and may be expensive. Negotiate exact/approximate execution explicitly; report approximation method/parameters and precision when using sketches. Do not return all source samples to the browser for all-matching metrics. Histograms are bounded counts, not reconstructable populations; box summaries do not reconstruct histograms; page-local distributions do not represent all-matching scope. Enforce source scan/time/group budgets, cancellation, result limits and bounded outlier payloads. Resource exhaustion produces a visible error, not a sampled distribution mislabeled as exact.

## Local verification

The design worker imports dependency-free [distribution helpers](mockups/metric-distributions.ts), parses the row expression with the repository interpreter, and computes exact statistics over the complete 12,840-row synthetic population or the exact shown 100 rows. Native SVG draws both displays. This worker implementation is a small design scaffold, not the production execution strategy.

Verify exact percentile fixtures, singleton/constant/empty/signed inputs, Tukey actual endpoints and bounded outliers, explicit NULL/error handling, bin edge closure/zero bins/count conservation, shared edges across groups, scope and group-limit independence, row-expression validation, formatting without new requests, hover/focus details, grouping tuples, saved settings and preserved scalar/scatter behavior.
