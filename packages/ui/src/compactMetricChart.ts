import type { MetricAxisScale } from "@pythia-software/query-table-core";
import type { MetricBucket, MetricValueFormat, RenderingClause } from "./metricTypes";
import { metricScale } from "./metricChartHelpers";
import { formatMetricOutput } from "./metricFormat";

const durationUnits: Record<string, number> = {
  milliseconds: 1, seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000,
};
const elapsedUnits = [[86400000, "d"], [3600000, "h"], [60000, "m"], [1000, "s"], [1, "ms"]] as const;
function durationUnit(format: MetricValueFormat | undefined, magnitude: number) {
  const source = durationUnits[format?.sourceUnit ?? "milliseconds"] ?? 1;
  const unit = elapsedUnits.find(([size]) => magnitude * source >= size) ?? elapsedUnits[4];
  return { size: unit[0] / source, suffix: unit[1] };
}
const niceCeil = (value: number) => {
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
};

function niceDurationStep(raw: number, format: MetricValueFormat) {
  const source = durationUnits[format.sourceUnit ?? "milliseconds"] ?? 1;
  const ms = raw * source;
  if (ms < 1000) return niceCeil(ms) / source;
  for (const [size, choices] of [
    [1000, [1, 2, 5, 10, 15, 30, 60]],
    [60000, [1, 2, 5, 10, 15, 30, 60]],
    [3600000, [1, 2, 3, 6, 12, 24]],
  ] as const) {
    const choice = choices.find(n => n * size >= ms);
    if (choice) return choice * size / source;
  }
  return niceCeil(ms / 86400000) * 86400000 / source;
}

/** Opt-in cover axes: sparse round ticks, with raw coordinates and explicit bounds preserved. */
export function compactMetricScale(values: readonly number[], options: MetricAxisScale | undefined, zero = false, format?: MetricValueFormat) {
  const original = metricScale(values, options, zero);
  if (original.error || options?.mode === "log" || ["date", "time", "datetime"].includes(format?.kind ?? "")) return original;
  const span = original.max - original.min;
  const minimumDurationStep = format?.kind === "duration" ? durationUnit(format, Math.max(Math.abs(original.min), Math.abs(original.max))).size / 2 : 0;
  const roundStep = (raw: number) => format?.kind === "duration" ? niceDurationStep(Math.max(raw, minimumDurationStep), format) : niceCeil(raw);
  let step = roundStep(span / 2);
  // Extremely small/large finite values must not create NaN coordinates or loops.
  if (!Number.isFinite(step) || step <= 0) return original;
  let min = original.min, max = original.max;
  for (let attempt = 0; attempt < 8; attempt++) {
    min = options?.min ?? Math.floor(original.min / step) * step;
    max = options?.max ?? Math.ceil(original.max / step) * step;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return original;
    if ((max - min) / step <= 2.000001) break;
    step = roundStep(step * 1.01);
  }
  const axis = metricScale(values, { ...options, min, max }, zero);
  const ticks: number[] = [];
  const start = Math.ceil(min / step - 1e-10);
  for (let i = 0; i < 4; i++) {
    const tick = Number(((start + i) * step).toPrecision(12));
    if (tick > max + step * 1e-9) break;
    if (tick >= min - step * 1e-9) ticks.push(Object.is(tick, -0) ? 0 : tick);
  }
  return { ...axis, ticks };
}

/** Axis labels only. Tooltips and data tables continue using the full declared format. */
export function compactMetricTick(value: number, format?: MetricValueFormat, locale?: string) {
  if (format?.kind === "duration") {
    if (!value) return "0";
    const unit = durationUnit(format, Math.abs(value));
    return `${Number((value / unit.size).toPrecision(3))}${unit.suffix}`;
  }
  if (format?.kind === "percent")
    return formatMetricOutput(value, { ...format, decimals: Math.abs(value * 100) < 1 && value !== 0 ? Math.min(12, -Math.floor(Math.log10(Math.abs(value * 100)))) : 0 }, locale).text;
  if (format && ["date", "time", "datetime"].includes(format.kind)) return formatMetricOutput(value, format, locale).text;
  return value.toLocaleString(locale, { notation: "compact", maximumSignificantDigits: 3 });
}

/** Label round local calendar boundaries, sparsely enough to fit a small chart. */
export function compactCalendarLabels(points: readonly { bucket: MetricBucket; x: number }[], clause: RenderingClause, locale?: string): Map<MetricBucket, string> {
  const labels = new Map<MetricBucket, string>();
  const grouping = clause.dateGrouping;
  if (!grouping || !points.length) return labels;
  const timeZone = grouping.timeZone === "local" ? undefined : grouping.timeZone ?? "UTC";
  const dayFormatter = new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric" });
  const hourFormatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
  const info = points.flatMap(point => {
    const key = point.bucket.keys[0];
    const date = new Date(typeof key === "number" ? key : String(key));
    if (!Number.isFinite(date.getTime())) return [];
    return [{ ...point, date, day: dayFormatter.format(date), hour: Number(hourFormatter.format(date)) }];
  });
  const multipleDays = new Set(info.map(point => point.day)).size > 1;
  const candidates = grouping.interval === "hour"
    ? info.filter(point => point.hour % (multipleDays ? 12 : 6) === 0)
    : info;
  // Sparse observed data may contain no round-hour bucket; retain its actual hour.
  const selected = candidates.length ? candidates : info.filter((_, i) => i === 0 || i === info.length - 1);
  let lastRight = -Infinity;
  for (const point of selected) {
    const label = grouping.interval === "hour"
      ? `${multipleDays ? `${point.day} ` : ""}${String(point.hour).padStart(2, "0")}h`
      : formatMetricOutput(point.bucket.keys[0], { kind: "date", sourceUnit: "iso", style: "custom", pattern: grouping.interval === "year" ? "YYYY" : grouping.interval === "month" ? "MMM YYYY" : "MMM DD", timeZone: grouping.timeZone ?? "UTC" }, locale).text;
    const half = label.length * 2.7;
    if (point.x - half < lastRight + 8) continue;
    labels.set(point.bucket, label);
    lastRight = point.x + half;
  }
  return labels;
}
