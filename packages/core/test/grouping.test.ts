import { describe, expect, it } from "vitest";
import {
  applyAggregations,
  applyQuery,
  createGroupingModel,
  decodeQuery,
  encodeQuery,
  evaluateMetrics,
  GROUP_ID_FIELD,
  memoryStorageAdapter,
  normalizeQueryState,
  prepareGrouping,
  queriesEqual,
  readFieldValue,
  toAggregationQuery,
  toMetricQuery,
  toServerQuery,
  toServerQueryV2,
  type FieldSchema,
  type GroupedRow,
  type GroupingState,
  type QueryState,
} from "../src/index";

// A host schema with nested paths and no catalogue entry for its identity.
const schema: FieldSchema<GroupedRow> = {
  name: "customers",
  idField: "id",
  fields: [
    {
      name: "customer",
      label: "Customer",
      type: "text",
      source: { kind: "backend", path: "owner.name" },
    },
    {
      name: "region",
      label: "Region",
      type: "text",
      source: { kind: "backend" },
    },
    {
      name: "duration",
      label: "Duration",
      render: "client-duration",
      type: "number",
      source: { kind: "backend", path: "run.duration" },
    },
    {
      name: "created",
      label: "Created",
      type: "datetime",
      source: { kind: "backend" },
    },
    {
      name: "hidden",
      label: "Hidden",
      type: "number",
      source: { kind: "backend" },
      select: { enabled: false },
    },
  ],
};
const rows: GroupedRow[] = [
  {
    id: 1,
    owner: { name: "A" },
    run: { duration: 10 },
    region: "west",
    created: "2026-10-12T10:00:00Z",
  },
  {
    id: 2,
    owner: { name: "A" },
    run: { duration: 30 },
    region: "west",
    created: "2026-10-12T11:00:00Z",
  },
  {
    id: 3,
    owner: { name: "B" },
    run: { duration: 50 },
    region: "east",
    created: "2026-10-12T09:00:00Z",
  },
  {
    id: 4,
    owner: { name: "C" },
    run: { duration: null },
    region: "west",
    created: "2026-10-12T08:00:00Z",
  },
];
function stage(): GroupingState {
  return {
    keys: ["customer"],
    summaries: [
      { id: "n", op: "count" },
      { id: "average", op: "avg", field: "duration" },
      { id: "median", op: "formula", expression: "MEDIAN([duration])" },
    ],
    representative: null,
    source: normalizeQueryState({
      limit: 1,
      offset: 100,
      orderBy: [{ field: "created", dir: "desc" }],
    }),
  };
}
function query(): QueryState {
  return normalizeQueryState({
    grouping: stage(),
    select: [{ field: "customer" }, { field: "n" }],
    limit: 20,
  });
}

