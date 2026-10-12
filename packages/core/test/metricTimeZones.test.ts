import { describe, expect, it, vi } from "vitest";
import * as dateHelpers from "../src/metricDates";
import {
  EMPTY_QUERY,
  evaluateMetrics,
  encodeQuery,
  decodeQuery,
  metricComputationKey,
  normalizeQueryState,
  type AggregationClause,
  type FieldSchema,
  type MetricDateGrouping,
} from "../src/index";
import {
  metricDateFloor,
  metricDateNext,
  metricDateTime,
} from "../src/metricDates";

const schema: FieldSchema = {
  name: "zoned-dates",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    {
      name: "at",
      label: "Timestamp",
      type: "datetime",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
  ],
};
const definition = (
  config: Partial<MetricDateGrouping> = {},
): AggregationClause => ({
  id: "dates",
  op: "count",
  expression: "COUNT()",
  groupBy: ["at"],
  dateGrouping: {
    field: "at",
    interval: "day",
    timeZone: "America/Denver",
    includeEmpty: true,
    range: "custom",
    start: "2026-10-01",
    end: "2026-10-02",
    ...config,
  },
});
const evaluate = (
  config: Partial<MetricDateGrouping> = {},
  timestamps: string[] = [],
) =>
  evaluateMetrics(
    timestamps.map((at, id) => ({ id, at })),
    { ...EMPTY_QUERY, aggregations: [definition(config)] },
    schema,
  ).metrics[0]!;
