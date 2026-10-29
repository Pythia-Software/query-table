// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  memoryStorageAdapter,
  normalizeQueryState,
  type AggregationResult,
  type FieldSchema,
  type QueryState,
  type ServerQuery,
  type StorageAdapter,
  type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; tool: string };
const schema: FieldSchema<Row> = {
  name: "tool-calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "tool", label: "Tool", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
  ],
};
const filtered = (tool: string): QueryState => normalizeQueryState({ select: [{ field: "id" }, { field: "tool" }], where: [{ field: "tool", op: "=", value: tool }] });

/** A transport whose responses the test releases or rejects by tool name. */
function controllable() {
  const pending = new Map<string, Array<{ resolve: (rows: Row[]) => void; reject: (error: Error) => void }>>();
  const toolOf = (query: ServerQuery) => {
    const term = query.where.find((term) => "field" in term && term.field === "tool");
    return term && "value" in term ? String(term.value) : "all";
  };
  const transport: Transport<Row> = {
    fetchRows: (query) => new Promise((resolve, reject) => {
      const tool = toolOf(query);
      pending.set(tool, [...pending.get(tool) ?? [], {
        resolve: (rows) => resolve({ rows, total: rows.length }),
        reject,
      }]);
    }),
  };
  const take = (tool: string) => {
    const queue = pending.get(tool) ?? [];
    const next = queue.shift();
    if (!next) throw Error(`no request for ${tool}`);
    return next;
  };
  return {
    transport,
    resolve: (tool: string, rows: Row[] = [{ id: 1, tool }]) => act(async () => { take(tool).resolve(rows); }),
    reject: (tool: string, error: Error) => act(async () => { take(tool).reject(error); }),
  };
}
function recording(): StorageAdapter & { last: QueryState[] } {
  const inner = memoryStorageAdapter();
  const last: QueryState[] = [];
  return { ...inner, last, saveLast: async (key, query) => { last.push(query); await inner.saveLast(key, query); } };
}

