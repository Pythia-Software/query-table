import { describe, it, expect } from "vitest";
import {
  chronologicalBuckets,
  metricPieSlices,
  metricExtent,
  metricFraction,
} from "../src/metricChartHelpers";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";
const clause: RenderingClause = { id: "x", op: "count", groupBy: ["os"] };
const bucket = (key: string, value: number | null): MetricBucket => ({
  keys: [key],
  value,
  count: 1,
});
describe("metric chart geometry", () => {
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