describe("standard grouping model", () => {
  it("preserves host cell displays for keys and values while leaving counts unformatted", () => {
    const model = createGroupingModel<GroupedRow>({
      ...schema,
      fields: schema.fields.map(field => ({ ...field, display: { kind: "text", truncate: false } })),
    });
    const projected = model.resultSchema(["customer"], [
      { id: "value", op: "row", field: "region" },
      { id: "smallest", op: "min", field: "region" },
      { id: "count", op: "count", field: "region" },
    ]);
    for (const name of ["customer", "value", "smallest"])
      expect(projected.fields.find(field => field.name === name)?.display).toEqual({ kind: "text", truncate: false });
    expect(projected.fields.find(field => field.name === "count")?.display).toBeUndefined();
  });

  it.each([undefined, null])("treats grouping: %s as an ordinary row query", async grouping => {
    const plain = normalizeQueryState({ select: [{ field: "customer" }], limit: 2, offset: 1 });
    const q = normalizeQueryState({ ...plain, grouping });
    expect(q).toEqual(plain);
    expect(applyQuery(rows, q, schema)).toEqual(applyQuery(rows, plain, schema));
    expect(decodeQuery(encodeQuery(q))).toEqual(plain);
    const storage = memoryStorageAdapter();
    await storage.saveNamed(schema.name, "Rows", q, 1);
    expect((await storage.listSaved(schema.name))[0]!.query).toEqual(plain);
  });

  it("accepts a null grouping property on the source query without treating it as a nested stage", () => {
    const q = query();
    const normalized = normalizeQueryState({ ...q, grouping: { ...q.grouping, source: { ...q.grouping!.source, grouping: null } } });
    expect(normalized).toEqual(q);
    expect(applyQuery(rows, normalized, schema)).toEqual(applyQuery(rows, q, schema));
  });

  it.each([false, 0, "", []])("still rejects a non-null invalid grouping value: %j", grouping => {
    expect(() => applyQuery(rows, normalizeQueryState({ grouping }), schema)).toThrow(/Invalid grouping/);
  });

  it("evaluates source WHERE, full-population grouping, HAVING, sorting, then pagination", () => {
    const q = query();
    q.grouping!.source.where = [{ field: "region", op: "=", value: "west" }];
    q.where = [{ field: "n", op: ">=", value: "1" }];
    q.orderBy = [{ field: "average", dir: "desc" }];
    q.limit = 1;
    const result = applyQuery(rows, q, schema);
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([
      expect.objectContaining({ customer: "A", n: 2, average: 20, median: 20 }),
    ]);
    const prepared = prepareGrouping(rows, schema, q.grouping!);
    expect(
      readFieldValue(
        prepared.schema.fields.find((f) => f.name === "customer")!,
        result.rows[0]!,
      ),
    ).toBe("A");
    expect(prepared.schema.name).toBe("customers:groups");
    expect(
      prepared.schema.fields.find((field) => field.name === "average")!.render,
    ).toBe("client-duration");
    expect(
      prepared.schema.fields.find((field) => field.name === "n")!.render,
    ).toBeUndefined();
  });

  it("uses identical semantics for built-in and formula reductions", () => {
    const grouping = stage();
    grouping.summaries.push({
      id: "formula_avg",
      op: "formula",
      expression: "AVG([duration])",
    });
    for (const row of prepareGrouping(rows, schema, grouping).rows)
      expect(row.average).toEqual(row.formula_avg);
    const empty = prepareGrouping(rows.slice(3), schema, grouping).rows[0]!;
    expect(empty).toMatchObject({ average: null, median: null, n: 1 });
  });

  it("chooses one stable representative for all row columns, even when ID is not in the catalogue", () => {
    const grouping = stage();
    grouping.representative = {
      orderBy: [{ field: "region", dir: "asc", nulls: "last" }],
    };
    grouping.summaries.push(
      { id: "chosen_duration", op: "row", field: "duration" },
      { id: "chosen_created", op: "row", field: "created" },
    );
    const first = prepareGrouping(rows, schema, grouping).rows;
    const second = prepareGrouping([...rows].reverse(), schema, grouping).rows;
    expect(first.find((row) => row.customer === "A")).toMatchObject({
      chosen_duration: 30,
      chosen_created: rows[1]!.created,
    });
    expect(second.find((row) => row.customer === "A")).toEqual(
      first.find((row) => row.customer === "A"),
    );
  });

  it("keeps typed keys and group identities distinct and stable", () => {
    const model = createGroupingModel(schema);
    const typed = [null, "", "1", 1, false].map((name, id) => ({
      id,
      owner: { name },
    }));
    const first = model.groupRows(typed, schema, ["customer"], []);
    expect(new Set(first.map((row) => row[GROUP_ID_FIELD])).size).toBe(5);
    expect(
      model
        .groupRows([...typed].reverse(), schema, ["customer"], [])
        .map((row) => row[GROUP_ID_FIELD])
        .sort(),
    ).toEqual(first.map((row) => row[GROUP_ID_FIELD]).sort());
    expect(() =>
      model.groupRows(
        [{ owner: { name: Infinity } }],
        schema,
        ["customer"],
        [],
      ),
    ).toThrow(/finite scalar/);
  });

  it("round-trips complete grouped views through URLs, equality, normalization, and storage", async () => {
    const q = query();
    const copy = decodeQuery(encodeQuery(q))!;
    expect(copy).toEqual(q);
    expect(queriesEqual(q, copy)).toBe(true);
    copy.grouping!.source.where = [{ field: "region", op: "=", value: "east" }];
    expect(queriesEqual(q, copy)).toBe(false);
    const storage = memoryStorageAdapter();
    const saved = await storage.saveNamed(schema.name, "Customers", q, 1);
    await storage.setDefaultSaved!(schema.name, saved.id);
    expect((await storage.loadDefaultSaved!(schema.name))!.query).toEqual(q);
  });

  it("evaluates metrics over matching groups and shown groups", () => {
    const q = query();
    q.where = [{ field: "average", op: ">", value: "0" }];
    q.orderBy = [{ field: "average", dir: "desc" }];
    q.limit = 1;
    q.aggregations = [
      { id: "matching", op: "count", groupBy: [] },
      { id: "shown", op: "sum", field: "n", groupBy: [], scope: "shownRows" },
    ];
    for (const evaluate of [applyAggregations, evaluateMetrics]) {
      const results = evaluate(rows, q, schema).metrics;
      expect(results[0]!.buckets[0]!.value).toBe(2);
      expect(results[1]!.buckets[0]!.value).toBe(1);
    }
  });

  it("uses one clock for source WHERE and group HAVING", () => {
    const q = query();
    q.grouping!.source.where = [{ field: "created", op: ">=", value: "-2h" }];
    expect(
      applyQuery(rows, q, schema, {
        now: Date.parse("2026-10-12T12:00:00Z"),
      }).rows.map((row) => row.customer),
    ).toEqual(["A"]);
  });

  it("rejects unsupported or invalid stages instead of silently reverting to source rows", () => {
    const nested = normalizeQueryState({
      ...query(),
      grouping: { ...stage(), source: query() },
    });
    expect(() => applyQuery(rows, nested, schema)).toThrow(/Invalid grouping/);
    const invalid = query();
    invalid.grouping!.keys = ["missing"];
    expect(() => applyQuery(rows, invalid, schema)).toThrow(/valid group keys/);
    invalid.grouping = stage();
    invalid.grouping.source.where = [
      { field: "@computed/missing", op: "=", value: "1" },
    ];
    expect(() => applyQuery(rows, invalid, schema)).toThrow(
      /unavailable field/,
    );
    const model = createGroupingModel(schema);
    expect(() =>
      model.validate({
        ...stage(),
        summaries: [{ id: "bad", op: "formula", expression: "SUM([hidden])" }],
      }),
    ).toThrow(/selectable/);
    expect(() =>
      model.validate({
        ...stage(),
        summaries: [
          {
            id: "bad",
            op: "formula",
            expression: 'COUNT(REGEX_EXTRACT([customer], "a"))',
          },
        ],
      }),
    ).toThrow(/Regex/);
    const q = query();
    expect(() => toServerQuery(q, schema)).toThrow(/group/);
    expect(() =>
      toServerQueryV2(q, schema, {
        profile: "x",
        fields: {},
        resolvedRevisions: {},
        planToken: "x",
      }),
    ).toThrow(/group/);
    expect(() => toAggregationQuery(q, schema)).toThrow(/group/);
    expect(() => toMetricQuery(q, schema)).toThrow(/group/);
  });
});

