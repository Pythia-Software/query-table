import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyAggregations,
  decodeQuery,
  encodeQuery,
  evaluateMetrics,
  inspectBucketQuery,
  metricComputationKey,
  planMetricSeries,
  toMetricQuery,
  toQueryRequestV3,
  validateMetric,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type QueryState,
} from "../src/index";

const schema: FieldSchema = {
  name: "usage",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "model", label: "Model", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "user", label: "User", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "read", label: "Cache reads", type: "number", source: { kind: "backend" } },
    { name: "input", label: "Input", type: "number", source: { kind: "backend" } },
  ],
};
type Row = { id: number; at: string; model: string; user: string; read: number | null; input: number };
// Day 1 is busy with a low cache share; day 2 is quiet with a high one, so
// an average of daily ratios differs from the pooled ratio.
const rows: Row[] = [
  { id: 1, at: "2026-10-01T09:00:00Z", model: "a", user: "u1", read: 10, input: 100 },
  { id: 2, at: "2026-10-01T15:00:00Z", model: "b", user: "u2", read: 0, input: 100 },
  { id: 3, at: "2026-10-02T09:00:00Z", model: "a", user: "u1", read: 9, input: 10 },
  { id: 4, at: "2026-10-04T09:00:00Z", model: "a", user: "u3", read: 5, input: 50 },
  { id: 5, at: "2026-10-04T10:00:00Z", model: "c", user: "u1", read: null, input: 20 },
];
const day = (date: string) => `2026-10-${date}T00:00:00.000Z`;
const daily: AggregationClause = {
  id: "trend",
  op: "count",
  expression: "SUM([input])",
  groupBy: ["at"],
  dateGrouping: { field: "at", interval: "day", includeEmpty: true, range: "query" },
};
const october: QueryState["where"] = [
  { field: "at", op: ">=", value: "2026-10-01T00:00:00Z" },
  { field: "at", op: "<", value: "2026-10-05T00:00:00Z" },
];
const query = (...aggregations: AggregationClause[]): QueryState => ({ ...EMPTY_QUERY, where: october, aggregations });
const now = Date.parse("2026-10-10T12:00:00Z");
const run = (clause: AggregationClause, data: Row[] = rows, q = query(clause)): AggregationResultEntry => {
  const entry = evaluateMetrics(data, q, schema, { now }).metrics[0]!;
  expect(entry.id).toBe(clause.id);
  return entry;
};
const values = (entry: AggregationResultEntry) => entry.buckets.map((b) => [b.keys[0], b.value]);

