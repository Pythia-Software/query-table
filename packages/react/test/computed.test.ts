// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  formulaRuntime,
  memoryComputedColumnStore,
  readFieldValue,
  type ComputedColumnStore,
  type FieldSchema,
  type FormulaNode,
  type FormulaValue,
  type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
import { evaluateFormulaRows } from "../src/formulaWorker";
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
function mount(store: ComputedColumnStore, transport?: Transport<Row>) {
  const result = {} as { current: QueryTableApi<Row> };
  function Probe() {
    result.current = useQueryTable({
      schema,
      computedColumnStore: store,
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
    const fetchRows = vi.fn<Transport<Row>["fetchRows"]>(async (query) => ({
      rows: rows
        .slice(query.offset, query.offset + Math.min(query.limit, 2))
        .map(
          (row) =>
            Object.fromEntries(
              query.select.map((k) => [k, row[k as keyof Row]]),
            ) as unknown as Row,
        ),
      total: rows.length,
    }));
    const result = mount(store, { fetchRows });
    await settle();
    await settle();
    expect(fetchRows.mock.calls.at(-1)?.[0].select).toEqual(["id", "name"]);
    const calls = fetchRows.mock.calls.length;
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
    expect(fetchRows).toHaveBeenCalledTimes(calls);
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
    expect(fetchRows.mock.calls.at(-1)?.[0].select).toEqual(["id", "other"]);
    const preview = await result.current.computed.preview("[other]", 3);
    expect(preview.processed).toBe(3);
    expect(fetchRows.mock.calls.at(-1)?.[0].offset).toBe(2);
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
