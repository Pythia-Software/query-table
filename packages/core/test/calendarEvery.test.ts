import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyQuery,
  createGroupingModel,
  groupSourceQuery,
  decodeQuery,
  encodeQuery,
  evaluateMetrics,
  inspectBucketQuery,
  metricDateFloor,
  metricDateNext,
  normalizeQueryState,
  planMetricSeries,
  toQueryRequestV3,
  validateMetric,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type MetricDateGrouping,
  type QueryCapabilitiesV3,
  type QueryState,
} from "../src/index";

type Row = { id: number; at: string | null; kind: string; ms: number };
const schema: FieldSchema<Row> = {
  name: "every",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    {
      name: "at",
      label: "At",
      type: "datetime",
      source: { kind: "backend" },
      filter: { enabled: true },
      aggregate: { groupable: true },
    },
    { name: "kind", label: "Kind", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "ms", label: "Duration", type: "number", source: { kind: "backend" }, aggregate: { measure: true } },
  ],
};
const rows = (times: (string | null)[]): Row[] => times.map((at, i) => ({ id: i, at, kind: "a", ms: i + 1 }));
const clause = (grouping: Partial<MetricDateGrouping>, extra: Partial<AggregationClause> = {}): AggregationClause => ({
  id: "m",
  op: "count",
  groupBy: ["at"],
  dateGrouping: { field: "at", interval: "hour", every: 3, timeZone: "UTC", includeEmpty: false, range: "query", ...grouping },
  ...extra,
});
const run = (data: Row[], c: AggregationClause, query: Partial<QueryState> = {}, now = Date.parse("2027-01-01T00:00:00Z")) =>
  evaluateMetrics(data, { ...EMPTY_QUERY, ...query, aggregations: [c] }, schema, { now }).metrics[0]!;
const pairs = (result: AggregationResultEntry) => result.buckets.map((b) => [...b.keys, b.count]);
const iso = (time: number) => new Date(time).toISOString();
type EveryCase = { name: string; zone: string; interval: "hour" | "day" | "week" | "month" | "year"; every: number; at: string; floor: string; next: string };
const fixture = JSON.parse(readFileSync(new URL("../../../schema/fixtures/calendar-every.json", import.meta.url), "utf8")) as { cases: EveryCase[] };

