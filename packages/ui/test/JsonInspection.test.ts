// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAttentionRegistry, createPropertyView, decodeQueryStrict, EMPTY_QUERY, encodeQuery, type AttentionResult, type FieldSchema, type JsonInspectionState, type QueryState } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { JsonCell, JsonValueView } from "../src/JsonCell";
import { DataTable } from "../src/DataTable";
import { ItemDetailsPanel } from "../src/ItemDetails";
import { defaultRenderers } from "../src/renderers";
import { ObjectProperties } from "../src/ObjectProperties";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); window.history.replaceState(null, "", "/"); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo); else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo; });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === name || node.textContent === name)!;
const path = '$["quoted.key\\\""][41]["text"]';
const value = { 'quoted.key"': Array.from({ length: 65 }, (_, i) => ({ text: i > 20 ? "needle needle" : "other" })) };
const scope = { dataset: "items", rowId: 0, field: "payload" };
const initial: JsonInspectionState = { version: 1, open: false, search: "", searchMode: "filter", raw: false, collapsedPaths: [], expandedBuckets: [], visibleEntryLimit: 200, searchOverrides: [] };
function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const schema: FieldSchema<{ id: number; payload: unknown }> = { name: "items", idField: "id", fields: [
  { name: "payload", label: "Payload", type: "text", source: { kind: "backend" }, display: { kind: "json" } },
] };

it("controls every JSON choice and restores a newly mounted viewer from its query token", async () => {
  let state = initial;
  function Viewer() { const [current, set] = useState(state); state = current; return createElement(JsonCell, { value, inspectionScope: scope, inspectionState: current, onInspectionStateChange: set }); }
  act(() => root.render(createElement(Viewer)));
  act(() => button("Inspect JSON").click());
  search("needle");
  const mode = document.querySelector<HTMLSelectElement>('[aria-label="JSON search mode"]')!;
  act(() => { mode.value = "find"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
  act(() => button("Next JSON match").click());
  expect(state.selectedMatch?.part).toBe("value"); expect(state.selectedMatch?.start).toBe(8);
  act(() => button('Collapse $["quoted.key\\\""]').click());
  expect(state.searchOverrides).toEqual([{ path: '$["quoted.key\\\""]', expanded: false }]);
  act(() => button("Show original").click());
  const query = { ...EMPTY_QUERY, itemDetails: { modes: ["modal" as const], jsonInspections: [{ ...scope, state }] } };
  const restored = decodeQueryStrict(encodeQuery(query)).itemDetails!.jsonInspections![0]!.state;
  act(() => root.render(createElement(JsonCell, { value, inspectionState: restored })));
  expect(document.querySelector("pre")?.textContent).toBe(JSON.stringify(value));
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("needle");
  expect(document.querySelector<HTMLSelectElement>('select')?.value).toBe("find");
  expect(restored).toEqual(state);
});

it("retains paging, buckets and collapsed paths while closing and reopening an inspector", () => {
  let state = initial;
  const wide = { items: Array.from({ length: 60 }, (_, id) => id), ...Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`key${i}`, i])) };
  function Viewer() { const [current, set] = useState(state); state = current; return createElement(JsonCell, { value: wide, inspectionState: current, onInspectionStateChange: set }); }
  act(() => root.render(createElement(Viewer)));
  act(() => button("Inspect JSON").click());
  act(() => button('Expand $["items"] items 40–59').click());
  act(() => button("Show more").click());
  act(() => button('Collapse $["items"]').click());
  expect(state.visibleEntryLimit).toBe(400);
  const { open: _, ...before } = state;
  act(() => button("Close JSON · JSON").click());
  expect(state.open).toBe(false);
  act(() => button("Inspect JSON").click());
  const { open: __, ...after } = state;
  expect(after).toEqual(before);
  expect(button('Expand $["items"]')).toBeDefined();
});

