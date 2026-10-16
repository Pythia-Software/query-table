import type {
  MetricBucket,
  RenderingClause,
  MetricValue,
  MetricValueFormat,
  BoxSummary,
} from "./metricTypes";
import { metricTimestamp, formatMetricOutput } from "./metricFormat";
import { metricTupleKey } from "./metricColors";
/** Calendar group labels must describe the same local dates as the computation. */
export function metricDateGroupFormat(
  clause: RenderingClause,
): MetricValueFormat | undefined {
  const grouping = clause.dateGrouping;
  // Scatter/histogram X formats survive display changes, but describe the
  // measure axis. Only explicit calendar grouping gives them date-key meaning.
  if (!grouping) return undefined;
  const format = clause.display?.xFormat;
  return {
    kind: "date",
    style: "custom",
    pattern:
      grouping.interval === "hour"
        ? "MMM DD HH:mm Z"
        : grouping.interval === "month"
          ? "MMM YYYY"
          : grouping.interval === "year"
            ? "YYYY"
            : "MMM DD",
    ...(format && ["date", "time", "datetime"].includes(format.kind)
      ? format
      : {}),
    sourceUnit: "iso",
    timeZone: grouping.timeZone ?? "UTC",
  };
}
export function metricGroupKeyLabel(
  value: MetricValue | undefined,
  axis: number,
  clause?: RenderingClause,
  locale?: string,
  detailed = false,
): string {
  if (value == null) return "NULL";
  if (axis !== 0 || !clause?.dateGrouping) return String(value);
  const format = detailed
    ? {
        kind: "datetime" as const,
        style: "custom" as const,
        pattern: "YYYY-MM-DD HH:mm Z",
        timeZone: clause.dateGrouping.timeZone ?? "UTC",
      }
    : metricDateGroupFormat(clause);
  return formatMetricOutput(value, format, locale).text;
}
/** Synthetic remainder rows, labelled verbatim rather than as group keys. */
const otherBuckets = new WeakSet<MetricBucket>();
export const isMetricOtherBucket = (b: MetricBucket): boolean => otherBuckets.has(b);
export const metricGroupLabel = (
  b: MetricBucket,
  clause?: RenderingClause,
  locale?: string,
  detailed = false,
): string =>
  otherBuckets.has(b)
    ? String(b.keys[0])
    : b.keys.length
    ? b.keys
        .map((v, axis) =>
          metricGroupKeyLabel(v, axis, clause, locale, detailed),
        )
        .join(" / ")
    : "All rows";
export const finiteMetricNumber = (v: MetricValue | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function metricExtent(
  values: readonly number[],
  zero = false,
): [number, number] {
  let min = zero ? 0 : Infinity,
    max = zero ? 0 : -Infinity;
  for (const v of values)
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return zero
      ? [Math.min(0, min), Math.min(Number.MAX_VALUE, max + pad)]
      : [
          Math.max(-Number.MAX_VALUE, min - pad),
          Math.min(Number.MAX_VALUE, max + pad),
        ];
  }
  return [min, max];
}
export function chronologicalBuckets(
  buckets: readonly MetricBucket[],
): Array<{ bucket: MetricBucket; time: number }> {
  return buckets
    .map((bucket) => ({
      bucket,
      time:
        typeof bucket.keys[0] === "number"
          ? bucket.keys[0]
          : metricTimestamp(bucket.keys[0] ?? null).date.getTime(),
    }))
    .map((point) => {
      if (!Number.isFinite(point.time))
        throw Error("Line coordinates must be finite.");
      return point;
    })
    .sort((a, b) => a.time - b.time);
}
export function additiveMetric(clause: RenderingClause): boolean {
  if (!clause.expression) return clause.op === "count" || clause.op === "sum";
  return /^\s*(?:COUNT\(\s*(?:\[[^\]]+\])?\s*\)|SUM\(\s*\[[^\]]+\]\s*\))\s*$/i.test(
    clause.expression,
  );
}
export interface MetricPieSlice {
  bucket: MetricBucket;
  value: number;
  other: boolean;
}
/** No guessed denominator: incomplete responses need an explicit exact Other. */
export function metricPieSlices(
  clause: RenderingClause,
  buckets: readonly MetricBucket[],
  groupCount?: number,
  other?: MetricBucket,
  limit = 8,
  showOther = true,
): { slices: MetricPieSlice[]; total: number; error?: string } {
  const fail = (error: string) => ({ slices: [], total: 0, error });
  if (!additiveMetric(clause))
    return fail("Pie charts require additive counts or sums.");
  if (groupCount !== undefined && groupCount > buckets.length && !other)
    return fail(
      "Pie requires complete group results or an exact Other result.",
    );
  const all = other ? [...buckets, other] : [...buckets];
  if (all.some((b) => b.error || !finiteMetricNumber(b.value) || b.value < 0))
    return fail(
      "Pie requires finite, nonnegative values without missing or errored groups.",
    );
  const total = all.reduce((n, b) => n + (b.value as number), 0);
  if (!Number.isFinite(total) || total <= 0)
    return fail("No positive additive values to display.");
  const head = buckets.slice(0, limit),
    tail = buckets.slice(limit);
  const slices = head.map((bucket) => ({
    bucket,
    value: bucket.value as number,
    other: false,
  }));
  const remainder =
    tail.reduce((n, b) => n + (b.value as number), 0) +
    ((other?.value as number) ?? 0);
  if (showOther && (tail.length || other))
    slices.push({
      bucket: {
        keys: ["Other"],
        value: remainder,
        count: tail.reduce((n, b) => n + b.count, 0) + (other?.count ?? 0),
      },
      value: remainder,
      other: true,
    });
  return { slices, total };
}

