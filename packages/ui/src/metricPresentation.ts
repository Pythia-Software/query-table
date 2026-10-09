import type { AggregationClause } from "@pythia-software/query-table-core";

export function metricPresentationProblem(
  clause: AggregationClause,
): string | undefined {
  for (const scale of [clause.display?.xScale, clause.display?.yScale]) {
    if (!scale) continue;
    if (
      (scale.mode !== undefined &&
        scale.mode !== "linear" &&
        scale.mode !== "log") ||
      [scale.min, scale.max].some(
        (v) =>
          v !== undefined &&
          (!Number.isFinite(v) || (scale.mode === "log" && v <= 0)),
      ) ||
      (scale.min !== undefined &&
        scale.max !== undefined &&
        scale.min >= scale.max)
    )
      return "Axis bounds must be finite, increasing, and positive for logarithmic scales.";
  }
  if (clause.display?.kind === "value" && clause.groupBy.length)
    return "Value display requires no grouping. Remove the grouping keys or choose Table, List, or a chart.";
  return undefined;
}

/** Remote results are untrusted even when the transport has TypeScript types. */
export function distributionProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const bad =
    "Invalid distribution result. Refresh the metric or ask the data provider to return a valid distribution summary.";
  if (!value || typeof value !== "object") return bad;
  const d = value as Record<string, unknown>;
  const finite = (v: unknown): v is number =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    (!Number.isInteger(v) || Number.isSafeInteger(v));
  const count = (v: unknown): v is number =>
    finite(v) && Number.isSafeInteger(v) && v >= 0;
  const numbers = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every(finite);
  if (d.kind === "box") {
    if (d.summary === null) return undefined;
    if (!d.summary || typeof d.summary !== "object") return bad;
    const s = d.summary as Record<string, unknown>;
    const stats = [s.min, s.q1, s.median, s.q3, s.max, s.mean, s.low, s.high];
    if (
      !stats.every(finite) ||
      !count(s.n) ||
      s.n === 0 ||
      !count(s.outlierCount) ||
      !numbers(s.outliers) ||
      s.outlierCount < s.outliers.length ||
      s.outlierCount > s.n ||
      s.method !== "exact-linear" ||
      !["minmax", "tukey"].includes(String(s.whiskers))
    )
      return bad;
    const [min, q1, median, q3, max, mean, low, high] = stats as number[];
    // Summation may round a mathematically bounded mean a few ULPs past an endpoint.
    const meanTolerance =
      Math.max(
        Number.MIN_VALUE,
        Math.max(Math.abs(min!), Math.abs(max!), Math.abs(mean!)) *
          Number.EPSILON,
      ) * 16;
    if (
      !(
        min! <= q1! &&
        q1! <= median! &&
        median! <= q3! &&
        q3! <= max! &&
        min! - meanTolerance <= mean! &&
        mean! <= max! + meanTolerance &&
        min! <= low! &&
        low! <= high! &&
        high! <= max!
      ) ||
      s.outliers.some((v) => v < min! || v > max!)
    )
      return bad;
    return undefined;
  }
  if (d.kind === "histogram") {
    if (
      !numbers(d.edges) ||
      !Array.isArray(d.counts) ||
      !d.counts.every(count) ||
      !count(d.n)
    )
      return bad;
    if (!d.edges.length && !d.counts.length && d.n === 0) return undefined;
    if (
      d.edges.length !== d.counts.length + 1 ||
      !d.counts.length ||
      d.counts.reduce((sum: number, n: number) => sum + n, 0) !== d.n ||
      d.edges.some(
        (v, i, edges) =>
          i > 0 &&
          (v < edges[i - 1]! || (edges.length > 2 && v === edges[i - 1])),
      )
    )
      return bad;
    return undefined;
  }
  return bad;
}
