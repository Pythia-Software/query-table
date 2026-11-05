// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  formulaRuntime,
  memoryComputedColumnStore,
  readFieldValue,
  sourceExecutionSchema,
  validateQueryResultV3,
  type ComputedColumnStore,
  type ComputedExecution,
  type FieldSchema,
  type FormulaNode,
  type FormulaValue,
  type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
import { evaluateFormulaRows } from "../src/formulaWorker";
import { MEMORY_V3_CAPABILITIES, serveQueryV3 } from "./v3Transport";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
interface Row {
  id: number;
  name: string;
  other?: string;
}
const schema: FieldSchema<Row> = {
  name: "shared",
  idField: "id",
  defaultSelect: [{ field: "name" }],
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
    {
      name: "other",
      label: "Other",
      type: "text",
      source: { kind: "backend" },
    },
  ],
};
const rows: Row[] = [
  { id: 1, name: "alpha", other: "one" },
  { id: 2, name: "alpine", other: "two" },
  { id: 3, name: "beta", other: "three" },
];
// The real worker's isolation/termination is covered by the browser test. This
// deterministic worker double exercises React invalidation and request lifetimes.
class TestWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  postMessage(message: {
    ast: FormulaNode;
    inputs: Record<string, FormulaValue>[];
  }) {
    queueMicrotask(() => {
      if (!this.terminated)
        this.onmessage?.({
          data: message.inputs.map((row) => formulaRuntime(message.ast, row)),
        });
    });
  }
  terminate() {
    this.terminated = true;
  }
}
const worker = () => new TestWorker() as unknown as Worker;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
function mount(
  store: ComputedColumnStore,
  transport?: Transport<Row>,
  execution?: ComputedExecution,
) {
  const result = {} as { current: QueryTableApi<Row> };
  function Probe() {
    result.current = useQueryTable({
      schema,
      computedColumnStore: store,
      ...(execution ? { computedExecution: execution } : {}),
      formulaWorkerFactory: worker,
      debounceMs: 0,
      ...(transport ? { transport } : { clientRows: rows }),
      initialQuery: {
        ...EMPTY_QUERY,
        select: [{ field: "@computed/prefix" }],
        limit: 1,
      },
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  cleanup.push(() => act(() => root.unmount()));
  return result;
}
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
const definition = {
  id: "prefix",
  label: "Prefix",
  expression: {
    language: "qt-expr" as const,
    version: 1 as const,
    source: "LEFT([name], 2)",
  },
};
describe("shared computed columns", () => {
  it("updates mounted tables by ID, keeps query history source-free, and previews beyond the page", async () => {
    const store = memoryComputedColumnStore();
    const first = await store.save("shared", definition, null);
    const a = mount(store),
      b = mount(store);
    await settle();
    await settle();
    expect(
      readFieldValue(a.current.visibleFields[0]!, a.current.rows[0]!),
    ).toBe("al");
    expect(a.current.query.select).toEqual([{ field: "@computed/prefix" }]);
    const preview = await a.current.computed.preview(
      "LEFT([name],2)",
      3,
      undefined,
      undefined,
      false,
    );
    expect(preview.processed).toBe(3);
    expect(preview.groups.map((g) => g.count)).toEqual([2, 1]);
    expect(a.current.rows).toHaveLength(1);
    await act(async () => {
      await store.save(
        "shared",
        {
          ...definition,
          expression: { ...definition.expression, source: "UPPER([name])" },
        },
        first.revision,
      );
    });
    await settle();
    await settle();
    expect(
      readFieldValue(a.current.visibleFields[0]!, a.current.rows[0]!),
    ).toBe("ALPHA");
    expect(
      readFieldValue(b.current.visibleFields[0]!, b.current.rows[0]!),
    ).toBe("ALPHA");
    expect(JSON.stringify(a.current.query)).not.toContain("UPPER");
  });
  it("requests hidden dependencies, batches previews, and only refetches on dependency changes", async () => {
    const store = memoryComputedColumnStore();
    const saved = await store.save("shared", definition, null);
    // A server that returns at most two projected rows per page.
    const fetchQueryV3 = vi.fn<Transport<Row>["fetchQueryV3"]>(async (request) => {
      const result = serveQueryV3(rows, schema, request, { project: true });
      return { ...result, rows: result.rows.slice(0, 2) };
    });
    const lastResult = () => fetchQueryV3.mock.calls.at(-1)?.[0].result;
    const result = mount(store, { queryCapabilities: MEMORY_V3_CAPABILITIES, fetchQueryV3 });
    await settle();
    await settle();
    expect(lastResult()?.select).toEqual(["id", "name"]);
    const calls = fetchQueryV3.mock.calls.length;
    await act(async () => {
      await result.current.computed.save(
        {
          ...definition,
          expression: { ...definition.expression, source: "RIGHT([name],2)" },
        },
        saved.revision,
      );
    });
    await settle();
    await settle();
    expect(fetchQueryV3).toHaveBeenCalledTimes(calls);
    const latest = result.current.computed.definitions[0]!;
    await act(async () => {
      await result.current.computed.save(
        {
          ...definition,
          expression: { ...definition.expression, source: "LEFT([other],2)" },
        },
        latest.revision,
      );
    });
    await settle();
    await settle();
    expect(lastResult()?.select).toEqual(["id", "other"]);
    const preview = await result.current.computed.preview("[other]", 3);
    expect(preview.processed).toBe(3);
    expect(lastResult()?.offset).toBe(2);
  });
  it("rejects cycles and leaves missing definitions visible", async () => {
    const store = memoryComputedColumnStore();
    await store.save("shared", definition, null);
    const result = mount(store);
    await settle();
    expect(() =>
      result.current.computed.compile("[@computed/prefix]", "prefix"),
    ).toThrow("Circular");
    act(() =>
      result.current.setQuery((q) => ({
        ...q,
        select: [{ field: "@computed/missing" }],
      })),
    );
    await settle();
    expect(result.current.visibleFields).toHaveLength(1);
    expect(
      readFieldValue(result.current.visibleFields[0]!, rows[0]!),
    ).toMatchObject({ computedError: expect.stringContaining("unavailable") });
  });
  it("mixes browser formulas with server sidecars and ignores browser revision changes", async () => {
    const store = memoryComputedColumnStore();
    const prefix = await store.save("shared", definition, null);
    const double = await store.save("shared", {
      id: "double", label: "Double",
      expression: { language: "qt-expr", version: 1, source: "[id]*2" },
    }, null);
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1", planToken: "plan", snapshot: "snapshot",
      resolvedRevisions: { prefix: prefix.revision, double: double.revision },
      fields: { "@computed/double": {
        type: "number", select: true, sort: true, measure: true, group: true,
      } },
    };
    const fetchQueryV3 = vi.fn<Transport<Row>["fetchQueryV3"]>(async (request) => ({
      version: 3, now: request.now, sourceTotal: rows.length, total: rows.length, metrics: [],
      rows: [{ ...rows[0]!, "@computed/double": 17 }],
      schema: { name: schema.name, idField: "id", fields: [...schema.fields.map(({ name, type }) => ({ name, type })), { name: "@computed/double", type: "number" }] },
      execution,
    }));
    const result = mount(store, { queryCapabilities: { ...MEMORY_V3_CAPABILITIES, profile: execution.profile }, fetchQueryV3 }, execution);
    await settle();
    await settle();
    act(() => result.current.setQuery(q => ({
      ...q, select: [{ field: "@computed/prefix" }, { field: "@computed/double" }],
    })));
    await settle();
    await settle();
    const query = fetchQueryV3.mock.calls.at(-1)![0];
    expect(query.result.select).toContain("name");
    expect(query.result.select).toContain("@computed/double");
    expect(query.result.select).not.toContain("@computed/prefix");
    expect(query.diagnostics).toEqual([]);
    // Keep the host's complete envelope for authoritative transitive checks.
    expect(query.expectedRevisions).toEqual(execution.resolvedRevisions);
    const response = await fetchQueryV3.mock.results.at(-1)!.value;
    const catalogue = sourceExecutionSchema(schema, execution);
    expect(() => validateQueryResultV3(response, query, catalogue)).not.toThrow();
    const staleResponse = {
      ...response,
      execution: { ...execution, resolvedRevisions: { ...execution.resolvedRevisions, double: "stale" } },
    };
    expect(() => validateQueryResultV3(staleResponse, query, catalogue)).toThrow("Computed definitions changed");
    expect(() => validateQueryResultV3({
      ...response, schema: { ...response.schema, fields: response.schema.fields.filter((field: { name: string }) => field.name !== "@computed/double") },
    }, query, catalogue)).toThrow("different projected schema");
    expect(result.current.error).toBeNull();
    expect(result.current.visibleFields.map(f => readFieldValue(f, result.current.rows[0]!))).toEqual(["al", 17]);
    await act(async () => {
      await store.save("shared", {
        ...definition, expression: { ...definition.expression, source: "LEFT([name],3)" },
      }, prefix.revision);
    });
    await settle();
    await settle();
    expect(result.current.error).toBeNull();
    expect(result.current.visibleFields.map(f => readFieldValue(f, result.current.rows[0]!))).toEqual(["alp", 17]);
    expect(result.current.visibleFields[0]!.sort?.enabled).toBe(false);
    expect(result.current.visibleFields[0]!.aggregate?.groupable).toBe(false);
    const calls = fetchQueryV3.mock.calls.length;
    act(() => result.current.setQuery(q => ({
      ...q, orderBy: [{ field: "@computed/prefix", dir: "asc" }],
    })));
    await settle();
    expect(result.current.error?.message).toContain("unsupported result ordering");
    expect(fetchQueryV3).toHaveBeenCalledTimes(calls);
  });
  it("terminates timed-out and cancelled workers", async () => {
    vi.useFakeTimers();
    const stuck = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    };
    const ast: FormulaNode = { kind: "literal", value: 1, from: 0, to: 1 };
    const promise = evaluateFormulaRows(
      ast,
      [{}],
      undefined,
      () => stuck as unknown as Worker,
    );
    const rejected = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    expect(stuck.terminate).toHaveBeenCalledOnce();
    const ac = new AbortController();
    const cancelled = evaluateFormulaRows(
      ast,
      [{}],
      ac.signal,
      () => stuck as unknown as Worker,
    );
    ac.abort();
    await expect(cancelled).rejects.toThrow("Aborted");
  });
});
