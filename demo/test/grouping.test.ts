import { describe, expect, it } from "vitest";
import {
  applyQuery,
  normalizeQueryState,
  type FieldSchema,
} from "@pythia-software/query-table-core";
import {
  filteredInput,
  groupRows,
  inputRows,
  inputSchema,
  parseView,
  parseRepresentative,
  reconcileRepresentative,
  resultSchema,
  seedViews,
  type Row,
  type SummaryColumn,
  type RepresentativeRow,
} from "../src/grouping/model";

const summaries: SummaryColumn[] = [
  { id: "n", op: "count" },
  { id: "non_null", op: "count", field: "total_ms" },
  { id: "avg", op: "avg", field: "total_ms" },
  { id: "sum", op: "sum", field: "total_ms" },
  { id: "min", op: "min", field: "total_ms" },
  { id: "max", op: "max", field: "total_ms" },
  { id: "distinct", op: "count_distinct", field: "total_ms" },
];
const row = (
  id: number,
  platform: unknown,
  total_ms: number | null,
  job_name = `job-${id}`,
  enqueued_at: string | null = "2026-05-01T00:00:00Z",
): Row => ({ id, platform, total_ms, job_name, enqueued_at });
const order = (
  field: string,
  dir: "asc" | "desc" = "desc",
  nulls: "first" | "last" = "last",
): RepresentativeRow => ({ orderBy: [{ field, dir, nulls }] });

