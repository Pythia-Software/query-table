import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyAggregations,
  applyQuery,
  decodeQuery,
  encodeQuery,
  evaluateMetrics,
  inspectBucketQuery,
  metricCycleSlot,
  normalizeQueryState,
  planMetricSeries,
  toQueryRequestV3,
  validateMetric,
  type AggregationClause,
  type FieldSchema,
  type MetricDateGrouping,
  type QueryCapabilitiesV3,
  type QueryState,
} from "../src/index";

type Row = { id: number; at: string | null; kind: string | null; ms: number | null };
const schema: FieldSchema<Row> = {
  name: "cycles",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "kind", label: "Kind", type: "text", source: { kind: "backend" } },
    { name: "ms", label: "Duration", type: "number", source: { kind: "backend" } },
  ],
};
const rows = (times: (string | null)[], kinds: (string | null)[] = []): Row[] =>
  times.map((at, i) => ({ id: i, at, kind: kinds[i] ?? "a", ms: i + 1 }));
const clause = (
  grouping: Partial<MetricDateGrouping>,
  extra: Partial<AggregationClause> = {},
): AggregationClause => ({
  id: "m",
  op: "count",
  groupBy: ["at"],
  dateGrouping: { field: "at", interval: "hourOfDay", timeZone: "UTC", includeEmpty: false, range: "query", ...grouping },
  ...extra,
});
const run = (data: Row[], c: AggregationClause, query: Partial<QueryState> = {}, now = Date.parse("2026-04-01T00:00:00Z")) =>
  evaluateMetrics(data, { ...EMPTY_QUERY, ...query, aggregations: [c] }, schema, { now }).metrics[0]!;
const pairs = (result: ReturnType<typeof run>) => result.buckets.map((b) => [...b.keys, b.count, b.value]);

