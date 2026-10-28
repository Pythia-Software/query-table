import type { FormulaDiagnostic } from "./formula";
import type { AggregationClause, OrderByClause, WhereTerm } from "./query";
export type MetricValue = number | string | boolean | null;
export type MetricKey = MetricValue;
export type MetricScope = "allMatching" | "shownRows";
/** Calendar intervals: each bucket is one interval on the timeline, keyed by
 * its start as an ISO instant. */
export type MetricCalendarInterval = "hour" | "day" | "week" | "month" | "year";
/** Cyclic intervals: each bucket is one slot of a repeating cycle, keyed by a
 * number. `hourOfDay` is the local hour, 0–23; `dayOfWeek` the ISO weekday,
 * 1 (Monday) to 7 (Sunday). */
export type MetricCycleInterval = "hourOfDay" | "dayOfWeek";
/** Summarise each cyclic slot over its occurrences: every whole day or hour
 * the slot covers inside the query's time bounds. */
export interface MetricDateOccurrence {
  /** One occurrence: "day" (dayOfWeek only) or "hour". */
  interval: "hour" | "day";
  /** Count occurrences without rows: 0 for direct COUNT, COUNT_DISTINCT and
   * SUM metrics, no value for other expressions. false leaves them out. */
  includeEmpty: boolean;
}
/** Calendar grouping, currently executed over complete local populations. */
export interface MetricDateGrouping {
  field: string;
  interval: MetricCalendarInterval | MetricCycleInterval;
  /** IANA timezone identifier; omitted settings retain UTC behavior. */
  timeZone?: string;
  /** Add a bucket for every interval of the range, or for every slot of a
   * cyclic interval. */
  includeEmpty: boolean;
  /** The calendar range empty intervals fill; for a cyclic interval, the range
   * whose empty occurrences count. */
  range: "query" | "observed" | "custom";
  start?: string;
  end?: string;
  /** "exclude" leaves out intervals the query's bounds cut, and intervals that
   * have not ended by the evaluation time; omitted includes them. A cyclic
   * interval's intervals are its hours or days. */
  partialIntervals?: "include" | "exclude";
  /** Cyclic intervals only: each slot's value is the mean of its
   * per-occurrence values, and a box distribution summarises them. Only whole
   * occurrences count. Computed from a calendar metric by planMetricSeries. */
  occurrence?: MetricDateOccurrence;
}
/** A trailing window over a calendar metric's intervals. */
export interface MetricWindow {
  /** Intervals per point, its own included (2–1,000), or "all" for a running
   * value from the first interval. */
  periods: number | "all";
  /** "total" (default) evaluates the metric over every row in the window, so
   * ratios pool their parts. "mean" averages the per-interval values of a
   * single SUM, COUNT or COUNT_DISTINCT. */
  reduce?: "total" | "mean";
  /** Points whose window starts before the first interval have no value
   * ("omit", default) or use the intervals available ("include"). */
  partial?: "omit" | "include";
}
/** Divide each bucket by the total of all groups ("total") or of its first
 * grouping key ("group0"), such as one calendar interval. */
export type MetricShare = "total" | "group0";
export interface MetricValueFormat {
  kind: "number" | "percent" | "duration" | "date" | "time" | "datetime";
  decimals?: number;
  sourceUnit?:
    | "milliseconds"
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "iso"
    | "epochSeconds"
    | "epochMilliseconds"
    | "secondsOfDay"
    | "millisecondsOfDay";
  style?: "human" | "long" | "clock" | "custom" | "iso";
  pattern?: string;
  timeZone?: string;
}
/** Bounds use raw result units; omitted bounds are inferred from the data. */
export interface MetricAxisScale {
  mode?: "linear" | "log";
  min?: number;
  max?: number;
}
export interface MetricDisplay {
  kind:
    | "auto"
    | "value"
    | "table"
    | "list"
    | "bar-horizontal"
    | "bar-vertical"
    | "line"
    | "pie"
    | "donut"
    | "scatter"
    | "box"
    | "histogram";
  valueLabel?: string;
  xLabel?: string;
  yLabel?: string;
  format?: MetricValueFormat;
  xFormat?: MetricValueFormat;
  yFormat?: MetricValueFormat;
  legendPosition?: "left" | "right" | "top" | "bottom" | "none";
  /** Maximum displayed groups; does not change the computed result or ordering. */
  maxGroups?: number;
  /** Show the exact additive remainder in pie/donut (default true) or list (default false). */
  showOther?: boolean;
  list?: {
    showBars?: boolean;
    useGroupColors?: boolean;
    showValues?: boolean;
    /** Place the line bar beside the label (default) or underneath a wrapping label. */
    barPosition?: "inline" | "below";
    /** Maximum wrapped label lines for below bars (positive integer); omitted means unlimited. */
    maxLabelLines?: number;
  };
  pivot?: {
    swap?: boolean;
    rowDir?: "asc" | "desc";
    columnDir?: "asc" | "desc";
  };
  boxMean?: boolean;
  xScale?: MetricAxisScale;
  yScale?: MetricAxisScale;
}
export interface MetricLayout {
  widthRem: number;
  heightRem: number;
  minWidthRem: number;
  minHeightRem: number;
}
export interface MetricDistribution {
  kind: "box" | "histogram";
  input: string;
  whiskers?: "minmax" | "tukey";
  bins?: number;
}
export interface MetricSort {
  key: "value" | "y" | "count" | "samples" | `group${number}`;
  dir: "asc" | "desc";
  nulls?: "first" | "last";
}
export interface MetricBoxSummary {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  low: number;
  high: number;
  outliers: number[];
  outlierCount: number;
  whiskers: "minmax" | "tukey";
  method: "exact-linear";
}
/** One histogram bin: `min <= value < max`, or `<= max` for the final bin. */
export interface MetricHistogramBin {
  min: number;
  max: number;
  inclusiveMax: boolean;
}
export type MetricDistributionResult =
  | { kind: "box"; summary: MetricBoxSummary | null }
  | { kind: "histogram"; edges: number[]; counts: number[]; n: number };
export interface MetricDiagnostic extends FormulaDiagnostic {
  metricId?: string;
  code?: string;
}
/** Host must enforce snapshot against the row response; this token alone does not pin data. */
export interface MetricQuery {
  snapshot?: string;
  profile?: string;
  expectedRevisions?: Record<string, string>;
  planToken?: string;
  version: 2;
  where: WhereTerm[];
  orderBy: OrderByClause[];
  limit: number;
  offset: number;
  metrics: AggregationClause[];
  diagnostics: MetricDiagnostic[];
}
export interface MetricCapabilities {
  version: 2;
  expressions?: boolean;
  shownRows?: boolean;
  distributions?: boolean;
  computedFields?: boolean;
  /** Executes AggregationClause.where. Clauses using it are refused otherwise. */
  filters?: boolean;
  /** Executes AggregationClause.minCount and reports hiddenGroups. */
  minCount?: boolean;
  maxGroups?: number;
  profile?: string;
}
