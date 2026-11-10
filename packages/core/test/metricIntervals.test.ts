import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyAggregations,
  compileMetric,
  metricComputationKey,
  metricPopulationError,
  evaluateMetrics,
  gammaQuantile,
  metricIntervalBounds,
  metricRatioParts,
  normalQuantile,
  toQueryRequestV3,
  validateMetric,
  type AggregationBucket,
  type AggregationClause,
  type FieldSchema,
  type QueryCapabilitiesV3,
} from "../src/index";

type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = {
  name: "turns",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "text", source: { kind: "backend" } },
    { name: "bucket", label: "Bucket", type: "text", source: { kind: "backend" } },
    { name: "turn", label: "Turn", type: "text", source: { kind: "backend" } },
    { name: "events", label: "Events", type: "number", source: { kind: "backend" } },
  ],
};
// Pharos's prompt-length evidence: turns with an "unclear instructions" event.
const groups: [string, number, number][] = [
  ["31-100", 6, 128],
  ["101-300", 8, 52],
  ["300+", 6, 15],
];
const rows: Row[] = groups.flatMap(([bucket, hits, turns]) =>
  Array.from({ length: turns }, (_, i) => ({
    id: `${bucket}-${i}`,
    bucket,
    turn: `${bucket}-t${i}`,
    events: i < hits ? 1 : 0,
  })),
);
const share: AggregationClause = {
  id: "share",
  op: "count",
  expression: "COUNT_DISTINCT(IF([events]>0,[turn],NULL))/NULLIF(COUNT_DISTINCT([turn]),0)",
  groupBy: ["bucket"],
  sort: [{ key: "group0", dir: "asc" }],
  interval: { kind: "proportion" },
};

describe("metric interval numerics", () => {
  it("matches reference quantiles", () => {
    expect(normalQuantile(0.05)).toBeCloseTo(1.959963984540054, 14);
    // Garwood bounds for 0..2 events: chi-square quantiles / 2.
    expect(gammaQuantile(0.975, 1)).toBeCloseTo(3.6888794541139363, 12);
    expect(gammaQuantile(0.025, 2)).toBeCloseTo(0.24220927854396496, 12);
    // A trillion events: Stirling's series keeps the bounds exact.
    expect(gammaQuantile(0.025, 1e12) / 999998040036.9626).toBeCloseTo(1, 12);
    expect(gammaQuantile(0.975, 1e12 + 1) / 1000001959965.9316).toBeCloseTo(1, 12);
  });
  it("computes Wilson bounds for the Pharos evidence", () => {
    const bounds = groups.map(([, hits, turns]) => metricIntervalBounds({ kind: "proportion" }, hits, turns));
    expect(bounds.map((b) => b && "lower" in b && [b.lower, b.upper])).toEqual([
      [expect.closeTo(0.021658, 5), expect.closeTo(0.098498, 5)],
      [expect.closeTo(0.080077, 5), expect.closeTo(0.275241, 5)],
      [expect.closeTo(0.198245, 5), expect.closeTo(0.642532, 5)],
    ]);
  });
  it("handles zero, full and invalid parts", () => {
    expect(metricIntervalBounds({ kind: "proportion" }, 0, 10)).toMatchObject({ lower: 0 });
    expect(metricIntervalBounds({ kind: "proportion" }, 10, 10)).toMatchObject({ upper: 1 });
    expect(metricIntervalBounds({ kind: "proportion" }, 1, 0)).toBeUndefined();
    expect(metricIntervalBounds({ kind: "proportion" }, 11, 10)).toHaveProperty("error");
    expect(metricIntervalBounds({ kind: "rate" }, -1, 10)).toHaveProperty("error");
    expect(metricIntervalBounds({ kind: "rate" }, 0, 10, 1000)).toEqual({ lower: 0, upper: expect.closeTo(368.88794541139363, 9) });
  });
});