describe("row-producing GROUP BY with demo fixtures", () => {
  it("groups every source match, independent of the detail page and order", () => {
    const query = normalizeQueryState({
      where: [{ field: "platform", op: "=", value: "linux" }],
      limit: 1,
      offset: 2,
      orderBy: [{ field: "id", dir: "desc" }],
    });
    const inputs = filteredInput(inputRows, query, inputSchema);
    expect(inputs.length).toBe(
      inputRows.filter((r) => r.platform === "linux").length,
    );
    const groups = groupRows(inputs, inputSchema, ["platform"], summaries);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.n).toBe(inputs.length);
  });

  it("filters groups using HAVING before sorting and paging them", () => {
    const raw = [
      row(1, "linux", 10),
      row(2, "linux", 20),
      row(3, "macos", 30),
      row(4, "windows", 40),
      row(5, "windows", 50),
    ];
    const groups = groupRows(raw, inputSchema, ["platform"], summaries);
    const query = normalizeQueryState({
      where: [{ field: "n", op: ">", value: "1" }],
      orderBy: [{ field: "sum", dir: "desc" }],
      limit: 1,
    });
    const result = applyQuery(
      groups,
      query,
      resultSchema(["platform"], summaries),
    );
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.platform)).toEqual(["windows"]);
    expect(result.rows[0]?.sum).toBe(90);
  });

  it("implements count rows, count values, distinct and null-aware reductions", () => {
    const [mixed, missing] = groupRows(
      [
        row(1, "linux", 10),
        row(2, "linux", null),
        row(3, "linux", 20),
        row(4, "linux", 20),
        row(5, "macos", null),
      ],
      inputSchema,
      ["platform"],
      summaries,
    );
    expect(mixed).toMatchObject({
      n: 4,
      non_null: 3,
      avg: 50 / 3,
      sum: 50,
      min: 10,
      max: 20,
      distinct: 2,
    });
    expect(missing).toMatchObject({
      n: 1,
      non_null: 0,
      avg: null,
      sum: null,
      min: null,
      max: null,
      distinct: 0,
    });
    expect(groupRows([], inputSchema, ["platform"], summaries)).toEqual([]);
  });

  it("distinguishes typed group keys and keeps group IDs stable", () => {
    const rows = [
      row(1, null, 1),
      row(2, "", 2),
      row(3, 1, 3),
      row(4, "1", 4),
      row(5, false, 5),
    ];
    const first = groupRows(rows, inputSchema, ["platform"], summaries);
    const second = groupRows(
      [...rows].reverse().map((r) => ({ ...r, total_ms: 99 })),
      inputSchema,
      ["platform"],
      [],
    );
    expect(new Set(first.map((r) => r.__qt_group_id__)).size).toBe(5);
    expect(second.map((r) => r.__qt_group_id__).sort()).toEqual(
      first.map((r) => r.__qt_group_id__).sort(),
    );
    const both = rows.map((r) => ({ ...r, worker: "worker-1" }));
    expect(
      groupRows(both, inputSchema, ["platform", "worker"], [])[0]?.__qt_group_id__,
    ).toBe(
      groupRows(both, inputSchema, ["worker", "platform"], [])[0]?.__qt_group_id__,
    );
  });

  it("uses one shared representative row, preserving nulls and all-member aggregates", () => {
    const columns: SummaryColumn[] = [
      { id: "row_id", op: "row", field: "id" },
      { id: "row_job", op: "row", field: "job_name" },
      { id: "maximum", op: "max", field: "total_ms" },
      { id: "n", op: "count" },
    ];
    const raw = [
      row(1, "linux", 100, "slow-1"),
      row(2, "linux", 100, "slow-2"),
      {
        ...row(3, "linux", 10, "newest", "2026-05-02T00:00:00Z"),
        job_name: null,
      },
      row(9, "linux", null, "missing", null),
    ];
    const [group] = groupRows(
      raw,
      inputSchema,
      ["platform"],
      columns,
      order("total_ms"),
    );
    expect(group).toMatchObject({
      row_id: 2,
      row_job: "slow-2",
      maximum: 100,
      n: 4,
    });
    expect(
      groupRows(
        [...raw].reverse(),
        inputSchema,
        ["platform"],
        columns,
        order("total_ms"),
      ),
    ).toEqual([group]);
    expect(
      groupRows(
        raw,
        inputSchema,
        ["platform"],
        columns,
        order("enqueued_at"),
      )[0],
    ).toMatchObject({
      row_id: 3,
      row_job: null,
      maximum: 100,
      n: 4,
    });
  });

  it("compares timestamps as instants, including offsets", () => {
    const raw = [
      row(1, "linux", 1, "later", "2026-05-01T01:00:00-06:00"),
      row(2, "linux", 2, "earlier", "2026-05-01T06:00:00Z"),
    ];
    const [group] = groupRows(
      raw,
      inputSchema,
      ["platform"],
      [
        { id: "latest_id", op: "row", field: "id" },
        { id: "max_date", op: "max", field: "enqueued_at" },
      ],
      order("enqueued_at"),
    );
    expect(group).toMatchObject({
      latest_id: 1,
      max_date: "2026-05-01T07:00:00.000Z",
    });
  });

  it("honors ordering priority, direction and null placement before the stable ID tie-break", () => {
    const raw = [
      row(1, "linux", 10, "b"),
      row(2, "linux", 10, "a"),
      row(3, "linux", null, "z"),
    ];
    const columns: SummaryColumn[] = [{ id: "chosen", op: "row", field: "id" }];
    const choose = (rule: RepresentativeRow) =>
      groupRows(raw, inputSchema, ["platform"], columns, rule)[0]?.chosen;
    expect(choose(order("total_ms", "asc"))).toBe(2);
    expect(choose(order("total_ms", "asc", "first"))).toBe(3);
    expect(choose(order("total_ms", "desc", "first"))).toBe(3);
    expect(
      choose({
        orderBy: [...order("total_ms").orderBy, ...order("job_name").orderBy],
      }),
    ).toBe(1);
    expect(
      choose({
        orderBy: [...order("total_ms").orderBy, ...order("id", "asc").orderBy],
      }),
    ).toBe(1);
    expect(
      choose({
        orderBy: [...order("job_name").orderBy, ...order("total_ms").orderBy],
      }),
    ).toBe(3);
    expect(
      groupRows(
        raw.map((r) => ({ ...r, total_ms: null })),
        inputSchema,
        ["platform"],
        columns,
        order("total_ms"),
      )[0]?.chosen,
    ).toBe(3);
  });

  it("chooses from every source match independent of input/output sorting and paging", () => {
    const raw = [
      row(1, "linux", 10),
      row(2, "linux", 30),
      row(3, "linux", 20),
      row(4, "macos", 40),
    ];
    const inputs = filteredInput(
      raw,
      normalizeQueryState({
        where: [{ field: "platform", op: "=", value: "linux" }],
        orderBy: [{ field: "id", dir: "asc" }],
        limit: 1,
        offset: 2,
      }),
      inputSchema,
    );
    const columns: SummaryColumn[] = [
      { id: "chosen", op: "row", field: "id" },
      { id: "n", op: "count" },
    ];
    expect(
      groupRows(
        inputs,
        inputSchema,
        ["platform"],
        columns,
        order("total_ms"),
      )[0],
    ).toMatchObject({ chosen: 2, n: 3 });
    expect(() => groupRows(inputs, inputSchema, ["platform"], columns)).toThrow(
      /ordering/,
    );
  });

  it("reads source paths for keys and values", () => {
    const schema: FieldSchema<Row> = {
      ...inputSchema,
      fields: inputSchema.fields.map((f) => ({
        ...f,
        source: { kind: "backend", path: `nested.${f.name}` },
      })),
    };
    const [group] = groupRows(
      [{ nested: row(1, "linux", 50) }],
      schema,
      ["platform"],
      summaries,
    );
    expect(group).toMatchObject({ platform: "linux", sum: 50 });
  });
});

