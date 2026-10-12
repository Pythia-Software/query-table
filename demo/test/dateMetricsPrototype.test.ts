import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ORDERS,
  INITIAL_DATE_METRIC,
  previewDateMetric,
  type DateMetricDefinition,
} from "../src/dateMetricExample";

const definition = (
  options: Partial<DateMetricDefinition["dateGrouping"]> = {},
): DateMetricDefinition => ({
  ...INITIAL_DATE_METRIC,
  dateGrouping: {
    ...INITIAL_DATE_METRIC.dateGrouping,
    includeEmpty: true,
    ...options,
  },
});

describe("date metric prototype", () => {
  it("fills interior and boundary days without changing population totals", () => {
    const sparse = previewDateMetric(
      definition({ includeEmpty: false }),
      EXAMPLE_ORDERS,
    );
    const completed = previewDateMetric(definition(), EXAMPLE_ORDERS);
    expect(sparse.buckets).toHaveLength(7);
    expect(completed.buckets).toHaveLength(14);
    expect(completed.emptyBuckets).toBe(7);
    expect(completed.buckets[0]).toEqual({
      keys: ["2026-10-01"],
      value: 0,
      count: 0,
    });
    expect(completed.buckets[13]).toEqual({
      keys: ["2026-10-14"],
      value: 0,
      count: 0,
    });
    expect(completed.matchingRows).toBe(96);
    expect(
      completed.buckets.reduce((sum, bucket) => sum + Number(bucket.value), 0),
    ).toBe(96);
    expect(completed.buckets.filter((bucket) => bucket.count)).toEqual(
      sparse.buckets,
    );
  });

  it("keeps empty averages undefined and empty sums zero", () => {
    const avg = previewDateMetric(
      { ...definition(), op: "avg", expression: "AVG([total])" },
      EXAMPLE_ORDERS,
    );
    const sum = previewDateMetric(
      { ...definition(), op: "sum", expression: "SUM([total])" },
      EXAMPLE_ORDERS,
    );
    expect(
      avg.buckets.filter((b) => b.count === 0).every((b) => b.value === null),
    ).toBe(true);
    expect(
      sum.buckets.filter((b) => b.count === 0).every((b) => b.value === 0),
    ).toBe(true);
    expect(avg.buckets[1]!.value).toBe(67.5);
    expect(sum.buckets.reduce((total, b) => total + Number(b.value), 0)).toBe(
      EXAMPLE_ORDERS.reduce((total, order) => total + order.total, 0),
    );
  });

  it("completes an empty population only when the range is known", () => {
    expect(previewDateMetric(definition(), []).buckets).toHaveLength(14);
    expect(
      previewDateMetric(definition({ range: "observed" }), []).buckets,
    ).toEqual([]);
    expect(
      previewDateMetric(definition({ range: "observed" }), EXAMPLE_ORDERS)
        .buckets,
    ).toHaveLength(12);
  });

  it("uses Monday weeks and calendar months while retaining partial edge buckets", () => {
    const weekly = previewDateMetric(
      definition({ interval: "week" }),
      EXAMPLE_ORDERS,
    );
    expect(weekly.buckets.map((b) => [b.keys[0], b.value])).toEqual([
      ["2026-09-28", 30],
      ["2026-10-05", 46],
      ["2026-10-12", 20],
    ]);
    expect(
      previewDateMetric(definition({ interval: "month" }), EXAMPLE_ORDERS)
        .buckets,
    ).toEqual([{ keys: ["2026-10-01"], value: 96, count: 96 }]);
    const months = previewDateMetric(
      definition({
        range: "custom",
        interval: "month",
        start: "2024-01-31",
        end: "2024-03-01",
      }),
      [],
    );
    expect(months.buckets.map((b) => b.keys[0])).toEqual([
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
    ]);
  });

  it("validates ranges, includes leap days, and bounds generated buckets", () => {
    const leap = previewDateMetric(
      definition({ range: "custom", start: "2024-02-28", end: "2024-03-01" }),
      [],
    );
    expect(leap.buckets.map((b) => b.keys[0])).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
    expect(() =>
      previewDateMetric(
        definition({ range: "custom", start: "2026-02-30" }),
        [],
      ),
    ).toThrow(/valid/);
    expect(() =>
      previewDateMetric(
        definition({ range: "custom", start: "2026-10-15" }),
        [],
      ),
    ).toThrow(/end date/);
    expect(() =>
      previewDateMetric(
        definition({ range: "custom", start: "2020-01-01" }),
        [],
      ),
    ).toThrow(/400/);
  });
});
