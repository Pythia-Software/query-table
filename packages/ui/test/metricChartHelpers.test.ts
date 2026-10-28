import { describe, it, expect } from "vitest";
import {
  chronologicalBuckets,
  metricPieSlices,
  metricExtent,
  metricFraction,
  metricDisplayBuckets,
  isMetricOtherBucket,
  metricGroupLabel,
  metricGroupKeyLabel,
  metricCycleLabel,
  metricDateGroupFormat,
} from "../src/metricChartHelpers";
import { compactCalendarLabels } from "../src/compactMetricChart";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";
const clause: RenderingClause = { id: "x", op: "count", groupBy: ["os"] };
const bucket = (key: string, value: number | null): MetricBucket => ({
  keys: [key],
  value,
  count: 1,
});
describe("metric chart geometry", () => {
  it("hides a pie remainder without rebasing its exact denominator or hiding a real Other", () => {
    const result = metricPieSlices(clause, [bucket("Other", 4), bucket("a", 2), bucket("b", 3)], 3, undefined, 1, false);
    expect(result.total).toBe(9);
    expect(result.slices.map(s => [s.value, s.other, s.bucket.keys])).toEqual([[4, false, ["Other"]]]);
    expect(metricPieSlices(clause, [bucket("a", 2)], 10, undefined, 1, false).error).toMatch(/complete/);
  });
  it("limits lists in result order and combines only an exact additive remainder", () => {
    const input = [bucket("Other", 4), bucket("a", 2), bucket("b", 3)];
    const list: RenderingClause = { ...clause, display: { kind: "list", maxGroups: 1, showOther: true } };
    expect(metricDisplayBuckets(list, input, 3).map(b => [b.keys[0], b.value])).toEqual([["Other", 4], ["Other (combined remainder)", 5]]);
    expect(metricDisplayBuckets(list, input, 10, bucket("Other", 11)).at(-1)?.value).toBe(16);
    expect(metricDisplayBuckets({ ...list, display: { kind: "list", showOther: true } }, input, 10, bucket("Other", 11)).at(-1)?.value).toBe(11);
    expect(metricDisplayBuckets(list, [bucket("a", 1), bucket("b", 1e308), bucket("c", 1e308)])).toHaveLength(1);
    for (const variant of ["unknown", "partial", "average", "negative", "hidden"] as const) {
      const output = metricDisplayBuckets({ ...list, op: variant === "average" ? "avg" : "count", display: { ...list.display!, showOther: variant !== "hidden" } }, variant === "negative" ? [...input, bucket("bad", -1)] : input, variant === "unknown" ? 10 : 3, undefined, variant === "partial");
      expect(output).toHaveLength(1);
    }
    expect(input).toHaveLength(3);
    expect(metricDisplayBuckets(clause, input)).toBe(input);
  });
  it("limits pivots by row rather than by cell", () => {
    const cell = (row: string, col: string, value: number) => ({ keys: [row, col], value, count: 1 });
    const input = [cell("r1", "a", 1), cell("r1", "b", 2), cell("r2", "a", 3), cell("r3", "b", 4)];
    for (const kind of ["table", "auto"] as const) {
      const pivot: RenderingClause = { ...clause, groupBy: ["row", "col"], display: { kind, maxGroups: 2 } };
      expect(metricDisplayBuckets(pivot, input).map(b => b.keys)).toEqual(input.slice(0, 3).map(b => b.keys));
    }
    const swapped: RenderingClause = { ...clause, groupBy: ["row", "col"], display: { kind: "table", maxGroups: 1, pivot: { swap: true } } };
    expect(metricDisplayBuckets(swapped, input).map(b => b.keys)).toEqual([["r1", "a"], ["r2", "a"]]);
    const flat: RenderingClause = { ...clause, groupBy: ["a", "b", "c"], display: { kind: "table", maxGroups: 1 } };
    expect(metricDisplayBuckets(flat, [{ keys: ["x", "y", "z"], value: 1, count: 1 }, { keys: ["x", "y", "w"], value: 1, count: 1 }])).toHaveLength(1);
  });
  it("labels the combined remainder verbatim on date-grouped lists", () => {
    const dated: RenderingClause = { ...clause, dateGrouping: { field: clause.groupBy[0]!, interval: "day", includeEmpty: false, range: "observed" }, display: { kind: "list", maxGroups: 1, showOther: true } };
    const output = metricDisplayBuckets(dated, [bucket("2026-10-01", 4), bucket("2026-10-02", 2)], 2);
    expect(isMetricOtherBucket(output[0]!)).toBe(false);
    expect(isMetricOtherBucket(output[1]!)).toBe(true);
    expect(metricGroupLabel(output[1]!, dated)).toBe("Other (combined remainder)");
    expect(metricGroupLabel(output[1]!, dated, undefined, true)).toBe("Other (combined remainder)");
  });
  it("limits line charts by series rather than by time point", () => {
    const point = (day: string, series: string, value: number) => ({ keys: [day, series], value, count: 1 });
    const input = [point("2026-10-01", "a", 1), point("2026-10-01", "b", 2), point("2026-10-02", "a", 3), point("2026-10-02", "b", 4), point("2026-10-03", "c", 5)];
    const line: RenderingClause = { ...clause, groupBy: ["day", "series"], display: { kind: "line", maxGroups: 2 } };
    expect(metricDisplayBuckets(line, input).map(b => b.keys)).toEqual(input.slice(0, 4).map(b => b.keys));
    expect(metricDisplayBuckets({ ...line, display: { kind: "line", maxGroups: 3 } }, input)).toBe(input);
    const single = input.filter(b => b.keys[1] === "a").map(b => ({ ...b, keys: [b.keys[0]!] }));
    expect(metricDisplayBuckets({ ...line, groupBy: ["day"], display: { kind: "line", maxGroups: 1 } }, single)).toBe(single);
  });
  it("orders time chronologically without mutating results and keeps gaps", () => {
    const input = [
        bucket("2026-10-08", 4),
        bucket("2026-10-01", 1),
        bucket("2026-10-03", null),
      ],
      out = chronologicalBuckets(input);
    expect(out.map((p) => p.bucket.value)).toEqual([1, null, 4]);
    expect(out[1]!.time - out[0]!.time).toBe(2 * 86400000);
    expect(input[0]!.value).toBe(4);
  });
  it("uses exact additive denominator and distinguishes a real Other category", () => {
    const buckets = [bucket("Other", 4), bucket("a", 2), bucket("b", 3)];
    const pie = metricPieSlices(clause, buckets, 3, undefined, 1);
    expect(pie.total).toBe(9);
    expect(pie.slices.map((s) => [s.value, s.other])).toEqual([
      [4, false],
      [5, true],
    ]);
    expect(metricPieSlices(clause, buckets, 10).error).toMatch(/complete/);
    expect(
      metricPieSlices(clause, buckets, 10, bucket("Other", 11)).total,
    ).toBe(20);
    expect(metricPieSlices({ ...clause, op: "avg" }, buckets).error).toMatch(
      /additive/,
    );
    expect(
      metricPieSlices(clause, [bucket("negative", -1)]).error,
    ).toBeTruthy();
    expect(
      metricPieSlices(clause, [bucket("missing", null)]).error,
    ).toBeTruthy();
  });
  it("retains zero baseline for signed bars and visible constant domains", () => {
    expect(metricExtent([-5, 10], true)).toEqual([-5, 10]);
    expect(metricExtent([5], true)).toEqual([0, 5]);
    expect(metricExtent([0])).toEqual([-1, 1]);
  });
});

