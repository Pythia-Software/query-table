// @vitest-environment jsdom
import { act, createElement, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createPropertyView, EMPTY_QUERY, ITEM_DETAILS_COLUMN, memoryPropertyViewStorage, normalizeQueryState, toServerQuery, type FieldSchema, type QueryState, type Transport } from "@pythia-software/query-table-core";
import { useItemDetails, type ItemDetailsApi, type ItemDetailsOptions, type ItemDetailRecord } from "../src/useItemDetails";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Row = { id: string | number; name: string; secret?: string };
const schema: FieldSchema<Row> = { name: "items", idField: "id", fields: [
  { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  { name: "secret", label: "Secret", type: "text", source: { kind: "backend" } },
] };
const rows: Row[] = [{ id: 0, name: "Zero", secret: "complete" }, { id: "0", name: "String" }];
const rowId = (row: Row) => row.id;
async function mount(options: ItemDetailsOptions<Row> | boolean = true, seed: QueryState = EMPTY_QUERY, transport?: Transport<Row>) {
  let api!: ItemDetailsApi<Row>;
  let query!: QueryState;
  let setQuery!: (next: QueryState) => void;
  function Probe() {
    const [state, set] = useState(seed);
    query = state;
    setQuery = (next) => set(normalizeQueryState(next));
    api = useItemDetails({ schema, query: state, setQuery: (next) => set((previous) => normalizeQueryState(typeof next === "function" ? next(previous) : next)),
      options, rows, clientRows: transport ? undefined : rows, rowId, transport, refreshKey: 0 })!;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  return { api: () => api, query: () => query, setQuery: (next: QueryState) => act(async () => setQuery(next)), unmount: () => act(() => root.unmount()) };
}
describe("built-in item details", () => {
  it("keeps each query history action pure when Strict Mode replays updates", async () => {
    let api!: QueryTableApi<Row>;
    function Probe() { api = useQueryTable({ schema, clientRows: rows, itemDetails: true }); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
    try {
      expect(api.canUndo).toBe(false);
      await act(async () => {
        api.setQuery(q => ({ ...q, limit: 10 }));
        api.setQuery(q => ({ ...q, limit: 20 }));
      });
      expect(api.query.limit).toBe(20);
      await act(async () => api.undo());
      expect(api.query.limit).toBe(10);
      await act(async () => api.undo());
      expect(api.canUndo).toBe(false);
      await act(async () => api.redo());
      expect(api.query.limit).toBe(10);
      await act(async () => api.redo());
      expect(api.query.limit).toBe(20);
      expect(api.canRedo).toBe(false);
      await act(async () => api.itemDetails!.open(0, "modal"));
      await act(async () => api.itemDetails!.close());
      await act(async () => api.resetAll());
      await act(async () => api.undo());
      expect(api.itemDetails!.active).toBeNull();
      expect(api.query.limit).toBe(20);
    } finally { await act(async () => root.unmount()); }
  });

  it("starts with Modal while allowing users to add the other buttons", async () => {
    const probe = await mount();
    expect(probe.api().modes).toEqual(["modal"]);
    expect(probe.api().availableModes).toEqual(["hover", "modal", "expand", "page"]);
    await act(async () => probe.api().properties.setView(createPropertyView(schema, ["secret"])));
    expect(probe.query().itemDetails?.modes).toEqual(["modal"]);
    await act(async () => probe.api().setModes(["page"]));
    expect(probe.api().modes).toEqual(["page"]);
    await probe.unmount();
  });
  it("fetches hidden Page template fields and follows creator defaults for Page-only instances", async () => {
    const fetchRows = vi.fn<NonNullable<Transport<Row>["fetchRows"]>>(async () => ({ rows, total: 2 }));
    let api!: QueryTableApi<Row>;
    const options: ItemDetailsOptions<Row> = { modes: ["page"], page: { urlTemplate: "/items/{field:secret}", target: "_self" } };
    const transport: Transport<Row> = { fetchRows };
    const projectedSchema = { ...schema, defaultSelect: [{ field: "name" }] };
    function Probe() { api = useQueryTable({ schema: projectedSchema, transport, itemDetails: options, debounceMs: 0 }); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    try {
      await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
      expect(api.itemDetails!.modes).toEqual(["page"]);
      expect(api.itemDetails!.page).toEqual(options.page);
      expect(api.visibleFields.map(field => field.name)).not.toContain("secret");
      expect(fetchRows.mock.calls[0]![0].select).toContain("secret");
      const count = fetchRows.mock.calls.length;
      await act(async () => api.setQuery(q => ({ ...q, itemDetails: { modes: ["page"], page: { urlTemplate: "/items/{field:secret}", target: "_blank" } } })));
      await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
      expect(fetchRows).toHaveBeenCalledTimes(count);
    } finally { await act(async () => root.unmount()); }
  });
  it("keeps modality views independent across identities and query undo", async () => {
    const probe = await mount({ defaultModes: ["hover", "modal", "expand"] });
    await act(async () => probe.api().open(0, "modal"));
    expect(probe.api().record?.row.name).toBe("Zero");
    const original = probe.query();
    const view = createPropertyView(schema, ["secret"]);
    await act(async () => probe.api().properties.setView(view));
    expect(probe.query().itemDetails?.views?.modal).toEqual(view);
    await act(async () => probe.api().open("0", "expand"));
    expect(probe.api().record?.row.name).toBe("String");
    expect(probe.api().properties.view).toEqual(view);
    expect(probe.api().propertiesByMode.expand.view).toEqual(createPropertyView(schema));
    expect(probe.api().propertiesByMode.hover.view).toEqual(createPropertyView(schema));
    await probe.setQuery(original);
    expect(probe.api().active).toEqual({ id: 0, mode: "modal" });
    expect(probe.api().properties.view).toEqual(original.itemDetails?.views?.modal);
    await act(async () => probe.api().close());
    expect(probe.query().itemDetails?.active).toBeUndefined();
    probe.unmount();
  });
  it("restores the initial view when query undo removes the first detail snapshot", async () => {
    const probe = await mount();
    await act(async () => probe.api().properties.setView(createPropertyView(schema, ["secret"])));
    expect(probe.query().itemDetails?.views?.modal?.properties).toHaveLength(1);
    await probe.setQuery(EMPTY_QUERY);
    expect(probe.api().properties.view).toEqual(createPropertyView(schema));
    expect(probe.query().itemDetails).toBeUndefined();
    probe.unmount();
  });
  it("resets a shared-link view to schema defaults rather than the link snapshot", async () => {
    const view = createPropertyView(schema, ["secret"]);
    const probe = await mount(true, { ...EMPTY_QUERY, itemDetails: { modes: ["modal"], view } });
    expect(probe.api().properties.view).toEqual(view);
    await act(async () => probe.api().properties.reset());
    expect(probe.query().itemDetails?.views?.modal).toEqual(createPropertyView(schema));
    probe.unmount();
  });
  it("persists separate type-level views per modality and shares all snapshots", async () => {
    const storage = memoryPropertyViewStorage();
    let probe = await mount({ storage });
    const modalView = { ...createPropertyView(schema, ["secret"]), labelWidth: 45 };
    const popoverView = createPropertyView(schema, ["name"]);
    await act(async () => probe.api().propertiesByMode.modal.setView(modalView));
    await act(async () => probe.api().propertiesByMode.hover.setView(popoverView));
    await act(async () => probe.api().propertiesByMode.hover.save("Compact"));
    await act(async () => probe.api().open(0, "modal"));
    const snapshot = probe.query();
    expect(snapshot.itemDetails?.views).toEqual({ modal: modalView, hover: popoverView, expand: createPropertyView(schema) });
    expect(probe.api().propertiesByMode.modal.saved).toHaveLength(0);
    await probe.unmount();
    probe = await mount({ storage });
    expect(probe.api().propertiesByMode.modal.view).toEqual(modalView);
    expect(probe.api().propertiesByMode.hover.view).toEqual(popoverView);
    expect(probe.api().propertiesByMode.hover.saved).toHaveLength(1);
    await probe.unmount();
    probe = await mount(true, snapshot);
    expect(probe.api().propertiesByMode.modal.view).toEqual(modalView);
    expect(probe.api().propertiesByMode.hover.view).toEqual(popoverView);
    await probe.unmount();
  });
  it("treats details as a movable selectable column without requesting it from the backend", async () => {
    let api!: QueryTableApi<Row>;
    const root = createRoot(document.createElement("div"));
    const columnSchema: FieldSchema<Row> = { ...schema, defaultSelect: [{ field: "name" }] };
    function Probe() { api = useQueryTable({ schema: columnSchema, clientRows: rows, itemDetails: true }); return null; }
    await act(async () => root.render(createElement(Probe)));
    try {
      expect(api.select.fields.map(field => field.name)).toContain(ITEM_DETAILS_COLUMN);
      await act(async () => api.select.move(ITEM_DETAILS_COLUMN, 0));
      expect(api.visibleFields[0]?.name).toBe(ITEM_DETAILS_COLUMN);
      await act(async () => api.select.setWidth(ITEM_DETAILS_COLUMN, 150));
      expect(api.query.select[0]).toEqual({ field: ITEM_DETAILS_COLUMN, width: 150 });
      expect(toServerQuery(api.query, schema).select).not.toContain(ITEM_DETAILS_COLUMN);
      await act(async () => api.select.hide(ITEM_DETAILS_COLUMN));
      expect(api.visibleFields.map(field => field.name)).not.toContain(ITEM_DETAILS_COLUMN);
      expect(api.select.hidden.map(field => field.name)).toContain(ITEM_DETAILS_COLUMN);
      await act(async () => api.select.show(ITEM_DETAILS_COLUMN));
      expect(api.visibleFields.at(-1)?.name).toBe(ITEM_DETAILS_COLUMN);
    } finally { await act(async () => root.unmount()); }
  });
  it("cancels slow loads and never displays an earlier identity", async () => {
    const pending: Array<{ id: unknown; signal: AbortSignal; finish: (record: ItemDetailRecord<Row> | null) => void }> = [];
    const probe = await mount({ loadRow: (id, signal) => new Promise((finish) => pending.push({ id, signal, finish })) });
    await act(async () => probe.api().open(0, "modal"));
    await act(async () => probe.api().open("0", "modal"));
    expect(pending[0]?.signal.aborted).toBe(true);
    await act(async () => pending[0]!.finish({ row: rows[0]! }));
    expect(probe.api().record).toBeNull();
    await act(async () => pending[1]!.finish({ row: rows[1]! }));
    expect(probe.api().record?.row.name).toBe("String");
    probe.unmount();
  });
  it("loads an item absent from the page using fetchRow and enforces creator modes", async () => {
    const fetchRow = vi.fn(async () => ({ id: "remote", name: "Remote", secret: "not projected" }));
    const probe = await mount({ modes: ["modal"] }, EMPTY_QUERY, { fetchRows: async () => ({ rows: [], total: 0 }), fetchRow });
    await act(async () => probe.api().open("remote", "modal"));
    expect(probe.api().record?.row.secret).toBe("not projected");
    await act(async () => probe.api().open(0, "expand"));
    expect(probe.api().active?.id).toBe("remote");
    await act(async () => probe.api().setModes([]));
    expect(probe.api().active).toBeNull();
    probe.unmount();
  });
  it("does not restart complete-record loads for inline callbacks or new collection rows", async () => {
    const loader = vi.fn(async () => ({ row: rows[0]! }));
    let api!: ItemDetailsApi<Row>;
    function Probe() {
      const [query, setQuery] = useState<QueryState>(EMPTY_QUERY);
      api = useItemDetails({ schema, query, setQuery, options: { loadRow: async () => loader() },
        rows: [...rows], clientRows: undefined, rowId, transport: undefined, refreshKey: 0 })!;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    try {
      await act(async () => api.open(0, "modal"));
      await act(async () => api.properties.setView(createPropertyView(schema, ["secret"])));
      expect(api.record?.row.secret).toBe("complete");
      expect(loader).toHaveBeenCalledTimes(1);
    } finally { act(() => root.unmount()); }
  });
  it("does not refetch the collection when the detail view or identity changes", async () => {
    vi.useFakeTimers();
    const fetchRows = vi.fn(async () => ({ rows, total: 2 }));
    let api!: QueryTableApi<Row>;
    const transport: Transport<Row> = { fetchRows, fetchRow: async (id) => rows.find((row) => row.id === id) ?? null };
    function Probe() { api = useQueryTable({ schema, transport, itemDetails: true, debounceMs: 10 }); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => vi.advanceTimersByTimeAsync(10));
      const count = fetchRows.mock.calls.length;
      await act(async () => api.itemDetails!.open(0, "modal"));
      await act(async () => api.itemDetails!.properties.setView(createPropertyView(schema, ["secret"])));
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(api.itemDetails!.record?.row.secret).toBe("complete");
      expect(fetchRows).toHaveBeenCalledTimes(count);
    } finally { act(() => root.unmount()); vi.useRealTimers(); }
  });
});