it("restores native item JSON by stable row and field after layout changes and row reorder", async () => {
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  const rows = [{ id: 0, payload: value }, { id: 1, payload: { other: true } }];
  const view = createPropertyView(schema);
  const query: QueryState = { ...EMPTY_QUERY, itemDetails: { modes: ["expand"], active: { id: 0, mode: "expand" }, views: { expand: view } } };
  function Table({ seed, data = rows }: { seed?: QueryState; data?: typeof rows }) {
    api = useQueryTable({ schema, clientRows: data, ...(seed ? { initialQuery: seed } : {}), syncUrl: true, itemDetails: true, debounceMs: 0 });
    return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers });
  }
  await act(async () => root.render(createElement(Table, { seed: query })));
  act(() => button("Open Payload in JSON Viewer").click());
  search("needle");
  act(() => button("Next JSON match").click());
  const captured = api.query.itemDetails!.jsonInspections;
  expect(captured?.[0]?.rowId).toBe(0);
  const url = window.location.href;
  expect(decodeQueryStrict(new URL(url).searchParams.get("q")!).itemDetails!.jsonInspections).toEqual(captured);
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(Table, { data: [...rows].reverse() })));
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("needle");
  expect(api.query.itemDetails?.jsonInspections).toEqual(captured);
  const revised = { ...view, properties: view.properties.map(entry => ({ ...entry, id: "new-layout-instance" })) };
  await act(async () => api.itemDetails!.propertiesByMode.expand.setView(revised));
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("needle");
  await act(async () => api.itemDetails!.open(1, "expand"));
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')).toBeNull();
  expect(button("Expand $")).toBeDefined();
});

it("reveals a bucketed path without focus movement and does not scroll again on refresh", async () => {
  vi.stubGlobal("matchMedia", vi.fn(query => ({ matches: query.includes("prefers-reduced-motion"), addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const attention = createAttentionRegistry();
  const anchor = document.createElement("input"); document.body.prepend(anchor); anchor.focus();
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
  let state = { ...initial, raw: true, collapsedPaths: ["$"] };
  function Viewer({ data = value }: { data?: unknown }) { const [current, set] = useState(state); state = current; return createElement(JsonValueView, { value: data, inspectionScope: scope, attention, inspectionState: current, onInspectionStateChange: set }); }
  act(() => root.render(createElement(Viewer)));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path }); });
  expect((await pending).status).toBe("revealed");
  expect(state.expandedBuckets).toContain('$["quoted.key\\\""]:bucket:40');
  expect(container.querySelector(".qt-attention-target")?.getAttribute("data-json-path")).toBe(path);
  expect(document.activeElement).toBe(anchor); expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", behavior: "instant" });
  act(() => root.render(createElement(Viewer, { data: JSON.parse(JSON.stringify(value)) })));
  expect(scroll).toHaveBeenCalledOnce();
  expect((await attention.resolve({ ...scope, path: '$["deleted"]' })).status).toBe("unavailable");
  expect(document.activeElement).toBe(anchor); anchor.remove();
});

it("reports missing restored targets without selecting a replacement match", () => {
  const resolution = vi.fn();
  act(() => root.render(createElement(JsonValueView, { value: { text: "needle" }, inspectionState: { ...initial, search: "needle", collapsedPaths: ['$["deleted"]'], selectedMatch: { path: '$["deleted"]', part: "value", start: 0 } }, onInspectionResolution: resolution })));
  expect(resolution).toHaveBeenLastCalledWith({ status: "unavailable", missingPaths: ['$["deleted"]'], selectedMatchUnavailable: true });
  expect(container.querySelector(".qt-json-current-mark")).toBeNull();
  expect(container.textContent).toContain("Selected JSON match is unavailable");
});

