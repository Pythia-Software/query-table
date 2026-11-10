import type {
  MetricBucket,
  RenderingClause,
  MetricValue,
  MetricValueFormat,
  BoxSummary,
} from "./metricTypes";
import { metricTimestamp, formatMetricOutput } from "./metricFormat";
import { metricTupleKey } from "./metricColors";
import { DEFAULT_METRIC_INTERVAL_LEVEL } from "@pythia-software/query-table-core";
/** A cyclic slot's label: "09:00" for an hour of the day and the locale's
 * weekday ("Mon", or "Monday" in detail) for an ISO day of the week. */
export function metricCycleLabel(
  value: MetricValue | undefined,
  interval: string | undefined,
  locale?: string,
  detailed = false,
): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (interval === "hourOfDay" && value >= 0 && value <= 23) {
    const hour = `${String(value).padStart(2, "0")}:00`;
    return detailed
      ? `${hour}–${String((value + 1) % 24).padStart(2, "0")}:00`
      : hour;
  }
  if (interval === "dayOfWeek" && value >= 1 && value <= 7)
    // 2024-01-01 was a Monday, ISO day 1.
    return new Intl.DateTimeFormat(locale, {
      weekday: detailed ? "long" : "short",
      timeZone: "UTC",
    }).format(Date.UTC(2024, 0, value));
  return undefined;
}
const cyclic = (clause?: RenderingClause) =>
  clause?.dateGrouping?.interval === "hourOfDay" ||
  clause?.dateGrouping?.interval === "dayOfWeek";
