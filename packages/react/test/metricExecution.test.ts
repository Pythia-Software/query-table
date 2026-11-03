import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  compileFormula,
  formulaRuntime,
  type FieldSchema,
  type FormulaNode,
  type FormulaValue,
  type QueryRequestV3,
  type QueryResultV3,
  type Transport,
} from "@pythia-software/query-table-core";
import { executeMetrics } from "../src/metricExecution";
import { MEMORY_V3_CAPABILITIES, memoryV3Transport, metricRequests, v3Response } from "./v3Transport";
interface Row {
  id: number;
  x: number;
  y: number;
  group: string;
  name: string;
}
const schema: FieldSchema<Row> = {
  name: "metrics",
  idField: "id",
  fields: [
    ...["id", "x", "y"].map((name) => ({
      name,
      label: name,
      type: "number" as const,
      source: { kind: "backend" as const },
    })),
    ...["group", "name"].map((name) => ({
      name,
      label: name,
      type: "text" as const,
      source: { kind: "backend" as const },
    })),
  ],
};
const rows: Row[] = [
  { id: 1, x: 10, y: 2, group: "a", name: "alpha" },
  { id: 2, x: 30, y: 3, group: "a", name: "beta" },
  { id: 3, x: 20, y: 4, group: "b", name: "charlie" },
];
const clause = {
  id: "ratio",
  op: "count" as const,
  groupBy: ["group"],
  expression: "SUM([x]) / SUM([y])",
};
/** A v3 transport whose spy answers every metric with `answer`. */
function v3Transport(answer: (request: QueryRequestV3) => QueryResultV3["metrics"], capabilities: Partial<Transport["queryCapabilities"]> = {}) {
  const fetchQueryV3 = vi.fn(async (request: QueryRequestV3, _signal?: AbortSignal) => v3Response(request, { metrics: answer(request) }));
  return { queryCapabilities: { ...MEMORY_V3_CAPABILITIES, ...capabilities }, fetchQueryV3 } satisfies Transport<Row>;
}
describe("metric execution boundary", () => {
  it("requires a shown-row minimum's measured field on the page", async () => {
    const query = { ...EMPTY_QUERY, aggregations: [
      { id: "page", op: "count" as const, groupBy: ["group"], scope: "shownRows" as const, minCount: { min: 2, distinct: "name" } },
    ] };
    // The page loaded group and id only; name is missing, not NULL.
    const page = rows.map(({ id, group }) => ({ id, group }) as Row);
    await expect(executeMetrics(query, { schema, shownRows: page, rowsReady: true, shownFields: ["id", "group"] }))
      .rejects.toThrow("Shown-page input name is not loaded");
    const result = await executeMetrics(query, { schema, shownRows: rows, rowsReady: true, shownFields: ["id", "group", "name"] });
    expect(result.metrics[0]!.buckets.map((b) => b.keys)).toEqual([["a"]]);
  });
  it("sends shown-row and all-matching clauses in one v3 request with the computed envelope, in clause order", async () => {
    const transport = v3Transport(request => request.metrics.map(m => ({ id: m.id, buckets: [{ keys: [], value: 100, count: 100 }] })),
      { profile: "qt-postgres-v1" });
    const execution = {
      profile: "qt-postgres-v1", planToken: "metric-plan", resolvedRevisions: { double: "metric-revision" },
      fields: { "@computed/double": { type: "number" as const, select: true, sort: true, group: true, measure: true } },
    };
    const query = { ...EMPTY_QUERY, offset: 1, limit: 1, aggregations: [
      { id: "page", op: "sum" as const, field: "@computed/double", groupBy: [], scope: "shownRows" as const },
      { id: "all", op: "sum" as const, field: "@computed/double", groupBy: [] },
      { id: "page-count", op: "count" as const, groupBy: [], scope: "shownRows" as const },
    ] };
    const context = {
      schema, transport, execution, clientRows: rows, shownRows: [rows[1]!], rowsReady: true,
      resolveComputed: (name: string) => name === "@computed/double" ? compileFormula("[x] * 2", schema.fields) : undefined,
    };
    const result = await executeMetrics(query, context);
    expect(result.metrics.map(m => [m.id, m.buckets[0]?.value])).toEqual([["page", 100], ["all", 100], ["page-count", 100]]);
    expect(transport.fetchQueryV3).toHaveBeenCalledOnce();
    expect(transport.fetchQueryV3.mock.calls[0]![0]).toMatchObject({
      rows: false, result: { offset: 1, limit: 1 },
      metrics: [{ id: "page", field: "@computed/double", scope: "shownRows" }, { id: "all", field: "@computed/double" }, { id: "page-count", scope: "shownRows" }],
      expectedRevisions: { double: "metric-revision" }, planToken: "metric-plan",
    });
    const ac = new AbortController(); ac.abort();
    await expect(executeMetrics(query, context, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.fetchQueryV3).toHaveBeenCalledOnce();
  });
  it("runs metrics on the server even when the complete client dataset is present", async () => {
    const transport = memoryV3Transport(rows, schema);
    const q = { ...EMPTY_QUERY, aggregations: [clause] };
    expect(
      await executeMetrics(q, { schema, transport, clientRows: rows.slice(0, 1) }),
    ).toEqual(await executeMetrics(q, { schema, clientRows: rows }));
    expect(
      (await executeMetrics({ ...EMPTY_QUERY, aggregations: [{ id: "m", op: "count_distinct" as const, field: "x", groupBy: ["group"] }] },
        { schema, transport, clientRows: rows.slice(0, 1) })).metrics[0]!.buckets.map((b) => b.value),
    ).toEqual([2, 1]);
    expect(
      (
        await executeMetrics(
          { ...q, where: [{ field: "x", op: ">", value: "15" }] },
          { schema, transport, clientRows: rows.slice(0, 1) },
        )
      ).metrics[0]!.buckets[0]!.value,
    ).toBe(10);
    expect(metricRequests(transport)).toHaveLength(3);
    expect(metricRequests(transport)[2]!.source.where).toEqual([{ field: "x", op: ">", value: "15" }]);
  });
  it("uses the full filtered dataset and a separately committed shown page", async () => {
    const result = await executeMetrics(
      {
        ...EMPTY_QUERY,
        limit: 1,
        offset: 1,
        aggregations: [clause, { ...clause, id: "shown", scope: "shownRows" }],
      },
      { schema, clientRows: rows, shownRows: [rows[1]!], rowsReady: true },
    );
    expect(result.metrics[0]!.buckets.map((b) => b.value)).toEqual([8, 5]);
    expect(result.metrics[1]!.buckets[0]!.value).toBe(10);
    expect(result.metrics[1]!.processedRows).toBe(1);
  });
  it("expands stored computed definitions before aggregate arithmetic", async () => {
    const result = await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [
          { ...clause, expression: "SUM([@computed/double]) / SUM([y])" },
        ],
      },
      {
        schema,
        clientRows: rows,
        resolveComputed: (name) =>
          name === "@computed/double"
            ? compileFormula("[x] * 2", schema.fields)
            : undefined,
      },
    );
    expect(result.metrics[0]!.buckets.map((b) => b.value)).toEqual([16, 10]);
  });
  it("never substitutes partial pages for all-matching results without a server", async () => {
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [clause] },
        { schema, shownRows: [rows[0]!], rowsReady: true },
      ),
    ).rejects.toThrow("metric-capable");
  });
  it("uses committed shown-page inputs without a server", async () => {
    const q = {
      ...EMPTY_QUERY,
      limit: 1,
      aggregations: [
        {
          id: "sum",
          op: "sum" as const,
          field: "x",
          groupBy: [],
          scope: "shownRows" as const,
        },
      ],
    };
    const result = await executeMetrics(q, {
      schema,
      shownRows: [rows[0]!],
      rowsReady: true,
    });
    expect(result.metrics[0]!.buckets[0]!.value).toBe(10);
    await expect(
      executeMetrics(q, {
        schema,
        shownRows: [{ id: 1 } as Row],
        rowsReady: true,
      }),
    ).rejects.toThrow("not loaded");
  });
  it("uses one v3 batch for shown/all paired measures and forwards cancellation", async () => {
    const transport = v3Transport(() => [
      { id: "ratio", buckets: [] },
      { id: "shown", buckets: [] },
    ]);
    const ac = new AbortController();
    await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [clause, { ...clause, id: "shown", scope: "shownRows" }],
      },
      { schema, transport },
      ac.signal,
    );
    expect(transport.fetchQueryV3).toHaveBeenCalledOnce();
    expect(transport.fetchQueryV3.mock.calls[0]![0].metrics.map((c) => c.scope)).toEqual([
      undefined,
      "shownRows",
    ]);
    expect(transport.fetchQueryV3.mock.calls[0]![1]).toBe(ac.signal);
  });
  it("rejects a computed execution handshake from another profile before dispatch", async () => {
    const transport = v3Transport(() => [], { profile: "other-profile" });
    const execution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      resolvedRevisions: { category: "r1" },
      fields: {
        "@computed/category": {
          type: "text" as const,
          select: true,
          sort: true,
          group: true,
          measure: true,
        },
      },
    };
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [{ id: "grouped", op: "count" as const, groupBy: ["@computed/category"] }] },
        { schema, transport, execution },
      ),
    ).rejects.toThrow("profile");
    expect(transport.fetchQueryV3).not.toHaveBeenCalled();
  });
  it("omits inactive formula alternatives from the server request", async () => {
    const transport = v3Transport(request => request.metrics.map(m => ({ id: m.id, buckets: [] })));
    await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [
          {
            id: "scalar",
            op: "sum",
            field: "x",
            groupBy: [],
            expressionY: "SUM([y])",
            display: { kind: "value" },
          },
        ],
      },
      { schema, transport },
    );
    expect(transport.fetchQueryV3.mock.lastCall![0].metrics[0]).not.toHaveProperty(
      "expressionY",
    );
    await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [
          {
            id: "box",
            op: "sum",
            field: "x",
            groupBy: [],
            expression: "SUM([x])",
            expressionY: "SUM([y])",
            distribution: { kind: "box", input: "[x]" },
            display: { kind: "box" },
          },
        ],
      },
      { schema, transport },
    );
    expect(transport.fetchQueryV3.mock.lastCall![0].metrics[0]).not.toHaveProperty(
      "expression",
    );
    expect(transport.fetchQueryV3.mock.lastCall![0].metrics[0]).not.toHaveProperty(
      "expressionY",
    );
    expect(transport.fetchQueryV3).toHaveBeenCalledTimes(2);
  });
  it("runs shown-row regex inputs on a worker", async () => {
    const inputs: Record<string, FormulaValue>[] = [];
    const terminate = vi.fn();
    const worker = {
      terminate,
      postMessage(data: {
        ast: FormulaNode;
        inputs: Record<string, FormulaValue>[];
      }) {
        inputs.push(...data.inputs);
        queueMicrotask(() =>
          worker.onmessage?.({
            data: data.inputs.map((row) => formulaRuntime(data.ast, row)),
          } as MessageEvent),
        );
      },
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
    };
    const regex = {
      id: "regex",
      op: "count" as const,
      expression: 'SUM(IF(REGEX_TEST([name], "^b"), 1, 0))',
      groupBy: [],
      scope: "shownRows" as const,
    };
    const result = await executeMetrics(
      { ...EMPTY_QUERY, limit: 1, offset: 1, aggregations: [regex] },
      {
        schema,
        clientRows: rows,
        shownRows: [rows[1]!],
        rowsReady: true,
        workerFactory: () => worker as unknown as Worker,
      },
    );
    expect(result.metrics[0]!.buckets[0]!.value).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.name).toBe("beta");
    expect(terminate).toHaveBeenCalledOnce();
    inputs.length = 0;
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [{ ...regex, scope: "allMatching" }] },
        {
          schema,
          clientRows: rows,
          workerFactory: () => worker as unknown as Worker,
        },
      ),
    ).rejects.toThrow("Regex");
    expect(inputs).toHaveLength(0);
  });
});

