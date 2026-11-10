import { describe, it, expect } from "vitest";
import type { AggregationClause } from "@pythia-software/query-table-core";
import {
  formatMetricOutput as format,
  metricFormatFromMeasure,
  metricTimestamp,
  validateMetricFormat,
} from "../src/metricFormat";
describe("metric output formatting", () => {
  it.each([
    ["{m}:{ss}", 3700, "61:40"],
    ["{mm}:{ss}", 90061, "1501:01"],
    ["{s}", 3700, "3700"],
    ["{h}:{ss}", 3700, "1:100"],
    ["{d}:{mm}:{ss}", 90061, "1:61:01"],
    ["{ms}", 1.234, "1234"],
    ["{m}:{ms}", 61.234, "1:1234"],
  ])("carries omitted duration units in %s", (pattern, value, expected) => {
    expect(
      format(value, {
        kind: "duration",
        sourceUnit: "seconds",
        style: "custom",
        pattern,
      }).text,
    ).toBe(expected);
  });
  it("suppresses negative signs after numeric and percent rounding without hiding negative values", () => {
    expect(
      format(-0.00004, { kind: "number", decimals: 1 }, "en-US").text,
    ).toBe("0.0");
    expect(
      format(-0.0001, { kind: "percent", decimals: 0 }, "en-US").text,
    ).toBe("0%");
    expect(format(-0.001, { kind: "percent", decimals: 1 }, "en-US").text).toBe(
      "-0.1%",
    );
    expect(format(-0.1, { kind: "number", decimals: 1 }, "en-US").text).toBe(
      "-0.1",
    );
    expect(format(-0.00000004, undefined, "en-US").text).toBe("0");
    expect(
      format(-0.00004, { kind: "number", decimals: 1 }, "ar-EG").text,
    ).toBe(format(0, { kind: "number", decimals: 1 }, "ar-EG").text);
  });
  it("preserves elapsed duration units, carries rounding, signs and unbounded hours", () => {
    expect(
      format(84000, { kind: "duration", sourceUnit: "seconds" }).text,
    ).toBe("23h20m");
    expect(format(84000, { kind: "duration" }).text).toBe("1m24s");
    expect(
      format(59.9999, { kind: "duration", sourceUnit: "seconds" }).text,
    ).toBe("1m");
    expect(
      format(-90000, {
        kind: "duration",
        sourceUnit: "seconds",
        style: "clock",
      }).text,
    ).toBe("−25:00:00");
    expect(format(0, { kind: "duration" }).text).toBe("0ms");
    expect(format(0.125, { kind: "duration" }).text).toBe("0.125ms");
    expect(
      format(90061007, {
        kind: "duration",
        style: "custom",
        pattern: "{d}d {hh}:{mm}:{ss}.{ms}",
      }).text,
    ).toBe("1d 01:01:01.007");
    expect(
      format(84000, { kind: "duration", sourceUnit: "seconds", style: "long" })
        .text,
    ).toBe("23 hours, 20 minutes");
  });
  it("rejects coercion and precision overflow with a separate error preserving raw data", () => {
    for (const value of [true, "1,000", "1x", Infinity, Number.MAX_VALUE]) {
      const out = format(value, { kind: "duration" });
      expect(out.text).toBe("Invalid format");
      expect(out.error).toBeTruthy();
      expect(out.raw).toBe(value);
    }
    expect(format("84000", { kind: "duration" }).text).toBe("1m24s");
    expect(format(null, { kind: "duration" }).text).toBe("—");
  });
  it("strictly decodes calendar dates and qualified timestamps", () => {
    for (const value of [
      "2026-02-30",
      "2026-13-01",
      "2026-10-08T14:30:00",
      "10/08/2026",
      "2026-10-08T24:00:00Z",
      "2026-10-08T14:30:00+24:00",
      "0000-01-01",
    ])
      expect(format(value, { kind: "datetime" }).error, value).toBeTruthy();
    expect(format(1720000000, { kind: "datetime" }).error).toBeTruthy();
    expect(format("2024-02-29", { kind: "date", style: "iso" }).text).toBe(
      "2024-02-29",
    );
    expect(format("0001-01-01", { kind: "date", style: "iso" }).text).toBe(
      "0001-01-01",
    );
    expect(
      format("2026-10-08", {
        kind: "date",
        style: "iso",
        timeZone: "America/Denver",
      }).text,
    ).toBe("2026-10-08");
    expect(
      format("2026-10-08T00:30:00Z", {
        kind: "date",
        style: "iso",
        timeZone: "America/Denver",
      }).text,
    ).toBe("2026-10-07");
    expect(
      format(0, { kind: "datetime", sourceUnit: "epochSeconds", style: "iso" })
        .text,
    ).toBe("1970-01-01 00:00:00 +00:00");
  });
  it("supports civil clock fields and rejects elapsed values outside a day", () => {
    expect(
      format("14:30:00.123", {
        kind: "time",
        style: "custom",
        pattern: "HH:mm:ss.SSS",
        timeZone: "America/Denver",
      }).text,
    ).toBe("14:30:00.123");
    expect(
      format(90000, { kind: "time", sourceUnit: "secondsOfDay" }).error,
    ).toBeTruthy();
    expect(
      format(52200, {
        kind: "time",
        sourceUnit: "secondsOfDay",
        style: "custom",
        pattern: "hh:mm A",
      }).text,
    ).toBe("02:30 PM");
    expect(format("23:59:60", { kind: "time" }).error).toBeTruthy();
  });
  it("validates bounded literal grammars and timezones", () => {
    for (const pattern of [
      "YYYY [open",
      "YYYY unescaped",
      "[literal]",
      "YYYY " + "x".repeat(160),
    ])
      expect(
        validateMetricFormat({ kind: "date", style: "custom", pattern }),
      ).toBeTruthy();
    expect(
      validateMetricFormat({
        kind: "duration",
        style: "custom",
        pattern: "{hours}",
      }),
    ).toBeTruthy();
    expect(
      validateMetricFormat({ kind: "datetime", timeZone: "not/a/zone" }),
    ).toBeTruthy();
    expect(
      format("2026-10-08T14:30:00Z", {
        kind: "datetime",
        style: "custom",
        pattern: "MMM DD, YYYY [at] hh:mm A Z",
      }).text,
    ).toBe("Oct 08, 2026 at 02:30 PM +00:00");
    expect(format(1.25, { kind: "percent", decimals: 1 }).text).toBe("125.0%");
    expect(() => metricTimestamp("2026-02-30")).toThrow();
  });
});