it("materializes native delayed item details and preserves focus even when the modal opens", async () => {
  const attention = createAttentionRegistry();
  const emptyRows: { id: number; payload: unknown }[] = [];
  const loadRow = vi.fn(async () => ({ row: { id: 0, payload: value } }));
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  const anchor = document.createElement("input"); document.body.prepend(anchor); anchor.focus();
  function Table() { api = useQueryTable({ schema, clientRows: emptyRows, itemDetails: { attention, loadRow }, debounceMs: 0 }); return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers }); }
  await act(async () => root.render(createElement(Table)));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path }); });
  expect((await pending).status).toBe("revealed");
  expect(document.activeElement).toBe(anchor);
  expect(loadRow).toHaveBeenCalled();
  expect(api.query.where).toEqual([]);
  const target = container.querySelector(".qt-attention-target");
  expect(target?.getAttribute("data-json-path")).toBe(path);
  await act(async () => api.refresh());
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});

it("cancels native navigation before a delayed loader can reveal another record", async () => {
  const attention = createAttentionRegistry();
  let finish!: (record: { row: { id: number; payload: unknown } }) => void;
  const loadRow = vi.fn(() => new Promise<{ row: { id: number; payload: unknown } }>(resolve => { finish = resolve; }));
  const emptyRows: { id: number; payload: unknown }[] = [];
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  function Table() { api = useQueryTable({ schema, clientRows: emptyRows, itemDetails: { attention, loadRow }, debounceMs: 0 }); return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers }); }
  await act(async () => root.render(createElement(Table)));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path }); });
  await act(async () => api.itemDetails!.close());
  expect((await pending).status).toBe("cancelled");
  await act(async () => finish({ row: { id: 0, payload: value } }));
  expect(api.query.itemDetails?.active).toBeUndefined();
  expect(container.querySelector(".qt-attention-target")).toBeNull();
});

it("materializes a closed standalone JSON cell without moving focus", async () => {
  const attention = createAttentionRegistry();
  const anchor = document.createElement("input"); document.body.prepend(anchor); anchor.focus();
  act(() => root.render(createElement(JsonCell, { value, inspectionScope: scope, attention })));
  expect(container.querySelector(".qt-json-entry")).toBeNull();
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path }); });
  expect((await pending).status).toBe("revealed");
  expect(document.activeElement).toBe(anchor);
  expect(container.querySelector(".qt-attention-target")?.getAttribute("data-json-path")).toBe(path);
  anchor.remove();
});

it("keeps anonymous local inspections separate from every real record identity", async () => {
  const looseSchema: FieldSchema<Record<string, unknown>> = { name: "items", idField: "id", fields: [
    { name: "payload", label: "Payload", type: "text", source: { kind: "backend" }, display: { kind: "json" } },
  ] };
  const view = createPropertyView(looseSchema);
  const row = { payload: value };
  await act(async () => root.render(createElement(ObjectProperties<Record<string, unknown>>, { schema: looseSchema, row, view })));
  act(() => button("Open Payload in JSON Viewer").click());
  search("needle");
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("needle");
  await act(async () => root.render(createElement(ObjectProperties<Record<string, unknown>>, { schema: looseSchema, row, view, recordId: "@local/0" })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  act(() => button("Open Payload in JSON Viewer").click());
  expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
});

// Inline review regressions: each reveal must settle without a navigation cancel.
const attentionStatus = async (pending: Promise<AttentionResult>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending.then(result => result.status), new Promise<"pending">(resolve => { timer = setTimeout(() => resolve("pending"), 300); })]); }
  finally { if (timer) clearTimeout(timer); }
};

it.each([null, "", { a: 1 }])("returns unavailable for a non-navigable rendered property (%j)", async payload => {
  const attention = createAttentionRegistry();
  const view = createPropertyView(schema);
  if (payload !== null && payload !== "") view.properties = view.properties.map(property => ({ ...property, format: { kind: "text" } }));
  await act(async () => root.render(createElement(ObjectProperties<{ id: number; payload: unknown }>, { schema, row: { id: 0, payload }, view, attention })));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path: "$" }); });
  const status = await attentionStatus(pending);
  await act(async () => attention.cancel());
  expect(status).toBe("unavailable");
});