describe("complete grouping view snapshots", () => {
  it("round-trips both query modes, summaries, HAVING and target metrics", () => {
    for (const item of seedViews()) {
      const saved = parseView(JSON.parse(JSON.stringify(item.view)));
      expect(saved).toEqual(item.view);
      expect(saved.input.aggregations?.[0]?.diagnostics).toBeUndefined();
      expect(saved.result.aggregations?.[0]?.diagnostics).toBeUndefined();
    }
    const busy = seedViews()[2]!.view;
    expect(busy.result.where).toEqual([
      { field: "run_count", op: ">=", value: "10" },
    ]);
    expect(busy.input.where).toEqual([]);
  });
  it("migrates old single-rule views without changing selected output IDs or query definitions", () => {
    const original = seedViews()[2]!.view;
    for (const op of ["latest", "longest"] as const) {
      const legacy = {
        ...original,
        version: 1,
        representative: undefined,
        summaries: original.summaries.map((s) =>
          s.op === "row" ? { ...s, op } : s,
        ),
      };
      const migrated = parseView(legacy);
      expect(migrated.version).toBe(2);
      expect(migrated.summaries).toEqual(original.summaries);
      expect(migrated.result).toEqual(original.result);
      expect(migrated.representative).toEqual(
        order(op === "latest" ? "enqueued_at" : "total_ms"),
      );
    }
    expect(() =>
      parseView({
        ...original,
        version: 1,
        summaries: [
          { id: "a", op: "latest", field: "id" },
          { id: "b", op: "longest", field: "id" },
        ],
      }),
    ).toThrow(/both latest and longest/);
  });

  it("allows only one ordering-only representative definition over known sortable fields", () => {
    expect(parseRepresentative(order("job_name", "asc"))).toEqual(
      order("job_name", "asc"),
    );
    for (const rule of [
      { orderBy: [] },
      { orderBy: [{ field: "unknown", dir: "asc" }] },
      { orderBy: [{ field: "id", dir: "sideways" }] },
      { orderBy: [{ field: "id", dir: "asc", nulls: "middle" }] },
      { orderBy: [{ field: "id", dir: "asc", extract: { regex: ".*" } }] },
      { ...order("id"), where: [] },
      { orderBy: [...order("id").orderBy, ...order("id", "asc").orderBy] },
      [order("id"), order("total_ms")],
    ])
      expect(() => parseRepresentative(rule)).toThrow();
    expect(() =>
      parseView({ ...seedViews()[2]!.view, representative: null }),
    ).toThrow(/require/);
  });
  it("rejects unsupported source fields, reductions, duplicate IDs, and missing keys", () => {
    const view = seedViews()[1]!.view;
    expect(() => parseView({ ...view, keys: ["arbitrary_sql"] })).toThrow();
    expect(() => parseView({ ...view, keys: [] })).toThrow();
    expect(() =>
      parseView({
        ...view,
        summaries: [{ id: "x", op: "sum", field: "job_name" }],
      }),
    ).toThrow();
    expect(() =>
      parseView({ ...view, summaries: [{ id: "platform", op: "count" }] }),
    ).toThrow();
    expect(() =>
      parseView({
        ...view,
        summaries: [{ id: "x", op: "count", field: "unknown" }],
      }),
    ).toThrow();
  });
});

