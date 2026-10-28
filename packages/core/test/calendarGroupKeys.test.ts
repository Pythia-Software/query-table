import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  GROUP_ID_FIELD,
  applyQuery,
  createGroupingModel,
  decodeQueryStrict,
  encodeQuery,
  evaluateMetrics,
  groupSourceQuery,
  inspectBucketQuery,
  normalizeQueryState,
  prepareGrouping,
  toQueryRequestV3,
  withGroupingKeys,
  type AggregationClause,
  type FieldSchema,
  type GroupKey,
  type GroupLinkValue,
  type QueryCapabilitiesV3,
  type QueryState,
} from "../src/index";

// Grouped rows share the record type in applyQuery; read both as plain records.
type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "at", label: "Called at", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "kind", label: "Kind", type: "text", source: { kind: "backend" } },
    { name: "ms", label: "Duration", type: "number", source: { kind: "backend" } },
  ],
};
// Denver springs forward on 2026-03-08: that local day has 23 hours.
const times = [
  "2026-03-08T06:30:00.000Z", // Mar 7 23:30 MST
  "2026-03-08T07:30:00.000Z", // Mar 8 00:30 MST
  "2026-03-08T10:30:00.000Z", // Mar 8 04:30 MDT
  "2026-03-09T05:59:00.000Z", // Mar 8 23:59 MDT
  "2026-03-09T06:00:00.000Z", // Mar 9 00:00 MDT
  null,
];
const rows: Row[] = times.map((at, i) => ({ id: i, at, kind: i % 2 ? "b" : "a", ms: (i + 1) * 10 }));
const denverDay: GroupKey = { field: "at", interval: "day", timeZone: "America/Denver" };
const grouped = (keys: GroupKey[], query: Partial<QueryState> = {}): QueryState => ({
  ...EMPTY_QUERY,
  select: [],
  ...query,
  grouping: {
    keys,
    summaries: [{ id: "calls", op: "count" }, { id: "total", op: "sum", field: "ms" }],
    representative: null,
    source: EMPTY_QUERY,
  },
});
const now = Date.parse("2026-04-01T00:00:00Z");
const metric = (interval: "day" | "hour", timeZone?: string): AggregationClause => ({
  id: "m",
  op: "sum",
  field: "ms",
  groupBy: ["at"],
  dateGrouping: { field: "at", interval, ...(timeZone ? { timeZone } : {}), includeEmpty: false, range: "query" },
});