describe("calendar buckets of several intervals", () => {
  // Shared with backends/go/calendar_every_test.go.
  it.each(fixture.cases)("$name", ({ zone, interval, every, at, floor, next }) => {
    const time = Date.parse(at);
    expect(iso(metricDateFloor(time, interval, zone, every))).toBe(floor);
    expect(iso(metricDateNext(time, interval, zone, every))).toBe(next);
    expect(iso(metricDateNext(Date.parse(floor), interval, zone, every))).toBe(next);
    expect(iso(metricDateFloor(Date.parse(next), interval, zone, every))).toBe(next);
  });

  it("tiles the timeline: each bucket's next start is the following floor", () => {
    for (const zone of ["America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "UTC"])
      for (const [interval, every] of [["hour", 2], ["hour", 3], ["hour", 5], ["hour", 12], ["day", 3], ["week", 2], ["month", 3]] as const)
        // Around both DST changes in New York and Lord Howe.
        for (const from of ["2026-03-07", "2026-04-03", "2026-10-02", "2026-10-31"]) {
          const span = Date.parse(`${from}T00:00:00Z`) + 3 * 86_400_000;
          for (let time = Date.parse(`${from}T00:00:00Z`); time < span; time += 1_800_000) {
            const start = metricDateFloor(time, interval, zone, every);
            const end = metricDateNext(start, interval, zone, every);
            expect(start <= time && time < end, `${zone} ${interval} ${every} ${iso(time)}`).toBe(true);
            expect(metricDateFloor(end, interval, zone, every)).toBe(end);
          }
        }
  });

  it("keys rows by bucket start and fills empty buckets of the range", () => {
    const data = rows(["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "2026-03-08T08:15:00Z", "2026-03-08T13:00:00Z", null]);
    const result = run(
      data,
      clause({ timeZone: "America/New_York", includeEmpty: true, range: "custom", start: "2026-03-08", end: "2026-03-08" }),
    );
    // 00:00 EST, 03:00 EDT, 06:00 … 21:00 EDT.
    expect(pairs(result)).toEqual([
      ["2026-03-08T05:00:00.000Z", 1],
      ["2026-03-08T07:00:00.000Z", 2],
      ["2026-03-08T10:00:00.000Z", 0],
      ["2026-03-08T13:00:00.000Z", 1],
      ["2026-03-08T16:00:00.000Z", 0],
      ["2026-03-08T19:00:00.000Z", 0],
      ["2026-03-08T22:00:00.000Z", 0],
      ["2026-03-09T01:00:00.000Z", 0],
      [null, 1],
    ]);
  });

  it("fills a query range with whole buckets and excludes the partial ones", () => {
    const data = rows(["2026-04-02T00:00:00Z", "2026-05-10T00:00:00Z", "2026-08-01T00:00:00Z", "2026-11-20T00:00:00Z"]);
    const where = [
      { field: "at", op: ">=" as const, value: "2026-02-15T00:00:00Z" },
      { field: "at", op: "<" as const, value: "2026-12-01T00:00:00Z" },
    ];
    const quarters = clause({ interval: "month", includeEmpty: true });
    expect(pairs(run(data, quarters, { where }))).toEqual([
      ["2026-01-01T00:00:00.000Z", 0],
      ["2026-04-01T00:00:00.000Z", 2],
      ["2026-07-01T00:00:00.000Z", 1],
      ["2026-10-01T00:00:00.000Z", 1],
    ]);
    // Q1 and Q4 are cut by the bounds.
    const whole = clause({ interval: "month", includeEmpty: true, partialIntervals: "exclude" });
    expect(pairs(run(data, whole, { where }))).toEqual([
      ["2026-04-01T00:00:00.000Z", 2],
      ["2026-07-01T00:00:00.000Z", 1],
    ]);
    // The bucket still in progress is partial.
    const now = Date.parse("2026-09-15T00:00:00Z");
    expect(pairs(run(data.slice(0, 3), whole, { where }, now))).toEqual([["2026-04-01T00:00:00.000Z", 2]]);
    // Observed fills between the first and last observed buckets.
    expect(pairs(run(data, clause({ interval: "month", every: 6, includeEmpty: true, range: "observed" })))).toEqual([
      ["2026-01-01T00:00:00.000Z", 2],
      ["2026-07-01T00:00:00.000Z", 2],
    ]);
  });

  it("counts buckets as window periods", () => {
    const data = rows(["2026-01-01T01:00:00Z", "2026-01-01T07:00:00Z", "2026-01-01T08:00:00Z", "2026-01-01T19:00:00Z"]);
    const where = [
      { field: "at", op: ">=" as const, value: "2026-01-01T00:00:00Z" },
      { field: "at", op: "<" as const, value: "2026-01-02T00:00:00Z" },
    ];
    const windowed = clause({ every: 6, includeEmpty: true }, { window: { periods: 2 } });
    const query: QueryState = { ...EMPTY_QUERY, where, aggregations: [windowed] };
    const plan = planMetricSeries(query, schema, { now: Date.parse("2027-01-01T00:00:00Z") })!;
    const result = plan.combine(plan.queries.flatMap((q) => evaluateMetrics(rows([]).concat(data), q, schema).metrics))[0]!;
    expect(result.buckets.map((b) => [b.keys[0], b.value])).toEqual([
      ["2026-01-01T00:00:00.000Z", null],
      ["2026-01-01T06:00:00.000Z", 3],
      ["2026-01-01T12:00:00.000Z", 2],
      ["2026-01-01T18:00:00.000Z", 1],
    ]);
    // A windowed point drills into its two buckets.
    const drill = inspectBucketQuery(query, result.buckets[2]!, windowed, schema)!;
    expect(drill.where.slice(2)).toEqual([
      { field: "at", op: ">=", value: "2026-01-01T06:00:00.000Z" },
      { field: "at", op: "<", value: "2026-01-01T18:00:00.000Z" },
    ]);
  });

  it("drills into one bucket's [start, next) range", () => {
    const c = clause({ timeZone: "America/New_York" });
    const drill = inspectBucketQuery(EMPTY_QUERY, { keys: ["2026-11-01T04:00:00.000Z"], count: 1, value: 1 }, c, schema)!;
    expect(drill.where).toEqual([
      { field: "at", op: ">=", value: "2026-11-01T04:00:00.000Z" },
      { field: "at", op: "<", value: "2026-11-01T08:00:00.000Z" },
    ]);
  });

  it("validates every and refuses it for cycles", () => {
    const message = (c: AggregationClause) => validateMetric(c, schema)[0]?.message;
    expect(message(clause({ every: 1000 }))).toBeUndefined();
    for (const every of [0, 1001, 1.5]) expect(message(clause({ every }))).toMatch(/1–1,000/);
    expect(message(clause({ interval: "hourOfDay", every: 2 }))).toMatch(/every applies to calendar intervals/);
    expect(message(clause({ interval: "hourOfDay", every: 1 }))).toBeUndefined();
    expect(
      message(clause({ interval: "dayOfWeek", every: 2, occurrence: { interval: "day", includeEmpty: true } })),
    ).toMatch(/every applies to calendar intervals/);
  });

  it("round-trips links and leaves out every 1", () => {
    const c = clause({ interval: "month", every: 3, timeZone: "America/New_York" });
    const query = { ...EMPTY_QUERY, aggregations: [c] };
    expect(decodeQuery(encodeQuery(query)).aggregations?.[0]?.dateGrouping).toEqual(c.dateGrouping);
    const one = normalizeQueryState({ ...EMPTY_QUERY, aggregations: [clause({ every: 1 })] }).aggregations![0]!;
    expect(one.dateGrouping).not.toHaveProperty("every");
    const bad = normalizeQueryState({ ...EMPTY_QUERY, aggregations: [clause({ every: -2 })] }).aggregations![0]!;
    expect(bad.diagnostics).toContain("Invalid metric every.");
  });

  it("needs a server that executes buckets of several intervals", () => {
    const capabilities = {
      version: 3, profile: "p", groupedRows: true, calendarGrouping: true, calendarGroupKeys: true,
      computedSourceFilters: false, regex: false, maxRows: 10, maxGroups: 10, maxPopulation: 10,
    } satisfies QueryCapabilitiesV3;
    const query = { ...EMPTY_QUERY, aggregations: [clause({})] };
    expect(() => toQueryRequestV3(query, schema, capabilities)).toThrow("This server does not support buckets of several calendar intervals (every).");
    const request = toQueryRequestV3(query, schema, { ...capabilities, calendarEvery: true });
    expect(request.metrics[0]!.dateGrouping).toMatchObject({ interval: "hour", every: 3 });
    // every 1 is the default, which every server executes.
    const plain = toQueryRequestV3({ ...EMPTY_QUERY, aggregations: [clause({ every: 1 })] }, schema, capabilities);
    expect(plain.metrics[0]!.dateGrouping).not.toHaveProperty("every");
  });
});

describe("calendar group keys of several intervals", () => {
  const grouped = (key: object): QueryState => ({
    ...EMPTY_QUERY,
    grouping: {
      keys: [key as never],
      summaries: [{ id: "num", op: "count" }],
      representative: null,
      source: { ...EMPTY_QUERY, select: [{ field: "id" }] },
    },
  });

  it("groups by bucket start and selects a group's bucket", () => {
    const key = { field: "at", interval: "hour" as const, every: 6, timeZone: "Asia/Kolkata" };
    const data = rows(["2026-03-02T00:30:00Z", "2026-03-02T06:29:00Z", "2026-03-02T06:30:00Z"]);
    const query = { ...grouped(key), select: [], orderBy: [{ field: "at", dir: "asc" as const }] };
    const result = applyQuery(data as unknown as Record<string, unknown>[], query, schema as never);
    expect(result.rows.map((g) => [g.at, g.num])).toEqual([
      ["2026-03-02T00:30:00.000Z", 2],
      ["2026-03-02T06:30:00.000Z", 1],
    ]);
    const group = groupSourceQuery(query, result.rows[0] as never, schema as never)!;
    expect(group.where).toEqual([
      { field: "at", op: ">=", value: "2026-03-02T00:30:00.000Z" },
      { field: "at", op: "<", value: "2026-03-02T06:30:00.000Z" },
    ]);
    const model = createGroupingModel(schema);
    expect(model.resultSchema([key], []).fields.find((f) => f.name === "at")?.label).toBe("At (6 hours)");
  });

  it("round-trips links, leaves out every 1 and refuses invalid counts", () => {
    const query = grouped({ field: "at", interval: "week", every: 2 });
    expect(decodeQuery(encodeQuery(query)).grouping?.keys).toEqual([{ field: "at", interval: "week", every: 2 }]);
    expect(normalizeQueryState(grouped({ field: "at", interval: "week", every: 1 })).grouping?.keys).toEqual([
      { field: "at", interval: "week" },
    ]);
    expect(normalizeQueryState(grouped({ field: "at", interval: "week", every: 0 })).grouping?.diagnostics?.[0]).toMatch(/every 1–1000/);
  });

  it("needs a server that executes buckets of several intervals", () => {
    const capabilities = {
      version: 3, profile: "p", groupedRows: true, calendarGrouping: true, calendarGroupKeys: true,
      computedSourceFilters: false, regex: false, maxRows: 10, maxGroups: 10, maxPopulation: 10,
    } satisfies QueryCapabilitiesV3;
    const query = grouped({ field: "at", interval: "day", every: 7 });
    expect(() => toQueryRequestV3(query, schema, capabilities)).toThrow("grouping keys by several calendar intervals");
    expect(toQueryRequestV3(query, schema, { ...capabilities, calendarEvery: true }).grouping?.keys).toEqual([
      { field: "at", interval: "day", every: 7 },
    ]);
  });
});