const iso = (time: number) => new Date(time).toISOString();
describe("metric grouping timezones", () => {
  // The uncached reference calculation spans 25 timezone/interval combinations;
  // allow it to finish while the full suite runs in parallel.
  it("reuses calendar boundaries for dense rows across DST and fractional offsets", () => {
    for (const [timeZone, start, end] of [
      ["America/Denver", "2026-03-07T06:00:00Z", "2026-03-09T09:00:00Z"],
      ["America/Denver", "2026-10-31T05:00:00Z", "2026-11-02T09:00:00Z"],
      ["Australia/Lord_Howe", "2026-04-04T13:00:00Z", "2026-04-05T17:00:00Z"],
      ["Australia/Lord_Howe", "2026-10-03T13:00:00Z", "2026-10-04T17:00:00Z"],
      ["Asia/Kathmandu", "2026-10-01T17:00:00Z", "2026-10-03T19:00:00Z"],
    ] as const) {
      const timestamps: string[] = [];
      for (let time = Date.parse(start); time < Date.parse(end); time += 60000)
        timestamps.push(iso(time));
      for (const interval of [
        "hour",
        "day",
        "week",
        "month",
        "year",
      ] as const) {
        const expected = new Map<string, number>();
        for (const timestamp of timestamps) {
          const key = iso(
            metricDateFloor(Date.parse(timestamp), interval, timeZone),
          );
          expected.set(key, (expected.get(key) ?? 0) + 1);
        }
        const floor = vi.spyOn(dateHelpers, "metricDateFloor");
        const next = vi.spyOn(dateHelpers, "metricDateNext");
        try {
          const result = evaluate(
            { timeZone, interval, includeEmpty: false },
            timestamps,
          );
          expect(result.error).toBeUndefined();
          expect(result.buckets.map((b) => [b.keys[0], b.value])).toEqual([
            ...expected,
          ]);
          expect(floor).toHaveBeenCalledTimes(expected.size);
          expect(next).toHaveBeenCalledTimes(expected.size);
        } finally {
          floor.mockRestore();
          next.mockRestore();
        }
      }
    }
  }, 20000);
  it("recomputes out-of-order buckets and treats their ends as exclusive", () => {
    const result = evaluate({ interval: "hour", includeEmpty: false }, [
      "2026-11-01T07:59:59.999Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T06:59:59.999Z",
      "2026-11-01T08:59:59.999Z",
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.buckets.map((b) => [b.keys[0], b.value])).toEqual([
      ["2026-11-01T06:00:00.000Z", 1],
      ["2026-11-01T07:00:00.000Z", 2],
      ["2026-11-01T08:00:00.000Z", 3],
      ["2026-11-01T09:00:00.000Z", 1],
    ]);
  });
  it("reuses repeated date-only inputs per metric without hiding invalid inputs or operation limits", () => {
    const rows = Array.from({ length: 1000 }, (_, id) => ({
      id,
      at: "2026-10-01",
    }));
    const clauses = [
      definition({ includeEmpty: false }),
      {
        ...definition({ includeEmpty: false, timeZone: "Asia/Kathmandu" }),
        id: "nepal",
      },
    ];
    const query = { ...EMPTY_QUERY, aggregations: clauses };
    const parse = vi.spyOn(dateHelpers, "metricDateTime");
    try {
      const result = evaluateMetrics(rows, query, schema);
      expect(
        result.metrics.map((m) => [
          m.error,
          m.buckets[0]?.keys[0],
          m.buckets[0]?.value,
        ]),
      ).toEqual([
        [undefined, "2026-10-01T06:00:00.000Z", 1000],
        [undefined, "2026-09-30T18:15:00.000Z", 1000],
      ]);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
    expect(
      evaluate({ includeEmpty: false }, ["2026-10-01", "2026-02-30"]).error,
    ).toContain("Invalid date grouping value");
    expect(
      evaluateMetrics(rows, query, schema, { maxOperations: 10 }).metrics.every(
        (m) => m.error?.includes("operation budget"),
      ),
    ).toBe(true);
  });
  it("groups timestamps by local date and handles date-only inputs/custom bounds in that zone", () => {
    const result = evaluate({}, [
      "2026-10-02T02:00:00Z",
      "2026-10-02T20:00:00Z",
      "2026-10-01",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.buckets.map((b) => [b.keys[0], b.value])).toEqual([
      ["2026-10-01T06:00:00.000Z", 2],
      ["2026-10-02T06:00:00.000Z", 1],
    ]);
    expect(iso(metricDateTime("2026-10-01", "Asia/Kathmandu"))).toBe(
      "2026-09-30T18:15:00.000Z",
    );
  });
  it("keeps query bounds as instants and completes intersecting local dates", () => {
    const clause = definition({ range: "query" });
    const result = evaluateMetrics(
      [],
      {
        ...EMPTY_QUERY,
        aggregations: [clause],
        where: [
          { field: "at", op: ">=", value: "2026-10-01T06:00:00Z" },
          { field: "at", op: "<", value: "2026-10-03T06:00:00Z" },
        ],
      },
      schema,
    ).metrics[0]!;
    expect(result.buckets.map((b) => b.keys[0])).toEqual([
      "2026-10-01T06:00:00.000Z",
      "2026-10-02T06:00:00.000Z",
    ]);
  });
  it("advances local days across 23- and 25-hour days without midnight drift", () => {
    for (const [start, end, expected] of [
      [
        "2026-03-07",
        "2026-03-09",
        [
          "2026-03-07T07:00:00.000Z",
          "2026-03-08T07:00:00.000Z",
          "2026-03-09T06:00:00.000Z",
        ],
      ],
      [
        "2026-10-31",
        "2026-11-02",
        [
          "2026-10-31T06:00:00.000Z",
          "2026-11-01T06:00:00.000Z",
          "2026-11-02T07:00:00.000Z",
        ],
      ],
    ] as const) {
      const result = evaluate({ start, end });
      expect(result.error).toBeUndefined();
      expect(result.buckets.map((b) => b.keys[0])).toEqual(expected);
    }
  });
  it("skips spring's missing hour and keeps both autumn occurrences of 01:00", () => {
    const spring = evaluate({
      interval: "hour",
      start: "2026-03-08",
      end: "2026-03-08",
    });
    expect(spring.error).toBeUndefined();
    expect(spring.buckets).toHaveLength(23);
    expect(spring.buckets[2]!.keys[0]).toBe("2026-03-08T09:00:00.000Z");
    const autumn = evaluate(
      { interval: "hour", start: "2026-11-01", end: "2026-11-01" },
      ["2026-11-01T01:15:00-06:00", "2026-11-01T01:15:00-07:00"],
    );
    expect(autumn.error).toBeUndefined();
    expect(autumn.buckets).toHaveLength(25);
    expect(
      autumn.buckets.filter((b) => b.value === 1).map((b) => b.keys[0]),
    ).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
  });
  it("completes every observed hour even for fractional offsets and 30-minute DST shifts", () => {
    for (const [timeZone, date] of [
      ["Asia/Kathmandu", "2026-10-04"],
      ["Australia/Lord_Howe", "2026-10-04"],
      ["Australia/Lord_Howe", "2026-04-05"],
    ] as const) {
      const result = evaluate({
        timeZone,
        interval: "hour",
        start: date!,
        end: date!,
      });
      expect(result.error).toBeUndefined();
      const keys = result.buckets.map((b) => Date.parse(String(b.keys[0])));
      const end = metricDateNext(keys[0]!, "day", timeZone);
      // Every minute of the local day maps to exactly one generated bucket.
      const generated = new Set(keys);
      for (let time = keys[0]!; time < end; time += 60000)
        expect(generated.has(metricDateFloor(time, "hour", timeZone))).toBe(
          true,
        );
      expect(keys.every((time, i) => i === 0 || time > keys[i - 1]!)).toBe(
        true,
      );
    }
  });
  it("uses local Monday/month/year boundaries and skips nonexistent calendar dates", () => {
    for (const [interval, expected] of [
      ["week", "2026-09-28T06:00:00.000Z"],
      ["month", "2026-10-01T06:00:00.000Z"],
      ["year", "2026-01-01T07:00:00.000Z"],
    ] as const)
      expect(
        iso(
          metricDateFloor(
            Date.parse("2026-10-04T18:00:00Z"),
            interval,
            "America/Denver",
          ),
        ),
      ).toBe(expected);
    expect(
      evaluate({
        timeZone: "Pacific/Apia",
        start: "2011-12-29",
        end: "2011-12-31",
      }).buckets,
    ).toHaveLength(2);
    expect(iso(metricDateTime("2018-11-04", "America/Sao_Paulo"))).toBe(
      "2018-11-04T03:00:00.000Z",
    );
  });
  it("defaults to UTC, persists named zones, changes computation identity and rejects invalid zones", () => {
    const defaultZone = definition();
    delete defaultZone.dateGrouping!.timeZone;
    expect(
      evaluateMetrics(
        [],
        { ...EMPTY_QUERY, aggregations: [defaultZone] },
        schema,
      ).metrics[0]!.buckets[0]!.keys[0],
    ).toBe("2026-10-01T00:00:00.000Z");
    const query = { ...EMPTY_QUERY, aggregations: [definition()] };
    expect(
      decodeQuery(encodeQuery(query))!.aggregations![0]!.dateGrouping!.timeZone,
    ).toBe("America/Denver");
    expect(metricComputationKey([definition()])).not.toBe(
      metricComputationKey([definition({ timeZone: "UTC" })]),
    );
    for (const timeZone of [
      "Invalid/Zone",
      "",
      "local",
      "+06:00",
      "x".repeat(81),
    ])
      expect(evaluate({ timeZone }).error).toContain("grouping timezone");
    const malformed = normalizeQueryState({
      ...query,
      aggregations: [
        {
          ...definition(),
          dateGrouping: { ...definition().dateGrouping, timeZone: 7 },
        },
      ],
    });
    expect(malformed.aggregations![0]!.diagnostics).toBeDefined();
  });
});