describe("calendar grouping keys", () => {
  it("groups by local day keyed by local midnight, matching dateGrouping", () => {
    const result = applyQuery(rows, grouped([denverDay], { orderBy: [{ field: "at", dir: "asc" }] }), schema, { now });
    expect(result.rows.map((row) => [row.at, row.calls, row.total])).toEqual([
      ["2026-03-07T07:00:00.000Z", 1, 10],
      ["2026-03-08T07:00:00.000Z", 3, 20 + 30 + 40],
      ["2026-03-09T06:00:00.000Z", 1, 50],
      [null, 1, 60],
    ]);
    const buckets = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [metric("day", "America/Denver")] }, schema, { now }).metrics[0]!.buckets;
    expect(buckets.map((b) => [b.keys[0], b.count, b.value])).toEqual(
      result.rows.map((row) => [row.at, row.calls, row.total]),
    );
  });

  it("groups by UTC hour, matching dateGrouping", () => {
    const result = applyQuery(rows, grouped([{ field: "at", interval: "hour" }], { orderBy: [{ field: "at", dir: "asc" }] }), schema, { now });
    const buckets = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [metric("hour")] }, schema, { now }).metrics[0]!.buckets;
    expect(result.rows.map((row) => [row.at, row.calls, row.total])).toEqual(buckets.map((b) => [b.keys[0], b.count, b.value]));
    expect(result.rows[0]!.at).toBe("2026-03-08T06:00:00.000Z");
  });

  it("names the key column after the field, typed datetime, with a stable identity", () => {
    const prepared = prepareGrouping(rows, schema, grouped([denverDay, "kind"]).grouping!, { now });
    const key = prepared.schema.fields.find((field) => field.name === "at")!;
    expect([key.type, key.label]).toEqual(["datetime", "Called at (day)"]);
    expect(prepared.schema.defaultSelect).toEqual([{ field: "at" }, { field: "kind" }]);
    const row = prepared.rows.find((r) => r.at === "2026-03-08T07:00:00.000Z" && r.kind === "a")!;
    expect(row[GROUP_ID_FIELD]).toBe('[["at","2026-03-08T07:00:00.000Z"],["kind","a"]]');
  });

  it("filters, orders and pages groups on the interval start", () => {
    const result = applyQuery(
      rows,
      grouped([denverDay], {
        where: [{ field: "at", op: ">=", value: "2026-03-08T07:00:00.000Z" }],
        orderBy: [{ field: "at", dir: "desc" }],
        limit: 1,
        offset: 1,
      }),
      schema,
      { now },
    );
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.at)).toEqual(["2026-03-08T07:00:00.000Z"]);
  });

  it("drills a grouped row down to exactly its interval's records", () => {
    const query = grouped([denverDay, "kind"]);
    const groups = applyQuery(rows, query, schema, { now }).rows;
    for (const group of groups) {
      const records = groupSourceQuery(query, group, schema)!;
      const members = applyQuery(rows, { ...records, limit: 100 }, schema, { now }).rows;
      expect(members.length, JSON.stringify(group)).toBe(group.calls);
    }
    const day = groups.find((g) => g.at === "2026-03-08T07:00:00.000Z" && g.kind === "a")!;
    expect(groupSourceQuery(query, day, schema)!.where).toEqual([
      { field: "at", op: ">=", value: "2026-03-08T07:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-09T06:00:00.000Z" },
      { field: "kind", op: "=", value: "a" },
    ]);
    const empty = groups.find((g) => g.at === null)!;
    expect(groupSourceQuery(query, empty, schema)!.where[0]).toEqual({ field: "at", op: "is_null", value: "" });
  });

  it("inspects a metric bucket over grouped rows as that group", () => {
    const clause: AggregationClause = { id: "per_day", op: "sum", field: "calls", groupBy: ["at"] };
    const query = { ...grouped([denverDay]), aggregations: [clause] };
    const bucket = evaluateMetrics(rows, query, schema, { now }).metrics[0]!.buckets.find((b) => b.keys[0] === "2026-03-08T07:00:00.000Z")!;
    const inspected = inspectBucketQuery(query, bucket, clause, schema)!;
    const groups = applyQuery(rows, inspected, schema, { now }).rows;
    expect(groups.map((g) => [g.at, g.calls])).toEqual([["2026-03-08T07:00:00.000Z", 3]]);
    const records = groupSourceQuery(inspected, groups[0]!, schema)!;
    expect(applyQuery(rows, records, schema, { now }).rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("gives link columns the interval range as key filters", () => {
    const query = grouped([denverDay]);
    query.grouping!.summaries.push({ id: "open", op: "link", link: { label: "Open", to: { kind: "query", target: "records" } } });
    const prepared = prepareGrouping(rows, schema, query.grouping!, { now });
    const field = prepared.schema.fields.find((f) => f.name === "open")!;
    const row = prepared.rows.find((r) => r.at === "2026-03-09T06:00:00.000Z")!;
    const value = (field.source as { accessor: (row: unknown) => GroupLinkValue }).accessor(row);
    expect(value.terms).toEqual([
      { field: "at", op: ">=", value: "2026-03-09T06:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-10T06:00:00.000Z" },
    ]);
  });

  it("rejects cyclic intervals, non-datetime fields and unknown zones clearly", () => {
    const model = createGroupingModel(schema);
    const validate = (key: unknown) => () =>
      model.validate({ keys: [key as GroupKey], summaries: [], representative: null });
    expect(validate({ field: "at", interval: "hourOfDay" })).toThrow(/hour-of-day and day-of-week are metric intervals/);
    expect(validate({ field: "kind", interval: "day" })).toThrow(/needs a datetime field/);
    expect(validate({ field: "at", interval: "day", timeZone: "Mars/Olympus" })).toThrow(/IANA timezone/);
    expect(() => model.validate({ keys: [denverDay, "at"], summaries: [], representative: null })).toThrow(/valid group keys/);
    expect(validate(denverDay)).not.toThrow();
  });

  it("keeps a key's column, group filters and sorts when only its interval changes", () => {
    const before = withGroupingKeys({ ...EMPTY_QUERY, select: [{ field: "kind" }] }, ["at"]);
    const filtered = { ...before, where: [{ field: "at", op: "is_not_null" as const, value: "" }], orderBy: [{ field: "at", dir: "asc" as const }] };
    const after = withGroupingKeys(filtered, [denverDay]);
    expect(after.grouping!.keys).toEqual([denverDay]);
    expect(after.select).toEqual([{ field: "at" }]);
    expect(after.where).toEqual(filtered.where);
    expect(after.orderBy).toEqual(filtered.orderBy);
  });

  it("normalizes, encodes and decodes calendar keys", () => {
    const query = grouped([denverDay, "kind", { field: "at2", interval: "hour" }]);
    expect(normalizeQueryState(query).grouping!.keys).toEqual([denverDay, "kind", { field: "at2", interval: "hour" }]);
    expect(decodeQueryStrict(encodeQuery(query)).grouping!.keys).toEqual(query.grouping!.keys);
    const invalid = normalizeQueryState(grouped([{ field: "at", interval: "dayOfWeek" } as never]));
    expect(invalid.grouping!.diagnostics?.[0]).toMatch(/hour-of-day and day-of-week are metric intervals/);
  });

  it("negotiates calendar keys with the server", () => {
    const capabilities: QueryCapabilitiesV3 = {
      version: 3, profile: "p", groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false,
      maxRows: 100, maxGroups: 100, maxPopulation: 1000,
    };
    const query = grouped([denverDay], { select: [{ field: "at" }, { field: "calls" }] });
    expect(toQueryRequestV3(query, schema, capabilities).diagnostics).toContain(
      "This server does not support grouping keys by calendar interval.",
    );
    const request = toQueryRequestV3(query, schema, { ...capabilities, calendarGroupKeys: true });
    expect(request.diagnostics).toEqual([]);
    expect(request.grouping!.keys).toEqual([denverDay]);
    expect(toQueryRequestV3(grouped(["kind"]), schema, capabilities).diagnostics).toEqual([]);
  });
});