it("keeps permissive legacy results and clause order in a mixed local dashboard", async () => {
  const mixedSchema: FieldSchema<{
    id: number;
    at: unknown;
    x: unknown;
    group: unknown;
  }> = {
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
      { name: "x", label: "X", type: "number", source: { kind: "backend" } },
      {
        name: "group",
        label: "Group",
        type: "number",
        source: { kind: "backend" },
      },
    ],
  };
  const date = new Date("2026-01-01T00:00:00Z");
  for (const at of [date, date.getTime(), "2026-01-01 00:00:00"]) {
    const result = await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [
          { id: "distinct", op: "count_distinct", field: "at", groupBy: [] },
          { id: "modern", op: "count", expression: "COUNT()", groupBy: [] },
          { id: "sum", op: "sum", field: "x", groupBy: ["group"] },
          { id: "min", op: "min", field: "at", groupBy: [] },
        ],
      },
      {
        schema: mixedSchema,
        clientRows: [
          { id: 1, at, x: "12", group: date },
          { id: 2, at, x: "8", group: date },
        ],
      },
    );
    expect(result.metrics.map((m) => m.id)).toEqual([
      "distinct",
      "modern",
      "sum",
      "min",
    ]);
    expect(result.metrics.map((m) => m.buckets[0]?.value)).toEqual([
      1,
      2,
      20,
      at,
    ]);
    expect(result.metrics[2]?.buckets[0]?.keys).toEqual([String(date)]);
  }
});