describe("metric windows", () => {
  it("totals trailing intervals, leaving points whose window starts early without a value", () => {
    const entry = run({ ...daily, window: { periods: 2 } });
    expect(entry.error).toBeUndefined();
    expect(values(entry)).toEqual([[day("01"), null], [day("02"), 210], [day("03"), 10], [day("04"), 70]]);
    expect(entry.buckets.map((b) => [b.count, b.intervals])).toEqual([[2, 1], [3, 2], [1, 2], [2, 2]]);
    expect(entry.other).toBeUndefined();
    const partial = run({ ...daily, window: { periods: 2, partial: "include" } });
    expect(partial.buckets[0]!.value).toBe(200);
  });

  it("pools ratio parts over the window instead of averaging interval ratios", () => {
    const share = run({ ...daily, expression: "SUM([read]) / NULLIF(SUM([input]), 0)", window: { periods: 2 } });
    // Days 1–2: (10 + 0 + 9) / (100 + 100 + 10), not (0.05 + 0.9) / 2.
    expect(share.buckets[1]!.value).toBeCloseTo(19 / 210, 12);
    expect(share.buckets[2]!.value).toBeCloseTo(9 / 10, 12);
    const running = run({ ...daily, expression: "SUM([read]) / NULLIF(SUM([input]), 0)", window: { periods: "all" } });
    expect(running.buckets.map((b) => b.value)).toEqual([10 / 200, 19 / 210, 19 / 210, 24 / 280]);
    // AVG pools as SUM / COUNT of its input; the null read is not a sample.
    const mean = run({ ...daily, expression: "AVG([read])", window: { periods: 2 } });
    expect(mean.buckets[3]!.value).toBe(5);
    expect(mean.buckets[1]!.value).toBeCloseTo(19 / 3, 12);
    const extremes = run({ ...daily, expression: "MAX([read]) - MIN([read])", window: { periods: 3 } });
    expect(extremes.buckets.map((b) => b.value)).toEqual([null, null, 10, 4]);
  });

  it("runs totals from the first interval of the range", () => {
    const entry = run({ ...daily, window: { periods: "all" } });
    expect(entry.buckets.map((b) => [b.value, b.count, b.intervals])).toEqual([[200, 2, 1], [210, 3, 2], [210, 3, 3], [280, 5, 4]]);
  });

  it("averages per-interval values, including distinct counts per interval", () => {
    const sums = run({ ...daily, window: { periods: 2, reduce: "mean" } });
    expect(sums.buckets.map((b) => b.value)).toEqual([null, 105, 5, 35]);
    // u1 on days 1, 2 and 4; a user present on two days counts on each.
    const users = run({ ...daily, expression: "COUNT_DISTINCT([user])", window: { periods: 2, reduce: "mean" } });
    expect(users.buckets.map((b) => b.value)).toEqual([null, 1.5, 0.5, 1]);
    const partial = run({ ...daily, expression: "COUNT_DISTINCT([user])", window: { periods: 3, reduce: "mean", partial: "include" } });
    expect(partial.buckets.map((b) => b.value)).toEqual([2, 1.5, 1, 1]);
  });

  it("windows each series separately and applies minCount to the window's rows", () => {
    const series = (entry: AggregationResultEntry, model: string) =>
      entry.buckets.filter((b) => b.keys[1] === model).map((b) => [b.keys[0], b.value, b.count]);
    const all = run({ ...daily, groupBy: ["at", "model"], window: { periods: 2 } });
    expect(series(all, "a")).toEqual([[day("01"), null, 1], [day("02"), 110, 2], [day("03"), 10, 1], [day("04"), 50, 1]]);
    expect(series(all, "c")).toEqual([[day("01"), null, 0], [day("02"), 0, 0], [day("03"), 0, 0], [day("04"), 20, 1]]);
    // Windows with rows but fewer than two are hidden; empty windows stay.
    const sampled = run({ ...daily, groupBy: ["at", "model"], window: { periods: 2 }, minCount: 2 });
    expect(series(sampled, "a")).toEqual([[day("02"), 110, 2]]);
    expect(series(sampled, "c")).toEqual([[day("01"), null, 0], [day("02"), 0, 0], [day("03"), 0, 0]]);
    expect(sampled.hiddenGroups).toBe(all.buckets.filter((b) => b.count === 1).length);
  });

  it("refuses windows it cannot compute exactly", () => {
    const message = (clause: AggregationClause) => validateMetric(clause, schema)[0]?.message;
    expect(message({ ...daily, expression: "COUNT_DISTINCT([user])", window: { periods: 7 } })).toMatch(/COUNT_DISTINCT.*mean per interval/);
    expect(message({ ...daily, expression: "MEDIAN([input])", window: { periods: 7 } })).toMatch(/MEDIAN/);
    expect(message({ ...daily, expression: "SUM([read]) / SUM([input])", window: { periods: 7, reduce: "mean" } })).toMatch(/pools/);
    expect(message({ ...daily, window: { periods: 1 } })).toMatch(/2–1,000/);
    expect(message({ ...daily, dateGrouping: { ...daily.dateGrouping!, includeEmpty: false }, window: { periods: 7 } })).toMatch(/empty dates/);
    const { dateGrouping: _date, ...undated } = daily;
    expect(message({ ...undated, groupBy: ["model"], window: { periods: 7 } })).toMatch(/calendar interval/);
    const refused = run({ ...daily, expression: "COUNT_DISTINCT([user])", window: { periods: 7 } });
    expect(refused.error).toMatch(/COUNT_DISTINCT/);
    expect(refused.buckets).toEqual([]);
  });
});

