import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyQuery, applyAggregations, matchesClause, coerceValue, parseRelativeDuration, negateClause, encodeQuery, decodeQuery, toServerQuery, toAggregationQuery, EMPTY_QUERY, OPS_BY_TYPE } from "../src/index";
import type { FieldSchema, FilterOp, QueryState, WhereClause } from "../src/index";

const fixtures = JSON.parse(readFileSync(new URL("../../../schema/fixtures/relative-time.json", import.meta.url), "utf8")) as {
  valid: { value: string; offsetMs: number }[]; invalid: string[];
};
const now = Date.parse("2026-03-08T10:00:00Z"); // DST transition: d is still 24 hours.
type Row = { id: number; at: string | null };
const schema: FieldSchema<Row> = { name: "events", idField: "id", fields: [
  { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
  { name: "at", label: "Time", type: "datetime", aliases: ["time"], source: { kind: "backend" } },
] };
const rows: Row[] = [-3600001, -3600000, -1, 0, 3599999, 3600000].map((offset, id) => ({ id, at: new Date(now + offset).toISOString() }));
rows.push({ id: 6, at: null }, { id: 7, at: "invalid" });
const clause = (value: string, op: FilterOp = ">="): WhereClause => ({ field: "at", op, value });
const query = (where: QueryState["where"]): QueryState => ({ ...EMPTY_QUERY, where });
const ids = (where: QueryState["where"]) => applyQuery(rows, query(where), schema, { now }).rows.map(r => r.id);

describe("signed datetime duration values", () => {
  it("matches the shared duration fixtures", () => {
    for (const f of fixtures.valid) expect(parseRelativeDuration(f.value), f.value).toBe(f.offsetMs);
    for (const value of fixtures.invalid) expect(parseRelativeDuration(value), value).toBeNull();
  });
  it("keeps existing operators and expresses bounds using ordinary predicates", () => {
    expect(OPS_BY_TYPE.datetime).toEqual(["=", "!=", ">", ">=", "<", "<=", "is_null", "is_not_null"]);
    expect(ids([clause("-1h"), clause("+0s", "<")])).toEqual([1,2]);
    expect(ids([negateClause(clause("-1h"))])).toEqual([0]);
    expect(ids([{ any: [clause("-1h", "="), clause("+1h", "=")] }])).toEqual([1,5]);
    expect(matchesClause(rows[1]!, { ...clause("-1h", "="), field: "time" }, schema, { now })).toBe(true);
  });
  it("coerces compound offsets and compares instants for every comparison operator", () => {
    for (const [op, expected] of [["=", [5]], ["!=", [0,1,2,3,4]], [">", []], [">=", [5]], ["<", [0,1,2,3,4]], ["<=", [0,1,2,3,4,5]]] as [FilterOp, number[]][]) {
      expect(ids([clause("+1h", op)])).toEqual(expected);
    }
    expect(matchesClause({ id: 1, at: "2026-03-08T03:00:00-07:00" }, clause("+0s", "="), schema, { now })).toBe(true);
    expect(coerceValue("datetime", "-1d", now)).toBe(now - 86400000);
    expect(coerceValue("datetime", "+8d2h10m", now)).toBe(now + 699000000);
    expect(coerceValue("text", "+8d2h10m", now)).toBe("+8d2h10m");
    expect(() => coerceValue("number", "-1h", now)).toThrow();
  });
  it("rejects malformed offsets before scanning empty rows or negated OR branches", () => {
    for (const value of fixtures.invalid.filter(v => v.startsWith("+") || v.startsWith("-"))) {
      expect(() => applyQuery([], query([negateClause(clause(value))]), schema, { now })).toThrow();
    }
    expect(() => ids([{ any: [clause("+1h"), clause("+1h-2m")] }])).toThrow();
    expect(() => applyQuery(rows, query([clause("+1ms")]), schema, { now: 8_640_000_000_000_000 })).toThrow();
    for (const value of ["last 7d", "now", "1h ago", "1h from now"]) expect(() => ids([clause(value)])).toThrow();
  });
  it("captures one local clock per execution and advances on reexecution", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const q = query([clause("-1h"), clause("+0s", "<")]);
      expect(applyQuery(rows, q, schema).rows.map(r => r.id)).toEqual([1,2]);
      expect(clock).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(now + 3600000);
      expect(applyQuery(rows, q, schema).rows.map(r => r.id)).toEqual([3,4]);
    } finally { clock.mockRestore(); }
  });
  it("preserves signed values and the original wire shape in URLs and server requests", () => {
    const q = { ...query([clause("-1h"), clause("+0s", "<")]), aggregations: [{ id: "count", op: "count" as const, groupBy: [] }] };
    expect(decodeQuery(encodeQuery(q))).toEqual(q);
    expect(toServerQuery(q, schema)).toEqual({ select: ["id"], where: q.where, orderBy: [], limit: 100, offset: 0 });
    expect(toAggregationQuery(q, schema)).toEqual({ where: q.where, aggregations: q.aggregations });
    expect(applyAggregations(rows, q, schema, { now }).metrics[0]?.buckets[0]?.value).toBe(2);
  });
});
