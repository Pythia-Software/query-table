import { describe, it, expect } from "vitest";
import { applyQuery, EMPTY_QUERY } from "../src/index";
import type { QueryState } from "../src/index";
import { runsSchema, rows } from "./fixtures";

const base = (over: Partial<QueryState>): QueryState => ({ ...EMPTY_QUERY, ...over });

describe("applyQuery — filtering", () => {
  it("equality on enum", () => {
    const r = applyQuery(rows, base({ where: [{ field: "overall", op: "=", value: "FAIL" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
    expect(r.total).toBe(2);
  });

  it("numeric comparison", () => {
    const r = applyQuery(rows, base({ where: [{ field: "total_ms", op: ">", value: "100" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([1, 2]);
  });

  it("textarray includes (case-insensitive)", () => {
    const r = applyQuery(rows, base({ where: [{ field: "error_codes", op: "includes", value: "EVAL" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
  });

  it("is_null treats empty array and null alike", () => {
    const r = applyQuery(rows, base({ where: [{ field: "error_codes", op: "is_null", value: "" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([1, 4]); // null + []
  });

  it("contains on text", () => {
    const r = applyQuery(rows, base({ where: [{ field: "case_name", op: "contains", value: "ra" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([2]); // only "bravo" contains "ra"
  });

  it("matches and rejects a regular expression on text", () => {
    const matching = applyQuery(
      rows,
      base({ where: [{ field: "case_name", op: "matches_regex", value: "^(alpha|charlie)$" }] }),
      runsSchema,
    );
    expect(matching.rows.map((x) => x.id)).toEqual([1, 3]);

    const notMatching = applyQuery(
      rows,
      base({ where: [{ field: "case_name", op: "not_matches_regex", value: "a$" }] }),
      runsSchema,
    );
    expect(notMatching.rows.map((x) => x.id)).toEqual([2, 3]);
  });

  it("fails closed for an invalid regular expression", () => {
    const r = applyQuery(rows, base({ where: [{ field: "case_name", op: "matches_regex", value: "[" }] }), runsSchema);
    expect(r.rows).toEqual([]);
  });
});

describe("applyQuery — multi-sort + nulls + pagination", () => {
  it("nulls sort last by default", () => {
    const r = applyQuery(rows, base({ orderBy: [{ field: "total_ms", dir: "asc" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([4, 1, 2, 3]); // 50,120,999,null
  });

  it("nulls:first places nulls ahead", () => {
    const r = applyQuery(rows, base({ orderBy: [{ field: "total_ms", dir: "asc", nulls: "first" }] }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([3, 4, 1, 2]);
  });

  it("multi-sort: primary then tiebreak", () => {
    const r = applyQuery(
      rows,
      base({ orderBy: [{ field: "platform", dir: "asc" }, { field: "case_name", dir: "desc" }] }),
      runsSchema,
    );
    // macos: delta,bravo ; windows: charlie,alpha
    expect(r.rows.map((x) => x.id)).toEqual([4, 2, 3, 1]);
  });

  it("sorts by a regex capture and treats non-matches as null", () => {
    const extractedRows = [
      { ...rows[0]!, case_name: "item-3" },
      { ...rows[1]!, case_name: "item-20" },
      { ...rows[2]!, case_name: "other" },
    ];
    const r = applyQuery(
      extractedRows,
      base({ orderBy: [{ field: "case_name", dir: "asc", extract: { regex: "item-(\\d+)" } }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2, 1, 3]); // lexical capture order: "20", "3", then NULL
  });

  it("paginates after filter+sort and reports pre-pagination total", () => {
    const r = applyQuery(rows, base({ orderBy: [{ field: "id", dir: "asc" }], limit: 2, offset: 1 }), runsSchema);
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
    expect(r.total).toBe(4);
  });
});
