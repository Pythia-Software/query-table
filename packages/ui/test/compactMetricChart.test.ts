import { describe, expect, it } from "vitest";
import { compactMetricScale, compactMetricTick, compactTickStep, compactCalendarLabels } from "../src/compactMetricChart";
import { metricScale } from "../src/metricChartHelpers";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";

describe("compact chart axes", () => {
  it("uses sparse round ticks without changing raw values or signed zero baselines", () => {
    const values = [869.5, 1739], before = [...values];
    const scale = compactMetricScale(values, undefined, true);
    expect(scale.ticks).toEqual([0, 1000, 2000]);
    expect(scale.fraction(1739)).toBeCloseTo(.8695);
    expect(values).toEqual(before);
    const signed = compactMetricScale([-47, 129], undefined, true);
    expect(signed.ticks).toEqual([-200, 0, 200]);
    expect(signed.baseline).toBe(0);
  });
  it("keeps explicit bounds, sub-unit precision and finite extremes", () => {
    const bounded = compactMetricScale([1, 100], { min: 10, max: 50 });
    expect([bounded.min, bounded.max]).toEqual([10, 50]);
    expect(bounded.ticks).toEqual([20, 40]);
    const tiny = compactMetricScale([.00012, .00024], undefined, true);
    expect(new Set(tiny.ticks.map(v => compactMetricTick(v))).size).toBe(tiny.ticks.length);
    for (const values of [[0], [-Number.MAX_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE]]) {
      const scale = compactMetricScale(values, undefined, true);
      expect(scale.ticks.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(scale.fraction(values[0]!))).toBe(true);
    }
    expect(compactMetricScale([1, 10], { min: 10, max: 1 }).error).toBeTruthy();
    expect(compactMetricScale([1, 100], { mode: "log" }).ticks).toEqual(metricScale([1, 100], { mode: "log" }).ticks);
  });
  it("rounds elapsed axes in commensurate units, independently of histogram count ticks", () => {
    const format = { kind: "duration" as const, sourceUnit: "milliseconds" as const };
    const scale = compactMetricScale([30572, 403000], undefined, false, format);
    expect(scale.ticks).toEqual([0, 300000, 600000]);
    expect(scale.ticks.map(v => compactMetricTick(v, format))).toEqual(["0", "5m", "10m"]);
    expect(compactMetricTick(2000)).toBe("2K");
    expect(compactMetricTick(2000, format)).toBe("2s");
    expect(compactMetricTick(5, { kind: "duration", sourceUnit: "minutes" })).toBe("5m");
    expect(compactMetricTick(.5, { kind: "percent" })).toBe("50%");
    expect(compactMetricTick(.0001, { kind: "percent" })).toBe("0.01%");
    expect(compactMetricTick(.000001, { kind: "percent" })).toBe("0.0001%");
    const narrow = compactMetricScale([140000, 170000], undefined, false, format);
    expect(narrow.ticks.map(v => compactMetricTick(v, format))).toEqual(["2m", "2.5m", "3m"]);
    const constant = compactMetricScale([160000, 160000], undefined, false, format);
    expect(constant.ticks.map(v => compactMetricTick(v, format))).toEqual(["2.5m", "3m"]);
  });
  it("keeps narrow ranges far from zero distinguishable", () => {
    const labels = (values: number[], format?: { kind: "percent" }) => {
      const scale = compactMetricScale(values, undefined, false, format);
      return scale.ticks.map(v => compactMetricTick(v, format, "en-US", compactTickStep(scale.ticks)));
    };
    expect(labels([1000000, 1004000])).toEqual(["1M", "1.002M", "1.004M"]);
    expect(labels([.1, .108], { kind: "percent" })).toEqual(["10.0%", "10.5%", "11.0%"]);
    expect(compactTickStep([0, 1000, 2000])).toBe(1000);
    expect(compactTickStep([5])).toBeUndefined();
    expect(compactMetricTick(2000, undefined, "en-US", 1000)).toBe("2K");
  });
  it("labels sparse round hours in the computation timezone and retains date identity across days", () => {
    const clause: RenderingClause = { id: "words", op: "sum", groupBy: ["sent_at"], dateGrouping: { field: "sent_at", interval: "hour", timeZone: "America/Denver", range: "observed", includeEmpty: false } };
    const buckets: MetricBucket[] = ["2026-10-08T18:00:00Z", "2026-10-09T00:00:00Z", "2026-10-09T18:00:00Z"].map(key => ({ keys: [key], value: 1, count: 1 }));
    const labels = compactCalendarLabels(buckets.map((bucket, i) => ({ bucket, x: i * 100 })), clause, "en-US");
    expect([...labels.values()]).toEqual(["Oct 8 12h", "Oct 9 12h"]);
    clause.dateGrouping!.timeZone = "UTC";
    expect([...compactCalendarLabels(buckets.map((bucket, i) => ({ bucket, x: i * 100 })), clause, "en-US").values()]).toEqual(["Oct 9 00h"]);
  });
});
