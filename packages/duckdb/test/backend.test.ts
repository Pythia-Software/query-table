import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuckDBInstance,
  type DuckDBConnection as NativeConnection,
} from "@duckdb/node-api";
import {
  applyQuery,
  createGroupingModel,
  evaluateMetrics,
  formulaRuntime,
  normalizeQueryState,
  toQueryRequestV3,
  toServerQuery,
  validateQueryResultV3,
  type FieldSchema,
  type AggregationClause,
} from "@pythia-software/query-table-core";
import {
  DuckDBBackend,
  SQLBuilder,
  compileDuckDBRows,
  normalizeDuckDBValue,
  loadDuckDBSchema,
} from "../src/index";

const rows = [
  {
    id: "1",
    category: "a",
    amount: 10,
    duration: 2,
    tags: ["milk", "organic"],
    date: "2025-01-01T12:00:00Z",
    flag: true,
  },
  {
    id: "2",
    category: "a",
    amount: 30,
    duration: 5,
    tags: ["organic"],
    date: "2025-01-03T12:00:00Z",
    flag: false,
  },
  {
    id: "3",
    category: "a",
    amount: null,
    duration: 4,
    tags: [],
    date: "2025-01-03T13:00:00Z",
    flag: null,
  },
  {
    id: "4",
    category: "b",
    amount: 20,
    duration: 2,
    tags: ["MILK"],
    date: "2025-01-01T14:00:00Z",
    flag: true,
  },
  {
    id: "5",
    category: "b",
    amount: 200,
    duration: 3,
    tags: null,
    date: null,
    flag: false,
  },
  {
    id: "6",
    category: null,
    amount: 5,
    duration: 2,
    tags: ["soy"],
    date: "2025-01-02T12:00:00Z",
    flag: true,
  },
];
const schema: FieldSchema = {
  name: "runs",
  idField: "id",
  fields: [
    {
      name: "id",
      label: "ID",
      type: "text",
      source: { kind: "backend" },
      aggregate: { groupable: false },
    },
    {
      name: "category",
      label: "Category",
      type: "text",
      source: { kind: "backend" },
    },
    ...["amount", "duration"].map((name) => ({
      name,
      label: name,
      type: "number" as const,
      source: { kind: "backend" as const },
    })),
    {
      name: "tags",
      label: "Tags",
      type: "textarray",
      source: { kind: "backend" },
      filter: { editor: "set" },
    },
    {
      name: "date",
      label: "Date",
      type: "datetime",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
    {
      name: "flag",
      label: "Flag",
      type: "bool",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
  ],
};
let native: NativeConnection, backend: DuckDBBackend;
beforeEach(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  native = await instance.connect();
  await native.run("SET TimeZone='UTC'");
  await native.run(
    "CREATE TABLE runs (id VARCHAR, category VARCHAR, amount DOUBLE, duration DOUBLE, tags VARCHAR[], date TIMESTAMPTZ, flag BOOLEAN)",
  );
  for (const row of rows)
    await native.run(
      "INSERT INTO runs VALUES ($1,$2,$3,$4,CAST($5 AS JSON)::VARCHAR[],CAST($6 AS TIMESTAMPTZ),$7)",
      [
        row.id,
        row.category,
        row.amount,
        row.duration,
        JSON.stringify(row.tags),
        row.date,
        row.flag,
      ],
    );
  backend = new DuckDBBackend({
    relation: "runs",
    schema,
    connection: {
      query: async (sql, args) =>
        (await native.runAndReadAll(sql, args as any[])).getRowObjectsJS(),
    },
  });
});
afterEach(() => native?.closeSync());
const execute = (input: Parameters<typeof normalizeQueryState>[0]) => {
  const query = normalizeQueryState(input);
  return backend.execute(
    toQueryRequestV3(query, schema, backend.capabilities, undefined, {
      now: Date.parse("2025-01-04T00:00:00Z"),
    }),
  );
};
const metric = (
  expression: string,
  extra: Partial<AggregationClause> = {},
): AggregationClause => ({
  id: expression,
  op: "count",
  groupBy: ["category"],
  expression,
  ...extra,
});

describe("DuckDB native conformance", () => {
  it("executes parameterized AND/OR filters and deterministic pagination", async () => {
    const query = normalizeQueryState({
      select: [{ field: "amount" }, { field: "category" }],
      where: [
        {
          any: [
            { field: "category", op: "=", value: "a" },
            { field: "category", op: "=", value: "b" },
          ],
        },
        { field: "amount", op: ">=", value: "20" },
      ],
      orderBy: [{ field: "amount", dir: "desc" }],
      limit: 2,
      offset: 1,
    });
    const actual = await execute(query),
      expected = applyQuery(rows, query, schema);
    expect(actual.total).toBe(expected.total);
    expect(actual.rows.map((row) => row.id)).toEqual(
      expected.rows.map((row) => row.id),
    );
    validateQueryResultV3(
      actual,
      toQueryRequestV3(query, schema, backend.capabilities, undefined, {
        now: actual.now,
      }),
      schema,
    );
  });
  it("implements null-exclusive set negation and empty arrays", async () => {
    for (const where of [
      [{ field: "tags", op: "includes", value: "milk" }],
      [{ field: "tags", op: "includes", value: "milk", negated: true }],
      [{ field: "tags", op: "is_null", value: "" }],
    ] as const) {
      const query = normalizeQueryState({
        where: [...where],
        select: [{ field: "id" }],
      });
      expect((await execute(query)).rows.map((row) => row.id)).toEqual(
        applyQuery(rows, query, schema).rows.map((row) => row.id),
      );
    }
  });
  it("matches literal text without treating percent or underscore as wildcards", async () => {
    expect(
      (
        await execute({
          where: [{ field: "category", op: "contains", value: "%" }],
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await execute({
          where: [{ field: "category", op: "=", value: "a' OR TRUE --" }],
        })
      ).total,
    ).toBe(0);
    expect(() =>
      compileDuckDBRows(
        {
          select: ["amount; DROP TABLE runs"],
          where: [],
          orderBy: [],
          limit: 10,
          offset: 0,
        },
        schema,
        "runs",
      ),
    ).toThrow("Unavailable");
  });
  it("uses RE2 search semantics and null-safe extraction sorting", async () => {
    expect(
      (
        await execute({
          where: [{ field: "id", op: "matches_regex", value: "[24]" }],
        })
      ).rows.map((row) => row.id),
    ).toEqual(["2", "4"]);
    expect(
      (
        await execute({
          orderBy: [{ field: "id", dir: "desc", extract: { regex: "(\\d)" } }],
        })
      ).rows[0]?.id,
    ).toBe("6");
  });
  it("matches composed reductions, exact median, distinct and scatter", async () => {
    const clauses = [
      metric("SUM([amount]) / NULLIF(SUM([duration]), 0)"),
      metric("MEDIAN([amount])"),
      metric("COUNT_DISTINCT([flag])"),
      metric("AVG([amount])", {
        display: { kind: "scatter" },
        expressionY: "SUM([duration])",
      }),
    ];
    const query = normalizeQueryState({ aggregations: clauses });
    const actual = await execute(query),
      expected = evaluateMetrics(rows, query, schema);
    for (let i = 0; i < clauses.length; i++) {
      expect(actual.metrics[i]?.error).toBeUndefined();
      const comparable = (b: AggregationClause | any) => JSON.stringify(b.keys);
      expect(
        actual.metrics[i]?.buckets.sort((a, b) =>
          comparable(a).localeCompare(comparable(b)),
        ),
      ).toEqual(
        expected.metrics[i]?.buckets.sort((a, b) =>
          comparable(a).localeCompare(comparable(b)),
        ),
      );
    }
  });
  it("scopes shown-row metrics after the ordered page", async () => {
    const actual = await execute({
      orderBy: [{ field: "amount", dir: "desc" }],
      limit: 2,
      offset: 1,
      aggregations: [
        metric("SUM([amount])", { scope: "shownRows", groupBy: [] }),
      ],
    });
    expect(actual.metrics[0]?.buckets[0]?.value).toBe(50);
  });
  it("produces GROUP BY/HAVING independently of source pagination", async () => {
    const source = normalizeQueryState({
      limit: 1,
      offset: 4,
      where: [{ field: "amount", op: "is_not_null", value: "" }],
    });
    const query = normalizeQueryState({
      grouping: {
        source,
        keys: ["category"],
        summaries: [
          { id: "total", op: "sum", field: "amount" },
          { id: "latest", op: "row", field: "id" },
        ],
        representative: { orderBy: [{ field: "amount", dir: "desc" }] },
      },
      select: [{ field: "category" }, { field: "total" }, { field: "latest" }],
      where: [{ field: "total", op: ">", value: "30" }],
      orderBy: [{ field: "total", dir: "desc" }],
      aggregations: [metric("SUM([total])", { groupBy: [] })],
    });
    const result = await execute(query);
    expect(result.sourceTotal).toBe(5);
    expect(result.total).toBe(2);
    expect(
      result.rows.map((row) => [row.category, row.total, row.latest]),
    ).toEqual([
      ["b", 220, "5"],
      ["a", 40, "2"],
    ]);
    expect(result.metrics[0]?.buckets[0]?.value).toBe(260);
    const expectedSchema = createGroupingSchema(query);
    validateQueryResultV3(
      result,
      toQueryRequestV3(query, schema, backend.capabilities, undefined, {
        now: result.now,
      }),
      expectedSchema,
    );
  });
  it("returns exact boxes and shared-edge histograms", async () => {
    const clauses = [
      metric("COUNT()", {
        display: { kind: "box" },
        distribution: { kind: "box", input: "[amount]", whiskers: "tukey" },
      }),
      metric("COUNT()", {
        display: { kind: "histogram" },
        distribution: { kind: "histogram", input: "[amount]", bins: 4 },
      }),
    ];
    const actual = await execute({ aggregations: clauses });
    expect(actual.metrics.map((entry) => entry.error)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      actual.metrics[0]?.buckets.find((bucket) => bucket.keys[0] === "a")
        ?.distribution,
    ).toMatchObject({ kind: "box", summary: { n: 2, median: 20 } });
    const histograms = actual.metrics[1]!.buckets.map(
      (bucket) => bucket.distribution!,
    );
    expect(
      histograms.every(
        (item) =>
          item.kind === "histogram" &&
          JSON.stringify(item.edges) ===
            JSON.stringify((histograms[0] as any).edges),
      ),
    ).toBe(true);
  });
  it("fills empty dates and preserves null date buckets", async () => {
    const result = await execute({
      aggregations: [
        metric("COUNT()", {
          groupBy: ["date"],
          dateGrouping: {
            field: "date",
            interval: "day",
            timeZone: "UTC",
            includeEmpty: true,
            range: "custom",
            start: "2025-01-01",
            end: "2025-01-04",
          },
          sort: [{ key: "group0", dir: "asc" }],
        }),
      ],
    });
    expect(result.metrics[0]?.error).toBeUndefined();
    expect(
      result.metrics[0]?.buckets.map((bucket) => [
        bucket.keys[0],
        bucket.value,
      ]),
    ).toEqual([
      ["2025-01-01T00:00:00.000Z", 2],
      ["2025-01-02T00:00:00.000Z", 1],
      ["2025-01-03T00:00:00.000Z", 2],
      ["2025-01-04T00:00:00.000Z", 0],
      [null, 1],
    ]);
  });
  it("supports autocomplete, array suggestions and full item lookup", async () => {
    const transport = backend.transport();
    expect(
      await transport.fetchDistinctValues!({ field: "tags", search: "milk" }),
    ).toEqual({ values: ["MILK", "milk"], hasMore: false, hasNull: true });
    expect(await transport.fetchRow!("3")).toMatchObject({
      ...rows[2],
      date: "2025-01-03T13:00:00.000Z",
    });
  });
  it("rejects population budgets and recovers its transaction", async () => {
    const small = new DuckDBBackend({ ...backend.options, maxPopulation: 2 });
    await expect(
      small
        .transport()
        .fetchRows(toServerQuery(normalizeQueryState({}), schema)),
    ).rejects.toThrow("budget");
    expect(
      (
        await backend
          .transport()
          .fetchRows(toServerQuery(normalizeQueryState({ limit: 1 }), schema))
      ).total,
    ).toBe(6);
  });
  it("rejects stale clocks, profiles and aborted requests", async () => {
    const request = toQueryRequestV3(
      normalizeQueryState({}),
      schema,
      backend.capabilities,
    );
    await expect(
      backend.execute({ ...request, profile: "qt-postgres-v1" }),
    ).rejects.toThrow("profile");
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.execute(request, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects unsafe driver integers and unsupported functions", () => {
    expect(() => normalizeDuckDBValue(9007199254740992n)).toThrow("precision");
    expect(() =>
      new SQLBuilder(schema).expression('FORMAT_DATE([date], "YYYY")'),
    ).toThrow("not available");
  });
  it("matches the client's ISO WEEKDAY numbering and UTC boundaries", async () => {
    const dates = [
      "2025-01-06T12:00:00Z",
      "2025-01-07T12:00:00Z",
      "2025-01-08T12:00:00Z",
      "2025-01-09T12:00:00Z",
      "2025-01-10T12:00:00Z",
      "2025-01-11T12:00:00Z",
      "2025-01-12T12:00:00Z",
      null,
      "2025-01-13T00:30:00+02:00", // Sunday in UTC.
      "2025-01-12T23:30:00-02:00", // Monday in UTC.
    ];
    await native.run("CREATE TABLE weekday_dates (id INTEGER, date TIMESTAMPTZ)");
    for (const [index, date] of dates.entries())
      await native.run(
        "INSERT INTO weekday_dates VALUES ($1, CAST($2 AS TIMESTAMPTZ))",
        [index, date],
      );
    const { sql, plan } = new SQLBuilder(schema).expression("WEEKDAY([date])");
    const result = (
      await native.runAndReadAll(
        `SELECT ${sql} AS weekday FROM weekday_dates ORDER BY id`,
      )
    ).getRowObjectsJS();
    const expected = [1, 2, 3, 4, 5, 6, 7, null, 7, 1];
    expect(result.map((row) => normalizeDuckDBValue(row.weekday))).toEqual(expected);
    expect(dates.map((date) => formulaRuntime(plan.ast, { date }).value)).toEqual(expected);
  });
  it("resolves static computed fields with their execution revision", async () => {
    const computed = new DuckDBBackend({
      ...backend.options,
      computedColumns: [
        {
          id: "unit",
          label: "Per unit",
          revision: "1",
          expression: {
            language: "qt-expr",
            version: 1,
            source: "[amount] / [duration]",
          },
        },
      ],
    });
    const query = normalizeQueryState({
      select: [{ field: "@computed/unit" }],
      where: [{ field: "@computed/unit", op: ">", value: "5" }],
      orderBy: [{ field: "@computed/unit", dir: "desc" }],
    });
    const request = toQueryRequestV3(
      query,
      computed.schema,
      computed.capabilities,
      computed.execution,
    );
    const result = await computed.execute(request);
    expect(result.rows.map((row) => row.id)).toEqual(["5", "4", "2"]);
    expect(result.rows[1]?.["@computed/unit"]).toBe(10);
    await expect(
      computed.execute({ ...request, expectedRevisions: { unit: "2" } }),
    ).rejects.toThrow("definitions changed");
  });
  it("reads only explicit DuckDB schema bindings", () => {
    const doc = {
      name: "bound",
      idField: "id",
      fields: [
        {
          name: "id",
          label: "ID",
          type: "text",
          bindings: {
            duckdb: { expr: "record_id" },
            postgres: { expr: "pg_id" },
          },
        },
      ],
    };
    expect(loadDuckDBSchema(doc).bindings.id).toBe("record_id");
    expect(() =>
      loadDuckDBSchema({
        ...doc,
        fields: [
          { ...doc.fields[0], bindings: { postgres: { expr: "pg_id" } } },
        ],
      }),
    ).toThrow("explicit");
  });
  it("reports field statistics, and rejects disabled filters", async () => {
    expect(
      await backend.transport().fetchFieldStats!(["amount", "tags"]),
    ).toEqual({
      amount: { distinct: 5, min: 5, max: 200 },
      tags: { distinct: 4 },
    });
    const closed = new DuckDBBackend({
      ...backend.options,
      schema: {
        ...schema,
        fields: schema.fields.map((field) =>
          field.name === "category"
            ? { ...field, filter: { enabled: false } }
            : field,
        ),
      },
    });
    await expect(
      closed.transport().fetchDistinctValues!({
        field: "category",
        search: "",
      }),
    ).rejects.toThrow("not filterable");
  });
  it("handles row expressions with numeric parameters and stable unique arrays", async () => {
    const clauses = [
      metric("SUM(IF([flag], 1, 0)) / NULLIF(COUNT(), 0)", { groupBy: [] }),
      metric("COUNT_DISTINCT(LEFT([category], 1))", { groupBy: [] }),
    ];
    const result = await execute({ aggregations: clauses });
    expect(result.metrics[0]?.buckets[0]?.value).toBe(0.5);
    expect(result.metrics[1]?.buckets[0]?.value).toBe(2);
    const sql = new SQLBuilder(schema).expression(
      'JOIN(ARRAY_UNIQUE(SPLIT("b,a,b,c", ",")), ",")',
    );
    const b = new SQLBuilder(schema);
    const expression = b.expression(
      'JOIN(ARRAY_UNIQUE(SPLIT("b,a,b,c", ",")), ",")',
    );
    const actual = (
      await native.runAndReadAll(
        `SELECT ${expression.sql} AS value`,
        b.args as any[],
      )
    ).getRowObjectsJS();
    expect(actual[0]?.value).toBe("b,a,c");
    expect(sql.plan.type).toBe("text");
  });
  it("fails expression expansion before allocating an unbounded SQL statement", () => {
    const expression = Array(12).fill("[amount]").join("*");
    expect(() => new SQLBuilder(schema).expression(expression)).toThrow(
      "budget",
    );
  });
  it("preserves civil dates and UTC native timestamps when grouping in named zones", async () => {
    await native.run("CREATE TABLE civil (id VARCHAR, date DATE)");
    await native.run("INSERT INTO civil VALUES ('c', DATE '2025-01-01')");
    const civil = new DuckDBBackend({
      ...backend.options,
      relation: "civil",
      schema: {
        ...schema,
        fields: schema.fields.filter((field) =>
          ["id", "date"].includes(field.name),
        ),
      },
    });
    const query = normalizeQueryState({
      aggregations: [
        metric("COUNT()", {
          groupBy: ["date"],
          dateGrouping: {
            field: "date",
            interval: "day",
            timeZone: "America/New_York",
            range: "observed",
            includeEmpty: false,
          },
        }),
      ],
    });
    const result = await civil.execute(
      toQueryRequestV3(query, civil.schema, civil.capabilities),
    );
    expect(result.metrics[0]?.buckets[0]?.keys[0]).toBe(
      "2025-01-01T05:00:00.000Z",
    );
    await native.run(
      "ALTER TABLE civil ALTER date TYPE TIMESTAMP USING TIMESTAMP '2025-01-01 01:00:00'",
    );
    const timestamp = await civil.execute(
      toQueryRequestV3(query, civil.schema, civil.capabilities),
    );
    expect(timestamp.metrics[0]?.buckets[0]?.keys[0]).toBe(
      "2024-12-31T05:00:00.000Z",
    );
  });
  it("keeps empty text and null as separate typed groups", async () => {
    await native.run("INSERT INTO runs VALUES ('7', '', 7, 1, [], NULL, TRUE)");
    const result = await execute({
      aggregations: [
        metric("COUNT()"),
        metric("COUNT_DISTINCT([category])", { groupBy: [] }),
      ],
    });
    expect(
      result.metrics[0]?.buckets.find((bucket) => bucket.keys[0] === "")?.value,
    ).toBe(1);
    expect(
      result.metrics[0]?.buckets.find((bucket) => bucket.keys[0] === null)
        ?.value,
    ).toBe(1);
    expect(result.metrics[1]?.buckets[0]?.value).toBe(3);
    const groups = await execute({
      grouping: {
        source: normalizeQueryState({}),
        keys: ["category"],
        summaries: [{ id: "n", op: "count" }],
        representative: null,
      },
    });
    expect(groups.total).toBe(4);
  });
  it("projects physical bindings into canonical frontend paths", async () => {
    const bound = new DuckDBBackend({
      ...backend.options,
      schema: {
        name: "bound",
        idField: "id",
        fields: [
          schema.fields[0]!,
          {
            name: "cost",
            label: "Cost",
            type: "number",
            source: { kind: "backend", path: "amount" },
          },
        ],
      },
      bindings: { cost: "r.amount * 2" },
    });
    const query = normalizeQueryState({
      select: [{ field: "cost" }],
      where: [{ field: "cost", op: "=", value: "20" }],
    });
    const result = await bound.execute(
      toQueryRequestV3(query, bound.schema, bound.capabilities),
    );
    expect(result.rows[0]?.cost).toBe(20);
    expect(bound.schema.fields[1]?.source).toMatchObject({ path: "cost" });
  });
  it("honors physical column paths in the standalone compiler", async () => {
    const physical: FieldSchema = {
      name: "physical",
      idField: "id",
      fields: [
        schema.fields[0]!,
        {
          name: "constructor",
          label: "Cost",
          type: "number",
          source: { kind: "backend", path: "amount" },
        },
      ],
    };
    const statement = compileDuckDBRows(
      {
        select: ["constructor"],
        where: [{ field: "constructor", op: ">=", value: "20" }],
        orderBy: [{ field: "constructor", dir: "desc" }],
        limit: 2,
        offset: 0,
      },
      physical,
      "runs",
    );
    const result = (
      await native.runAndReadAll(statement.sql, statement.args as any[])
    ).getRowObjectsJS();
    expect(result).toEqual([
      { id: "5", constructor: 200 },
      { id: "2", constructor: 30 },
    ]);
  });
});

function createGroupingSchema(query: ReturnType<typeof normalizeQueryState>) {
  return createGroupingModel(schema).resultSchema(
    query.grouping!.keys,
    query.grouping!.summaries,
  );
}
