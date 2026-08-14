import { describe, it, expect } from "vitest";
import {
  encodeQuery,
  decodeQuery,
  toServerQuery,
  normalizeQueryState,
  EMPTY_QUERY,
  MAX_QUERY_LIMIT,
  MAX_QUERY_OFFSET,
  MAX_WHERE_CLAUSES,
  MAX_QUERY_TOKEN_LENGTH,
} from "../src/index";
import type { QueryState } from "../src/index";
import { runsSchema } from "./fixtures";

describe("encodeQuery / decodeQuery", () => {
  it("round-trips a full query including widths and multi-sort", () => {
    const q: QueryState = {
      select: [{ field: "case_name", width: 200 }, { field: "overall" }],
      where: [{ field: "overall", op: "=", value: "FAIL" }],
      orderBy: [
        { field: "total_ms", dir: "desc", nulls: "last" },
        { field: "case_name", dir: "asc" },
      ],
      limit: 50,
      offset: 100,
    };
    expect(decodeQuery(encodeQuery(q))).toEqual(q);
  });

  it("encodes an all-default query with explicit defaults", () => {
    const token = encodeQuery(EMPTY_QUERY);
    expect(token).not.toBe("");
    expect(decodeQuery(token)).toEqual(EMPTY_QUERY);
  });

  it("never throws on garbage input", () => {
    expect(decodeQuery("!!!not base64!!!")).toEqual(EMPTY_QUERY);
    expect(decodeQuery("x".repeat(MAX_QUERY_TOKEN_LENGTH + 1))).toEqual(EMPTY_QUERY);
  });

  it("decodes the legacy single-object orderBy and string[] columns", () => {
    // legacy compact shape: o is an object, c is string[]
    const legacy = Buffer.from(
      JSON.stringify({ o: { field: "total_ms", dir: "desc" }, c: ["case_name", "overall"], l: 50 }),
      "utf8",
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const q = decodeQuery(legacy);
    expect(q.orderBy).toEqual([{ field: "total_ms", dir: "desc" }]);
    expect(q.select).toEqual([{ field: "case_name" }, { field: "overall" }]);
    expect(q.limit).toBe(50);
  });

  it("bounds paging and drops malformed clauses from an untrusted token", () => {
    const token = Buffer.from(
      JSON.stringify({
        w: [
          { field: "overall", op: "=", value: "FAIL" },
          { field: "overall", op: "DROP TABLE", value: "FAIL" },
          { field: "overall", op: "=", value: { nested: true } },
        ],
        o: [
          { field: "total_ms", dir: "desc" },
          { field: "total_ms", dir: "sideways" },
        ],
        l: Number.MAX_SAFE_INTEGER,
        f: Number.MAX_SAFE_INTEGER,
      }),
      "utf8",
    ).toString("base64url");

    expect(decodeQuery(token)).toMatchObject({
      where: [{ field: "overall", op: "=", value: "FAIL" }],
      orderBy: [{ field: "total_ms", dir: "desc" }],
      limit: MAX_QUERY_LIMIT,
      offset: MAX_QUERY_OFFSET,
    });
  });
});

describe("normalizeQueryState", () => {
  it("does not impose an application-level 1,000-row limit", () => {
    expect(normalizeQueryState({ ...EMPTY_QUERY, limit: 10_000 }).limit).toBe(10_000);
  });

  it("normalizes arbitrary runtime input into a bounded QueryState", () => {
    const where = Array.from({ length: MAX_WHERE_CLAUSES + 20 }, (_, i) => ({
      field: `field_${i}`,
      op: "=",
      value: String(i),
    }));
    const q = normalizeQueryState({
      select: [{ field: "name", width: 999_999 }, null],
      where,
      orderBy: [{ field: "name", dir: "asc", nulls: "invalid" }],
      limit: Infinity,
      offset: -50,
      aggregations: [{ id: "a", op: "execute", groupBy: [] }],
    });

    expect(q.select).toEqual([{ field: "name", width: 2_000 }]);
    expect(q.where).toHaveLength(MAX_WHERE_CLAUSES);
    expect(q.orderBy).toEqual([{ field: "name", dir: "asc" }]);
    expect(q.limit).toBe(EMPTY_QUERY.limit);
    expect(q.offset).toBe(0);
    expect(q.aggregations).toBeUndefined();
  });
});

describe("toServerQuery", () => {
  it("drops client-only filters, keeps pushdown filters, remaps sort fields", () => {
    const q: QueryState = {
      select: [{ field: "case_name" }],
      where: [
        { field: "overall", op: "=", value: "FAIL" }, // pushdown
        { field: "error_codes", op: "includes", value: "eval" }, // pushdown:false → client-only
      ],
      orderBy: [{ field: "is_starred", dir: "desc" }], // sort.field === "is_starred"
      limit: 25,
      offset: 0,
    };
    const sq = toServerQuery(q, runsSchema);
    expect(sq.where).toEqual([{ field: "overall", op: "=", value: "FAIL" }]);
    expect(sq.orderBy).toEqual([{ field: "is_starred", dir: "desc" }]);
    // select carries: visible columns ∪ id ∪ client-filtered backend column
    expect(new Set(sq.select)).toEqual(new Set(["case_name", "id", "error_codes"]));
  });

  it("enforces paging bounds even for a directly constructed typed query", () => {
    const sq = toServerQuery(
      { ...EMPTY_QUERY, limit: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER },
      runsSchema,
    );
    expect(sq.limit).toBe(MAX_QUERY_LIMIT);
    expect(sq.offset).toBe(MAX_QUERY_OFFSET);
  });
});