/** Calendar group labels must describe the same local dates as the computation. */
export function metricDateGroupFormat(
  clause: RenderingClause,
): MetricValueFormat | undefined {
  const grouping = clause.dateGrouping;
  // Scatter/histogram X formats survive display changes, but describe the
  // measure axis. Only explicit calendar grouping gives them date-key meaning.
  // Cyclic slots are numbers, labelled by metricGroupKeyLabel.
  if (!grouping || cyclic(clause)) return undefined;
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
  if (cyclic(clause))
    return (
      metricCycleLabel(value, clause.dateGrouping.interval, locale, detailed) ??
      String(value)
    );
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

/** A bucket's confidence interval (`clause.interval`), when it has finite,
 * ordered bounds and no error. */
export function metricBucketInterval(
  b: MetricBucket,
): { lower: number; upper: number } | undefined {
  const { lower, upper } = b;
  return !b.error && finiteMetricNumber(lower) && finiteMetricNumber(upper) && lower <= upper
    ? { lower, upper }
    : undefined;
}

/** The interval a chart draws as a whisker or band: none when the display
 * turns intervals off. Hover text names the interval either way. */
export function metricDrawnInterval(
  clause: RenderingClause,
  b: MetricBucket,
): { lower: number; upper: number } | undefined {
  return clause.display?.showIntervals === false ? undefined : metricBucketInterval(b);
}

/** The values a bar or line value axis spans: each drawable value and its
 * drawn bounds, so whiskers and bands are never clipped by inferred extents.
 * A log axis takes only positive bounds; a nonpositive bound is clamped to
 * the axis when drawn (see metricIntervalSpan), never counted as an omitted
 * value or shifted. */
export function metricValueAxisValues(
  clause: RenderingClause,
  buckets: readonly MetricBucket[],
  log = false,
): number[] {
  const out: number[] = [];
  for (const b of buckets) {
    if (b.error || !finiteMetricNumber(b.value)) continue;
    out.push(b.value);
    const interval = metricDrawnInterval(clause, b);
    if (!interval || (log && b.value <= 0)) continue;
    for (const bound of [interval.lower, interval.upper])
      if (!log || bound > 0) out.push(bound);
  }
  return out;
}

/** The part of an interval inside an axis domain `[min, max]`, in data units.
 * An end clamped to the domain (an explicit axis bound, or a nonpositive lower
 * bound on a log axis) has no cap, so an open end reads as "continues beyond".
 * Undefined when nothing of the interval is inside the domain. */
export function metricIntervalSpan(
  interval: { lower: number; upper: number },
  min: number,
  max: number,
): { low: number; high: number; lowCap: boolean; highCap: boolean } | undefined {
  if (!(interval.upper >= min) || !(interval.lower <= max) || !(min < max)) return undefined;
  return {
    low: Math.max(min, interval.lower),
    high: Math.min(max, interval.upper),
    lowCap: interval.lower >= min,
    highCap: interval.upper <= max,
  };
}

/** Hover and accessible text for a bucket's interval, e.g.
 * "95% interval 2.2%–9.8%": the clause's level as a percent and the bounds in
 * the metric's own value format. Undefined when the bucket has no bounds. */
export function metricIntervalText(
  clause: RenderingClause,
  b: MetricBucket,
  format: (value: number) => string,
  locale?: string,
): string | undefined {
  const interval = metricBucketInterval(b);
  if (!interval) return undefined;
  return `${metricIntervalLevelText(clause, locale)} interval ${format(interval.lower)}–${format(interval.upper)}`;
}

/** A clause's interval level as a percent, "95%" by default. */
export function metricIntervalLevelText(clause: RenderingClause, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(clause.interval?.level ?? DEFAULT_METRIC_INTERVAL_LEVEL);
}

/** A line series' interval band as one SVG path: an area over each run of
 * consecutive points with bounds, broken where a point has none. A run of one
 * point has no area and is returned in `singles`, to draw as a whisker. */
export function metricBandPath<P extends { x: number; high: number; low: number }>(
  points: ReadonlyArray<P | null>,
): { d: string; singles: P[] } {
  let d = "";
  const singles: P[] = [];
  let run: P[] = [];
  const close = () => {
    if (run.length === 1) singles.push(run[0]!);
    else if (run.length > 1)
      d += `M${run.map((p) => `${p.x},${p.high}`).join(" L")} L${run
        .slice()
        .reverse()
        .map((p) => `${p.x},${p.low}`)
        .join(" L")} Z `;
    run = [];
  };
  for (const point of points) {
    if (point) run.push(point);
    else close();
  }
  close();
  return { d: d.trim(), singles };
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
// Advance widths, in ems, at or above those of common system UI fonts
// (San Francisco, Segoe UI, DejaVu Sans). Charts size label gutters from
// these, so SVG text never needs DOM measurement and never outgrows its room.
const narrowGlyphs = new Set("iljI.,:;'|!·");
const slimGlyphs = new Set("frt()[]{}/\\ ");
const dashGlyphs = new Set("-*\"`");
const wideGlyphs = new Set("mwMW@%…—");
function glyphWidth(char: string): number {
  if (narrowGlyphs.has(char)) return 0.33;
  if (slimGlyphs.has(char)) return 0.43;
  if (dashGlyphs.has(char)) return 0.53;
  if (wideGlyphs.has(char)) return 1;
  if (char > "\u024f") return 1.05;
  if (char >= "A" && char <= "Z") return 0.79;
  if (char >= "0" && char <= "9") return 0.66;
  return 0.64;
}
/** Upper-bound width of an axis label at `fontSize` px (the axis font is 11px). */
export function metricLabelWidth(label: string, fontSize = 11): number {
  let ems = 0;
  for (const char of label) ems += glyphWidth(char);
  return ems * fontSize;
}
/** Shortens a label at its end, with an ellipsis, so it fits `width` px. */
export function truncateMetricLabel(label: string, width: number, fontSize = 11): string {
  if (metricLabelWidth(label, fontSize) <= width) return label;
  const chars = Array.from(label);
  let used = metricLabelWidth("…", fontSize), end = 0;
  while (end < chars.length) {
    const next = used + glyphWidth(chars[end]!) * fontSize;
    if (next > width) break;
    used = next;
    end++;
  }
  return `${chars.slice(0, end).join("").trimEnd()}…`;
}