it("does not bypass the mixed-dashboard card cap by partitioning engines", async () => {
  const result = await executeMetrics(
    {
      ...EMPTY_QUERY,
      aggregations: [
        clause,
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `m${i}`,
          op: "count" as const,
          groupBy: [],
        })),
      ],
    },
    { schema, clientRows: rows },
  );
  expect(result.metrics).toHaveLength(21);
  expect(
    result.metrics.every((m) =>
      m.error?.includes("Malformed metric definitions"),
    ),
  ).toBe(true);
});
describe("metric population capability negotiation", () => {
  const plain = { id: "plain", op: "count" as const, groupBy: ["group"] };
  const filtered = { id: "filtered", op: "count" as const, groupBy: ["group"], where: [{ field: "name", op: "=" as const, value: "alpha" }] };
  const small = { id: "small", op: "count" as const, groupBy: ["group"], minCount: 2 };
  it("fails only the clauses a v3 server cannot execute exactly", async () => {
    const transport = v3Transport(request => request.metrics.map((m) => ({ id: m.id, buckets: [{ keys: ["a"], value: 2, count: 2 }] })),
      { metricFilters: false, metricMinCount: true, metricMinCountMeasures: false });
    const result = await executeMetrics({ ...EMPTY_QUERY, aggregations: [plain, filtered, small] }, { schema, transport });
    expect(transport.fetchQueryV3).toHaveBeenCalledOnce();
    expect(transport.fetchQueryV3.mock.calls[0]![0].metrics.map((m) => m.id)).toEqual(["plain", "small"]);
    expect(result.metrics.map((m) => [m.id, m.error ?? null])).toEqual([
      ["plain", null],
      ["filtered", "This server does not support metric filters."],
      ["small", null],
    ]);
  });
  it("sends a distinct or summed minimum only to servers that advertise it", async () => {
    const measured = { id: "measured", op: "count" as const, groupBy: ["group"], minCount: { min: 2, distinct: "name" } };
    const calls: QueryRequestV3[] = [];
    const run = (capabilities: Partial<Transport["queryCapabilities"]>) => {
      const transport = v3Transport(request => { calls.push(request); return request.metrics.map((m) => ({ id: m.id, buckets: [] })); },
        { metricFilters: false, metricMinCount: false, metricMinCountMeasures: false, ...capabilities });
      return executeMetrics({ ...EMPTY_QUERY, aggregations: [small, measured] }, { schema, transport });
    };
    const older = await run({ metricMinCount: true });
    expect(calls[0]!.metrics.map((m) => m.id)).toEqual(["small"]);
    expect(older.metrics[1]).toEqual({ id: "measured", buckets: [], error: "This server does not support a minimum of distinct values or a sum per group." });
    const none = await run({});
    expect(calls).toHaveLength(1);
    expect(none.metrics[0]).toEqual({ id: "small", buckets: [], error: "This server does not support a minimum rows per group." });
    const current = await run({ metricMinCount: true, metricMinCountMeasures: true });
    expect(calls[1]!.metrics).toEqual([
      expect.objectContaining({ id: "small", minCount: 2 }),
      expect.objectContaining({ id: "measured", minCount: { min: 2, distinct: "name" } }),
    ]);
    expect(current.metrics.every((m) => !m.error)).toBe(true);
  });
  it("evaluates both controls on the local engine, including shown rows", async () => {
    const result = await executeMetrics(
      { ...EMPTY_QUERY, aggregations: [filtered, small, { ...filtered, id: "page", scope: "shownRows" as const }] },
      { schema, clientRows: rows, shownRows: rows, rowsReady: true },
    );
    expect(result.metrics.map((m) => [m.id, m.buckets.map((b) => [b.keys[0], b.count]), m.hiddenGroups])).toEqual([
      ["filtered", [["a", 1]], undefined],
      ["small", [["a", 2]], 1],
      ["page", [["a", 1]], undefined],
    ]);
  });
});

