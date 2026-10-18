import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyAggregations,
  applyQuery,
  evaluateMetrics,
  exitGrouping,
  groupSourceQuery,
  inspectBucketQuery,
  prepareGrouping,
  withoutGrouping,
  withGroupingKeys,
  type AggregationBucket,
  type AggregationClause,
  type FieldSchema,
  type GroupingState,
  type QueryState,
  type WhereClause,
} from "../src/index";

type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = {
  name: "orders",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "status", label: "Status", type: "enum", source: { kind: "backend" } },
    { name: "owner", label: "Owner", type: "text", source: { kind: "backend" } },
    { name: "paid", label: "Paid", type: "bool", source: { kind: "backend" } },
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
    { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "secret", label: "Secret", type: "text", source: { kind: "backend" }, filter: { enabled: false } },
  ],
};
const rows: Row[] = [
  { id: 1, status: "open", owner: "ana", paid: true, at: "2026-03-07T06:30:00Z", amount: 0, tags: ["a"], secret: "x" },
  { id: 2, status: "open", owner: "", paid: false, at: "2026-03-07T07:30:00Z", amount: 2.5, tags: [], secret: "x" },
  { id: 3, status: "done", owner: null, paid: true, at: "2026-03-08T06:59:59Z", amount: 5, tags: ["b"], secret: "y" },
  { id: 4, status: "done", owner: "bo", paid: false, at: "2026-03-08T07:00:00Z", amount: 7.5, tags: ["a"], secret: "y" },
  { id: 5, status: null, owner: "bo", paid: true, at: "2026-03-09T06:00:00Z", amount: 10, tags: ["b"], secret: "z" },
  { id: 6, status: "open", owner: "ana", paid: true, at: "2026-03-09T08:00:00Z", amount: null, tags: [], secret: "z" },
];
const base: QueryState = { ...EMPTY_QUERY, where: [{ field: "id", op: "<", value: "100" }], offset: 40 };
const metric = (clause: Partial<AggregationClause>): AggregationClause => ({ id: "m", op: "count", groupBy: [], ...clause });
const total = (query: QueryState) => applyQuery(rows, { ...query, limit: 1000 }, schema).total;
const buckets = (clause: AggregationClause, query: QueryState = base) => {
  const result = evaluateMetrics(rows, { ...query, aggregations: [clause] }, schema).metrics[0]!;
  expect(result.error).toBeUndefined();
  return result.buckets;
};