describe("cyclic date intervals", () => {
  it("assigns local hours and ISO weekdays", () => {
    expect(metricCycleSlot(Date.parse("2026-03-01T23:30:00Z"), "hourOfDay")).toBe(23);
    expect(metricCycleSlot(Date.parse("2026-03-01T23:30:00Z"), "dayOfWeek")).toBe(7);
    expect(metricCycleSlot(Date.parse("2026-03-01T23:30:00Z"), "dayOfWeek", "Asia/Kolkata")).toBe(1);
    expect(metricCycleSlot(Date.parse("2026-03-02T03:15:00Z"), "hourOfDay", "Asia/Kolkata")).toBe(8);
    expect(metricCycleSlot(Date.parse("2026-03-02T03:45:00Z"), "hourOfDay", "Asia/Kolkata")).toBe(9);
  });

  it("returns 24 hour slots across New York daylight-saving changes", () => {
    const data = rows([
      "2026-03-08T06:15:00.000Z", // 01:15 EST
      "2026-03-08T07:15:00.000Z", // 03:15 EDT: 02:00 does not exist
      "2026-11-01T05:15:00.000Z", // 01:15 EDT
      "2026-11-01T06:15:00.000Z", // 01:15 EST, the repeated hour
      null,
    ]);
    const result = run(data, clause({ timeZone: "America/New_York", includeEmpty: true }));
    expect(result.buckets.map((b) => b.keys[0])).toEqual([...Array.from({ length: 24 }, (_, i) => i), null]);
    expect(result.buckets[1]).toMatchObject({ count: 3, value: 3 });
    expect(result.buckets[2]).toMatchObject({ count: 0, value: 0 });
    expect(result.buckets[3]).toMatchObject({ count: 1, value: 1 });
    expect(result.buckets[24]).toMatchObject({ keys: [null], count: 1 });
    expect(result.groupCount).toBe(25);
  });

  it("buckets a fractional-offset zone by local hour", () => {
    const data = rows(["2026-03-02T03:15:00.000Z", "2026-03-02T03:45:00.000Z", "2026-03-02T04:29:00.000Z"]);
    expect(pairs(run(data, clause({ timeZone: "Asia/Kolkata" })))).toEqual([
      [8, 1, 1],
      [9, 2, 2],
    ]);
  });

  it("groups weekdays with other keys and fills every slot per series", () => {
    const data = rows(
      ["2026-03-02T10:00:00.000Z", "2026-03-08T10:00:00.000Z", "2026-03-09T10:00:00.000Z"],
      ["a", "b", "a"],
    );
    const result = run(data, clause({ interval: "dayOfWeek", includeEmpty: true }, { groupBy: ["at", "kind"], op: "sum", field: "ms" }));
    expect(result.buckets).toHaveLength(14);
    expect(result.buckets.filter((b) => b.count)).toEqual([
      { keys: [1, "a"], count: 2, value: 4 },
      { keys: [7, "b"], count: 1, value: 2 },
    ]);
    expect(result.buckets.find((b) => b.keys[0] === 3 && b.keys[1] === "b")).toEqual({ keys: [3, "b"], count: 0, value: 0 });
  });

  it("lists every slot without data or a range", () => {
    const result = run([], clause({ interval: "dayOfWeek", includeEmpty: true }, { op: "avg", field: "ms" }));
    expect(pairs(result)).toEqual([1, 2, 3, 4, 5, 6, 7].map((day) => [day, 0, null]));
  });

  it("applies minCount like other groupings: fill-ins stay, small slots are hidden", () => {
    const data = rows(["2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z", "2026-03-02T10:00:00.000Z"]);
    const result = run(data, clause({ includeEmpty: true }, { minCount: 2 }));
    expect(result.hiddenGroups).toBe(1);
    expect(result.buckets).toHaveLength(23);
    expect(result.buckets.find((b) => b.keys[0] === 10)).toBeUndefined();
    expect(result.buckets.find((b) => b.keys[0] === 9)).toMatchObject({ count: 2 });
  });

  it("matches the legacy aggregation path and the shared sort order", () => {
    const data = rows(["2026-03-02T09:00:00.000Z", "2026-03-02T02:00:00.000Z", "2026-03-03T09:00:00.000Z"]);
    const c = clause({}, { sort: [{ key: "value", dir: "desc" }] });
    const result = applyAggregations(data, { ...EMPTY_QUERY, aggregations: [c] }, schema).metrics[0]!;
    expect(pairs(result)).toEqual([
      [9, 2, 2],
      [2, 1, 1],
    ]);
  });

  it("narrows whole intervals to whole hours", () => {
    const data = rows(["2026-03-02T09:10:00.000Z", "2026-03-02T10:10:00.000Z", "2026-03-02T11:50:00.000Z"]);
    const query = { where: [{ field: "at", op: ">=" as const, value: "2026-03-02T09:05:00.000Z" }] };
    const now = Date.parse("2026-03-02T11:55:00.000Z");
    expect(pairs(run(data, clause({ partialIntervals: "exclude" }), query, now))).toEqual([[10, 1, 1]]);
  });

  it("validates cyclic options", () => {
    const message = (c: AggregationClause) => validateMetric(c, schema)[0]?.message;
    expect(message(clause({ interval: "day", occurrence: { interval: "day", includeEmpty: true } }))).toMatch(/hour-of-day or day-of-week/);
    expect(message(clause({ occurrence: { interval: "day", includeEmpty: true } }))).toMatch(/hourly occurrences/);
    expect(message(clause({ interval: "dayOfWeek", partialIntervals: "include", occurrence: { interval: "day", includeEmpty: true } }))).toMatch(/always whole/);
    expect(message(clause({ interval: "dayOfWeek", occurrence: { interval: "day", includeEmpty: true } }, { distribution: { kind: "histogram", input: "" } }))).toMatch(/not a histogram/);
    expect(message(clause({ includeEmpty: true }, { window: { periods: 3 } }))).toMatch(/calendar interval/);
    expect(message(clause({ interval: "dayOfWeek", occurrence: { interval: "hour", includeEmpty: false } }, { distribution: { kind: "box", input: "" } }))).toBeUndefined();
    expect(message(clause({ interval: "dayOfWeek" }, { distribution: { kind: "box", input: "ms" } }))).toMatch(/not distributions/);
  });

  it("round-trips through links and normalization", () => {
    const c = clause({ interval: "dayOfWeek", timeZone: "Asia/Kolkata", occurrence: { interval: "day", includeEmpty: true } }, { distribution: { kind: "box", input: "" } });
    const query = { ...EMPTY_QUERY, aggregations: [c] };
    expect(decodeQuery(encodeQuery(query)).aggregations?.[0]?.dateGrouping).toEqual(c.dateGrouping);
    const broken = normalizeQueryState({
      ...EMPTY_QUERY,
      aggregations: [{ ...c, dateGrouping: { ...c.dateGrouping!, occurrence: { interval: "week" } as never } }],
    }).aggregations![0]!;
    expect(broken.diagnostics).toContain("Invalid metric date grouping occurrence.");
  });

  it("needs a server that executes cyclic intervals", () => {
    const capabilities = { version: 3, profile: "p", groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false, maxRows: 10, maxGroups: 10, maxPopulation: 10 } satisfies QueryCapabilitiesV3;
    const query = { ...EMPTY_QUERY, aggregations: [clause({})] };
    expect(toQueryRequestV3(query, schema, capabilities).diagnostics).toContain("This server does not support hour-of-day or day-of-week grouping.");
    expect(toQueryRequestV3(query, schema, { ...capabilities, calendarCycles: true }).diagnostics).toEqual([]);
  });
});

