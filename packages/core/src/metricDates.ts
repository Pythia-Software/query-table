import { coerceValue } from "./ops";
import { isOrGroup, type QueryState } from "./query";
import type { MetricDateGrouping, MetricValue } from "./metricTypes";
import { Temporal } from "temporal-polyfill";

export const METRIC_DATE_INTERVALS = [
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

/** Strict calendar input; timestamps require an explicit offset. */
export function metricDateTime(value: MetricValue, timeZone = "UTC"): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    throw Error(
      "Date grouping requires ISO dates or timestamps with a timezone.",
    );
  const time = Date.parse(value),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(value.slice(0, 4)), month, 0);
  if (
    !Number.isFinite(time) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > calendar.getUTCDate()
  )
    throw Error("Invalid date grouping value.");
  return value.length === 10 && timeZone !== "UTC"
    ? Temporal.PlainDate.from(value).toZonedDateTime(timeZone).epochMilliseconds
    : time;
}

/** Find an offset change inside one bucket window. The polyfill's "previous"
 * transition lookup caps future searches to about three years from today. */
function metricOffsetTransition(
  start: number,
  end: number,
  timeZone: string,
): number | undefined {
  if (end <= start) return undefined;
  const offset = (time: number) =>
    Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone)
      .offsetNanoseconds;
  const before = offset(start);
  if (before === offset(end)) return undefined;
  // IANA transitions are separated by more than this hour-sized window.
  while (end - start > 1) {
    const middle = Math.floor((start + end) / 2);
    if (offset(middle) === before) start = middle;
    else end = middle;
  }
  return end;
}

export function metricDateFloor(
  time: number,
  interval: MetricDateGrouping["interval"],
  timeZone = "UTC",
): number {
  if (timeZone !== "UTC") {
    const zoned =
      Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone);
    if (interval === "hour") {
      const floor =
        time - zoned.minute * 60000 - zoned.second * 1000 - zoned.millisecond;
      // An offset change can start a partial hour (e.g. Lord Howe's 30-minute
      // DST shift). Split there rather than mapping into the previous offset.
      return metricOffsetTransition(floor, time, timeZone) ?? floor;
    }
    let date = zoned.toPlainDate();
    if (interval === "week") date = date.subtract({ days: date.dayOfWeek - 1 });
    if (interval === "month" || interval === "year")
      date = date.with({ day: 1 });
    if (interval === "year") date = date.with({ month: 1 });
    return date.toZonedDateTime(timeZone).epochMilliseconds;
  }
  const date = new Date(time);
  date.setUTCMinutes(0, 0, 0);
  if (interval !== "hour") date.setUTCHours(0);
  if (interval === "week")
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (interval === "month" || interval === "year") date.setUTCDate(1);
  if (interval === "year") date.setUTCMonth(0);
  return date.getTime();
}

export function metricDateNext(
  time: number,
  interval: MetricDateGrouping["interval"],
  timeZone = "UTC",
): number {
  if (timeZone !== "UTC") {
    const zoned =
      Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone);
    if (interval === "hour") {
      const target = zoned
        .toPlainDateTime()
        .with({
          minute: 0,
          second: 0,
          millisecond: 0,
          microsecond: 0,
          nanosecond: 0,
        })
        .add({ hours: 1 });
      let next = target.toZonedDateTime(timeZone).epochMilliseconds;
      if (next <= time)
        next = target.toZonedDateTime(timeZone, {
          disambiguation: "later",
        }).epochMilliseconds;
      return metricOffsetTransition(time, next, timeZone) ?? next;
    }
    let date = zoned.toPlainDate();
    if (interval === "month") date = date.with({ day: 1 }).add({ months: 1 });
    else if (interval === "year")
      date = date.with({ month: 1, day: 1 }).add({ years: 1 });
    else if (interval === "week")
      date = date.subtract({ days: date.dayOfWeek - 1 }).add({ weeks: 1 });
    else date = date.add({ days: 1 });
    return date.toZonedDateTime(timeZone).epochMilliseconds;
  }
  const date = new Date(time);
  if (interval === "hour") date.setUTCHours(date.getUTCHours() + 1);
  else if (interval === "month") date.setUTCMonth(date.getUTCMonth() + 1);
  else if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCDate(date.getUTCDate() + (interval === "week" ? 7 : 1));
  return date.getTime();
}

