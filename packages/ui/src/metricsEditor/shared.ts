// Constants and pure helpers shared across the MetricsEditor modules:
// display kinds, pane labels, minimum-count helpers, ids and small format utilities.
import {
  METRIC_FUNCTIONS,
  aggOpsForField,
  compileMetric,
  metricExpression,
  metricMinCountMeasure,
  type AggregationClause,
  type FieldDef,
  type MetricDisplay,
  type MetricLayout,
  type MetricValueFormat,
} from "@pythia-software/query-table-core";
import { type IconName } from "../Icon";

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const fieldSource = (name: string) => `[${name.replace(/\]/g, "]]")}]`;
export const defaultLayout: MetricLayout = {
  widthRem: 20,
  heightRem: 12,
  minWidthRem: 14,
  minHeightRem: 8,
};
export const kinds: Array<[MetricDisplay["kind"], string]> = [
  ["auto", "Automatic"],
  ["value", "Value"],
  ["table", "Table"],
  ["list", "List"],
  ["bar-horizontal", "Horizontal bars"],
  ["bar-vertical", "Vertical bars"],
  ["line", "Line chart"],
  ["pie", "Pie chart"],
  ["donut", "Ring chart"],
  ["scatter", "Scatterplot"],
  ["box", "Box & whisker"],
  ["histogram", "Histogram"],
  ["quantiles", "Quantile curve"],
];
/** A new quantile curve reads 0, 0.01, …, 1 (MAX_QUANTILE_PROBABILITIES points). */
export const defaultProbabilities = Array.from({ length: 101 }, (_, i) => i / 100);
export const panes: Array<{ label: string; icon: IconName }> = [
  { label: "Metric list", icon: "panelList" },
  { label: "Definition", icon: "panelDefinition" },
  { label: "Fields & functions", icon: "panelReference" },
  { label: "Live preview", icon: "panelPreview" },
];
export const aggregateFunctions = METRIC_FUNCTIONS;
export const titleOf = (clause: AggregationClause, fields: FieldDef[]) =>
  clause.label ||
  `${clause.op.toUpperCase()} ${fields.find((f) => f.name === clause.field)?.label ?? clause.field ?? "rows"}`;

type MinCount = AggregationClause["minCount"];
/** The "Counting" choice of a minimum: rows, or a distinct or summed field. */
export function minimumKey(m: MinCount): string {
  const measure = metricMinCountMeasure({ minCount: m });
  return measure
    ? `${measure.op === "sum" ? "sum" : "distinct"}:${measure.field}`
    : "rows";
}
export function minimumOf(key: string, min: number): MinCount {
  const split = key.indexOf(":");
  if (split < 0) return min;
  const kind = key.slice(0, split),
    field = key.slice(split + 1);
  return kind === "sum" ? { min, sum: field } : { min, distinct: field };
}
/** Whether validation accepts this kind of minimum for the metric:
 * distributions and per-occurrence summaries count rows only, and distinct
 * values cannot be combined across a window's intervals. */
export function minimumAllowed(c: AggregationClause, key: string): boolean {
  if (key === "rows") return true;
  const distribution = !!c.distribution && (!c.display || ["box", "histogram", "quantiles"].includes(c.display.kind));
  if (distribution || c.dateGrouping?.occurrence) return false;
  return !(key.startsWith("distinct:") && c.window);
}
/** A new threshold keeps what the minimum counts. */
export function withMinimum(m: MinCount, min: number): MinCount {
  return minimumOf(minimumKey(m), min);
}
/** Distinct values of any measurable field, sums of numeric ones, plus the
 * current choice so an unlisted field is never silently dropped. */
export function minimumChoices(
  measurable: FieldDef[],
  current: MinCount,
  label: (name: string) => string,
): [string, string][] {
  const plain = measurable.filter((f) => !f.name.startsWith("@computed/"));
  const choices: [string, string][] = [
    ...plain
      .filter((f) => aggOpsForField(f).includes("count_distinct"))
      .map((f): [string, string] => [`distinct:${f.name}`, `Distinct ${f.label}`]),
    ...plain
      .filter((f) => f.type === "number" && aggOpsForField(f).includes("sum"))
      .map((f): [string, string] => [`sum:${f.name}`, `Sum of ${f.label}`]),
  ];
  const key = minimumKey(current);
  if (key !== "rows" && !choices.some(([k]) => k === key)) {
    const measure = metricMinCountMeasure({ minCount: current })!;
    choices.push([
      key,
      `${measure.op === "sum" ? "Sum of" : "Distinct"} ${label(measure.field)}`,
    ]);
  }
  return choices;
}
export function newId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `metric-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const SHARE_FORMAT: MetricValueFormat = { kind: "percent", decimals: 1 };
export const sameFormat = (a: MetricValueFormat | undefined, b: MetricValueFormat) =>
  !!a && JSON.stringify(a) === JSON.stringify(b);
/** A display without the interval toggle, which defaults to drawn. */
export function withoutIntervalDisplay(display: MetricDisplay): MetricDisplay {
  const { showIntervals: _showIntervals, ...rest } = display;
  return rest;
}

export function simpleAggregate(
  clause: AggregationClause,
  fields: FieldDef[],
): { op: AggregationClause["op"]; field?: string } | undefined {
  try {
    const ast = compileMetric(metricExpression(clause), fields).ast;
    if (
      ast.kind !== "call" ||
      !["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"].includes(
        ast.name,
      )
    )
      return;
    if (ast.args.length === 0 && ast.name === "COUNT") return { op: "count" };
    if (ast.args.length === 1 && ast.args[0]?.kind === "field")
      return {
        op: ast.name.toLowerCase() as AggregationClause["op"],
        field: ast.args[0].name,
      };
  } catch {
    return;
  }
}