it("formats ISO time in deterministic 24-hour form", () => {
  expect(
    format("14:30:00", { kind: "time", sourceUnit: "iso", style: "iso" }).text,
  ).toBe("14:30:00");
});

it("suppresses duration negative zero in clock and custom styles", () => {
  expect(
    format(-0.4, {
      kind: "duration",
      sourceUnit: "milliseconds",
      style: "clock",
    }).text,
  ).toBe("00:00:00");
  expect(
    format(-0.4, {
      kind: "duration",
      sourceUnit: "milliseconds",
      style: "custom",
      pattern: "{h}h{m}m",
    }).text,
  ).toBe("0h0m");
  expect(
    format(-1, { kind: "duration", sourceUnit: "milliseconds", style: "clock" })
      .text,
  ).toBe("−00:00:00.001");
});

it("omits a duration sign when the custom pattern drops every nonzero unit", () => {
  expect(
    format(-59, {
      kind: "duration",
      sourceUnit: "seconds",
      style: "custom",
      pattern: "{h}h{m}m",
    }).text,
  ).toBe("0h0m");
  expect(
    format(-59, {
      kind: "duration",
      sourceUnit: "seconds",
      style: "custom",
      pattern: "{s}s",
    }).text,
  ).toBe("−59s");
});

describe("metricFormatFromMeasure", () => {
  const avg: AggregationClause = { id: "m", op: "avg", field: "x", groupBy: [] };
  it("maps numeric cell displays to metric value formats", () => {
    expect(metricFormatFromMeasure(avg, { display: { kind: "percent" } })).toEqual({ kind: "percent", decimals: 2 });
    expect(metricFormatFromMeasure(avg, { display: { kind: "number", decimals: 1 } })).toEqual({ kind: "number", decimals: 1 });
    expect(metricFormatFromMeasure(avg, { display: { kind: "number" } })).toBeUndefined();
    expect(metricFormatFromMeasure(avg, { display: { kind: "duration", sourceUnit: "seconds", style: "clock" } }))
      .toEqual({ kind: "duration", sourceUnit: "seconds", style: "clock" });
    expect(metricFormatFromMeasure(avg, { display: { kind: "text" } })).toBeUndefined();
    expect(metricFormatFromMeasure({ ...avg, op: "count" }, { display: { kind: "percent" } })).toBeUndefined();
  });
  it("maps currency and compact cell displays without their cell locale", () => {
    expect(metricFormatFromMeasure(avg, { display: { kind: "currency", currency: "EUR", notation: "compact", locale: "de-DE" } }))
      .toEqual({ kind: "currency", currency: "EUR", notation: "compact" });
    expect(metricFormatFromMeasure(avg, { display: { kind: "currency", currency: "USD", decimals: 0 } }))
      .toEqual({ kind: "currency", currency: "USD", decimals: 0 });
    expect(metricFormatFromMeasure(avg, { display: { kind: "compact", decimals: 2 } })).toEqual({ kind: "compact", decimals: 2 });
    expect(metricFormatFromMeasure({ ...avg, op: "count_distinct" }, { display: { kind: "compact" } })).toBeUndefined();
    expect(metricFormatFromMeasure({ ...avg, expression: "SUM([x])/2" }, { display: { kind: "currency", currency: "USD" } })).toBeUndefined();
  });
});