/** A date-only Through value includes the whole local day, even for hourly groups. */
function customEndTime(value: string, timeZone = "UTC"): number {
  const time = metricDateTime(value, timeZone);
  return value.length === 10 ? metricDateNext(time, "day", timeZone) - 1 : time;
}

export function validateDateGrouping(config: MetricDateGrouping): void {
  if (
    typeof config.field !== "string" ||
    !config.field ||
    config.field.length > 256 ||
    !METRIC_DATE_INTERVALS.includes(config.interval) ||
    typeof config.includeEmpty !== "boolean" ||
    !["query", "observed", "custom"].includes(config.range)
  )
    throw Error("Invalid date grouping definition.");
  if (config.timeZone !== undefined) {
    if (
      typeof config.timeZone !== "string" ||
      !config.timeZone ||
      config.timeZone.length > 80 ||
      /^[+-]/.test(config.timeZone)
    )
      throw Error(
        "Use a valid IANA grouping timezone, such as America/Denver or UTC.",
      );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone });
    } catch {
      throw Error(
        "Use a valid IANA grouping timezone, such as America/Denver or UTC.",
      );
    }
  }
  if (config.includeEmpty && config.range === "custom") {
    const start = metricDateTime(config.start ?? "", config.timeZone),
      end = customEndTime(config.end ?? "", config.timeZone);
    if (end < start)
      throw Error("The end date must be on or after the start date.");
  }
}

/** Only conjunctive bounds prove a domain; OR alternatives are not bounds. */
export function metricDateRange(
  config: MetricDateGrouping,
  query: QueryState,
  observed: readonly number[],
  now: number,
  canonical: (field: string) => string,
): [number, number] | undefined {
  let min = Infinity,
    max = -Infinity;
  for (const time of observed) {
    min = Math.min(min, time);
    max = Math.max(max, time);
  }
  if (config.range === "observed")
    return observed.length ? [min, max] : undefined;
  if (config.range === "custom") {
    const start = metricDateFloor(
      metricDateTime(config.start ?? "", config.timeZone),
      config.interval,
      config.timeZone,
    );
    const end = metricDateFloor(
      customEndTime(config.end ?? "", config.timeZone),
      config.interval,
      config.timeZone,
    );
    if (observed.length && (start > min || end < max))
      throw Error(
        "Custom date bounds must include all observed buckets. Narrow the query filters to exclude data.",
      );
    return [start, end];
  }
  let start = -Infinity,
    end = Infinity;
  for (const term of query.where) {
    if (
      isOrGroup(term) ||
      term.negated ||
      canonical(term.field) !== canonical(config.field)
    )
      continue;
    if (!["=", ">", ">=", "<", "<="].includes(term.op)) continue;
    const time = Number(coerceValue("datetime", term.value, now));
    if (term.op === ">" || term.op === ">=" || term.op === "=")
      start = Math.max(start, time + (term.op === ">" ? 1 : 0));
    if (term.op === "<" || term.op === "<=" || term.op === "=")
      end = Math.min(end, time - (term.op === "<" ? 1 : 0));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const missing = [
      ...(Number.isFinite(start) ? [] : ["a lower bound (>= or >)"]),
      ...(Number.isFinite(end) ? [] : ["an upper bound (<= or <)"]),
    ].join(" and ");
    throw Error(
      `Include empty dates with range "query" needs a bounded date filter on ${config.field}: add ${missing} as top-level filters (bounds inside OR groups do not count). Otherwise use range "observed" to fill from the first to the last observed date, or range "custom" with start and end.`,
    );
  }
  if (end < start) return undefined;
  return [
    metricDateFloor(start, config.interval, config.timeZone),
    metricDateFloor(end, config.interval, config.timeZone),
  ];
}