describe("metric shares", () => {
  it("divides by each interval's total over every series, including those past the group limit", () => {
    const entry = run({ ...daily, groupBy: ["at", "model"], share: "group0", groupLimit: 3, sort: [{ key: "group0", dir: "asc" }, { key: "value", dir: "desc" }] });
    expect(entry.buckets.map((b) => [b.keys[0], b.keys[1], b.value])).toEqual([
      [day("01"), "a", 0.5], [day("01"), "b", 0.5], [day("01"), "c", 0],
    ]);
    expect(entry.groupCount).toBe(12);
    const day4 = run({ ...daily, groupBy: ["at", "model"], share: "group0" }).buckets.filter((b) => b.keys[0] === day("04"));
    expect(day4.map((b) => [b.keys[1], b.value])).toEqual([["a", 50 / 70], ["b", 0], ["c", 20 / 70]]);
    // An interval with no usage has no shares.
    const day3 = run({ ...daily, groupBy: ["at", "model"], share: "group0" }).buckets.filter((b) => b.keys[0] === day("03"));
    expect(day3.every((b) => b.value === null)).toBe(true);
  });

  it("smooths the amounts before dividing them", () => {
    const entry = run({ ...daily, groupBy: ["at", "model"], share: "group0", window: { periods: 2 } });
    const a = entry.buckets.filter((b) => b.keys[1] === "a").map((b) => b.value);
    expect(a).toEqual([null, 110 / 210, 10 / 10, 50 / 70]);
  });

  it("divides by the grand total without calendar grouping, keeping legacy operations", () => {
    const clause: AggregationClause = { id: "models", op: "sum", field: "input", groupBy: ["model"], share: "total" };
    const plan = planMetricSeries(query(clause), schema, { now })!;
    expect(plan.queries[0]!.aggregations!.map(({ op, field, groupBy, expression }) => ({ op, field, groupBy, expression }))).toEqual([
      { op: "sum", field: "input", groupBy: ["model"], expression: undefined },
      { op: "sum", field: "input", groupBy: [], expression: undefined },
    ]);
    const entry = run(clause);
    expect(entry.buckets.map((b) => [b.keys[0], b.value])).toEqual([["a", 160 / 280], ["b", 100 / 280], ["c", 20 / 280]]);
  });

  it("divides legacy clauses through applyAggregations as well", () => {
    // A share is the clause's only advanced option, so the legacy path must not take it.
    const clause: AggregationClause = { id: "models", op: "sum", field: "input", groupBy: ["model"], share: "total" };
    const plain: AggregationClause = { id: "plain", op: "sum", field: "input", groupBy: ["model"] };
    const applied = applyAggregations(rows, query(clause, plain), schema, { now }).metrics;
    expect(applied[0]).toEqual(evaluateMetrics(rows, query(clause), schema, { now }).metrics[0]);
    expect(applied[0]!.buckets.map((b) => b.value)).toEqual([160 / 280, 100 / 280, 20 / 280]);
    expect(applied[1]!.buckets.map((b) => b.value)).toEqual([160, 100, 20]);
  });

  it("refuses shares of quantities that do not add up", () => {
    const message = (clause: AggregationClause) => validateMetric(clause, schema)[0]?.message;
    for (const expression of ["COUNT_DISTINCT([user])", "AVG([input])", "SUM([read]) / SUM([input])"])
      expect(message({ ...daily, groupBy: ["at", "model"], expression, share: "group0" })).toMatch(/additive/);
    expect(message({ ...daily, share: "group0" })).toMatch(/second grouping/);
    expect(message({ ...daily, groupBy: ["at", "model"], share: "total", window: { periods: 2 } })).toMatch(/own total/);
  });
});

