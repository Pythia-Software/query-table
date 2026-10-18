import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  evaluateMetrics,
  applyAggregations,
  encodeQuery,
  decodeQuery,
  normalizeQueryState,
  metricComputationKey,
  toMetricQuery,
  toAggregationQuery,
  type AggregationClause,
  type FieldSchema,
  type QueryState,
} from "../src/index";
import {
  metricDateFloor,
  metricDateNext,
  metricDateTime,
} from "../src/metricDates";

const schema: FieldSchema = {
  name: "dates",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    {
      name: "at",
      label: "Date",
      type: "datetime",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
    { name: "n", label: "Number", type: "number", source: { kind: "backend" } },
    {
      name: "series",
      label: "Series",
      type: "text",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
  ],
};
const metric = (extra: Partial<AggregationClause> = {}): AggregationClause => ({
  id: "daily",
  op: "count",
  expression: "COUNT()",
  groupBy: ["at"],
  dateGrouping: {
    field: "at",
    interval: "day",
    includeEmpty: true,
    range: "query",
  },
  ...extra,
});
const query = (extra: Partial<AggregationClause> = {}): QueryState => ({
  ...EMPTY_QUERY,
  where: [
    { field: "at", op: ">=", value: "2026-10-01" },
    { field: "at", op: "<", value: "2026-10-05" },
  ],
  aggregations: [metric(extra)],
});
const rows = [
  { id: 1, at: "2026-10-02T10:00:00Z", n: 6, series: "A" },
  { id: 2, at: "2026-10-02T23:00:00Z", n: 4, series: "A" },
  { id: 3, at: "2026-10-04T00:00:00Z", n: null, series: "B" },
];
const result = (
  extra: Partial<AggregationClause> = {},
  data: Array<{ id: number; at: string; n: unknown; series: string }> = rows,
  q = query(extra),
) => evaluateMetrics(data, q, schema).metrics[0]!;

describe("calendar metric grouping", () => {
  it("groups timestamps by UTC date and fills edge/interior buckets without altering table rows", () => {
    const r = result();
    expect(r.error).toBeUndefined();
    expect(r.buckets.map((b) => [b.keys[0], b.count, b.value])).toEqual([
      ["2026-10-01T00:00:00.000Z", 0, 0],
      ["2026-10-02T00:00:00.000Z", 2, 2],
      ["2026-10-03T00:00:00.000Z", 0, 0],
      ["2026-10-04T00:00:00.000Z", 1, 1],
    ]);
    expect(r.processedRows).toBe(3);
    expect(applyAggregations(rows, query(), schema)).toEqual(
      evaluateMetrics(rows, query(), schema),
    );
    expect(rows).toHaveLength(3);
    expect(result({}, []).buckets.map((b) => b.value)).toEqual([0, 0, 0, 0]);
  });
  it("distinguishes empty sums/counts from missing averages and real all-null buckets", () => {
    for (const expression of ["COUNT()", "COUNT_DISTINCT([n])", "SUM([n])"]) {
      const r = result({ expression });
      expect(r.buckets[0]!.value).toBe(0);
      expect(r.buckets[3]!.count).toBe(1);
    }
    expect(result({ expression: "SUM([n])" }).buckets[3]!.value).toBeNull();
    for (const expression of [
      "AVG([n])",
      "MIN([n])",
      "MAX([n])",
      "SUM([n])/COUNT()",
      "COUNT()+1",
    ]) {
      const r = result({ expression });
      expect(r.error).toBeUndefined();
      expect(r.buckets[0]!.value).toBeNull();
      expect(r.buckets[0]!.inputErrorCount).toBeUndefined();
    }
    const invalid = result(
      { expression: "SUM([n])" },
      rows.map((row) => ({ ...row, n: "invalid" })),
    );
    expect(
      invalid.buckets.find((b) => b.keys[0] === "2026-10-02T00:00:00.000Z")!
        .error,
    ).toBeTruthy();
  });
  it("can omit completion, use observed dates, and complete each observed series", () => {
    expect(
      result({
        dateGrouping: { ...metric().dateGrouping!, includeEmpty: false },
      }).buckets,
    ).toHaveLength(2);
    expect(
      result({ dateGrouping: { ...metric().dateGrouping!, range: "observed" } })
        .buckets,
    ).toHaveLength(3);
    expect(
      result(
        { dateGrouping: { ...metric().dateGrouping!, range: "observed" } },
        [],
      ).buckets,
    ).toEqual([]);
    const r = result({ groupBy: ["at", "series"] });
    expect(r.buckets).toHaveLength(8);
    expect(r.buckets.filter((b) => b.count === 0)).toHaveLength(6);
    expect(
      result({
        dateGrouping: {
          ...metric().dateGrouping!,
          includeEmpty: false,
          range: "custom",
        },
      }).error,
    ).toBeUndefined();
  });
  it("fills before sorting and limiting groups", () => {
    expect(result({ groupLimit: 2 }).buckets.map((b) => b.value)).toEqual([
      0, 2,
    ]);
    expect(
      result({ groupLimit: 1, sort: [{ key: "value", dir: "desc" }] })
        .buckets[0]!.value,
    ).toBe(2);
  });
  it("completes whole custom days for hourly groups and uses the same relative query clock", () => {
    const hourly = result({
      dateGrouping: {
        ...metric().dateGrouping!,
        interval: "hour",
        range: "custom",
        start: "2026-10-01",
        end: "2026-10-04",
      },
    });
    expect(hourly.error).toBeUndefined();
    expect(hourly.buckets).toHaveLength(96);
    expect(hourly.buckets.at(-1)!.keys[0]).toBe("2026-10-04T23:00:00.000Z");
    const relative: QueryState = {
      ...query(),
      where: [
        { field: "at", op: ">=", value: "-4d" },
        { field: "at", op: "<", value: "-1d" },
      ],
    };
    expect(
      evaluateMetrics([], relative, schema, {
        now: Date.parse("2026-10-05T00:00:00Z"),
      }).metrics[0]!.buckets.map((b) => b.keys[0]),
    ).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    ]);
    expect(
      result(
        {
          dateGrouping: {
            ...metric().dateGrouping!,
            range: "custom",
            start: "2024-02-28",
            end: "2024-03-01",
          },
        },
        [],
      ).buckets,
    ).toHaveLength(3);
  });
  it("requires a provable query domain and never drops observations for a custom range", () => {
    expect(result({}, rows, { ...query(), where: [] }).error).toContain(
      "bounded date filter",
    );
    const custom = {
      ...metric().dateGrouping!,
      range: "custom" as const,
      start: "2026-10-01",
      end: "2026-10-06",
    };
    expect(result({ dateGrouping: custom }).buckets).toHaveLength(6);
    expect(
      result({ dateGrouping: { ...custom, start: "2026-10-03" } }).error,
    ).toContain("all observed buckets");
    expect(
      result({ dateGrouping: { ...custom, end: "2026-09-30" } }).error,
    ).toContain("end date");
    const orQuery: QueryState = {
      ...query(),
      where: [
        {
          any: [
            { field: "at", op: ">=", value: "2026-10-01" },
            { field: "at", op: "<", value: "2026-10-05" },
          ],
        },
      ],
    };
    expect(result({}, rows, orQuery).error).toContain("bounded date filter");
    expect(result({}, rows, { ...query(), where: [] }).error).toBe(
      'Include empty dates with range "query" needs a bounded date filter on at: add a lower bound (>= or >) and an upper bound (<= or <) as top-level filters (bounds inside OR groups do not count). Otherwise use range "observed" to fill from the first to the last observed date, or range "custom" with start and end.',
    );
    expect(result({}, rows, { ...query(), where: [{ field: "at", op: ">=", value: "2026-10-01" }] }).error)
      .toContain("needs a bounded date filter on at: add an upper bound (<= or <) as");
  });
  it("respects group, memory and operation budgets and cancellation during completion", () => {
    for (const [options, message] of [
      [{ maxGroups: 2 }, "group budget"],
      [{ maxGroupBytes: 1000 }, "memory budget"],
      [{ maxOperations: 2 }, "operation budget"],
      [{ signal: AbortSignal.abort() }, "cancelled"],
    ] as const)
      expect(
        evaluateMetrics([], query(), schema, options).metrics[0]!.error,
      ).toContain(message);
  });
  it("persists normalized definitions and prevents unsupported server projections", () => {
    const q = query();
    expect(decodeQuery(encodeQuery(q))!.aggregations![0]!.dateGrouping).toEqual(
      metric().dateGrouping,
    );
    expect(
      metricComputationKey([
        metric({
          dateGrouping: { ...metric().dateGrouping!, includeEmpty: false },
        }),
      ]),
    ).not.toBe(metricComputationKey(q.aggregations!));
    expect(
      toMetricQuery(q, schema).diagnostics.some(
        (d) => d.code === "unsupported_date_grouping",
      ),
    ).toBe(true);
    expect(toMetricQuery(q, schema).metrics[0]).not.toHaveProperty(
      "dateGrouping",
    );
    expect(() => toAggregationQuery(q, schema)).toThrow("Date grouping");
    expect(
      normalizeQueryState({
        ...q,
        aggregations: [
          {
            ...metric(),
            dateGrouping: { ...metric().dateGrouping!, interval: "decade" },
          },
        ],
      }).aggregations![0]!.diagnostics,
    ).toBeDefined();
    expect(result({ groupBy: ["series", "at"] }).error).toContain(
      "first grouping field",
    );
  });
  it("uses calendar boundaries for hours, Monday weeks, leap days, months and years", () => {
    for (const [input, interval, floor, next] of [
      [
        "2026-10-02T01:45:00+02:00",
        "hour",
        "2026-10-01T23:00:00Z",
        "2026-10-02T00:00:00Z",
      ],
      ["2026-10-04", "week", "2026-09-28", "2026-10-05"],
      ["2024-02-28", "day", "2024-02-28", "2024-02-29"],
      ["2024-02-29", "month", "2024-02-01", "2024-03-01"],
      ["2024-12-31", "year", "2024-01-01", "2025-01-01"],
    ] as const) {
      const time = metricDateFloor(metricDateTime(input), interval);
      expect(time).toBe(Date.parse(floor));
      expect(metricDateNext(time, interval)).toBe(Date.parse(next));
    }
    expect(() => metricDateTime("2026-02-30")).toThrow("Invalid date");
    expect(() => metricDateTime("2026-10-01T00:00:00")).toThrow("timezone");
  });
});