let root: Root | undefined;
function mount(options: Partial<UseQueryTableOptions<Row>>) {
  const current = { api: undefined as unknown as QueryTableApi<Row>, options };
  function Probe() {
    current.api = useQueryTable({ schema, debounceMs: 0, persistLast: "succeeded", ...current.options });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return {
    current,
    rerender(next: Partial<UseQueryTableOptions<Row>>) {
      current.options = { ...current.options, ...next };
      act(() => root!.render(createElement(Probe)));
    },
  };
}
const unmount = () => { if (root) act(() => root!.unmount()); root = undefined; };
async function wait(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const tool = (query: QueryState | undefined) => query?.where[0] && "field" in query.where[0] ? query.where[0].value : undefined;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { unmount(); vi.useRealTimers(); });

describe("persistLast: succeeded", () => {
  for (const [name, failure] of [
    ["service error", Error("HTTP 500")],
    ["validation failure", Error("HTTP 422: unknown field")],
    ["deadline", new DOMException("The operation timed out.", "TimeoutError")],
  ] as const) {
    it(`keeps the last successful query when the next one fails (${name})`, async () => {
      const storage = recording();
      const server = controllable();
      const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
      await wait(0);
      await server.resolve("A");
      expect(current.api.execution).toMatchObject({ status: "succeeded", rows: "succeeded", metrics: "none" });
      await wait(400);
      expect(tool(storage.last.at(-1))).toBe("A");

      act(() => current.api.setQuery(filtered("B")));
      await wait(0);
      expect(current.api.execution).toMatchObject({ status: "running", rows: "running" });
      // B is held well past the old 400 ms debounce, then fails.
      await wait(2000);
      expect(tool(storage.last.at(-1))).toBe("A");
      await server.reject("B", failure);
      expect(current.api.execution).toMatchObject({ status: "failed", rows: "failed" });
      expect(current.api.execution!.error!.message).toBe(failure.message);
      await wait(1000);
      expect(storage.last.map(tool)).toEqual(["A"]);

      // B stays the current, retryable query; a bare remount restores A.
      expect(tool(current.api.query)).toBe("B");
      unmount();
      expect(tool(await storage.loadLast("tool-calls") ?? undefined)).toBe("A");
      const again = mount({ transport: server.transport, storage, initialQuery: filtered("B") });
      await wait(0);
      // Retrying B succeeds; it is now the last query that worked.
      await server.resolve("B");
      expect(again.current.api.execution!.status).toBe("succeeded");
      await wait(400);
      expect(tool(storage.last.at(-1))).toBe("B");
    });
  }

  it("saves a success that a later edit interrupts before the debounce", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
    await wait(0);
    await server.resolve("A");
    await wait(400);
    act(() => current.api.setQuery(filtered("B")));
    await wait(0);
    await server.resolve("B");
    // 300 ms later the user edits to C, which fails.
    await wait(300);
    act(() => current.api.setQuery(filtered("C")));
    await wait(0);
    await server.reject("C", Error("HTTP 500"));
    await wait(1000);
    expect(storage.last.map(tool)).toEqual(["A", "B"]);
  });

  it("saves under refreshes faster than the debounce", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
    await wait(0);
    await server.resolve("A");
    for (let i = 0; i < 5; i++) {
      await wait(200);
      act(() => current.api.refresh());
      await wait(0);
      await server.resolve("A");
    }
    expect(storage.last.map(tool)).toEqual(["A"]);
    await wait(1000);
    expect(storage.last.map(tool)).toEqual(["A"]);
  });

  it("does not let a slower earlier query mark a later one healthy", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
    await wait(0);
    act(() => current.api.setQuery(filtered("B")));
    await wait(0);
    const generation = current.api.execution!.generation;
    await server.resolve("A");
    expect(current.api.execution).toMatchObject({ status: "running", generation });
    expect(tool(current.api.execution!.query)).toBe("B");
    expect(current.api.rows).toEqual([]);
    await server.reject("B", Error("HTTP 500"));
    await wait(1000);
    expect(storage.last).toEqual([]);
  });

  it("keeps empty results, including pages past the end, restorable", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: { ...filtered("none"), offset: 500 } });
    await wait(0);
    await server.resolve("none", []);
    expect(current.api.execution!.status).toBe("succeeded");
    await wait(400);
    expect(storage.last.at(-1)).toMatchObject({ offset: 500 });
  });

  it("saves presentation edits of a successful query without executing again", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
    await wait(0);
    await server.resolve("A");
    const key = current.api.execution!.key;
    act(() => current.api.setQuery((q) => ({ ...q, select: q.select.map((c) => ({ ...c, width: 200 })) })));
    await wait(400);
    expect(current.api.execution).toMatchObject({ status: "succeeded", key });
    expect(storage.last.at(-1)!.select[0]!.width).toBe(200);
  });

  it("treats a failed metric as an incomplete success", async () => {
    const storage = recording();
    const server = controllable();
    let metricsFail = true;
    const transport: Transport<Row> = {
      ...server.transport,
      fetchAggregations: async (): Promise<AggregationResult> => {
        if (metricsFail) throw Error("metric backend down");
        return { metrics: [{ id: "n", buckets: [{ keys: [], value: 1, count: 1 }] }] };
      },
    };
    const query = { ...filtered("A"), aggregations: [{ id: "n", op: "count" as const, groupBy: [] }] };
    const { current } = mount({ transport, storage, initialQuery: query });
    await wait(0);
    await server.resolve("A");
    await wait(10);
    expect(current.api.execution).toMatchObject({ status: "failed", rows: "succeeded", metrics: "failed" });
    await wait(1000);
    expect(storage.last).toEqual([]);
    metricsFail = false;
    act(() => current.api.refresh());
    await wait(0);
    await server.resolve("A");
    await wait(10);
    expect(current.api.execution).toMatchObject({ status: "succeeded", metrics: "succeeded" });
    await wait(400);
    expect(tool(storage.last.at(-1))).toBe("A");
  });

  it("publishes no receipt while hidden", async () => {
    const storage = recording();
    const server = controllable();
    const table = mount({ transport: server.transport, storage, initialQuery: filtered("A") });
    await wait(0);
    await server.resolve("A");
    expect(table.current.api.execution!.status).toBe("succeeded");
    table.rerender({ active: false });
    expect(table.current.api.execution).toBeNull();
  });

  it("keeps the default policy saving every change", async () => {
    const storage = recording();
    const server = controllable();
    const { current } = mount({ transport: server.transport, storage, initialQuery: filtered("A"), persistLast: "always" });
    await wait(0);
    act(() => current.api.setQuery(filtered("B")));
    await wait(400);
    expect(tool(storage.last.at(-1))).toBe("B");
  });
});