describe("metric series execution", () => {
  it("sends shares to a v3 server as plain metrics and divides the results", async () => {
    const sent: string[][] = [];
    const transport = v3Transport((request) => {
      sent.push(request.metrics.map((m) => `${m.expression ?? m.op}:${m.groupBy.join(",")}`));
      expect(request.diagnostics).toEqual([]);
      return request.metrics.map((m) => ({
        id: m.id,
        buckets: m.groupBy.length
          ? [{ keys: ["a"], value: 40, count: 2 }, { keys: ["b"], value: 20, count: 1 }]
          : [{ keys: [], value: 60, count: 3 }],
      }));
    });
    const share = { id: "share", op: "sum" as const, field: "x", groupBy: ["group"], share: "total" as const };
    const result = await executeMetrics({ ...EMPTY_QUERY, aggregations: [share, clause] }, { schema, transport });
    expect(sent).toEqual([["sum:group", "sum:", "SUM([x]) / SUM([y]):group"]]);
    expect(result.metrics.map((m) => m.id)).toEqual(["share", "ratio"]);
    expect(result.metrics[0]!.buckets.map((b) => [b.keys[0], b.value])).toEqual([["a", 40 / 60], ["b", 20 / 60]]);
  });

  it("runs windows through the v3 executor in budgeted batches", async () => {
    const batches: number[] = [];
    const executeV3 = vi.fn(async (query: Parameters<NonNullable<Parameters<typeof executeMetrics>[1]["executeV3"]>>[0]) => {
      batches.push(query.aggregations!.length);
      expect(query.aggregations!.every((m) => m.window === undefined)).toBe(true);
      return {
        metrics: query.aggregations!.map((m) => ({
          id: m.id,
          buckets: ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"].map((day, i) => ({
            keys: [day], value: m.expression === "SUM([x])" ? i + 1 : 2, count: 1,
          })),
        })),
      };
    });
    const dated: FieldSchema<Row> = {
      ...schema,
      fields: [...schema.fields, { name: "at", label: "at", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } }],
    };
    const windows = Array.from({ length: 11 }, (_, i) => ({
      id: `w${i}`, op: "count" as const, groupBy: ["at"], expression: "SUM([x]) / SUM([y])",
      dateGrouping: { field: "at", interval: "day" as const, includeEmpty: true, range: "observed" as const },
      window: { periods: 2 },
    }));
    const result = await executeMetrics({ ...EMPTY_QUERY, aggregations: windows }, { schema: dated, executeV3 });
    expect(batches).toEqual([20, 2]);
    expect(result.metrics.map((m) => m.id)).toEqual(windows.map((w) => w.id));
    expect(result.metrics[10]!.buckets.map((b) => b.value)).toEqual([null, 3 / 4, 5 / 4]);
  });
});