describe("whole intervals", () => {
  const hourly: AggregationClause = { ...daily, dateGrouping: { ...daily.dateGrouping!, partialIntervals: "exclude" } };
  it("leaves out intervals the query bounds cut and the interval still in progress", () => {
    const cut = query(hourly);
    cut.where = [
      { field: "at", op: ">=", value: "2026-10-01T12:00:00Z" },
      { field: "at", op: "<", value: "2026-10-05T00:00:00Z" },
    ];
    const entry = run(hourly, rows, cut);
    // October 1 starts at noon; October 4 is still in progress at `now`.
    const early = evaluateMetrics(rows, cut, schema, { now: Date.parse("2026-10-04T12:00:00Z") }).metrics[0]!;
    expect(values(entry)).toEqual([[day("02"), 10], [day("03"), 0], [day("04"), 70]]);
    expect(values(early)).toEqual([[day("02"), 10], [day("03"), 0]]);
    expect(run(daily, rows, { ...cut, aggregations: [daily] }).buckets[0]!.value).toBe(100);
  });

  it("returns no buckets when no interval is whole, and windows only whole intervals", () => {
    const narrow = query(hourly);
    narrow.where = [
      { field: "at", op: ">=", value: "2026-10-01T06:00:00Z" },
      { field: "at", op: "<", value: "2026-10-01T18:00:00Z" },
    ];
    expect(run(hourly, rows, narrow)).toMatchObject({ buckets: [], groupCount: 0, coverage: "exact" });
    const cut = query({ ...hourly, window: { periods: "all" } });
    cut.where = [{ field: "at", op: ">=", value: "2026-10-01T12:00:00Z" }, october[1]!];
    expect(values(run({ ...hourly, window: { periods: "all" } }, rows, cut))).toEqual([[day("02"), 10], [day("03"), 10], [day("04"), 80]]);
  });

  it("keeps the remaining definition for the engine and strips the option from the wire", () => {
    const plan = planMetricSeries(query(hourly), schema, { now })!;
    const part = plan.queries[0]!.aggregations![0]!;
    expect(part.dateGrouping).toEqual({ field: "at", interval: "day", includeEmpty: true, range: "custom", start: day("01"), end: "2026-10-04T23:59:59.999Z" });
    expect(part.where).toEqual([
      { field: "at", op: ">=", value: day("01") },
      { field: "at", op: "<", value: "2026-10-05T00:00:00.000Z" },
    ]);
  });
});

describe("planning and the wire", () => {
  it("packs each clause's parts into one query within the metric budget", () => {
    const clauses = Array.from({ length: 15 }, (_, i): AggregationClause => ({
      ...daily, id: `ratio-${i}`, expression: "SUM([read]) / NULLIF(SUM([input]), 0)", window: { periods: 2 },
    }));
    const plan = planMetricSeries({ ...EMPTY_QUERY, where: october, aggregations: clauses }, schema, { now })!;
    expect(plan.queries.map((q) => q.aggregations!.length)).toEqual([20, 10]);
    const ids = plan.queries.flatMap((q) => q.aggregations!.map((c) => c.id));
    expect(new Set(ids).size).toBe(30);
    const combined = plan.combine(plan.queries.flatMap((q) => evaluateMetrics(rows, q, schema, { now }).metrics));
    expect(combined.map((m) => m.id)).toEqual(clauses.map((c) => c.id));
    expect(combined.every((m) => m.buckets[1]!.value === 19 / 210)).toBe(true);
  });

  it("does not plan queries without series options and reuses identical parts", () => {
    expect(planMetricSeries(query(daily), schema)).toBeUndefined();
    const plan = planMetricSeries(query({ ...daily, expression: "SUM([read]) / SUM([input]) + AVG([input])", window: { periods: 2 } }), schema, { now })!;
    expect(plan.queries[0]!.aggregations!.map((c) => c.expression)).toEqual(["SUM([read])", "SUM([input])", "COUNT([input])"]);
  });

  it("never sends an unexpanded series clause to a server", () => {
    const windowed = query({ ...daily, window: { periods: 7 } });
    const request = toMetricQuery(windowed, schema);
    expect(request.diagnostics.map((d) => d.code)).toContain("unexpanded_series");
    expect(request.metrics[0]).not.toHaveProperty("window");
    const v3 = toQueryRequestV3(windowed, schema, { version: 3, profile: "test", calendarGrouping: true } as never);
    expect(v3.diagnostics.join(" ")).toMatch(/planMetricSeries/);
    const plan = planMetricSeries(windowed, schema, { now })!;
    expect(toMetricQuery(plan.queries[0]!, schema).diagnostics.map((d) => d.code)).not.toContain("unexpanded_series");
  });

  it("round-trips through links and the computation key", () => {
    const clause: AggregationClause = {
      ...daily, groupBy: ["at", "model"], share: "group0", window: { periods: 7, reduce: "mean", partial: "include" },
      dateGrouping: { ...daily.dateGrouping!, partialIntervals: "exclude" },
    };
    const decoded = decodeQuery(encodeQuery(query(clause)))!.aggregations![0]!;
    expect(decoded).toMatchObject({ share: "group0", window: clause.window, dateGrouping: clause.dateGrouping });
    expect(decoded.diagnostics).toBeUndefined();
    expect(metricComputationKey([clause])).not.toBe(metricComputationKey([{ ...clause, window: { periods: 7 } }]));
    const invalid = decodeQuery(encodeQuery(query({ ...clause, window: { periods: -1 } as never })))!.aggregations![0]!;
    expect(invalid.diagnostics).toContain("Invalid metric window.");
  });
});