/**
 * Line buckets are (time, series) points and pivot buckets are (row, column)
 * cells, so their limit applies to series or rows rather than to buckets.
 */
export function metricKeyedLimit(clause: RenderingClause): { unit: "series" | "rows"; key: (b: MetricBucket) => string } | undefined {
  const kind = clause.display?.kind ?? "auto";
  if (kind === "line") return { unit: "series", key: b => metricTupleKey(b.keys.slice(1)) };
  if ((kind === "table" || kind === "auto") && clause.groupBy.length === 2) {
    const axis = clause.display?.pivot?.swap ? 1 : 0;
    return { unit: "rows", key: b => metricTupleKey([b.keys[axis] ?? null]) };
  }
  return undefined;
}

/** Presentation limit, with an exact additive remainder only when requested. */
export function metricDisplayBuckets(clause: RenderingClause, buckets: MetricBucket[], groupCount?: number, other?: MetricBucket, partial = false): MetricBucket[] {
  const requested = clause.display?.maxGroups;
  const limited = Number.isSafeInteger(requested) && !!requested && requested >= 1 && requested <= 1000000;
  if (!limited && (!other || !clause.display?.showOther)) return buckets;
  const keyed = metricKeyedLimit(clause);
  if (keyed) {
    if (!limited) return buckets;
    const kept = new Set<string>(), all = new Set<string>();
    for (const b of buckets) {
      const key = keyed.key(b);
      all.add(key);
      if (kept.size < requested!) kept.add(key);
    }
    return kept.size < all.size ? buckets.filter(b => kept.has(keyed.key(b))) : buckets;
  }
  const limit = limited ? requested! : buckets.length;
  const head = buckets.slice(0, limit), tail = buckets.slice(limit);
  const all = other ? [...buckets, other] : buckets;
  const list = clause.display?.kind === "list" || ((clause.display?.kind ?? "auto") === "auto" && clause.groupBy.length === 1);
  if (!list || !clause.display?.showOther || !additiveMetric(clause) || partial
    || (groupCount !== undefined && groupCount > buckets.length && !other)
    || all.some(b => b.error || !finiteMetricNumber(b.value) || b.value < 0)) return head;
  const remainder = tail.reduce((n, b) => n + Number(b.value), Number(other?.value ?? 0));
  if ((tail.length || other) && Number.isFinite(remainder)) {
    const row: MetricBucket = { keys: ["Other (combined remainder)"], value: remainder,
      count: tail.reduce((n, b) => n + b.count, other?.count ?? 0) };
    otherBuckets.add(row);
    head.push(row);
  }
  return head;
}

/** Unit-interval coordinate without overflowing for opposite signed finite extremes. */
export function metricFraction(
  value: number,
  min: number,
  max: number,
): number {
  const span = max - min;
  return Number.isFinite(span)
    ? (value - min) / span
    : (value / 2 - min / 2) / (max / 2 - min / 2);
}

/** A true logarithmic axis: nonpositive values are omitted, never shifted. */
export function metricScale(
  values: readonly number[],
  options:
    | import("@pythia-software/query-table-core").MetricAxisScale
    | undefined,
  zero = false,
) {
  const log = options?.mode === "log";
  const accepts = (value: number) =>
    Number.isFinite(value) && (!log || value > 0);
  const valid = values.filter(accepts);
  let [min, max] = metricExtent(valid, zero && !log);
  if (log) {
    if (!valid.length) [min, max] = [1, 10];
    else if (min <= 0) min = Math.min(...valid);
  }
  min = options?.min ?? min;
  max = options?.max ?? max;
  // A single user bound can sit outside the inferred domain.
  if (options?.min !== undefined && options.max === undefined && max <= min)
    max = log
      ? Math.min(Number.MAX_VALUE, min * 10)
      : min + (Math.abs(min) * 0.05 || 1);
  if (options?.max !== undefined && options.min === undefined && min >= max)
    min = log ? max / 10 : max - (Math.abs(max) * 0.05 || 1);
  const error =
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max ||
    (log && min <= 0)
      ? "Axis bounds must be finite, increasing, and positive for logarithmic scales."
      : undefined;
  const fraction = (value: number) => {
    const position = log
      ? metricFraction(Math.log(value), Math.log(min), Math.log(max))
      : metricFraction(value, min, max);
    // Marks beyond the viewport are clipped. Bound distant coordinates to keep
    // valid extreme values and very narrow explicit bounds finite in SVG.
    return Math.max(-1e12, Math.min(1e12, position));
  };
  const ticks = log
    ? [min, Math.exp(Math.log(min) / 2 + Math.log(max) / 2), max]
    : [min, min / 2 + max / 2, max];
  return {
    min,
    max,
    fraction,
    ticks,
    accepts,
    error,
    baseline: log ? min : Math.max(min, Math.min(max, 0)),
    omitted: values.length - valid.length,
  };
}

/** Interpolated quartiles can exceed observed Tukey inliers in sparse samples.
 * Keep visual whiskers outside the box without changing the returned statistics. */
export function metricBoxWhiskers(summary: BoxSummary) {
  return {
    low: Math.min(summary.low, summary.q1),
    high: Math.max(summary.high, summary.q3),
  };
}

/** Bounded backend samples must not hide the actual observed extremes. */
export function metricBoxOutliers(summary: BoxSummary): number[] {
  return [...new Set([
    ...summary.outliers,
    ...(summary.min < summary.low ? [summary.min] : []),
    ...(summary.max > summary.high ? [summary.max] : []),
  ])];
}