it.each([false, true])("validates JSON paths using the rendered decoding options (view override: %s)", async override => {
  const attention = createAttentionRegistry();
  const literalSchema: typeof schema = { ...schema, fields: schema.fields.map(field => ({ ...field,
    property: { format: { kind: "json", encoding: "value" } },
  })) };
  const view = createPropertyView(literalSchema);
  if (override) view.properties = view.properties.map(property => ({ ...property, format: { kind: "json", encoding: "value" } }));
  const rows = [{ id: 0, payload: "plain text" }];
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  function Table() {
    api = useQueryTable({ schema: override ? schema : literalSchema, clientRows: rows, initialQuery: { ...EMPTY_QUERY, itemDetails: { modes: ["modal"], view } }, itemDetails: { attention }, debounceMs: 0 });
    return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers });
  }
  await act(async () => root.render(createElement(Table)));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, path: "$" }); });
  expect(await attentionStatus(pending)).toBe("revealed");
  expect(container.querySelector(".qt-attention-target")?.textContent).toContain('"plain text"');
  await act(async () => { pending = attention.resolve({ ...scope, path: '$["a"]' }); });
  expect(await attentionStatus(pending)).toBe("unavailable");
});

it.each([false, true])("bounds a 201st inspection and preserves recent edits (all open: %s)", async allOpen => {
  const inspections = Array.from({ length: 200 }, (_, rowId) => ({ ...scope, rowId, state: { ...initial, open: allOpen || rowId === 0 } }));
  const rows = [{ id: 0, payload: value }];
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  function Table() { api = useQueryTable({ schema, clientRows: rows, initialQuery: { ...EMPTY_QUERY, itemDetails: { modes: ["expand"], jsonInspections: inspections } }, itemDetails: true, debounceMs: 0 }); return null; }
  await act(async () => root.render(createElement(Table)));
  await act(async () => api.itemDetails!.setJsonInspection!({ ...scope, rowId: 200, state: initial }));
  let stored = api.query.itemDetails!.jsonInspections!;
  expect(stored).toHaveLength(200);
  expect(stored[stored.length - 1]?.rowId).toBe(200);
  expect(stored.some(entry => entry.rowId === (allOpen ? 0 : 1))).toBe(false);
  if (!allOpen) expect(stored.some(entry => entry.rowId === 0)).toBe(true);
  await act(async () => api.itemDetails!.setJsonInspection!({ ...scope, rowId: 199, state: { ...initial, search: "newest" } }));
  stored = api.query.itemDetails!.jsonInspections!;
  expect(stored).toHaveLength(200);
  expect(stored[stored.length - 1]?.state.search).toBe("newest");
  expect(decodeQueryStrict(encodeQuery(api.query))).toEqual(api.query);
  expect(inspections).toHaveLength(200);
});

it.each([false, true])("reveals derived fields with dependency coverage (first navigation: %s)", async first => {
  const attention = createAttentionRegistry();
  const derivedSchema: typeof schema = { ...schema, fields: [{ name: "computed", label: "Computed", type: "text",
    source: { kind: "derived", dependencies: ["payload"], accessor: row => row.payload }, ...(first ? { display: { kind: "json" as const } } : {}),
  }] };
  const row = { id: 0, payload: first ? { a: 1 } : "derived value" };
  if (first) {
    const rows: typeof row[] = [];
    const loadRow = async () => ({ row, loadedFields: ["payload"] });
    function Table() {
      const api = useQueryTable({ schema: derivedSchema, clientRows: rows, itemDetails: { attention, loadRow }, debounceMs: 0 });
      return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers });
    }
    await act(async () => root.render(createElement(Table)));
  } else await act(async () => root.render(createElement(ObjectProperties<{ id: number; payload: unknown }>, { schema: derivedSchema, row, loadedFields: ["payload"], view: createPropertyView(derivedSchema), attention })));
  let pending!: Promise<AttentionResult>;
  await act(async () => { pending = attention.resolve({ ...scope, field: "computed", ...(first ? { path: '$["a"]' } : {}) }); });
  expect(await attentionStatus(pending)).toBe("revealed");
  expect(container.querySelector(".qt-attention-target")).not.toBeNull();
});

