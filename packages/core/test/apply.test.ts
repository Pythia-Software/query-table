import { describe, it, expect } from "vitest";
import { applyQuery, applyAggregations, EMPTY_QUERY } from "../src/index";
import type { FieldSchema, QueryState } from "../src/index";
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


describe("regex execution with computed SELECT columns", () => {
  it("applies backend-field regex operations while excluding computed filters, sorts, and metrics", () => {
    const field = "@computed/prefix";
    const schema: FieldSchema<(typeof rows)[number]> = {
      ...runsSchema,
      fields: [...runsSchema.fields, {
        name: field, label: "Prefix", type: "text",
        source: { kind: "derived", computedId: "prefix", accessor: () => {
          throw new Error("Data operations must not evaluate computed columns");
        } },
      }],
    };
    const input = [
      { ...rows[0]!, case_name: "item-3" },
      { ...rows[1]!, case_name: "item-20" },
      { ...rows[2]!, case_name: "other" },
    ];
    // Deliberately bypass normalization to verify the executor's own guard.
    const query = base({
      select: [{ field }],
      where: [
        { field, op: "matches_regex", value: "[" },
        { field: "case_name", op: "matches_regex", value: "^item-" },
      ],
      orderBy: [
        { field, dir: "asc", extract: { regex: "(.)" } },
        { field: "case_name", dir: "asc", extract: { regex: "item-([0-9]+)" } },
      ],
      aggregations: [
        { id: "count", op: "count", groupBy: [] },
        { id: "computed-measure", op: "count_distinct", field, groupBy: [] },
        { id: "computed-group", op: "count", groupBy: [field] },
      ],
    });
    const result = applyQuery(input, query, schema);
    expect(result.rows.map(row => row.id)).toEqual([2, 1]);
    expect(result.total).toBe(2);
    expect(applyAggregations(input, query, schema)).toEqual({
      metrics: [{ id: "count", buckets: [{ keys: [], count: 2, value: 2 }] }],
    });
  });
});

it("supports opt-in exact array keys for rows, CNF negation, pagination and metrics", () => {
  const data = [{ id: 1, tags: ["Bug"] }, { id: 2, tags: ["bug"] }, { id: 3, tags: [] }];
  const schema: FieldSchema<(typeof data)[number]> = {
    name: "labels", idField: "id", fields: [{ name: "tags", label: "Tags", type: "textarray",
      source: { kind: "backend", path: "tags" }, filter: { arrayCaseSensitive: true } }],
  };
  const clause = { field: "tags", op: "includes" as const, value: "Bug" };
  const query = base({ where: [clause], limit: 1, aggregations: [{ id: "n", op: "count", groupBy: [] }] });
  expect(applyQuery(data, query, schema)).toEqual({ rows: [data[0]], total: 1 });
  expect(applyAggregations(data, query, schema).metrics[0]!.buckets[0]!.value).toBe(1);
  expect(applyQuery(data, base({ where: [{ ...clause, negated: true }] }), schema).rows).toEqual([data[1]]);
  expect(applyQuery(data, base({ where: [{ any: [{ ...clause, negated: true },
    { field: "tags", op: "is_null", value: "" }] }] }), schema).rows).toEqual([data[1], data[2]]);
  schema.fields[0]!.filter = {};
  expect(applyQuery(data, query, schema).total).toBe(2);
});