describe("per-occurrence statistics", () => {
  // Tuesday 2026-03-03 14:00 to Tuesday 2026-03-31 14:00, a "last 28 days"
  // opened at 14:00: Mar 3 and Mar 31 are partial and do not count.
  const now = Date.parse("2026-03-31T14:00:00.000Z");
  const where = [{ field: "at", op: ">=" as const, value: "-28d" }];
  const data = rows([
    "2026-03-03T15:00:00.000Z", // partial first Tuesday
    "2026-03-10T08:00:00.000Z",
    "2026-03-10T09:00:00.000Z",
    "2026-03-17T08:00:00.000Z",
    "2026-03-31T10:00:00.000Z", // partial last Tuesday
    "2026-03-09T10:00:00.000Z", // Monday
  ]);
  const weekday = (extra: Partial<AggregationClause> = {}, occurrence = { interval: "day" as const, includeEmpty: true }) =>
    clause({ interval: "dayOfWeek", includeEmpty: true, occurrence }, extra);

  it("summarises each whole date's total, counting idle dates as zero", () => {
    const result = run(data, weekday({ distribution: { kind: "box", input: "" } }), { where }, now);
    expect(result.buckets.map((b) => b.keys[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const tuesday = result.buckets[1]!;
    // Mar 10, 17 and 24: totals 2, 1 and 0.
    expect(tuesday).toMatchObject({ count: 3, value: 1, occurrences: 3 });
    expect(tuesday.distribution).toMatchObject({ kind: "box", summary: { n: 3, min: 0, median: 1, max: 2, mean: 1 } });
    // Mondays Mar 9, 16, 23 and 30; Wednesdays Mar 4, 11, 18 and 25.
    expect(result.buckets[0]).toMatchObject({ count: 1, value: 0, occurrences: 4 });
    expect(result.buckets[2]).toMatchObject({ count: 0, value: 0, occurrences: 4 });
    expect(result.groupCount).toBe(7);
  });

  it("uses the mean over occurrences as the plain value", () => {
    const result = run(data, weekday(), { where }, now);
    expect(result.buckets[1]).toMatchObject({ value: 1, count: 3, occurrences: 3 });
    expect(result.buckets[0]).toMatchObject({ value: 0.25, occurrences: 4 });
  });

  it("gives idle occurrences no value for ratios", () => {
    const result = run(data, weekday({ expression: "AVG([ms])" }), { where }, now);
    // Tuesday averages: Mar 10 (2+3)/2 = 2.5, Mar 17 4; Mar 24 has no value.
    expect(result.buckets[1]).toMatchObject({ value: 3.25, occurrences: 2 });
  });

  it("leaves idle occurrences out without includeEmpty", () => {
    const result = run(data, weekday({}, { interval: "day", includeEmpty: false }), { where }, now);
    expect(result.buckets[1]).toMatchObject({ value: 1.5, occurrences: 2 });
    expect(result.buckets[2]).toMatchObject({ value: null, count: 0, occurrences: 0 });
  });

  it("supports hourly occurrences, other keys, minCount and limits", () => {
    const result = run(
      data,
      clause({ interval: "hourOfDay", occurrence: { interval: "hour", includeEmpty: true } }, { groupBy: ["at", "kind"], minCount: 2, groupLimit: 1, sort: [{ key: "count", dir: "desc" }] }),
      { where },
      now,
    );
    // Hours are whole from Mar 3 14:00: 08:00 occurs 28 times, with two rows.
    // 09:00 and 15:00 (one row each) are hidden; 10:00 ties 08:00 on count.
    expect(result.buckets).toEqual([{ keys: [8, "a"], count: 2, value: 2 / 28, occurrences: 28 }]);
    expect(result.hiddenGroups).toBe(2);
    expect(result.groupCount).toBe(22);
  });

  it("plans one calendar metric per occurrence clause", () => {
    const plan = planMetricSeries({ ...EMPTY_QUERY, where, aggregations: [weekday()] }, schema, { now })!;
    expect(plan.queries).toHaveLength(1);
    expect(plan.queries[0]!.aggregations![0]).toMatchObject({
      op: "count",
      groupBy: ["at"],
      where: [
        { field: "at", op: ">=", value: "2026-03-04T00:00:00.000Z" },
        { field: "at", op: "<", value: "2026-03-31T00:00:00.000Z" },
      ],
      dateGrouping: { interval: "day", includeEmpty: true, range: "custom", start: "2026-03-04T00:00:00.000Z", end: "2026-03-30T23:59:59.999Z" },
    });
  });

  it("lists every slot without a whole occurrence", () => {
    const result = run(data, weekday(), { where: [{ field: "at", op: ">=", value: "2026-03-31T01:00:00.000Z" }] }, now);
    expect(result.buckets.map((b) => [b.keys[0], b.value, b.occurrences])).toEqual([1, 2, 3, 4, 5, 6, 7].map((day) => [day, null, 0]));
  });
});

describe("cyclic drill-down", () => {
  const data = rows([
    "2026-03-02T09:10:00.000Z",
    "2026-03-03T09:50:00.000Z",
    "2026-03-03T10:00:00.000Z",
    "2026-03-04T08:59:59.000Z",
    "2026-03-05T09:00:00.000Z",
    null,
  ]);
  const base: QueryState = {
    ...EMPTY_QUERY,
    where: [
      { field: "at", op: ">=", value: "2026-03-02T00:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-06T00:00:00.000Z" },
    ],
  };
  const records = (query: QueryState | null) =>
    applyQuery(data, query!, schema, { now: Date.parse("2026-04-01T00:00:00Z") }).rows.map((row) => row.id);

  it("selects exactly one slot's records inside the query bounds", () => {
    const c = clause({});
    const query = inspectBucketQuery(base, { keys: [9], count: 3, value: 3 }, c, schema);
    expect(query?.where.slice(2)).toEqual([
      { field: "at", op: ">=", value: "2026-03-02T09:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-05T10:00:00.000Z" },
      { any: [{ field: "at", op: "<", value: "2026-03-02T10:00:00.000Z" }, { field: "at", op: ">=", value: "2026-03-03T09:00:00.000Z" }] },
      { any: [{ field: "at", op: "<", value: "2026-03-03T10:00:00.000Z" }, { field: "at", op: ">=", value: "2026-03-04T09:00:00.000Z" }] },
      { any: [{ field: "at", op: "<", value: "2026-03-04T10:00:00.000Z" }, { field: "at", op: ">=", value: "2026-03-05T09:00:00.000Z" }] },
    ]);
    expect(records(query)).toEqual([0, 1, 4]);
    expect(records(inspectBucketQuery(base, { keys: [null], count: 1, value: 1 }, c, schema))).toEqual([]);
  });

  it("selects weekdays in a zone and merges repeated hours", () => {
    const monday = inspectBucketQuery(base, { keys: [2], count: 2, value: 2 }, clause({ interval: "dayOfWeek", timeZone: "Asia/Kolkata" }), schema);
    // Tuesday in Kolkata: 2026-03-02T18:30Z to 2026-03-03T18:30Z.
    expect(records(monday)).toEqual([1, 2]);
    const fall: QueryState = {
      ...EMPTY_QUERY,
      where: [
        { field: "at", op: ">=", value: "2026-11-01T00:00:00.000Z" },
        { field: "at", op: "<", value: "2026-11-02T00:00:00.000Z" },
      ],
    };
    const one = inspectBucketQuery(fall, { keys: [1], count: 2, value: 2 }, clause({ timeZone: "America/New_York" }), schema);
    expect(one?.where.slice(2)).toEqual([
      { field: "at", op: ">=", value: "2026-11-01T05:00:00.000Z" },
      { field: "at", op: "<", value: "2026-11-01T07:00:00.000Z" },
    ]);
  });

  it("reads whole occurrences only", () => {
    const c = clause({ interval: "dayOfWeek", occurrence: { interval: "day", includeEmpty: true } });
    const query = inspectBucketQuery(
      { ...EMPTY_QUERY, where: [{ field: "at", op: ">=", value: "2026-03-02T09:30:00.000Z" }, { field: "at", op: "<=", value: "2026-03-10T12:00:00.000Z" }] },
      { keys: [2], count: 2, value: 2 },
      c,
      schema,
    );
    expect(query?.where.slice(2)).toEqual([
      { field: "at", op: ">=", value: "2026-03-03T00:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-04T00:00:00.000Z" },
    ]);
  });

  it("returns null without bounds or past the predicate budget", () => {
    expect(inspectBucketQuery(EMPTY_QUERY, { keys: [9], count: 1, value: 1 }, clause({}), schema)).toBeNull();
    const year: QueryState = {
      ...EMPTY_QUERY,
      where: [
        { field: "at", op: ">=", value: "2026-01-01T00:00:00.000Z" },
        { field: "at", op: "<", value: "2027-01-01T00:00:00.000Z" },
      ],
    };
    expect(inspectBucketQuery(year, { keys: [9], count: 1, value: 1 }, clause({}), schema)).toBeNull();
    expect(inspectBucketQuery(year, { keys: [24], count: 1, value: 1 }, clause({}), schema)).toBeNull();
  });
});