it("rematerializes a virtualized expanded detail on every explicit reveal", async () => {
  const attention = createAttentionRegistry();
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, payload: { a: id } }));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(370);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(10000);
  let delayedReadback = false;
  const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    if (!delayedReadback) this.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true });
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  function Table() {
    api = useQueryTable({ schema, clientRows: rows, initialQuery: { ...EMPTY_QUERY, itemDetails: { modes: ["expand"], active: { id: 0, mode: "expand" } } }, itemDetails: { attention }, debounceMs: 0 });
    return createElement(DataTable<{ id: number; payload: unknown }>, { fields: api.visibleFields, rows: api.rows, query: api.query, onQueryChange: api.setQuery, renderers: defaultRenderers, rowId: api.rowId, itemDetails: api.itemDetails!, maxHeight: 370, estimateRowHeight: 37, overscan: 1 });
  }
  await act(async () => root.render(createElement(Table)));
  const wrap = container.querySelector<HTMLElement>(".qt-table-wrap")!;
  for (let request = 0; request < 2; request++) {
    await act(async () => { wrap.scrollTop = 2000; wrap.dispatchEvent(new Event("scroll")); });
    expect(container.querySelector(".qt-object-properties")).toBeNull();
    delayedReadback = true;
    const before = scrollTo.mock.calls.length;
    let pending!: Promise<AttentionResult>;
    await act(async () => { pending = attention.resolve({ ...scope, path: '$["a"]' }); });
    expect(await attentionStatus(pending)).toBe("revealed");
    expect(scrollTo.mock.calls.length).toBeGreaterThan(before);
    expect(api.itemDetails!.attentionPending).toBe(false);
    // The target survives completion even before the virtualizer reads back
    // the programmatic scroll, so its local highlight is not lost to a remount.
    expect(container.querySelector(".qt-attention-target")).not.toBeNull();
    expect(api.query.itemDetails?.active).toEqual({ id: 0, mode: "expand" });
    expect(api.query.where).toEqual([]);
  }
});

it.each(["expand", "modal"] as const)("preserves focus through a restored JSON modal within %s details", async mode => {
  const attention = createAttentionRegistry();
  const rows = [{ id: 0, payload: { a: 1 } }];
  const anchor = document.createElement("input"); document.body.append(anchor); anchor.focus();
  let api!: QueryTableApi<{ id: number; payload: unknown }>;
  function Table() {
    api = useQueryTable({ schema, clientRows: rows, initialQuery: { ...EMPTY_QUERY, itemDetails: { modes: [mode], jsonInspections: [{ ...scope, state: { ...initial, open: true } }] } }, itemDetails: { attention }, debounceMs: 0 });
    return createElement(ItemDetailsPanel<{ id: number; payload: unknown }>, { api: api.itemDetails!, query: api.query, renderers: defaultRenderers });
  }
  try {
    await act(async () => root.render(createElement(Table)));
    let pending!: Promise<AttentionResult>;
    await act(async () => { pending = attention.resolve({ ...scope, path: '$["a"]' }); });
    expect(await attentionStatus(pending)).toBe("revealed");
    expect(document.activeElement).toBe(anchor);
    await act(async () => button("Close Payload · JSON").click());
    expect(document.activeElement).toBe(anchor);
    await act(async () => button("Open Payload in JSON Viewer").click());
    expect(document.activeElement).toBe(container.querySelector(".qt-json-inspector"));
  } finally { anchor.remove(); }
});
