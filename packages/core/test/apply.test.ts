import { describe, it, expect } from "vitest";
import { applyQuery, applyAggregations, EMPTY_QUERY } from "../src/index";
import type { FieldSchema, QueryState } from "../src/index";
import { runsSchema, rows } from "./fixtures";

const base = (over: Partial<QueryState>): QueryState => ({
  ...EMPTY_QUERY,
  ...over,
});

it("keeps count_distinct and neighboring legacy aggregates compatible with host datetime representations and group keys", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const schema: FieldSchema<{ id: number; at: unknown; group: unknown }> = {
    name: "legacy",
    idField: "id",
    fields: [
      { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
      {
        name: "at",
        label: "At",
        type: "datetime",
        source: { kind: "backend" },
      },
      {
        name: "group",
        label: "Group",
        type: "number",
        source: { kind: "backend" },
      },
    ],
  };
  for (const at of [date.getTime(), "2026-01-01 00:00:00", date]) {
    const rows = [
      { id: 1, at, group: date },
      { id: 2, at, group: date },
    ];
    const result = applyAggregations(
      rows,
      base({
        aggregations: [
          { id: "distinct", op: "count_distinct", field: "at", groupBy: [] },
          { id: "min", op: "min", field: "at", groupBy: [] },
          { id: "grouped", op: "count", groupBy: ["group"] },
          { id: "modern", op: "count", groupBy: [], scope: "allMatching" },
        ],
      }),
      schema,
    );
    expect(result.metrics).toEqual([
      { id: "distinct", buckets: [{ keys: [], count: 2, value: 1 }] },
      { id: "min", buckets: [{ keys: [], count: 2, value: at }] },
      {
        id: "grouped",
        buckets: [{ keys: [String(date)], count: 2, value: 2 }],
      },
      {
        id: "modern",
        buckets: [{ keys: [], count: 2, value: 2 }],
        scope: "allMatching",
        coverage: "exact",
        groupCount: 1,
        processedRows: 2,
      },
    ]);
  }
});