it("maps finite extremes without overflowing SVG coordinates", () => {
  expect(metricFraction(0, -Number.MAX_VALUE, Number.MAX_VALUE)).toBe(0.5);
  const extent = metricExtent([Number.MAX_VALUE]);
  expect(extent.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(metricFraction(Number.MAX_VALUE, ...extent))).toBe(
    true,
  );
  expect(() =>
    chronologicalBuckets([{ keys: [Infinity], value: 1, count: 1 }]),
  ).toThrow();
});

import { metricScale } from "../src/metricChartHelpers";
it("maps orders of magnitude evenly and omits nonpositive values", () => {
  const axis = metricScale([-2, 0, 1, 10, 100], { mode: "log" });
  expect(axis.fraction(1)).toBe(0);
  expect(axis.fraction(10)).toBeCloseTo(0.5);
  expect(axis.fraction(100)).toBe(1);
  expect(axis.ticks[1]).toBeCloseTo(10);
  expect(axis.omitted).toBe(2);
  expect(axis.accepts(0)).toBe(false);
  expect(axis.error).toBeUndefined();
});
it("uses explicit bounds in raw units and preserves coordinates outside the clipping domain", () => {
  const axis = metricScale([0, 100], { min: 10, max: 50 });
  expect(axis.fraction(30)).toBe(0.5);
  expect(axis.fraction(100)).toBeGreaterThan(1);
  expect(metricScale([1, 10], { mode: "log", min: 0 }).error).toBeTruthy();
  expect(metricScale([1, 10], { min: 10, max: 1 }).error).toBeTruthy();
  expect(metricScale([1, 10], { min: 100 }).max).toBeGreaterThan(100);
});

