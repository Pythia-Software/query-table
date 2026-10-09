import type { MetricValue, MetricValueFormat } from "./metricTypes";
export interface MetricFormattedValue {
  text: string;
  error?: string;
  raw: MetricValue | undefined;
}
const durationUnits: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60000,
  hours: 3600000,
  days: 86400000,
};
const dateTokens = /\[[^\[\]]*\]|YYYY|MMMM|MMM|MM|DD|ddd|HH|hh|mm|ss|SSS|A|Z/g;
const pad = (n: number | string, width = 2) => String(n).padStart(width, "0");
/** Suppress minus signs only when the formatter actually rounds to zero.
 * This works with older Intl implementations and non-Latin digit locales. */
function numberText(
  value: number,
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): string {
  const formatter = new Intl.NumberFormat(locale, options);
  if (
    (value < 0 || Object.is(value, -0)) &&
    formatter.format(Math.abs(value)) === formatter.format(0)
  )
    return formatter.format(0);
  return formatter.format(value);
}
function zone(format: MetricValueFormat): string | undefined {
  return format.timeZone === "local" ? undefined : (format.timeZone ?? "UTC");
}
export function validateMetricFormat(
  format: MetricValueFormat,
): string | undefined {
  if (
    format.decimals !== undefined &&
    (!Number.isInteger(format.decimals) ||
      format.decimals < 0 ||
      format.decimals > 20)
  )
    return "Decimals must be an integer from 0 to 20.";
  if (format.kind === "number" || format.kind === "percent") return;
  const duration = format.kind === "duration",
    unit = format.sourceUnit ?? (duration ? "milliseconds" : "iso");
  if (
    duration
      ? !Object.prototype.hasOwnProperty.call(durationUnits, unit)
      : ![
          "iso",
          "epochSeconds",
          "epochMilliseconds",
          ...(format.kind === "time"
            ? ["secondsOfDay", "millisecondsOfDay"]
            : []),
        ].includes(unit)
  )
    return "Unsupported source unit for this format.";
  if (
    !(
      duration
        ? ["human", "long", "clock", "custom"]
        : ["human", "iso", "custom"]
    ).includes(format.style ?? "human")
  )
    return "Unsupported label style.";
  if (!duration)
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: zone(format) });
    } catch {
      return "Enter a valid IANA timezone or UTC/local.";
    }
  if (format.style === "custom") {
    const pattern = format.pattern ?? "";
    if (!pattern.trim() || pattern.length > 160)
      return "Enter a format pattern of 1–160 characters.";
    if (duration) {
      const rest = pattern.replace(/\{(?:d|hh|h|mm|m|ss|s|ms)\}/g, "");
      if (rest === pattern || /[{}]/.test(rest))
        return "Use duration tokens {d}, {h}, {hh}, {m}, {mm}, {s}, {ss}, {ms}.";
    } else {
      const tokens = pattern.match(dateTokens) ?? [];
      const rest = pattern.replace(dateTokens, "");
      if (!tokens.some((t) => !t.startsWith("[")) || /[A-Za-z\[\]]/.test(rest))
        return "Use supported date/time tokens and [bracketed literals].";
    }
  }
}
function numeric(value: MetricValue): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw Error("Expected a finite number in the selected source unit.");
}
function durationText(
  value: MetricValue,
  format: MetricValueFormat,
  locale?: string,
): string {
  const ms =
    numeric(value) * durationUnits[format.sourceUnit ?? "milliseconds"]!;
  if (!Number.isFinite(ms) || Math.abs(ms) > Number.MAX_SAFE_INTEGER)
    throw Error("Duration exceeds safe millisecond precision.");
  const abs = Math.abs(ms),
    rounded = Math.round(abs),
    sign =
      ms < 0 &&
      (format.style === "clock" || format.style === "custom"
        ? rounded > 0
        : abs > 0)
        ? "−"
        : "",
    seconds = Math.floor(rounded / 1000),
    hours = Math.floor(seconds / 3600);
  const h = format.pattern?.includes("{d}") ? hours % 24 : hours;
  // Wrap only when a larger unit is explicitly represented. Otherwise the
  // highest displayed unit carries the full elapsed duration.
  const custom = format.style === "custom";
  const minutes = Math.floor(seconds / 60);
  const m = custom
    ? /\{hh?\}/.test(format.pattern!)
      ? minutes % 60
      : /\{d\}/.test(format.pattern!)
        ? minutes % 1440
        : minutes
    : minutes % 60;
  const s = custom
    ? /\{mm?\}/.test(format.pattern!)
      ? seconds % 60
      : /\{hh?\}/.test(format.pattern!)
        ? seconds % 3600
        : /\{d\}/.test(format.pattern!)
          ? seconds % 86400
          : seconds
    : seconds % 60;
  const millis =
    !custom || /\{ss?\}/.test(format.pattern!)
      ? rounded % 1000
      : /\{mm?\}/.test(format.pattern!)
        ? rounded % 60000
        : /\{hh?\}/.test(format.pattern!)
          ? rounded % 3600000
          : /\{d\}/.test(format.pattern!)
            ? rounded % 86400000
            : rounded;
  const parts: Record<string, string | number> = {
    d: Math.floor(seconds / 86400),
    h,
    hh: pad(h),
    m,
    mm: pad(m),
    s,
    ss: pad(s),
    ms: pad(millis, 3),
  };
  if (format.style === "custom") {
    const tokens = format.pattern!.match(/\{(d|hh|h|mm|m|ss|s|ms)\}/g) ?? [];
    const visible = tokens.some(
      (token) => Number(parts[token.slice(1, -1)]) !== 0,
    );
    return (
      (visible ? sign : "") +
      format.pattern!.replace(/\{(d|hh|h|mm|m|ss|s|ms)\}/g, (_, key: string) =>
        String(parts[key]),
      )
    );
  }
  if (format.style === "clock")
    return `${sign}${pad(hours)}:${parts.mm}:${parts.ss}${rounded % 1000 ? "." + parts.ms : ""}`;
  const amount = (n: number) =>
    n.toLocaleString(locale, { maximumFractionDigits: 3 });
  const long = format.style === "long";
  if (abs < 1000)
    return `${sign}${abs > 0 && abs < 0.001 ? "<0.001" : amount(abs)}${long ? (abs === 1 ? " millisecond" : " milliseconds") : "ms"}`;
  if (abs < 60000 && rounded < 60000)
    return `${sign}${amount(rounded / 1000)}${long ? (rounded === 1000 ? " second" : " seconds") : "s"}`;
  const sec = Math.round(abs / 1000),
    values = [
      Math.floor(sec / 86400),
      Math.floor(sec / 3600) % 24,
      Math.floor(sec / 60) % 60,
      sec % 60,
    ];
  return (
    sign +
    values
      .map((v, i) => ({ v, i }))
      .filter((p) => p.v)
      .slice(0, 2)
      .map(({ v, i }) =>
        long
          ? `${v} ${["day", "hour", "minute", "second"][i]}${v === 1 ? "" : "s"}`
          : `${v}${["d", "h", "m", "s"][i]}`,
      )
      .join(long ? ", " : "")
  );
}
function validCalendar(year: number, month: number, day: number): boolean {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return (
    year >= 1 &&
    year <= 9999 &&
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}
/** Strict coordinate parser shared by calendar formatting and chronological charts. */
export function metricTimestamp(
  value: MetricValue,
  format: MetricValueFormat = { kind: "datetime" },
): { date: Date; timeZone: string | undefined } {
  const unit = format.sourceUnit ?? "iso";
  let ms: number,
    civil = false;
  if (unit === "epochSeconds" || unit === "epochMilliseconds")
    ms = numeric(value) * (unit === "epochSeconds" ? 1000 : 1);
  else if (unit === "secondsOfDay" || unit === "millisecondsOfDay") {
    ms = numeric(value) * (unit === "secondsOfDay" ? 1000 : 1);
    if (format.kind !== "time" || ms < 0 || ms >= 86400000)
      throw Error("Time of day must be in [0, 24 hours).");
    civil = true;
  } else {
    if (typeof value !== "string")
      throw Error(
        "Expected ISO text; select Unix units for numeric timestamps.",
      );
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value),
      clock = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value),
      stamp =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
          value,
        );
    const calendar = date ?? stamp;
    if (calendar && !validCalendar(+calendar[1]!, +calendar[2]!, +calendar[3]!))
      throw Error("Invalid calendar date.");
    if (date && format.kind !== "time") {
      ms = Date.parse(value + "T00:00:00Z");
      civil = true;
    } else if (clock && format.kind === "time") {
      const h = +clock[1]!,
        m = +clock[2]!,
        s = +(clock[3] ?? 0);
      if (h > 23 || m > 59 || s > 59) throw Error("Invalid clock time.");
      ms =
        ((h * 60 + m) * 60 + s) * 1000 +
        Number((clock[4] ?? "").padEnd(3, "0"));
      civil = true;
    } else if (stamp) {
      const offset = stamp[8]!;
      if (
        +stamp[4]! > 23 ||
        +stamp[5]! > 59 ||
        +stamp[6]! > 59 ||
        (offset !== "Z" && (+offset.slice(1, 3) > 23 || +offset.slice(4) > 59))
      )
        throw Error("Invalid timestamp time or offset.");
      ms = Date.parse(value);
    } else
      throw Error(
        "Use a strict ISO date/time with an explicit timestamp offset.",
      );
  }
  const date = new Date(ms);
  if (
    !Number.isFinite(ms) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    throw Error("Calendar output supports years 0001–9999.");
  const timeZone = civil ? "UTC" : zone(format);
  const calendarParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    era: "short",
  }).formatToParts(date);
  const year = Number(calendarParts.find((p) => p.type === "year")?.value),
    era = calendarParts.find((p) => p.type === "era")?.value;
  if (era !== "AD" || year < 1 || year > 9999)
    throw Error(
      "Calendar output supports years 0001–9999 in the selected timezone.",
    );
  return { date, timeZone };
}
function calendarText(
  value: MetricValue,
  format: MetricValueFormat,
  locale?: string,
): string {
  const { date, timeZone } = metricTimestamp(value, format);
  if (format.style === "custom" || format.style === "iso") {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date))
      parts[p.type] = p.value;
    const offsetDate = new Date(0);
    offsetDate.setUTCFullYear(+parts.year!, +parts.month! - 1, +parts.day!);
    offsetDate.setUTCHours(
      +parts.hour!,
      +parts.minute!,
      +parts.second!,
      date.getUTCMilliseconds(),
    );
    const offset = Math.round((offsetDate.getTime() - date.getTime()) / 60000);
    const names = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(date);
    const tokens: Record<string, string> = {
      YYYY: pad(parts.year!, 4),
      MM: parts.month!,
      DD: parts.day!,
      HH: parts.hour!,
      hh: pad(+parts.hour! % 12 || 12),
      mm: parts.minute!,
      ss: parts.second!,
      SSS: pad(date.getUTCMilliseconds(), 3),
      MMM: names({ month: "short" }),
      MMMM: names({ month: "long" }),
      ddd: names({ weekday: "short" }),
      A: +parts.hour! < 12 ? "AM" : "PM",
      Z: `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    };
    const pattern =
      format.style === "custom"
        ? format.pattern!
        : format.kind === "date"
          ? "YYYY-MM-DD"
          : format.kind === "time"
            ? "HH:mm:ss"
            : "YYYY-MM-DD HH:mm:ss Z";
    return pattern.replace(dateTokens, (t) =>
      t.startsWith("[") ? t.slice(1, -1) : tokens[t]!,
    );
  }
  const options: Intl.DateTimeFormatOptions =
    format.kind === "date"
      ? { year: "numeric", month: "short", day: "numeric" }
      : format.kind === "time"
        ? {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }
        : {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
            timeZoneName: "short",
          };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
}
export function formatMetricOutput(
  value: MetricValue | undefined,
  format?: MetricValueFormat,
  locale?: string,
): MetricFormattedValue {
  if (value == null) return { text: "—", raw: value };
  try {
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("Expected a finite numeric value.");
    if (!format)
      return {
        text:
          typeof value === "number"
            ? numberText(value, locale, { maximumFractionDigits: 6 })
            : String(value),
        raw: value,
      };
    const error = validateMetricFormat(format);
    if (error) throw Error(error);
    const text =
      format.kind === "duration"
        ? durationText(value, format, locale)
        : ["date", "time", "datetime"].includes(format.kind)
          ? calendarText(value, format, locale)
          : typeof value === "number"
            ? numberText(value, locale, {
                style: format.kind === "percent" ? "percent" : "decimal",
                minimumFractionDigits: format.decimals ?? 0,
                maximumFractionDigits: format.decimals ?? 0,
              })
            : String(value);
    return { text, raw: value };
  } catch (error) {
    return {
      text: "Invalid format",
      error: error instanceof Error ? error.message : "Invalid format",
      raw: value,
    };
  }
}
