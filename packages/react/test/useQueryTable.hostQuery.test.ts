// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeQuery,
  memoryStorageAdapter,
  normalizeQueryState,
  type FieldSchema,
  type HostQueryState,
  type QueryState,
  type ServerQuery,
  type StorageAdapter,
  type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type HostQueryOptions, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; tool: string; status: string; command: string };
const schema: FieldSchema<Row> = {
  name: "tool_calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "tool", label: "Tool", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "status", label: "Status", type: "text", source: { kind: "backend" } },
    { name: "command", label: "Command", type: "text", source: { kind: "backend" } },
  ],
};
const keyword = (text: string): HostQueryState => ({ version: 1, params: { record_tool_calls: ["command", text] } });
const none: HostQueryState = { version: 1, params: {} };
/** The host's own validation: one keyword clause on a known field. Editor IDs are incidental. */
const hostQuery: HostQueryOptions = {
  ownedParameters: ["record_tool_calls"],
  defaults: none,
  normalize(state) {
    if (state.version !== 1) throw Error(`Unsupported keyword state version ${state.version}.`);
    const clause = state.params.record_tool_calls;
    if (clause && (clause.length !== 2 || clause[0] !== "command")) throw Error("Unknown keyword field.");
    return clause ? { version: 1, params: { record_tool_calls: clause } } : none;
  },
};
const errors: QueryState = normalizeQueryState({ select: [{ field: "tool" }], where: [{ field: "status", op: "=", value: "error" }] });

let requests: Array<ServerQuery & { hostState?: HostQueryState }> = [];
const transport: Transport<Row> = {
  fetchRows: async (query) => {
    requests.push(query);
    return { rows: [], total: 0 };
  },
};

