import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  compileFormula,
  formulaRuntime,
  type FieldSchema,
  type FormulaNode,
  type FormulaValue,
  type Transport,
} from "@pythia-software/query-table-core";
import { executeMetrics } from "../src/metricExecution";
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
describe("metric execution boundary", () => {
  it("falls back to the complete client dataset when a transport cannot aggregate", async () => {
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows: rows.slice(0, 1), total: 3 }),
    };
    const q = { ...EMPTY_QUERY, aggregations: [clause] };
    expect(
      await executeMetrics(q, { schema, transport, clientRows: rows }),
    ).toEqual(await executeMetrics(q, { schema, clientRows: rows }));
    const legacy = {
      ...EMPTY_QUERY,
      aggregations: [
        { id: "m", op: "count_distinct" as const, field: "x", groupBy: ["x"] },
      ],
    };
    expect(
      (await executeMetrics(legacy, { schema, transport, clientRows: rows }))
        .metrics[0]!.buckets,
    ).toHaveLength(3);
    expect(
      (
        await executeMetrics(
          { ...q, where: [{ field: "x", op: ">", value: "15" }] },
          { schema, transport, clientRows: rows },
        )
      ).metrics[0]!.buckets[0]!.value,
    ).toBe(10);
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
  it("never substitutes partial server pages for all-matching results", async () => {
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows: [rows[0]!], total: 3 }),
    };
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [clause] },
        { schema, transport, shownRows: [rows[0]!], rowsReady: true },
      ),
    ).rejects.toThrow("metric-capable");
  });
  it("never silently downgrades modern definitions to v1", async () => {
    const fetchAggregations = vi.fn(async () => ({ metrics: [] }));
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [clause] },
        {
          schema,
          transport: {
            fetchRows: async () => ({ rows, total: 3 }),
            fetchAggregations,
          },
        },
      ),
    ).rejects.toThrow();
    expect(fetchAggregations).not.toHaveBeenCalled();
  });
  it("uses committed shown-page inputs without a newer hydration request", async () => {
    const fetchRows = vi.fn<Transport<Row>["fetchRows"]>(async () => ({
      rows: [{ ...rows[0]!, x: 99 }],
      total: 3,
    }));
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
      transport: { fetchRows },
      shownRows: [rows[0]!],
      rowsReady: true,
    });
    expect(result.metrics[0]!.buckets[0]!.value).toBe(10);
    expect(fetchRows).not.toHaveBeenCalled();
    await expect(
      executeMetrics(q, {
        schema,
        transport: { fetchRows },
        shownRows: [{ id: 1 } as Row],
        rowsReady: true,
      }),
    ).rejects.toThrow("not loaded");
  });
  it("uses one v2 batch for shown/all paired measures and forwards cancellation", async () => {
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({
        metrics: [
          { id: "ratio", buckets: [] },
          { id: "shown", buckets: [] },
        ],
      }),
    );
    const ac = new AbortController();
    await executeMetrics(
      {
        ...EMPTY_QUERY,
        aggregations: [clause, { ...clause, id: "shown", scope: "shownRows" }],
      },
      {
        schema,
        transport: {
          fetchRows: async () => ({ rows, total: 3 }),
          fetchMetrics,
          metricCapabilities: {
            version: 2,
            expressions: true,
            shownRows: true,
          },
        },
      },
      ac.signal,
    );
    expect(fetchMetrics).toHaveBeenCalledOnce();
    expect(fetchMetrics.mock.calls[0]![0].metrics.map((c) => c.scope)).toEqual([
      undefined,
      "shownRows",
    ]);
    expect(fetchMetrics.mock.calls[0]![1]).toBe(ac.signal);
  });
  it("enforces paired-expression, computed-field and profile capability contracts", async () => {
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({ metrics: [] }),
    );
    const base: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchMetrics,
      metricCapabilities: { version: 2 },
    };
    const paired = {
      id: "paired",
      op: "sum" as const,
      field: "x",
      groupBy: ["group"],
      expressionY: "SUM([y])",
      display: { kind: "scatter" as const },
    };
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [paired] },
        { schema, transport: base },
      ),
    ).rejects.toThrow("composed");
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
    const grouped = {
      id: "grouped",
      op: "count" as const,
      groupBy: ["@computed/category"],
    };
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [grouped] },
        { schema, transport: base, execution },
      ),
    ).rejects.toThrow("computed fields");
    await expect(
      executeMetrics(
        { ...EMPTY_QUERY, aggregations: [grouped] },
        {
          schema,
          transport: {
            ...base,
            metricCapabilities: {
              version: 2,
              computedFields: true,
              profile: "other-profile",
            },
          },
          execution,
        },
      ),
    ).rejects.toThrow("profiles");
    expect(fetchMetrics).not.toHaveBeenCalled();
  });
  it("ignores inactive formula alternatives when gating server features", async () => {
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({ metrics: [] }),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchMetrics,
      metricCapabilities: { version: 2, distributions: true },
    };
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
    expect(fetchMetrics.mock.lastCall![0].metrics[0]).not.toHaveProperty(
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
    expect(fetchMetrics.mock.lastCall![0].metrics[0]).not.toHaveProperty(
      "expression",
    );
    expect(fetchMetrics.mock.lastCall![0].metrics[0]).not.toHaveProperty(
      "expressionY",
    );
    expect(fetchMetrics).toHaveBeenCalledTimes(2);
  });
  it("runs regex inputs only on the shown page in a terminated worker", async () => {
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
