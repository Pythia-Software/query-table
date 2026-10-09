import type { FormulaDiagnostic } from "./formula";
import type { AggregationClause, OrderByClause, WhereTerm } from "./query";
export type MetricValue = number | string | boolean | null;
export type MetricKey = MetricValue;
export type MetricScope = "allMatching" | "shownRows";
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
  list?: { showBars?: boolean; useGroupColors?: boolean; showValues?: boolean };
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
  maxGroups?: number;
  profile?: string;
}
