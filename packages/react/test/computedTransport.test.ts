// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY, applyQuery, createGroupingModel, formulaRuntime, memoryComputedColumnStore,
  type ComputedExecution, type FieldSchema, type FormulaNode, type FormulaValue,
  type QueryCapabilitiesV3, type QueryState, type ServerQuery, type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
import { fetchPreviewRows } from "../src/previewRows";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type Row = { id: number; name: string; other: string };
const schema: FieldSchema<Row> = { name: "previews", idField: "id", defaultSelect: [{ field: "name" }], fields: [
  { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
  { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  { name: "other", label: "Other", type: "text", source: { kind: "backend" } },
] };
const rows = Array.from({ length: 1001 }, (_, id) => ({ id, name: `name${id}`, other: `input${id}` }));
const applyServer = (query: ServerQuery) => applyQuery(rows, { ...query, select: query.select.map(field => ({ field })) }, schema);
const execution: ComputedExecution = { profile: "qt-sqlite-v1", resolvedRevisions: {}, fields: {}, planToken: "plan", snapshot: "snapshot" };
const capabilities: QueryCapabilitiesV3 = { version: 3, profile: execution.profile, groupedRows: true, calendarGrouping: true,
  computedSourceFilters: true, regex: false, maxRows: 10000, maxGroups: 2000, maxPopulation: 250000 };
const worker = () => {
  const instance = { onmessage: null as ((e: { data: unknown }) => void) | null, terminated: false,
    postMessage({ ast, inputs }: { ast: FormulaNode; inputs: Record<string, FormulaValue>[] }) {
      queueMicrotask(() => { if (!instance.terminated) instance.onmessage?.({ data: inputs.map(input => formulaRuntime(ast, input)) }); });
    }, terminate() { instance.terminated = true; } };
  return instance as unknown as Worker;
};
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }
function mount(transport: Transport<Row>, query: QueryState = EMPTY_QUERY) {
  const result = {} as { current: QueryTableApi<Row> };
  const store = memoryComputedColumnStore();
  const root = createRoot(document.createElement("div"));
  function Probe() { result.current = useQueryTable({ schema, transport, computedExecution: execution,
    computedColumnStore: store, initialQuery: query, debounceMs: 0, formulaWorkerFactory: worker }); return null; }
  act(() => root.render(createElement(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  return { result, store };
}

const v3Result = (query: Parameters<Transport<Row>["fetchQueryV3"]>[0], result: ComputedExecution = execution) => ({
  version: 3 as const, now: query.now, sourceTotal: rows.length,
  ...applyServer(query.result), schema: { name: schema.name, idField: "id", fields: schema.fields.map(({ name, type }) => ({ name, type })) },
  metrics: [], execution: result,
});

it("loads tables and bounded unsaved previews through v3", async () => {
  const fetchQueryV3 = vi.fn<Transport<Row>["fetchQueryV3"]>(async query => v3Result(query));
  const transport: Transport<Row> = { fetchQueryV3, queryCapabilities: capabilities };
  const { result, store } = mount(transport, { ...EMPTY_QUERY, limit: 1, offset: 10,
    where: [{ field: "id", op: ">=", value: "1" }], orderBy: [{ field: "id", dir: "asc" }] });
  await settle(); await settle();
  expect(result.current.error).toBeNull();
  expect(result.current.rows).toHaveLength(1);
  await act(async () => { await store.save(schema.name, { id: "saved", label: "Saved", expression: { language: "qt-expr", version: 1, source: "[other]" } }, null); });
  await settle();
  fetchQueryV3.mockClear();
  const preview = await result.current.computed.preview("UPPER([@computed/saved])", 1001);
  expect(preview.processed).toBe(1000);
  expect(preview.total).toBe(1000);
  expect(preview.groups[0]?.result.value).toBe("INPUT1");
  const requests = fetchQueryV3.mock.calls.map(([q]) => q.result);
  expect(requests.map(({ offset, limit }) => [offset, limit])).toEqual([[0, 500], [500, 500]]);
  expect(requests.every(q => JSON.stringify(q.select) === '["id","other"]')).toBe(true);
  expect(requests.every(q => q.where[0] && "field" in q.where[0] && q.where[0].field === "id" && q.orderBy[0]?.field === "id")).toBe(true);
  expect(JSON.stringify(fetchQueryV3.mock.calls)).not.toContain("UPPER");
});

it("rejects cancelled and superseded previews when a transport ignores abort", async () => {
  let held = false;
  const pending: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  const fetchQueryV3: Transport<Row>["fetchQueryV3"] = async (query, signal) => {
    if (held) await new Promise<void>(resolve => { pending.push(resolve); signals.push(signal!); });
    return v3Result(query);
  };
  const { result } = mount({ fetchQueryV3, queryCapabilities: capabilities }); await settle(); await settle(); held = true;
  const first = result.current.computed.preview("[name]", 1);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = result.current.computed.preview("[other]", 1);
  expect(signals[0]?.aborted).toBe(true);
  pending[0]!(); await rejected;
  pending[1]!(); expect((await second).processed).toBe(1);
  const controller = new AbortController();
  const third = result.current.computed.preview("[name]", 1, controller.signal);
  controller.abort(); pending[2]!();
  await expect(third).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects preview diagnostics and mismatched execution before local evaluation", async () => {
  const transport: Transport<Row> = { queryCapabilities: capabilities,
    fetchQueryV3: vi.fn<Transport<Row>["fetchQueryV3"]>(async query => v3Result(query, { ...execution, snapshot: "wrong" })) };
  await expect(fetchPreviewRows(transport, EMPTY_QUERY, schema, execution, [], 1, new AbortController().signal)).rejects.toThrow("mismatched");
  const invalid: Transport<Row> = { fetchQueryV3: vi.fn(), queryCapabilities: capabilities };
  await expect(fetchPreviewRows(invalid, { ...EMPTY_QUERY, where: [{ field: "missing", op: "=", value: "x" }] }, schema, execution, [], 1, new AbortController().signal)).rejects.toThrow("unsupported");
  expect(invalid.fetchQueryV3).not.toHaveBeenCalled();
});

it("previews grouped result inputs through V3 and honors its page limit", async () => {
  const grouping = { representative: null, keys: ["name"], summaries: [{ id: "num", op: "count" as const }], source: EMPTY_QUERY };
  const projected = createGroupingModel(schema).resultSchema(grouping.keys, grouping.summaries);
  const groupedRows = Array.from({ length: 3 }, (_, i) => ({ __qt_group_id__: `group${i}`, name: `name${i}`, num: i + 1 }));
  const fetchQueryV3 = vi.fn<Transport<Row>["fetchQueryV3"]>(async request => ({
    version: 3, now: request.now, sourceTotal: 6, rows: groupedRows.slice(request.result.offset, request.result.offset + request.result.limit), total: 3,
    schema: { name: projected.name, idField: projected.idField, fields: projected.fields.map(({ name, type }) => ({ name, type })) }, metrics: [], execution,
  }));
  const transport: Transport<Row> = { fetchQueryV3, queryCapabilities: { ...capabilities, maxRows: 2 } };
  const { result } = mount(transport, { ...EMPTY_QUERY, grouping, select: [{ field: "name" }, { field: "num" }], limit: 2 });
  await settle(); await settle();
  expect(result.current.error).toBeNull();
  fetchQueryV3.mockClear();
  const preview = await result.current.computed.preview("[num]*2", 3);
  expect(preview.processed).toBe(3);
  expect(preview.total).toBe(3);
  expect(preview.groups.map(group => group.result.value)).toEqual([2, 4, 6]);
  expect(fetchQueryV3.mock.calls.map(([request]) => [request.result.offset, request.result.limit])).toEqual([[0, 2], [2, 1]]);
  expect(fetchQueryV3.mock.calls.every(([request]) => request.grouping?.keys[0] === "name")).toBe(true);
  expect(new Set(fetchQueryV3.mock.calls.map(([request]) => request.now)).size).toBe(1);
});

it("retains canonical computed sorting and rejects stale preview revisions", async () => {
  const saved = { id: "saved", label: "Saved", revision: "current", expression: { language: "qt-expr" as const, version: 1 as const, source: "[name]" } };
  const canonical: ComputedExecution = { ...execution, resolvedRevisions: { saved: "current" }, fields: {
    "@computed/saved": { type: "text", select: true, sort: true, filter: true, group: true, measure: true },
  } };
  const query: QueryState = { ...EMPTY_QUERY, select: [{ field: "other" }], orderBy: [{ field: "@computed/saved", dir: "desc" }] };
  const fetchQueryV3 = vi.fn<Transport<Row>["fetchQueryV3"]>(async request => ({
    version: 3, now: request.now, sourceTotal: 1, rows: [rows[0]!], total: 1, metrics: [], execution: canonical,
    schema: { name: schema.name, idField: "id", fields: schema.fields.map(({ name, type }) => ({ name, type })) },
  }));
  const transport: Transport<Row> = { fetchQueryV3, queryCapabilities: capabilities };
  await fetchPreviewRows(transport, query, schema, canonical, [saved], 1, new AbortController().signal);
  expect(fetchQueryV3.mock.calls[0]?.[0].result.orderBy).toEqual(query.orderBy);
  expect(fetchQueryV3.mock.calls[0]?.[0].expectedRevisions).toEqual({ saved: "current" });
  await expect(fetchPreviewRows(transport, query, schema, canonical, [{ ...saved, revision: "new" }], 1, new AbortController().signal)).rejects.toThrow("Computed definitions changed");
  await expect(fetchPreviewRows(transport, { ...query, orderBy: [],
    where: [{ field: "@computed/saved", op: "=", value: "x" }] }, schema, canonical, [{ ...saved, revision: "new" }], 1, new AbortController().signal)).rejects.toThrow("Computed definitions changed");
  expect(fetchQueryV3).toHaveBeenCalledOnce();
});