describe("summary column display", () => {
  const rate = { id: "rate", op: "avg", field: "duration", display: { kind: "percent", decimals: 1 } } as const;

  it("projects the summary format onto the grouped field, replacing inherited presentation", () => {
    const model = createGroupingModel<GroupedRow>({
      ...schema,
      fields: schema.fields.map(field => field.name === "duration" ? { ...field, display: { kind: "duration" } } : field),
    });
    const projected = model.resultSchema(["customer"], [
      rate,
      { id: "plain", op: "avg", field: "duration" },
      { id: "custom", op: "formula", expression: "MEDIAN([duration])", display: { kind: "number", decimals: 2 } },
    ]);
    const field = (name: string) => projected.fields.find(f => f.name === name)!;
    expect(field("rate").display).toEqual({ kind: "percent", decimals: 1 });
    expect(field("rate").render).toBeUndefined();
    expect(field("plain")).toMatchObject({ render: "client-duration", display: { kind: "duration" } });
    expect(field("custom").display).toEqual({ kind: "number", decimals: 2 });
  });

  it("normalizes valid displays and turns invalid ones into diagnostics", () => {
    const valid = normalizeQueryState({ ...query(), grouping: { ...stage(), summaries: [rate] } });
    expect(valid.grouping!.summaries[0]!.display).toEqual({ kind: "percent", decimals: 1 });
    expect(valid.grouping!.diagnostics).toBeUndefined();
    const invalid = normalizeQueryState({ ...query(), grouping: { ...stage(), summaries: [
      { ...rate, display: { kind: "percent", decimals: 40 } },
      { id: "other", op: "count", display: { kind: "sparkline" } },
    ] } });
    expect(invalid.grouping!.summaries.map(s => s.display)).toEqual([undefined, undefined]);
    expect(invalid.grouping!.diagnostics).toEqual([
      'Invalid grouping: summary "rate" display: decimals must be an integer from 0 to 20.',
      'Invalid grouping: summary "other" display: unsupported kind.',
    ]);
    expect(() => applyQuery(rows, invalid, schema)).toThrow(/decimals must be an integer/);
  });

  it("round-trips summary displays through URLs and saved queries", async () => {
    const q = normalizeQueryState({ ...query(), grouping: { ...stage(), summaries: [...stage().summaries, rate] } });
    expect(decodeQuery(encodeQuery(q))).toEqual(q);
    const storage = memoryStorageAdapter();
    await storage.saveNamed(schema.name, "Rates", q, 1);
    expect((await storage.listSaved(schema.name))[0]!.query.grouping!.summaries.at(-1)).toEqual(rate);
  });
});

