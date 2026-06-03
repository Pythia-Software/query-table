import { describe, it, expect } from "vitest";
import {
  applyAggregations,
  encodeQuery,
  decodeQuery,
  toAggregationQuery,
  aggOpsForField,
  isGroupable,
  isMeasurable,
} from "../src/index";
import type { AggregationClause, QueryState } from "../src/index";
import { runsSchema, rows } from "./fixtures";

const base: Omit<QueryState, "aggregations"> = {
  select: [],
  where: [],
  orderBy: [],
  limit: 100,
  offset: 0,
};

function bucketsById(q: QueryState, id: string) {
  const res = applyAggregations(rows, q, runsSchema);
  return res.metrics.find((m) => m.id === id)?.buckets ?? [];
}

describe("applyAggregations", () => {
  it("counts all rows as a single grand-total bucket", () => {
    const agg: AggregationClause = { id: "c", op: "count", groupBy: [] };
    const buckets = bucketsById({ ...base, aggregations: [agg] }, "c");
    expect(buckets).toEqual([{ keys: [], value: 4, count: 4 }]);
  });

  it("breaks a count down by one group field", () => {
    const agg: AggregationClause = { id: "byp", op: "count", groupBy: ["platform"] };
    const buckets = bucketsById({ ...base, aggregations: [agg] }, "byp");
    const byKey = Object.fromEntries(buckets.map((b) => [String(b.keys[0]), b.value]));
    expect(byKey).toEqual({ windows: 2, macos: 2 });
  });

  it("averages a numeric measure by group, ignoring nulls", () => {
    // total_ms: alpha=120(win), bravo=999(mac), charlie=null(win), delta=50(mac)
    const agg: AggregationClause = { id: "avg", op: "avg", field: "total_ms", groupBy: ["platform"] };
    const buckets = bucketsById({ ...base, aggregations: [agg] }, "avg");
    const byKey = Object.fromEntries(buckets.map((b) => [String(b.keys[0]), b.value]));
    expect(byKey.windows).toBe(120); // null charlie excluded → avg of [120]
    expect(byKey.macos).toBe((999 + 50) / 2);
  });

  it("respects WHERE but ignores limit/offset (whole filtered set)", () => {
    const agg: AggregationClause = { id: "c", op: "count", groupBy: [] };
    const q: QueryState = {
      ...base,
      where: [{ field: "overall", op: "=", value: "FAIL" }],
      limit: 1,
      offset: 10, // would page past everything for the table, but agg ignores it
      aggregations: [agg],
    };
    expect(bucketsById(q, "c")).toEqual([{ keys: [], value: 2, count: 2 }]);
  });

  it("supports a two-axis (pivot) breakdown with one bucket per (k0,k1)", () => {
    const agg: AggregationClause = { id: "xy", op: "count", groupBy: ["platform", "overall"] };
    const buckets = bucketsById({ ...base, aggregations: [agg] }, "xy");
    // 4 rows, all distinct (platform, overall) pairs → 4 buckets, each count 1.
    expect(buckets).toHaveLength(4);
    expect(buckets.every((b) => b.keys.length === 2 && b.count === 1)).toBe(true);
    // the null `overall` (delta) becomes a null key, not "null"
    expect(buckets.some((b) => b.keys[0] === "macos" && b.keys[1] === null)).toBe(true);
  });

  it("min/max return the column's value (typed), count_distinct counts uniques", () => {
    const mx = bucketsById({ ...base, aggregations: [{ id: "m", op: "max", field: "total_ms", groupBy: [] }] }, "m");
    expect(mx[0]?.value).toBe(999);
    const cd = bucketsById(
      { ...base, aggregations: [{ id: "d", op: "count_distinct", field: "platform", groupBy: [] }] },
      "d",
    );
    expect(cd[0]?.value).toBe(2);
  });
});

describe("aggregation encode round-trip + projection", () => {
  it("round-trips aggregations through ?q=", () => {
    const q: QueryState = {
      ...base,
      aggregations: [
        { id: "a1", op: "avg", field: "total_ms", groupBy: ["platform", "overall"], label: "avg total" },
        { id: "a2", op: "count", groupBy: [] },
      ],
    };
    expect(decodeQuery(encodeQuery(q)).aggregations).toEqual(q.aggregations);
  });

  it("omits aggregations from the token when empty", () => {
    expect(decodeQuery(encodeQuery(base as QueryState)).aggregations).toBeUndefined();
  });

  it("toAggregationQuery keeps pushdown WHERE and drops derived-field metrics", () => {
    const q: QueryState = {
      ...base,
      where: [
        { field: "overall", op: "=", value: "FAIL" }, // pushdown
        { field: "failed_steps", op: "includes", value: "eval" }, // pushdown:false → dropped
      ],
      aggregations: [
        { id: "ok", op: "avg", field: "total_ms", groupBy: ["platform"] },
        { id: "bad", op: "count", groupBy: ["deviations"] }, // derived group field → dropped
      ],
    };
    const req = toAggregationQuery(q, runsSchema);
    expect(req.where).toEqual([{ field: "overall", op: "=", value: "FAIL" }]);
    expect(req.aggregations.map((a) => a.id)).toEqual(["ok"]);
  });
});

describe("aggregate capability helpers", () => {
  it("derives measurability/groupability from type + source", () => {
    const byName = new Map(runsSchema.fields.map((f) => [f.name, f]));
    expect(isMeasurable(byName.get("total_ms")!)).toBe(true);
    expect(isGroupable(byName.get("platform")!)).toBe(true); // enum
    expect(isGroupable(byName.get("total_ms")!)).toBe(false); // number, no bucketing
    expect(isMeasurable(byName.get("deviations")!)).toBe(false); // derived
    expect(aggOpsForField(byName.get("total_ms")!)).toContain("sum");
    expect(aggOpsForField(byName.get("overall")!)).not.toContain("sum"); // enum
  });
});
