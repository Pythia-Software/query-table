// Detail table for one inspected bucket of the live preview.
import {
  metricExpression,
  type AggregationBucket,
  type AggregationClause,
} from "@pythia-software/query-table-core";
import { formatMetricOutput } from "../metricFormat";

export function MetricInspection({
  bucket,
  clause,
  locale,
}: {
  bucket: AggregationBucket;
  clause: AggregationClause;
  locale?: string | undefined;
}) {
  const rows: Array<[string, string]> = [
    ["Input rows", bucket.count.toLocaleString(locale)],
  ];
  const box =
    bucket.distribution?.kind === "box" ? bucket.distribution.summary : null;
  if (box)
    for (const key of ["min", "q1", "median", "q3", "max", "mean"] as const)
      rows.push([
        {
          min: "Minimum",
          q1: "First quartile",
          median: "Median",
          q3: "Third quartile",
          max: "Maximum",
          mean: "Mean",
        }[key],
        formatMetricOutput(box[key], clause.display?.format, locale).text,
      ]);
  else {
    rows.push(["Raw value", String(bucket.value ?? "NULL")]);
    if (clause.display?.kind === "scatter")
      rows.push(["Raw Y value", String(bucket.y ?? "NULL")]);
  }
  if (bucket.distribution)
    rows.push(
      [
        "Numeric samples",
        String(
          bucket.distribution.kind === "histogram"
            ? bucket.distribution.n
            : (bucket.distribution.summary?.n ?? 0),
        ),
      ],
      ["NULL values", String(bucket.nullCount ?? 0)],
    );
  return (
    <>
      <code className="qt-metric-inspection-expression">
        {clause.distribution &&
        !clause.dateGrouping?.occurrence &&
        ["box", "histogram", "quantiles"].includes(clause.display?.kind ?? "")
          ? clause.distribution.input
          : metricExpression(clause)}
      </code>
      <dl className="qt-metric-inspection-values">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {bucket.error && <p className="qt-metric-editor-error">{bucket.error}</p>}
    </>
  );
}