describe("grouping diagnostics", () => {
  const diagnostics = (grouping: Record<string, unknown>) => normalizeQueryState({ grouping: { ...stage(), ...grouping } }).grouping!.diagnostics;

  it("names the summary and the problem instead of a generic message", () => {
    expect(diagnostics({ summaries: [{ id: "p50", op: "median", field: "duration" }] })).toEqual([
      'Invalid grouping: summary "p50" has unsupported op "median"; use count, count_distinct, sum, avg, min, max, row, formula, or link (for a median, use op "formula" with expression "MEDIAN([field])").',
    ]);
    expect(diagnostics({ summaries: [{ op: "count" }] })).toEqual(["Invalid grouping: summary 1 needs an id of 1–256 characters."]);
    expect(diagnostics({ keys: ["customer", "customer"] })).toEqual(["Invalid grouping: keys must list 1–20 distinct field names."]);
    expect(diagnostics({ summaries: [{ id: "n", op: "count" }, { id: "n", op: "sum", field: "duration" }] }))
      .toEqual(['Invalid grouping: summary "n" uses the same id as another summary column.']);
    expect(diagnostics({ source: { ...stage().source, grouping: stage() } }))
      .toEqual(["Invalid grouping: only one grouping stage is supported; the source query cannot itself be grouped."]);
  });

  it("reports summary ids that collide with group keys during normalization", () => {
    expect(diagnostics({ summaries: [{ id: "customer", op: "count" }] })).toEqual([
      'Invalid grouping: summary "customer" uses the same id as group key "customer"; summary ids must differ from source field names.',
    ]);
  });

  it("reports summary ids that collide with other source fields when validating against the schema", () => {
    const q = normalizeQueryState({ ...query(), grouping: { ...stage(), summaries: [{ id: "duration", op: "avg", field: "duration" }] } });
    expect(q.grouping!.diagnostics).toBeUndefined();
    expect(() => applyQuery(rows, q, schema)).toThrow(
      'Aggregate column ID "duration" is already a source field name. Choose a different id, such as "avg_duration".',
    );
    expect(() => createGroupingModel(schema).validate({ ...stage(), summaries: [{ id: "x", op: "count" }, { id: "x", op: "count" }] }))
      .toThrow('Aggregate column ID "x" is used by more than one column.');
  });

  it("keeps specific diagnostics through re-normalization and links", () => {
    const once = normalizeQueryState({ ...query(), grouping: { ...stage(), summaries: [{ id: "p50", op: "median", field: "duration" }] } });
    expect(normalizeQueryState(once)).toEqual(once);
    expect(decodeQuery(encodeQuery(once))).toEqual(once);
  });
});