describe("representative changes", () => {
  it("clears dependent filters, sorts and metrics while retaining aggregate consumers", () => {
    const view = seedViews()[2]!.view;
    const schema = resultSchema(view.keys, view.summaries);
    const query = normalizeQueryState({
      ...view.result,
      where: [
        ...view.result.where,
        { field: "example_job", op: "=", value: "a" },
      ],
      orderBy: [
        { field: "example_id", dir: "asc" },
        { field: "run_count", dir: "desc" },
      ],
      aggregations: [
        { id: "count", op: "count", groupBy: [], expression: "COUNT()" },
        { id: "average", op: "avg", field: "avg_duration", groupBy: [] },
        { id: "row", op: "max", groupBy: [], expression: "MAX([example_id])" },
        { id: "by-row", op: "count", groupBy: ["example_job"] },
      ],
    });
    const next = reconcileRepresentative(query, view.summaries, schema, false);
    expect(next.select).toEqual(query.select);
    expect(next.where).toEqual(view.result.where);
    expect(next.orderBy).toEqual([{ field: "run_count", dir: "desc" }]);
    expect(next.aggregations?.map((m) => m.id)).toEqual(["count", "average"]);
    const removed = reconcileRepresentative(
      query,
      view.summaries,
      schema,
      true,
    );
    expect(removed.select.map((c) => c.field)).toEqual([
      "worker",
      "run_count",
      "avg_duration",
    ]);
    expect(query.select).toHaveLength(5);
  });

  it("also reconciles consumers of computed fields derived from representative values", () => {
    const view = seedViews()[2]!.view;
    const schema = resultSchema(view.keys, view.summaries);
    schema.fields.push({
      name: "@computed/example",
      label: "Example formula",
      type: "number",
      source: {
        kind: "derived",
        accessor: (row) => row.example_id,
        dependencies: ["example_id"],
      },
    });
    const query = normalizeQueryState({
      select: [{ field: "@computed/example" }],
      where: [{ field: "@computed/example", op: ">", value: "1" }],
      orderBy: [{ field: "@computed/example", dir: "desc" }],
    });
    const next = reconcileRepresentative(query, view.summaries, schema, true);
    expect(next.select).toEqual([]);
    expect(next.where).toEqual([]);
    expect(next.orderBy).toEqual([]);
  });
});

describe("aggregate formula columns", () => {
  const custom: SummaryColumn[] = [
    {
      id: "middle",
      op: "formula",
      expression: "MEDIAN([total_ms])",
      label: "Median duration",
    },
    {
      id: "spread",
      op: "formula",
      expression: "MAX([total_ms]) - MIN([total_ms])",
      label: "Duration spread",
    },
  ];
  it("evaluates formulas over all members of each group and preserves null-only groups", () => {
    const groups = groupRows(
      [
        row(1, "linux", 10),
        row(2, "linux", 100),
        row(3, "linux", 20),
        row(4, "macos", 6),
        row(5, "macos", 2),
        row(6, "windows", null),
      ],
      inputSchema,
      ["platform"],
      custom,
    );
    expect(groups.map((g) => [g.platform, g.middle, g.spread])).toEqual([
      ["linux", 20, 90],
      ["macos", 4, 4],
      ["windows", null, null],
    ]);
    expect(
      resultSchema(["platform"], custom).fields.find(
        (f) => f.name === "middle",
      ),
    ).toMatchObject({ label: "Median duration", type: "number" });
  });
  it("round-trips formulas and labels in saved views and rejects invalid formulas", () => {
    const view = { ...seedViews()[1]!.view, summaries: custom };
    expect(parseView(JSON.parse(JSON.stringify(view))).summaries).toEqual(
      custom,
    );
    for (const expression of [
      "[total_ms]",
      "MEDIAN([job_name])",
      "MEDIAN(SUM([total_ms]))",
      "eval(1)",
      "MEDIAN([missing])",
    ]) {
      expect(() =>
        parseView({ ...view, summaries: [{ ...custom[0]!, expression }] }),
      ).toThrow();
    }
  });
  it("shows runtime errors instead of silently replacing them with empty values", () => {
    const groups = groupRows(
      [row(1, "linux", 2)],
      inputSchema,
      ["platform"],
      [{ id: "broken", op: "formula", expression: "SUM([total_ms]) / 0" }],
    );
    expect(groups[0]!.broken).toHaveProperty("computedError");
  });
});