describe("metric ratio shapes", () => {
  const parts = (expression: string) => {
    const { numerator, denominator, scale } = metricRatioParts(compileMetric(expression, schema).ast);
    return [numerator.name, denominator.name, scale];
  };
  it("accepts scaled ratios of additive aggregates", () => {
    expect(parts("SUM([events])/(COUNT_DISTINCT([turn])/1000)")).toEqual(["SUM", "COUNT_DISTINCT", 1000]);
    expect(parts("100*COUNT_DISTINCT(IF([events]>0,[turn],NULL))/NULLIF(COUNT_DISTINCT([turn]),0)")).toEqual(["COUNT_DISTINCT", "COUNT_DISTINCT", 100]);
    expect(parts("SUM([events])/NULLIF(COUNT()/1000,0)")).toEqual(["SUM", "COUNT", 1000]);
  });
  it("refuses other shapes", () => {
    for (const expression of ["SUM([events])", "AVG([events])", "SUM([events])-COUNT()", "-SUM([events])/COUNT()", "SUM([events])/COUNT()/COUNT()", "MAX([events])/COUNT()"])
      expect(() => metricRatioParts(compileMetric(expression, schema).ast), expression).toThrow(/ratio of two aggregates/);
  });
  it("validates clauses", () => {
    const issue = (c: Partial<AggregationClause>) => validateMetric({ ...share, ...c }, schema)[0]?.message;
    expect(issue({})).toBeUndefined();
    expect(issue({ expression: "AVG([events])" })).toMatch(/ratio/);
    expect(issue({ interval: { kind: "wald" as never } })).toMatch(/kind/);
    expect(issue({ interval: { kind: "rate", level: 1 } })).toMatch(/level/);
    expect(issue({ display: { kind: "scatter" }, expressionY: "COUNT()" })).toMatch(/single-value/);
    expect(issue({ expression: "COUNT()", share: "total", interval: { kind: "rate" } })).toMatch(/proportion/);
    expect(issue({ expression: "COUNT()", share: "total" })).toBeUndefined();
  });
});

describe("local engine", () => {
  it("returns Wilson bounds per group from exact parts", () => {
    const [metric] = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [share] }, schema).metrics;
    expect(metric!.buckets.map((b) => [b.keys[0], b.value, b.lower, b.upper])).toEqual([
      ["101-300", 8 / 52, expect.closeTo(0.080077, 5), expect.closeTo(0.275241, 5)],
      ["300+", 6 / 15, expect.closeTo(0.198245, 5), expect.closeTo(0.642532, 5)],
      ["31-100", 6 / 128, expect.closeTo(0.021658, 5), expect.closeTo(0.098498, 5)],
    ]);
  });
  it("pools a window's parts before its interval", () => {
    const days = ["2026-03-01", "2026-03-02", "2026-03-03"];
    const daily: Row[] = days.flatMap((day, d) =>
      Array.from({ length: 10 }, (_, i) => ({ id: `${day}-${i}`, at: `${day}T12:00:00.000Z`, events: i < d + 1 ? 1 : 0 })),
    );
    const timed: FieldSchema<Row> = {
      ...schema,
      fields: [...schema.fields, { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } }],
    };
    const clause: AggregationClause = {
      id: "w", op: "count", expression: "SUM([events])/NULLIF(COUNT()/1000,0)", groupBy: ["at"],
      dateGrouping: { field: "at", interval: "day", includeEmpty: true, range: "observed" },
      window: { periods: 2 }, interval: { kind: "rate" },
    };
    const [metric] = evaluateMetrics(daily, { ...EMPTY_QUERY, aggregations: [clause] }, timed).metrics;
    expect(metric!.error).toBeUndefined();
    const [first, second, third] = metric!.buckets;
    // The first point has no full window, so no value and no interval.
    expect(first).not.toHaveProperty("lower");
    expect(first!.value).toBeNull();
    // Days 2 and 3: (2 + 3) events over 20 rows, per 1,000.
    const pooled = metricIntervalBounds({ kind: "rate" }, 5, 20 / 1000);
    expect(third).toMatchObject({ value: 250, ...pooled });
    expect(second).toMatchObject({ value: 150, ...metricIntervalBounds({ kind: "rate" }, 3, 20 / 1000) });
    expect(validateMetric({ ...clause, window: { periods: 2, reduce: "mean" } }, timed)[0]?.message).toMatch(/mean per interval|single SUM/);
  });
  it("routes interval clauses away from the legacy engine and keys caches on them", () => {
    const { interval: _interval, ...plain } = share;
    expect(metricComputationKey([share])).not.toBe(metricComputationKey([plain]));
    const legacy: AggregationClause = { id: "legacy", op: "count", groupBy: ["bucket"], interval: { kind: "rate" } };
    expect(applyAggregations(rows, { ...EMPTY_QUERY, aggregations: [legacy] }, schema).metrics[0]!.error).toMatch(/ratio/);
    expect(metricPopulationError(share, { intervals: false })).toMatch(/metric intervals/);
    expect(metricPopulationError(share, { intervals: true })).toBeUndefined();
  });
  it("never changes a metric's values, ranking, errors or Other", () => {
    const bare = ({ lower: _l, upper: _u, intervalError: _e, ...b }: AggregationBucket) => b;
    const strip = (r: ReturnType<typeof evaluateMetrics>) =>
      r.metrics.map((m) => ({ ...m, buckets: m.buckets.map(bare), ...(m.other ? { other: bare(m.other) } : {}) }));
    const ratios = [
      // With groupLimit 2 of 3 groups, so Other must not appear with an interval.
      "SUM([events])/COUNT()",
      "100*SUM([events])/NULLIF(COUNT(),0)",
      // Fractional numerators: no bounds, but the same values.
      "SUM([events]*1.5)/COUNT()",
    ];
    for (const expression of ratios) {
      const plain: AggregationClause = { id: "m", op: "count", expression, groupBy: ["bucket"], groupLimit: 2 };
      for (const kind of ["proportion", "rate"] as const) {
        const query = (c: AggregationClause) => ({ ...EMPTY_QUERY, aggregations: [c] });
        const without = evaluateMetrics(rows, query(plain), schema),
          withInterval = evaluateMetrics(rows, query({ ...plain, interval: { kind } }), schema);
        expect(strip(withInterval), `${expression} ${kind}`).toEqual(strip(without));
      }
    }
  });
  it("refuses a server without the capability", () => {
    const capabilities: QueryCapabilitiesV3 = { version: 3, groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false, maxRows: 100, maxGroups: 100, maxPopulation: 1000, profile: "p" };
    const query = { ...EMPTY_QUERY, aggregations: [share] };
    expect(() => toQueryRequestV3(query, schema, capabilities)).toThrow(/metric intervals/);
    expect(toQueryRequestV3(query, schema, { ...capabilities, metricIntervals: true }).metrics[0]!.interval).toEqual({ kind: "proportion" });
  });
});