let root: Root | undefined;
function mount(options: Omit<Partial<UseQueryTableOptions<Row>>, "hostQuery"> & { hostQuery?: HostQueryOptions | null }) {
  const current = { api: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    // null leaves hostQuery out entirely.
    const { hostQuery: host = hostQuery, ...rest } = options;
    current.api = useQueryTable({ schema, transport, debounceMs: 0, ...rest, ...(host ? { hostQuery: host } : {}) });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return current;
}
const unmount = () => { if (root) act(() => root!.unmount()); root = undefined; };
async function settle() {
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}
const where = (api: QueryTableApi<Row>) => JSON.stringify(api.query.where);

beforeEach(() => { vi.useFakeTimers(); requests = []; window.history.replaceState(null, "", "/calls?tab=tools&other_q=keep"); });
afterEach(() => { unmount(); vi.useRealTimers(); });

describe("hostQuery: one definition", () => {
  it("exposes the committed definition and sends its host state with every request", async () => {
    const current = mount({ initialQuery: errors });
    await settle();
    expect(current.api.definition).toEqual({ query: expect.objectContaining({ where: errors.where }), hostState: none });
    expect(requests.at(-1)!.hostState).toEqual(none);
    requests = [];
    // One host edit, together with a table edit: one history entry, one execution.
    act(() => current.api.setDefinition!((previous) => ({ query: { ...previous.query, offset: 0 }, hostState: keyword("cache") })));
    await settle();
    expect(current.api.definition!.hostState).toEqual(keyword("cache"));
    expect(requests.map((request) => request.hostState)).toEqual([keyword("cache")]);
    act(() => current.api.undo());
    await settle();
    expect(current.api.definition!.hostState).toEqual(none);
    act(() => current.api.redo());
    await settle();
    expect(current.api.definition!.hostState).toEqual(keyword("cache"));
    // Reset restores the table and host defaults together.
    act(() => current.api.resetAll());
    await settle();
    expect(current.api.query.where).toEqual([]);
    expect(current.api.definition!.hostState).toEqual(none);
  });

  it("rejects a host state the host cannot accept, changing nothing", async () => {
    const current = mount({ initialQuery: errors });
    await settle();
    const before = current.api.query;
    expect(() => act(() => current.api.setDefinition!({ query: before, hostState: { version: 1, params: { record_tool_calls: ["unknown", "x"] } } })))
      .toThrow(/Unknown keyword field/);
    expect(current.api.query).toBe(before);
    expect(current.api.canUndo).toBe(false);
  });

  it("keeps host state across edits that do not mention it, and through grouping", async () => {
    // Grouping runs in memory here; the host still owns its clause.
    const rows: Row[] = [{ id: 1, tool: "Bash", status: "error", command: "cache" }];
    const current = mount({ initialQuery: { ...errors, hostState: keyword("cache") }, transport: undefined as never, clientRows: rows });
    await settle();
    act(() => current.api.setQuery((query) => ({ select: query.select, where: [], orderBy: [], limit: 10, offset: 0 })));
    await settle();
    expect(current.api.definition!.hostState).toEqual(keyword("cache"));
    act(() => current.api.setQuery((query) => ({ ...query, where: errors.where })));
    act(() => current.api.grouping!.changeKeys(["tool"]));
    await settle();
    expect(current.api.query.grouping!.source.hostState).toBeUndefined();
    expect(current.api.definition!.hostState).toEqual(keyword("cache"));
    act(() => current.api.grouping!.changeKeys([]));
    await settle();
    expect(current.api.query.grouping).toBeUndefined();
    expect(current.api.query.where).toEqual(errors.where);
    expect(current.api.definition!.hostState).toEqual(keyword("cache"));
  });
});

describe("hostQuery: execution receipts", () => {
  it("starts a new receipt when only the host state changes", async () => {
    const failing: Transport<Row> = {
      fetchRows: async (query: ServerQuery & { hostState?: HostQueryState }) => {
        requests.push(query);
        if (query.hostState?.params.record_tool_calls?.[1] === "bad") throw Error("HTTP 422: bad keyword");
        return { rows: [], total: 0 };
      },
    };
    const current = mount({ transport: failing, initialQuery: { ...errors, hostState: keyword("bad") } });
    await settle();
    const failed = current.api.execution!;
    expect(failed).toMatchObject({ status: "failed", rows: "failed" });
    act(() => current.api.setDefinition!((previous) => ({ ...previous, hostState: keyword("cache") })));
    // The same table query under new host state is a new execution, never the old failure.
    expect(current.api.execution!.key).not.toBe(failed.key);
    expect(current.api.execution!.generation).toBeGreaterThan(failed.generation);
    expect(current.api.execution!.status).toBe("running");
    await settle();
    expect(current.api.execution).toMatchObject({ status: "succeeded", error: null });
  });
});

describe("hostQuery: saved definitions", () => {
  it("saves the committed definition and restores all of it before any new request", async () => {
    const storage = memoryStorageAdapter();
    const current = mount({ initialQuery: { ...errors, hostState: keyword("(cache OR buffer) NOT obsolete") }, storage });
    await settle();
    const saved = await act(async () => current.api.saved.save("Errors with keyword"));
    expect(saved.query.hostState).toEqual(keyword("(cache OR buffer) NOT obsolete"));
    act(() => current.api.setDefinition!({ query: { ...errors, where: [] }, hostState: none }));
    await settle();
    // Identity covers the whole definition.
    expect(current.api.saved.items.find((item) => item.id === saved.id)!.query.hostState).not.toEqual(current.api.query.hostState);
    requests = [];
    act(() => current.api.saved.load(saved.id));
    await settle();
    expect(current.api.query.where).toEqual(errors.where);
    expect(current.api.definition!.hostState).toEqual(keyword("(cache OR buffer) NOT obsolete"));
    expect(requests.map((request) => [request.where, request.hostState])).toEqual([[errors.where, keyword("(cache OR buffer) NOT obsolete")]]);
  });

  it("gives a save without host state the host defaults", async () => {
    const storage = memoryStorageAdapter();
    const legacy = await storage.saveNamed("tool_calls", "Legacy", errors, 1);
    const current = mount({ initialQuery: { ...errors, hostState: keyword("cache") }, storage });
    await settle();
    await act(async () => {});
    act(() => current.api.saved.load(legacy.id));
    await settle();
    expect(current.api.definition!.hostState).toEqual(none);
    // A legacy save matches a live definition at the host defaults.
    expect(current.api.saved.items[0]!.query).toEqual(current.api.query);
  });

  it("rejects malformed or unsupported saved host state, leaving the live definition", async () => {
    const storage = memoryStorageAdapter();
    const unreadable = await storage.saveNamed("tool_calls", "Unreadable", { ...errors, hostState: { version: 1, params: { record_tool_calls: "x" } } as never }, 1);
    const future = await storage.saveNamed("tool_calls", "Future", { ...errors, hostState: { version: 2, params: {} } }, 2);
    const current = mount({ initialQuery: { ...errors, hostState: keyword("cache") }, storage });
    await settle();
    const live = current.api.query;
    expect(() => act(() => current.api.saved.load(unreadable.id))).toThrow(/could not be read/);
    expect(() => act(() => current.api.saved.load(future.id))).toThrow(/Unsupported keyword state version 2/);
    await settle();
    expect(current.api.query).toBe(live);
  });

  it("refuses to save through storage that would drop host state", async () => {
    const inner = memoryStorageAdapter();
    const saveNamed = vi.fn(inner.saveNamed);
    const tableOnly: StorageAdapter = { ...inner, storesHostState: false, saveNamed };
    const current = mount({ initialQuery: errors, storage: tableOnly });
    await settle();
    await expect(act(async () => current.api.saved.save("Nope"))).rejects.toThrow(/cannot save host query state/);
    expect(saveNamed).not.toHaveBeenCalled();
  });

  it("rejects saves carrying host state on a table without hostQuery", async () => {
    const storage = memoryStorageAdapter();
    const withHost = await storage.saveNamed("tool_calls", "Host", { ...errors, hostState: keyword("cache") }, 1);
    const current = mount({ storage, hostQuery: null });
    await settle();
    expect(() => act(() => current.api.saved.load(withHost.id))).toThrow(/does not support/);
    expect(current.api.definition).toBeUndefined();
  });
});

describe("hostQuery: URL", () => {
  it("mirrors host state into exactly its owned parameters", async () => {
    const current = mount({ syncUrl: true, initialQuery: errors });
    await settle();
    act(() => current.api.setDefinition!((previous) => ({ ...previous, hostState: keyword("cache") })));
    await settle();
    const url = new URL(window.location.href);
    expect(url.searchParams.getAll("record_tool_calls")).toEqual(["command", "cache"]);
    expect(url.searchParams.get("tab")).toBe("tools");
    expect(url.searchParams.get("other_q")).toBe("keep");
    act(() => current.api.setDefinition!((previous) => ({ ...previous, hostState: none })));
    await settle();
    expect(new URL(window.location.href).searchParams.has("record_tool_calls")).toBe(false);
  });

  it("restores host state from owned parameters beside a table-only link", async () => {
    window.history.replaceState(null, "", `/calls?q=${encodeQuery(errors)}&record_tool_calls=command&record_tool_calls=buffer`);
    const current = mount({ syncUrl: true });
    await settle();
    expect(current.api.query.where).toEqual(errors.where);
    expect(current.api.definition!.hostState).toEqual(keyword("buffer"));
    expect(requests.at(-1)!.hostState).toEqual(keyword("buffer"));
  });

  it("fails an explicit link with unacceptable host state instead of running without it", async () => {
    window.history.replaceState(null, "", `/calls?q=${encodeQuery({ ...errors, hostState: { version: 1, params: { record_tool_calls: ["unknown", "x"] } } })}`);
    const current = mount({ syncUrl: true });
    await settle();
    expect(current.api.restoration.status).toBe("error");
    expect(requests).toEqual([]);
  });

  it("refuses an owned parameter that is the table's own", () => {
    expect(() => mount({ syncUrl: true, hostQuery: { ...hostQuery, ownedParameters: ["q"] } })).toThrow(/cannot include the table's own "q"/);
    root = undefined;
  });
});