describe("currency and compact output", () => {
  it.each([
    [1234.5, { kind: "currency", currency: "USD" }, "en-US", "$1,234.50"],
    [1234.5, { kind: "currency", currency: "USD", decimals: 0 }, "en-US", "$1,235"],
    [1234.5, { kind: "currency", currency: "JPY" }, "en-US", "¥1,235"],
    [1234567, { kind: "currency", currency: "USD", notation: "compact" }, "en-US", "$1.2M"],
    [1234567, { kind: "currency", currency: "USD", notation: "compact", decimals: 2 }, "en-US", "$1.23M"],
    [-0.004, { kind: "currency", currency: "USD" }, "en-US", "$0.00"],
    ["12.5", { kind: "currency", currency: "USD" }, "en-US", "$12.50"],
    [1234, { kind: "compact" }, "en-US", "1.2K"],
    [3_400_000, { kind: "compact" }, "en-US", "3.4M"],
    [3_456_789, { kind: "compact", decimals: 2 }, "en-US", "3.46M"],
    [999, { kind: "compact" }, "en-US", "999"],
    [12.345, { kind: "compact" }, "en-US", "12.3"],
    [3_000_000, { kind: "compact" }, "en-US", "3M"],
    [-1500, { kind: "compact", decimals: 0 }, "en-US", "-2K"],
  ] as const)("formats %s as %j in %s", (value, f, locale, expected) => {
    expect(format(value, f, locale).text).toBe(expected);
  });
  it("follows the locale's compact notation and currency placement", () => {
    expect(format(1234567, { kind: "compact" }, "de-DE").text).toBe(new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(1234567));
    expect(format(1234.5, { kind: "currency", currency: "EUR" }, "de-DE").text).toBe("1.234,50 €");
  });
  it("reports a missing or malformed currency code and non-numeric input instead of guessing", () => {
    expect(validateMetricFormat({ kind: "currency" })).toMatch(/ISO 4217/);
    expect(validateMetricFormat({ kind: "currency", currency: "usd" })).toMatch(/ISO 4217/);
    expect(validateMetricFormat({ kind: "currency", currency: "USD" })).toBeUndefined();
    expect(validateMetricFormat({ kind: "compact", decimals: 21 })).toMatch(/Decimals/);
    const missing = format(5, { kind: "currency" }, "en-US");
    expect(missing).toMatchObject({ text: "Invalid format", raw: 5 });
    expect(missing.error).toMatch(/ISO 4217/);
    expect(format("five", { kind: "compact" }, "en-US")).toMatchObject({ text: "Invalid format", raw: "five" });
    expect(format(null, { kind: "currency", currency: "USD" }).text).toBe("—");
  });
});