it("keeps extreme values finite when explicit bounds zoom into a narrow range", () => {
  const axis = metricScale([Number.MAX_VALUE], {
    min: 0,
    max: Number.MIN_VALUE,
  });
  expect(Number.isFinite(axis.fraction(Number.MAX_VALUE) * 1000)).toBe(true);
});


it("keeps interpolated whiskers outside quartiles and sampled extremes complete without mutating summaries", async () => {
  const { boxSummary }=await import("@pythia-software/query-table-core");
  const { metricBoxWhiskers,metricBoxOutliers }=await import("../src/metricChartHelpers");
  for(const values of [[30000,750000,3200000,1700000000],[0,100,101,102],[5,5,5]]) {
    const summary=boxSummary(values,"tukey")!,before=structuredClone(summary);
    const {low,high}=metricBoxWhiskers(summary);
    expect(low).toBeLessThanOrEqual(summary.q1);expect(low).toBeGreaterThanOrEqual(summary.min);
    expect(high).toBeGreaterThanOrEqual(summary.q3);expect(high).toBeLessThanOrEqual(summary.max);
    const sampled={...summary,outliers:[]};
    if(summary.max>summary.high)expect(metricBoxOutliers(sampled)).toContain(summary.max);
    if(summary.min<summary.low)expect(metricBoxOutliers(sampled)).toContain(summary.min);
    expect(summary).toEqual(before);
  }
});

describe("cyclic slot labels", () => {
  const hours: RenderingClause = { id: "h", op: "count", groupBy: ["at"], dateGrouping: { field: "at", interval: "hourOfDay", timeZone: "Asia/Kolkata", includeEmpty: true, range: "query" } };
  const days: RenderingClause = { ...hours, dateGrouping: { ...hours.dateGrouping!, interval: "dayOfWeek" } };
  it("labels hours and ISO weekdays", () => {
    expect(metricCycleLabel(9, "hourOfDay")).toBe("09:00");
    expect(metricCycleLabel(23, "hourOfDay", "en-US", true)).toBe("23:00–00:00");
    expect(metricCycleLabel(1, "dayOfWeek", "en-US")).toBe("Mon");
    expect(metricCycleLabel(7, "dayOfWeek", "en-US", true)).toBe("Sunday");
    expect(metricCycleLabel(8, "dayOfWeek")).toBeUndefined();
    expect(metricGroupKeyLabel(0, 0, hours)).toBe("00:00");
    expect(metricGroupKeyLabel(3, 0, days, "en-US")).toBe("Wed");
    expect(metricGroupKeyLabel(null, 0, days)).toBe("NULL");
    expect(metricDateGroupFormat(days)).toBeUndefined();
    expect(metricGroupLabel({ keys: [5, "a"], value: 1, count: 1 }, days, "en-US")).toBe("Fri / a");
  });
  it("orders slots by number and labels compact axes sparsely", () => {
    const buckets = [3, 0, 12, 6].map((slot) => ({ keys: [slot], value: 1, count: 1 }));
    expect(chronologicalBuckets(buckets).map((p) => p.bucket.keys[0])).toEqual([0, 3, 6, 12]);
    const labels = compactCalendarLabels(buckets.map((bucket, i) => ({ bucket, x: i * 40 })), hours, "en-US");
    expect([...labels.values()]).toEqual(["00:00", "12:00", "06:00"]);
  });
});