describe("applyQuery — filtering", () => {
  it("equality on enum", () => {
    const r = applyQuery(
      rows,
      base({ where: [{ field: "overall", op: "=", value: "FAIL" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
    expect(r.total).toBe(2);
  });

  it("numeric comparison", () => {
    const r = applyQuery(
      rows,
      base({ where: [{ field: "total_ms", op: ">", value: "100" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([1, 2]);
  });

  it("textarray includes (case-insensitive)", () => {
    const r = applyQuery(
      rows,
      base({
        where: [{ field: "error_codes", op: "includes", value: "EVAL" }],
      }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
  });

  it("is_null treats empty array and null alike", () => {
    const r = applyQuery(
      rows,
      base({ where: [{ field: "error_codes", op: "is_null", value: "" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([1, 4]); // null + []
  });

  it("contains on text", () => {
    const r = applyQuery(
      rows,
      base({ where: [{ field: "case_name", op: "contains", value: "ra" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2]); // only "bravo" contains "ra"
  });

  it("filters text above or below a character length", () => {
    const over = (value: string) =>
      applyQuery(
        rows,
        base({ where: [{ field: "case_name", op: "length_gt", value }] }),
        runsSchema,
      ).rows.map((r) => r.id);
    const under = (value: string) =>
      applyQuery(
        rows,
        base({ where: [{ field: "case_name", op: "length_lt", value }] }),
        runsSchema,
      ).rows.map((r) => r.id);
    expect(over("5")).toEqual([3]);
    expect(under("5")).toEqual([]);
    expect(under("6")).toEqual([1, 2, 4]);
    expect(over("bad")).toEqual([]);
    expect(under("-1")).toEqual([]);
    expect(over("5.5")).toEqual([]);
    expect(
      applyQuery(
        [{ ...rows[0]!, case_name: "😀a" }],
        base({ where: [{ field: "case_name", op: "length_gt", value: "1" }] }),
        runsSchema,
      ).total,
    ).toBe(1);
    const withEmpty = [
      ...rows,
      { ...rows[0]!, id: 5, case_name: "" },
      { ...rows[0]!, id: 6, case_name: null },
    ];
    const matching = (op: "length_eq" | "length_gt", value: string) =>
      applyQuery(
        withEmpty,
        base({ where: [{ field: "case_name", op, value }] }),
        runsSchema,
      ).rows.map((r) => r.id);
    expect(matching("length_eq", "0")).toEqual([5]);
    expect(matching("length_gt", "0")).toEqual([1, 2, 3, 4]);
  });

  it("matches and rejects a regular expression on text", () => {
    const matching = applyQuery(
      rows,
      base({
        where: [
          {
            field: "case_name",
            op: "matches_regex",
            value: "^(alpha|charlie)$",
          },
        ],
      }),
      runsSchema,
    );
    expect(matching.rows.map((x) => x.id)).toEqual([1, 3]);

    const notMatching = applyQuery(
      rows,
      base({
        where: [{ field: "case_name", op: "not_matches_regex", value: "a$" }],
      }),
      runsSchema,
    );
    expect(notMatching.rows.map((x) => x.id)).toEqual([2, 3]);
  });

  it("fails closed for an invalid regular expression", () => {
    const r = applyQuery(
      rows,
      base({
        where: [{ field: "case_name", op: "matches_regex", value: "[" }],
      }),
      runsSchema,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("applyQuery — multi-sort + nulls + pagination", () => {
  it("nulls sort last by default", () => {
    const r = applyQuery(
      rows,
      base({ orderBy: [{ field: "total_ms", dir: "asc" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([4, 1, 2, 3]); // 50,120,999,null
  });

  it("nulls:first places nulls ahead", () => {
    const r = applyQuery(
      rows,
      base({ orderBy: [{ field: "total_ms", dir: "asc", nulls: "first" }] }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([3, 4, 1, 2]);
  });

  it("multi-sort: primary then tiebreak", () => {
    const r = applyQuery(
      rows,
      base({
        orderBy: [
          { field: "platform", dir: "asc" },
          { field: "case_name", dir: "desc" },
        ],
      }),
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
      base({
        orderBy: [
          { field: "case_name", dir: "asc", extract: { regex: "item-(\\d+)" } },
        ],
      }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2, 1, 3]); // lexical capture order: "20", "3", then NULL
  });

  it("paginates after filter+sort and reports pre-pagination total", () => {
    const r = applyQuery(
      rows,
      base({ orderBy: [{ field: "id", dir: "asc" }], limit: 2, offset: 1 }),
      runsSchema,
    );
    expect(r.rows.map((x) => x.id)).toEqual([2, 3]);
    expect(r.total).toBe(4);
  });
});

describe("regex execution with computed SELECT columns", () => {
  it("keeps row regex behavior but refuses unisolated metric populations", () => {
    const field = "@computed/prefix";
    const schema: FieldSchema<(typeof rows)[number]> = {
      ...runsSchema,
      fields: [
        ...runsSchema.fields,
        {
          name: field,
          label: "Prefix",
          type: "text",
          source: {
            kind: "derived",
            computedId: "prefix",
            accessor: () => {
              throw new Error(
                "Data operations must not evaluate computed columns",
              );
            },
          },
        },
      ],
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
    expect(result.rows.map((row) => row.id)).toEqual([2, 1]);
    expect(result.total).toBe(2);
    const metrics = applyAggregations(input, query, schema).metrics;
    expect(metrics).toHaveLength(3);
    expect(
      metrics.every((metric) => metric.error && metric.buckets.length === 0),
    ).toBe(true);
  });
});

it("supports opt-in exact array keys for rows, CNF negation, pagination and metrics", () => {
  const data = [
    { id: 1, tags: ["Bug"] },
    { id: 2, tags: ["bug"] },
    { id: 3, tags: [] },
  ];
  const schema: FieldSchema<(typeof data)[number]> = {
    name: "labels",
    idField: "id",
    fields: [
      {
        name: "tags",
        label: "Tags",
        type: "textarray",
        source: { kind: "backend", path: "tags" },
        filter: { arrayCaseSensitive: true },
      },
    ],
  };
  const clause = { field: "tags", op: "includes" as const, value: "Bug" };
  const query = base({
    where: [clause],
    limit: 1,
    aggregations: [{ id: "n", op: "count", groupBy: [] }],
  });
  expect(applyQuery(data, query, schema)).toEqual({
    rows: [data[0]],
    total: 1,
  });
  expect(
    applyAggregations(data, query, schema).metrics[0]!.buckets[0]!.value,
  ).toBe(1);
  expect(
    applyQuery(data, base({ where: [{ ...clause, negated: true }] }), schema)
      .rows,
  ).toEqual([data[1]]);
  expect(
    applyQuery(
      data,
      base({
        where: [
          {
            any: [
              { ...clause, negated: true },
              { field: "tags", op: "is_null", value: "" },
            ],
          },
        ],
      }),
      schema,
    ).rows,
  ).toEqual([data[1], data[2]]);
  schema.fields[0]!.filter = {};
  expect(applyQuery(data, query, schema).total).toBe(2);
});

it("retains legacy numeric coercion next to a formula and folds empty/null grouping keys for drilldown", () => {
  const schema: FieldSchema<{ id: number; x: unknown; g: string | null }> = {
    name: "mixed",
    idField: "id",
    fields: [
      { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
      { name: "x", label: "X", type: "number", source: { kind: "backend" } },
      { name: "g", label: "G", type: "text", source: { kind: "backend" } },
    ],
  };
  const rows = [
    { id: 1, x: "12", g: "" },
    { id: 2, x: "8", g: null },
  ];
  const result = applyAggregations(
    rows,
    base({
      aggregations: [
        { id: "sum", op: "sum", field: "x", groupBy: ["g"] },
        { id: "formula", op: "count", expression: "COUNT() * 2", groupBy: [] },
      ],
    }),
    schema,
  );
  expect(result.metrics[0]).toEqual({
    id: "sum",
    buckets: [{ keys: [null], count: 2, value: 20 }],
  });
  expect(result.metrics[1]?.buckets[0]?.value).toBe(4);
  expect(
    applyQuery(
      rows,
      base({ where: [{ field: "g", op: "is_null", value: "" }] }),
      schema,
    ).total,
  ).toBe(result.metrics[0]?.buckets[0]?.count);
});

it("keeps mixed-dashboard query-wide card limits", () => {
  const legacy = { id: "legacy", op: "count" as const, groupBy: [] };
  const modern = {
    id: "modern",
    op: "count" as const,
    groupBy: [],
    expression: "COUNT()",
  };
  const tooMany = applyAggregations(
    rows,
    base({
      aggregations: [
        modern,
        ...Array.from({ length: 20 }, (_, i) => ({
          ...legacy,
          id: `legacy${i}`,
        })),
      ],
    }),
    runsSchema,
  );
  expect(tooMany.metrics).toHaveLength(21);
  expect(
    tooMany.metrics.every((m) =>
      m.error?.includes("Malformed metric definitions"),
    ),
  ).toBe(true);
});
