import { assertMetricNumber } from "./metricPrecision";
// Exact bounded reductions over the complete scoped population.
export function percentile(sorted: number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 1)
    throw Error("Percentile must be between zero and one.");
  if (
    sorted.some((v, i) => !Number.isFinite(v) || (i > 0 && v < sorted[i - 1]!))
  )
    throw Error("Percentile inputs must be sorted finite numbers.");
  sorted.forEach(assertMetricNumber);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p,
    lower = Math.floor(position),
    fraction = position - lower;
  const a = sorted[lower]!,
    b = sorted[Math.min(lower + 1, sorted.length - 1)]!;
  // Floating underflow/roundoff cannot move an interpolated percentile outside its two samples.
  const raw = (1 - fraction) * a + fraction * b;
  assertMetricNumber(raw);
  const value = Math.min(b, Math.max(a, raw));
  return value;
}
export type BoxWhiskers = "minmax" | "tukey" | "percentile";
/** Percentile whiskers default to the 10th and 90th percentiles. */
export const DEFAULT_WHISKER_PROBABILITIES: readonly [number, number] = [0.1, 0.9];
/** Percentile whiskers [lo, hi] lie outside the box: 0 <= lo < 0.25 and 0.75 < hi <= 1. */
export function validWhiskerProbabilities(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    value[0] >= 0 &&
    value[0] < 0.25 &&
    value[1] > 0.75 &&
    value[1] <= 1
  );
}
/** Quantile probabilities: 1–101 strictly increasing numbers in [0, 1]. */
/** The most probabilities one quantile distribution may request. */
export const MAX_QUANTILE_PROBABILITIES = 101;
export function validQuantileProbabilities(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_QUANTILE_PROBABILITIES &&
    value.every(
      (p, i) =>
        typeof p === "number" &&
        p >= 0 &&
        p <= 1 &&
        (i === 0 || p > (value[i - 1] as number)),
    )
  );
}
/** The exact-linear percentile of each probability, or null without samples. */
export function quantilesSummary(values: number[], probabilities: readonly number[]) {
  return quantilesWithMedian(values, probabilities).summary;
}
/** quantilesSummary and the exact-linear median, from one sort. */
export function quantilesWithMedian(values: number[], probabilities: readonly number[]) {
  if (!validQuantileProbabilities(probabilities))
    throw Error("Quantiles need 1–101 strictly increasing probabilities from 0 to 1.");
  if (values.some((v) => !Number.isFinite(v)))
    throw Error("Distribution inputs must be finite numbers.");
  values.forEach(assertMetricNumber);
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { summary: null, median: null };
  return {
    summary: {
      n: sorted.length,
      probabilities: [...probabilities],
      values: probabilities.map((p) => percentile(sorted, p)!),
    },
    median: percentile(sorted, 0.5),
  };
}
export function boxSummary(
  values: number[],
  whiskers: BoxWhiskers = "minmax",
  whiskerProbabilities: readonly number[] = DEFAULT_WHISKER_PROBABILITIES,
) {
  if (whiskers === "percentile" && !validWhiskerProbabilities(whiskerProbabilities))
    throw Error("Percentile whiskers need [lo, hi] with 0 ≤ lo < 0.25 and 0.75 < hi ≤ 1.");
  if (values.some((v) => !Number.isFinite(v)))
    throw Error("Distribution inputs must be finite numbers.");
  values.forEach(assertMetricNumber);
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  if (!n) return null;
  const min = sorted[0]!,
    max = sorted[n - 1]!,
    q1 = percentile(sorted, 0.25)!,
    median = percentile(sorted, 0.5)!,
    q3 = percentile(sorted, 0.75)!;
  const lowFence = q1 - 1.5 * (q3 - q1),
    highFence = q3 + 1.5 * (q3 - q1);
  // Percentile whiskers are interpolated values, not observed samples; the
  // samples beyond them are counted but not retained as outlier markers.
  const low =
    whiskers === "tukey"
      ? sorted.find((v) => v >= lowFence)!
      : whiskers === "percentile"
        ? percentile(sorted, whiskerProbabilities[0]!)!
        : min;
  const high =
    whiskers === "tukey"
      ? [...sorted].reverse().find((v) => v <= highFence)!
      : whiskers === "percentile"
        ? percentile(sorted, whiskerProbabilities[1]!)!
        : max;
  const outside =
    whiskers === "minmax" ? [] : sorted.filter((v) => v < low || v > high);
  // Bound the response while retaining both tails. Report the total separately.
  const outliers =
    whiskers === "percentile"
      ? []
      : outside.length <= 20
        ? outside
        : [...outside.slice(0, 10), ...outside.slice(-10)];
  const rawMean = sorted.reduce((sum, value) => sum + value / n, 0);
  // Check the numeric boundary before correcting insignificant range drift.
  assertMetricNumber(rawMean);
  const mean = Math.min(max, Math.max(min, rawMean));
  [min, q1, median, q3, max, mean, low, high].forEach(assertMetricNumber);
  return {
    n,
    min,
    q1,
    median,
    q3,
    max,
    mean,
    low,
    high,
    outliers,
    outlierCount: outside.length,
    whiskers,
    ...(whiskers === "percentile"
      ? { whiskerProbabilities: [whiskerProbabilities[0]!, whiskerProbabilities[1]!] }
      : {}),
    method: "exact-linear" as const,
  };
}
export function histogramEdges(values: number[], bins: number): number[] {
  if (!Number.isInteger(bins) || bins < 2 || bins > 30)
    throw Error("Choose 2–30 histogram bins.");
  if (values.some((v) => !Number.isFinite(v)))
    throw Error("Histogram inputs must be finite numbers.");
  values.forEach(assertMetricNumber);
  if (!values.length) return [];
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === max) return [min, max]; // one point interval, not artificial spread
  if (!Number.isFinite(max - min))
    throw Error("Histogram range exceeds finite numeric precision.");
  const edges = Array.from(
    { length: bins + 1 },
    (_, i) => min + (max - min) * (i / bins),
  );
  edges[0] = min;
  edges[bins] = max;
  edges.forEach(assertMetricNumber);
  if (edges.some((value, i) => i > 0 && value <= edges[i - 1]!))
    throw Error(
      "Histogram bins are finer than numeric precision. Reduce the bin count.",
    );
  return edges;
}
export function histogramCounts(values: number[], edges: number[]): number[] {
  if (values.some((v) => !Number.isFinite(v)))
    throw Error("Histogram inputs must be finite numbers.");
  if (!edges.length) {
    if (values.length) throw Error("Histogram values require edges.");
    return [];
  }
  if (
    edges.length < 2 ||
    edges.some(
      (v, i) =>
        !Number.isFinite(v) ||
        (i > 0 &&
          (v < edges[i - 1]! || (v === edges[i - 1]! && edges.length !== 2))),
    )
  )
    throw Error("Histogram edges must be ordered finite boundaries.");
  values.forEach(assertMetricNumber);
  edges.forEach(assertMetricNumber);
  const counts = Array<number>(edges.length - 1).fill(0);
  for (const value of values) {
    if (value < edges[0]! || value > edges[edges.length - 1]!)
      throw Error("Value falls outside shared histogram edges.");
    // Lower inclusive, upper exclusive; the last bin also includes the maximum.
    let bin = 0;
    while (bin < counts.length - 1 && value >= edges[bin + 1]!) bin++;
    counts[bin] = counts[bin]! + 1;
  }
  return counts;
}