describe("inspectBucketQuery", () => {
  it("adds = for each group key and is_null for a null key", () => {
    const clause = metric({ groupBy: ["status", "paid"], expression: "COUNT()" });
    for (const bucket of buckets(clause)) {
      const query = inspectBucketQuery(base, bucket, clause, schema)!;
      expect(query.offset).toBe(0);
      expect(query.where[0]).toEqual(base.where[0]);
      expect(total(query)).toBe(bucket.count);
    }
    const nullStatus = inspectBucketQuery(base, { keys: [null, true], value: 1, count: 1 }, clause, schema)!;
    expect(nullStatus.where.slice(1)).toEqual([
      { field: "status", op: "is_null", value: "" },
      { field: "paid", op: "=", value: "true" },
    ]);
  });

  it("keeps legacy empty-text keys in the null bucket", () => {
    const clause = metric({ groupBy: ["owner"] });
    const result = applyAggregations(rows, { ...base, aggregations: [clause] }, schema).metrics[0]!;
    const empty = result.buckets.find((b) => b.keys[0] === null)!;
    expect(empty.count).toBe(2);
    const query = inspectBucketQuery(base, empty, clause, schema)!;
    expect(query.where.at(-1)).toEqual({ field: "owner", op: "is_null", value: "" });
    expect(total(query)).toBe(2);
  });

  it("does not duplicate a key filter that is already present", () => {
    const clause = metric({ groupBy: ["status"] });
    const query = { ...base, where: [...base.where, { field: "status", op: "=" as const, value: "open" }] };
    expect(inspectBucketQuery(query, { keys: ["open"], value: 3, count: 3 }, clause, schema)!.where).toEqual(query.where);
  });

  it("drills a grand total to the whole population", () => {
    const clause = metric({});
    const [bucket] = buckets(clause);
    const query = inspectBucketQuery(base, bucket!, clause, schema)!;
    expect(query).toEqual({ ...base, offset: 0 });
    expect(total(query)).toBe(bucket!.count);
  });

  it.each(["day", "week", "hour", "month"] as const)("turns %s buckets into [start, next) in the clause timezone", (interval) => {
    const clause = metric({
      groupBy: ["at"],
      expression: "COUNT()",
      dateGrouping: { field: "at", interval, timeZone: "America/Denver", includeEmpty: false, range: "observed" },
    });
    const result = buckets(clause);
    expect(result.length).toBeGreaterThan(0);
    for (const bucket of result) {
      const query = inspectBucketQuery(base, bucket, clause, schema)!;
      const [start, end] = query.where.slice(1) as WhereClause[];
      expect(start).toMatchObject({ field: "at", op: ">=" });
      expect(end).toMatchObject({ field: "at", op: "<" });
      expect(start!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(total(query)).toBe(bucket.count);
    }
  });

  it("uses the local calendar day, not the UTC day", () => {
    const clause = metric({
      groupBy: ["at"],
      dateGrouping: { field: "at", interval: "day", timeZone: "America/Denver", includeEmpty: false, range: "observed" },
    });
    // 2026-03-08 is the US DST start: the Denver day is 23 hours long.
    const query = inspectBucketQuery(base, { keys: ["2026-03-08T07:00:00.000Z"], value: 1, count: 1 }, clause, schema)!;
    expect(query.where.slice(1)).toEqual([
      { field: "at", op: ">=", value: "2026-03-08T07:00:00.000Z" },
      { field: "at", op: "<", value: "2026-03-09T06:00:00.000Z" },
    ]);
  });

  it("filters histogram bins on the distribution input", () => {
    const clause = metric({
      groupBy: ["paid"],
      display: { kind: "histogram" },
      distribution: { kind: "histogram", input: "[amount]", bins: 2 },
    });
    for (const cohort of buckets(clause)) {
      const histogram = cohort.distribution!;
      if (histogram.kind !== "histogram") throw Error("expected histogram");
      histogram.counts.forEach((count, i) => {
        const bin = { min: histogram.edges[i]!, max: histogram.edges[i + 1]!, inclusiveMax: i === histogram.counts.length - 1 };
        const query = inspectBucketQuery(base, { keys: cohort.keys, value: count, count, bin }, clause, schema)!;
        expect(total(query)).toBe(count);
      });
    }
    const last = inspectBucketQuery(base, { keys: [true], value: 1, count: 1, bin: { min: 5, max: 10, inclusiveMax: true } }, clause, schema)!;
    expect(last.where.slice(1)).toEqual([
      { field: "paid", op: "=", value: "true" },
      { field: "amount", op: ">=", value: "5" },
      { field: "amount", op: "<=", value: "10" },
    ]);
    const first = inspectBucketQuery(base, { keys: [true], value: 1, count: 1, bin: { min: 0, max: 0.1 + 0.2, inclusiveMax: false } }, clause, schema)!;
    expect(first.where.at(-1)).toEqual({ field: "amount", op: "<", value: "0.30000000000000004" });
  });

  it("returns null for histogram bins over expressions", () => {
    const clause = metric({ display: { kind: "histogram" }, distribution: { kind: "histogram", input: "[amount] * 2" } });
    expect(inspectBucketQuery(base, { keys: [], value: 1, count: 1, bin: { min: 0, max: 1, inclusiveMax: false } }, clause, schema)).toBeNull();
  });

  it("applies box cohort keys", () => {
    const clause = metric({ groupBy: ["status"], display: { kind: "box" }, distribution: { kind: "box", input: "[amount]" } });
    for (const bucket of buckets(clause)) expect(total(inspectBucketQuery(base, bucket, clause, schema)!)).toBe(bucket.count);
  });

  it("returns null when no exact query exists", () => {
    const clause = metric({ groupBy: ["status"] });
    const bucket: AggregationBucket = { keys: ["open"], value: 1, count: 1 };
    expect(inspectBucketQuery(base, bucket, { ...clause, scope: "shownRows" }, schema)).toBeNull();
    // An additive Other remainder carries no keys.
    expect(inspectBucketQuery(base, { keys: [], value: 4, count: 4 }, clause, schema)).toBeNull();
    expect(inspectBucketQuery(base, bucket, metric({ groupBy: ["secret"] }), schema)).toBeNull();
    expect(inspectBucketQuery(base, bucket, metric({ groupBy: ["missing"] }), schema)).toBeNull();
  });

  it("adds HAVING filters on group rows when the query is grouped", () => {
    const grouping: GroupingState = {
      keys: ["owner", "paid"],
      summaries: [{ id: "orders", op: "count" }],
      representative: null,
      source: { ...base, offset: 0, where: [{ field: "amount", op: ">=", value: "0" }] },
    };
    const query: QueryState = { ...EMPTY_QUERY, grouping, where: [{ field: "orders", op: ">=", value: "1" }] };
    const clause = metric({ groupBy: ["paid"], expression: "COUNT()" });
    for (const bucket of buckets(clause, query)) {
      const drilled = inspectBucketQuery(query, bucket, clause, schema)!;
      expect(drilled.grouping).toBe(grouping);
      expect(drilled.where).toEqual([...query.where, { field: "paid", op: "=", value: String(bucket.keys[0]) }]);
      const prepared = prepareGrouping(rows, schema, grouping);
      expect(applyQuery(prepared.rows, { ...withoutGrouping(drilled), limit: 1000 }, prepared.schema).total).toBe(bucket.count);
    }
  });
});

describe("groupSourceQuery", () => {
  const source: QueryState = {
    ...EMPTY_QUERY,
    select: [{ field: "id" }, { field: "amount", width: 90 }],
    where: [{ field: "amount", op: ">=", value: "0" }],
    orderBy: [{ field: "amount", dir: "desc" }],
    offset: 50,
    itemDetails: { modes: ["modal"] },
  };
  const grouped = (keys: string[]): QueryState => ({
    ...withGroupingKeys(source, keys),
    where: [{ field: "rows", op: ">", value: "0" }],
    grouping: { keys, summaries: [{ id: "rows", op: "count" }], representative: null, source },
  });

  it("keeps the source query, adds key filters and leaves grouping", () => {
    const query = grouped(["owner", "paid"]);
    const prepared = prepareGrouping(rows, schema, query.grouping!);
    for (const group of prepared.rows) {
      const drilled = groupSourceQuery(query, group, schema)!;
      expect(drilled.grouping).toBeUndefined();
      expect(drilled).toMatchObject({ select: source.select, orderBy: source.orderBy, itemDetails: source.itemDetails, offset: 0 });
      expect(drilled.where[0]).toEqual(source.where[0]);
      expect(applyQuery(rows, { ...drilled, limit: 1000 }, schema).total).toBe(group.rows);
    }
    expect(exitGrouping(query)).toBe(source);
  });

  it("encodes null keys as is_null and datetimes as ISO instants", () => {
    const query = grouped(["owner", "at"]);
    expect(groupSourceQuery(query, { owner: null, at: new Date("2026-03-07T06:30:00Z") }, schema)!.where.slice(1)).toEqual([
      { field: "owner", op: "is_null", value: "" },
      { field: "at", op: "=", value: "2026-03-07T06:30:00.000Z" },
    ]);
    expect(groupSourceQuery(query, { owner: "ana", at: "2026-03-07T08:30:00+02:00" }, schema)!.where.at(-1)).toEqual({
      field: "at", op: "=", value: "2026-03-07T06:30:00.000Z",
    });
    expect(groupSourceQuery(query, { owner: "ana", at: "not a date" }, schema)).toBeNull();
  });

  it("rejects textarray keys and ungrouped queries", () => {
    expect(groupSourceQuery(grouped(["tags"]), { tags: ["a"] }, schema)).toBeNull();
    expect(groupSourceQuery(source, { owner: "ana" }, schema)).toBeNull();
  });
});