// ---- schema/fixtures/metric-intervals.json: the cross-engine contract -------

interface FixtureCase {
  name: string;
  planned?: boolean;
  metric: AggregationClause;
  expected: { error?: true; groupCount?: number; hiddenGroups?: number; buckets?: Record<string, unknown>[]; other?: Record<string, unknown> };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/metric-intervals.json", import.meta.url), "utf8"),
) as { now: string; tolerance: number; schema: FieldSchema<Row>; rows: Row[]; cases: FixtureCase[] };

/** Fixture fields only; numbers within the fixture's relative tolerance. */
export function intervalBucket(bucket: AggregationBucket, tolerance: number) {
  const near = (value: unknown) =>
    typeof value === "number" ? expect.closeTo(value, -Math.log10(Math.max(Math.abs(value), 1) * tolerance)) : value;
  return {
    keys: bucket.keys,
    count: Number(bucket.count),
    ...(bucket.error ? { error: true } : { value: near(bucket.value) }),
    ...(bucket.lower !== undefined ? { lower: near(bucket.lower) } : {}),
    ...(bucket.upper !== undefined ? { upper: near(bucket.upper) } : {}),
    ...(bucket.intervalError ? { intervalError: true } : {}),
  };
}
const asExpected = (bucket: Record<string, unknown>) => ("error" in bucket ? { ...bucket, error: true } : bucket);

describe("shared metric interval fixture (local engine)", () => {
  for (const c of fixture.cases)
    it(c.name, () => {
      const [entry] = evaluateMetrics(fixture.rows, { ...EMPTY_QUERY, aggregations: [c.metric] }, fixture.schema, { now: Date.parse(fixture.now) }).metrics;
      if (c.expected.error) return expect(entry!.errorCode, entry!.error).toBe("metric_interval");
      expect(entry!.error).toBeUndefined();
      expect(entry!.groupCount).toBe(c.expected.groupCount);
      expect(entry!.hiddenGroups).toBe(c.expected.hiddenGroups);
      expect(c.expected.buckets!.map(asExpected)).toEqual(entry!.buckets.map((b) => intervalBucket(b, fixture.tolerance)));
      if (c.expected.other) expect(asExpected(c.expected.other)).toEqual(intervalBucket(entry!.other!, fixture.tolerance));
      else expect(entry!.other).toBeUndefined();
    });
});
