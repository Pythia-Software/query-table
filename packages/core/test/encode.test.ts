import { describe, it, expect } from "vitest";
import { encodeQuery, decodeQuery, toServerQuery, EMPTY_QUERY } from "../src/index";
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
});

describe("toServerQuery", () => {
  it("drops client-only filters, keeps pushdown filters, remaps sort fields", () => {
    const q: QueryState = {
      select: [{ field: "case_name" }],
      where: [
        { field: "overall", op: "=", value: "FAIL" }, // pushdown
        { field: "failed_steps", op: "includes", value: "eval" }, // pushdown:false → client-only
      ],
      orderBy: [{ field: "is_starred", dir: "desc" }], // sort.field === "is_starred"
      limit: 25,
      offset: 0,
    };
    const sq = toServerQuery(q, runsSchema);
    expect(sq.where).toEqual([{ field: "overall", op: "=", value: "FAIL" }]);
    expect(sq.orderBy).toEqual([{ field: "is_starred", dir: "desc" }]);
    // select carries: visible columns ∪ id ∪ client-filtered backend column
    expect(new Set(sq.select)).toEqual(new Set(["case_name", "id", "failed_steps"]));
  });
});