describe("unfinished date filters", () => {
  const whole: AggregationClause = { ...daily, dateGrouping: { ...daily.dateGrouping!, partialIntervals: "exclude" } };
  const plain: AggregationClause = { id: "total", op: "count", groupBy: [] };
  // A filter being typed: no value yet, so it neither filters nor bounds.
  const typing = (...aggregations: AggregationClause[]): QueryState => ({
    ...EMPTY_QUERY,
    where: [...october, { field: "at", op: ">=", value: "" }],
    aggregations,
  });

  it("treats an empty value as no bound instead of failing every metric", () => {
    const metrics = evaluateMetrics(rows, typing(plain, whole), schema, { now }).metrics;
    expect(metrics[0]).toMatchObject({ id: "total", buckets: [{ value: 5 }] });
    expect(metrics[1]!.error).toBeUndefined();
    expect(values(metrics[1]!)).toEqual(values(run(whole)));
    const entry = metrics[1]!;
    const drilled = inspectBucketQuery(typing(whole), entry.buckets[1]!, whole, schema)!;
    expect(drilled.where.slice(3)).toEqual([
      { field: "at", op: ">=", value: day("02") },
      { field: "at", op: "<", value: day("03") },
    ]);
  });

  it("leaves a malformed value to the filter that runs it", () => {
    const malformed: QueryState = { ...typing(plain, whole), where: [...october, { field: "at", op: "<", value: "2026-1" }] };
    expect(() => planMetricSeries(malformed, schema, { now })).not.toThrow();
    expect(planMetricSeries(malformed, schema, { now })!.combine([]).map((m) => m.id)).toEqual(["total", "trend"]);
  });
});

describe("drilldown", () => {
  it("opens the rows of a point's whole window", () => {
    const clause: AggregationClause = { ...daily, window: { periods: 3 } };
    const entry = run(clause);
    const drilled = inspectBucketQuery(query(clause), entry.buckets[3]!, clause, schema)!;
    expect(drilled.where.slice(2)).toEqual([
      { field: "at", op: ">=", value: day("02") },
      { field: "at", op: "<", value: day("05") },
    ]);
    const running = { ...clause, window: { periods: "all" as const } };
    expect(inspectBucketQuery(query(running), entry.buckets[3]!, running, schema)!.where.slice(2)).toEqual([
      { field: "at", op: "<", value: day("05") },
    ]);
  });
});
