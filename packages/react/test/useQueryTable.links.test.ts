// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryLinkService, createPropertyView, memoryPropertyViewStorage, memoryQuerySnapshotCache, memoryStorageAdapter, EMPTY_QUERY, ITEM_DETAILS_COLUMN, encodeQuery,
  type QuerySnapshot, type QuerySnapshotStore, type FieldSchema, type QueryState, type Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type Row = { id: number; name: string };
const schema: FieldSchema<Row> = { name:"runs", idField:"id", fields:[
  {name:"id",label:"Id",type:"number",source:{kind:"backend"}},
  {name:"name",label:"Name",type:"text",source:{kind:"backend"}},
] };
const rows: Row[] = [{id:1,name:"one"}];
const large: QueryState = {...EMPTY_QUERY,where:[{field:"name",op:"contains",value:Array.from({length:200},(_,i)=>String(i*7919)).join(",")}]};
const detailModes = ["modal", "hover", "expand"] as const;
const linkedView = createPropertyView(schema, ["name"]);
const linkedQuery: QueryState = { ...EMPTY_QUERY, limit: 25,
  itemDetails: { modes: ["modal"], views: { modal: linkedView, hover: linkedView, expand: linkedView } } };
async function storedDetailViews() {
  const storage = memoryPropertyViewStorage();
  const view = createPropertyView(schema, ["id"]);
  for (const mode of detailModes) await storage.saveLast(`runs:${mode}`, view);
  return storage;
}
let dispose: (() => void) | undefined;
function mount(options: Parameters<typeof useQueryTable<Row>>[0] | (() => Parameters<typeof useQueryTable<Row>>[0])) {
  const element = document.createElement("div"); const root = createRoot(element);
  let current!: QueryTableApi<Row>;
  let renders = 0;
  function Probe() {
    if (++renders > 50) throw Error("Unexpected query-controller render loop.");
    current = useQueryTable(typeof options === "function" ? options() : options); return null;
  }
  act(() => root.render(createElement(Probe)));
  dispose = () => act(() => root.unmount());
  return () => current;
}
async function settle() { await act(async () => {}); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); window.history.replaceState(null,"","/runs?section=recent#table"); });
afterEach(() => { dispose?.(); dispose=undefined; vi.useRealTimers(); });

it("isolates two mounted collection parameters without enabling item views", async () => {
  const firstQuery = {...EMPTY_QUERY,limit:25};
  const secondQuery = {...EMPTY_QUERY,limit:50};
  window.history.replaceState(null,"",`/runs?section=recent&q_first=${encodeQuery(firstQuery)}&q_second=${encodeQuery(secondQuery)}#table`);
  const root = createRoot(document.createElement("div"));
  let first!: QueryTableApi<Row>;
  let second!: QueryTableApi<Row>;
  const secondSchema = {...schema,name:"other"};
  function Probe() {
    first = useQueryTable({schema,clientRows:rows,syncUrl:true,queryParameter:"q_first",debounceMs:0});
    second = useQueryTable({schema:secondSchema,clientRows:rows,syncUrl:true,queryParameter:"q_second",debounceMs:0});
    return null;
  }
  act(() => root.render(createElement(Probe)));
  dispose = () => act(() => root.unmount());
  await settle();
  expect(first.query.limit).toBe(25);
  expect(second.query.limit).toBe(50);
  expect(first.itemDetails).toBeUndefined();
  expect(first.query.select.some(column => column.field === ITEM_DETAILS_COLUMN)).toBe(false);
  const secondToken = new URL(window.location.href).searchParams.get("q_second");
  act(() => first.setLimit(10));
  await settle();
  expect(second.query.limit).toBe(50);
  expect(new URL(window.location.href).searchParams.get("q_second")).toBe(secondToken);
  const share = await first.links.create();
  expect(new URL(share.url).searchParams.has("q_first")).toBe(true);
  expect(new URL(share.url).searchParams.get("q_second")).toBe(secondToken);
  expect(new URL(share.url).searchParams.get("section")).toBe("recent");
  expect(new URL(share.url).hash).toBe("#table");
});

it.each([undefined,"q_collection"])("resolves item links with collection parameter precedence (%s)", async queryParameter => {
  const parameter = queryParameter ?? "q_legacy";
  window.history.replaceState(null,"",`/runs?${parameter}=${encodeQuery({...EMPTY_QUERY,limit:25})}`);
  const api = mount({schema,clientRows:rows,syncUrl:true,debounceMs:0,...(queryParameter ? {queryParameter} : {}),
    itemDetails:{queryParameter:"q_legacy",modes:["modal"]}});
  await settle();
  expect(api().query.limit).toBe(25);
  expect(api().itemDetails?.queryParameter).toBe(parameter);
  const link = await api().links.create();
  expect(new URL(link.url).searchParams.has(parameter)).toBe(true);
  if (queryParameter) expect(new URL(link.url).searchParams.has("q_legacy")).toBe(false);
});

it("uses only local cache on edits, promotes on Save/Share, and associates the saved search", async () => {
  const snapshots: QuerySnapshotStore = {
    save: vi.fn(async (_key, snapshot) => snapshot), resolve: vi.fn(async () => null),
  };
  const cache = memoryQuerySnapshotCache(); const storage = { ...memoryStorageAdapter(), snapshots };
  const api = mount({schema, clientRows:rows,storage,syncUrl:true,links:{cache,maxUrlBytes:160},debounceMs:0});
  await settle();
  act(() => api().setQuery(large)); await settle();
  const local = new URL(window.location.href).searchParams.get("q");
  expect(local).toMatch(/^@/); expect(api().links.kind).toBe("local");
  expect(snapshots.save).not.toHaveBeenCalled();
  let saved!: Awaited<ReturnType<QueryTableApi<Row>["saved"]["save"]>>;
  await act(async () => { saved = await api().saved.save("Pinned"); });
  expect(saved.snapshotCode).toBe(local!.slice(1)); expect(api().links.kind).toBe("durable");
  expect(api().saved.items[0]?.snapshotCode).toBe(saved.snapshotCode);
  await act(async () => { await api().links.create(); });
  expect(snapshots.save).toHaveBeenCalledTimes(1);
  act(() => api().setQuery(EMPTY_QUERY)); await settle();
  await act(async () => { await api().links.create(); });
  expect(snapshots.save).toHaveBeenCalledTimes(2);
});

it("blocks fetch, persistence and URL rewriting until a remote reference resolves", async () => {
  let complete!: (value: QuerySnapshot | null) => void;
  const code = "a".repeat(22);
  const resolve = vi.fn(() => new Promise<QuerySnapshot | null>(r => {complete=r;}));
  const snapshots: QuerySnapshotStore = {resolve,save:vi.fn(async (_key,s)=>s)};
  const storage = {...memoryStorageAdapter(),snapshots,saveLast:vi.fn(async()=>{})};
  const fetchRows = vi.fn(async()=>({rows,total:1}));
  window.history.replaceState(null,"",`/runs?q=@${code}`);
  const api = mount({schema,storage,transport:{fetchRows},syncUrl:true,debounceMs:0,links:{cache:memoryQuerySnapshotCache()}});
  await settle();
  expect(api().loading).toBe(true); expect(fetchRows).not.toHaveBeenCalled(); expect(storage.saveLast).not.toHaveBeenCalled();
  expect(new URL(window.location.href).searchParams.get("q")).toBe("@"+code);
  await act(async()=>complete({version:1,code,createdAt:1,token:encodeQuery({...EMPTY_QUERY,limit:25})}));
  await settle();
  expect(api().query.limit).toBe(25); expect(fetchRows).toHaveBeenCalledOnce();
  expect(api().links.kind).toBe("durable");
  expect(new URL(window.location.href).searchParams.get("q")).toBe("@"+code);
});

it.each(["undo", "redo"] as const)("empty-history %s preserves a loading query link", async action => {
  let complete!: (snapshot: QuerySnapshot) => void;
  let signal!: AbortSignal;
  const code = "f".repeat(22);
  const snapshots: QuerySnapshotStore = {
    resolve: vi.fn<QuerySnapshotStore["resolve"]>((_source, _code, abortSignal) => {
      signal = abortSignal!;
      return new Promise<QuerySnapshot>(resolve => { complete = resolve; });
    }),
    save: vi.fn(async (_source, snapshot) => snapshot),
  };
  const storage = { ...memoryStorageAdapter(), snapshots, saveLast: vi.fn(async () => {}) };
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  window.history.replaceState(null, "", `/runs?q=@${code}&section=incoming#table`);
  const incoming = window.location.href;
  const api = mount({ schema, storage, transport: { fetchRows }, syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  const query = api().query;
  expect(api().canUndo).toBe(false); expect(api().canRedo).toBe(false);
  act(() => { api()[action](); api()[action](); });
  await settle();
  expect(signal.aborted).toBe(false);
  expect(api().restoration.status).toBe("resolving");
  expect(api().query).toBe(query);
  expect(fetchRows).not.toHaveBeenCalled(); expect(storage.saveLast).not.toHaveBeenCalled();
  expect(window.location.href).toBe(incoming);
  await act(async () => complete({ version: 1, code, token: encodeQuery({ ...EMPTY_QUERY, limit: 25 }), createdAt: 1 }));
  await settle();
  expect(api().query.limit).toBe(25); expect(api().restoration.ready).toBe(true);
  expect(fetchRows).toHaveBeenCalledOnce();
  const restoredUrl = new URL(window.location.href);
  expect(restoredUrl.searchParams.get("q")).toBe("@" + code);
  expect(restoredUrl.searchParams.get("section")).toBe("incoming"); expect(restoredUrl.hash).toBe("#table");
});

it.each(["undo", "redo"] as const)("empty-history %s preserves a failed query link", async action => {
  window.history.replaceState(null, "", "/runs?q=corrupt&section=incoming#table");
  const incoming = window.location.href;
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  const storage = { ...memoryStorageAdapter(), saveLast: vi.fn(async () => {}) };
  const api = mount({ schema, storage, transport: { fetchRows }, syncUrl: true, debounceMs: 0 });
  await settle();
  const error = api().restoration.error, query = api().query;
  expect(error).toBeInstanceOf(Error);
  expect(api().canUndo).toBe(false); expect(api().canRedo).toBe(false);
  act(() => { api()[action](); api()[action](); });
  await settle();
  expect(api().restoration.status).toBe("error"); expect(api().restoration.error).toBe(error);
  expect(api().query).toBe(query);
  expect(fetchRows).not.toHaveBeenCalled(); expect(storage.saveLast).not.toHaveBeenCalled();
  expect(window.location.href).toBe(incoming);
  await act(async () => { await expect(api().links.create()).rejects.toThrow("Resolve or reset"); });
  act(() => api().resetAll()); await settle();
  expect(api().restoration.ready).toBe(true); expect(fetchRows).toHaveBeenCalledOnce();
});

it("keeps batched history edits and retained keyboard callbacks current", async () => {
  const api = mount({ schema, clientRows: rows, initialQuery: EMPTY_QUERY, debounceMs: 0 });
  await settle();
  const baseline = api().query;
  const { undo, redo } = api();
  act(() => { api().setLimit(7); undo(); redo(); });
  await settle();
  expect(api().query.limit).toBe(7); expect(api().canUndo).toBe(true); expect(api().canRedo).toBe(false);
  expect(api().undo).toBe(undo); expect(api().redo).toBe(redo);
  act(() => { undo(); undo(); }); await settle();
  expect(api().query).toEqual(baseline); expect(api().canUndo).toBe(false); expect(api().canRedo).toBe(true);
  act(() => { redo(); redo(); }); await settle();
  expect(api().query.limit).toBe(7); expect(api().canUndo).toBe(true); expect(api().canRedo).toBe(false);
});

it.each(["undo", "redo"] as const)("available %s supersedes pending navigation through a retained callback", async action => {
  let complete!: (snapshot: QuerySnapshot) => void;
  let signal!: AbortSignal;
  const code = "g".repeat(22);
  const snapshots: QuerySnapshotStore = {
    resolve: (_source, _code, abortSignal) => {
      signal = abortSignal!;
      return new Promise(resolve => { complete = resolve; });
    },
    save: async (_source, snapshot) => snapshot,
  };
  const storage = { ...memoryStorageAdapter(), snapshots };
  const api = mount({ schema, clientRows: rows, storage, initialQuery: EMPTY_QUERY, syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  const retained = api()[action], baseline = api().query.limit;
  act(() => api().setLimit(7)); await settle();
  if (action === "redo") { act(() => api().undo()); await settle(); }
  window.history.pushState(null, "", `/runs?q=@${code}`);
  let pending!: Promise<void>;
  act(() => { pending = api().restoreLocation(window.location.href); }); await settle();
  expect(api().restoration.status).toBe("resolving");
  act(() => retained()); await settle();
  expect(signal.aborted).toBe(true); expect(api().restoration.ready).toBe(true);
  const applied = api().query, address = window.location.href;
  expect(applied.limit).toBe(action === "undo" ? baseline : 7);
  await act(async () => { complete({ version: 1, code, token: encodeQuery({ ...EMPTY_QUERY, limit: 25 }), createdAt: 1 }); await pending; });
  await settle();
  expect(api().query).toBe(applied); expect(window.location.href).toBe(address);
});

it.each([false, true])("waits for remote query restoration before syncing stored detail views (embedded views: %s)", async embedded => {
  const propertyStorage = await storedDetailViews();
  let complete!: (snapshot: QuerySnapshot) => void;
  const code = "b".repeat(22);
  const snapshots: QuerySnapshotStore = {
    resolve: vi.fn(() => new Promise<QuerySnapshot>(resolve => { complete = resolve; })),
    save: vi.fn(async (_key, snapshot) => snapshot),
  };
  const storage = { ...memoryStorageAdapter(), snapshots, saveLast: vi.fn(async () => {}) };
  const fetchRows = vi.fn<NonNullable<Transport<Row>["fetchRows"]>>(async () => ({ rows, total: 1 }));
  window.history.replaceState(null, "", `/runs?q=@${code}`);
  const api = mount({ schema, storage, transport: { fetchRows }, itemDetails: { storage: propertyStorage },
    syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  expect(api().itemDetails!.properties.loading).toBe(false);
  expect(api().itemDetails!.properties.view).toEqual(createPropertyView(schema, ["id"]));
  expect(api().loading).toBe(true);
  expect(api().canUndo).toBe(false);
  expect(fetchRows).not.toHaveBeenCalled();
  expect(storage.saveLast).not.toHaveBeenCalled();
  expect(new URL(window.location.href).searchParams.get("q")).toBe("@" + code);
  const restored = embedded ? linkedQuery : { ...EMPTY_QUERY, limit: 25 };
  await act(async () => complete({ version: 1, code, token: encodeQuery(restored), createdAt: 1 }));
  await settle();
  expect(api().query.limit).toBe(25);
  expect(api().error).toBeNull();
  expect(api().rows).toEqual(rows);
  expect(fetchRows).toHaveBeenCalledOnce();
  expect(fetchRows.mock.calls[0]![0].limit).toBe(25);
  expect(snapshots.save).not.toHaveBeenCalled();
  if (embedded) {
    expect(api().query).toEqual(linkedQuery);
    expect(api().canUndo).toBe(false);
    for (const mode of detailModes) expect(api().itemDetails!.propertiesByMode[mode].view).toEqual(linkedView);
    expect(new URL(window.location.href).searchParams.get("q")).toBe("@" + code);
  }
});

it.each(["loadLast", "loadDefaultSaved"] as const)("does not let detail hydration cancel a delayed %s restore", async source => {
  const propertyStorage = await storedDetailViews();
  let complete!: () => void;
  const storage = memoryStorageAdapter();
  const saved = { id: "default", name: "Default", savedAt: 1, query: linkedQuery };
  const last = new Promise<QueryState>(resolve => { if (source === "loadLast") complete = () => resolve(linkedQuery); });
  const defaultSaved = new Promise<typeof saved>(resolve => { if (source === "loadDefaultSaved") complete = () => resolve(saved); });
  storage.loadLast = vi.fn(() => source === "loadLast" ? last : Promise.resolve(null));
  storage.loadDefaultSaved = vi.fn(() => source === "loadDefaultSaved" ? defaultSaved : Promise.resolve(null));
  const api = mount({ schema, storage, clientRows: rows, syncUrl: true, debounceMs: 0,
    itemDetails: { storage: propertyStorage }, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  expect(api().itemDetails!.properties.loading).toBe(false);
  expect(api().canUndo).toBe(false);
  expect(new URL(window.location.href).searchParams.has("q")).toBe(false);
  await act(async () => complete());
  await settle();
  expect(api().query).toEqual(linkedQuery);
  expect(api().canUndo).toBe(false);
  expect(api().error).toBeNull();
  for (const mode of detailModes) expect(api().itemDetails!.propertiesByMode[mode].view).toEqual(linkedView);
});

it("keeps snapshot detail views when property storage hydrates after the remote query", async () => {
  const storedView = createPropertyView(schema, ["id"]);
  let complete!: () => void;
  const pending = new Promise<typeof storedView>(resolve => { complete = () => resolve(storedView); });
  const propertyStorage = { ...memoryPropertyViewStorage(), loadLast: () => pending };
  const code = "e".repeat(22);
  const snapshot = { version: 1 as const, code, token: encodeQuery(linkedQuery), createdAt: 1 };
  const snapshots: QuerySnapshotStore = { resolve: async () => snapshot, save: async (_key, value) => value };
  window.history.replaceState(null, "", `/runs?q=@${code}`);
  const api = mount({ schema, clientRows: rows, storage: { ...memoryStorageAdapter(), snapshots },
    itemDetails: { storage: propertyStorage }, syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  expect(api().query).toEqual(linkedQuery);
  expect(api().itemDetails!.properties.loading).toBe(true);
  await act(async () => complete());
  await settle();
  expect(api().query).toEqual(linkedQuery);
  expect(api().canUndo).toBe(false);
  for (const mode of detailModes) {
    expect(api().itemDetails!.propertiesByMode[mode].loading).toBe(false);
    expect(api().itemDetails!.propertiesByMode[mode].view).toEqual(linkedView);
  }
  expect(new URL(window.location.href).searchParams.get("q")).toBe("@" + code);
});

it("keeps real user edits ahead of a pending remote restore with detail storage", async () => {
  const propertyStorage = await storedDetailViews();
  let complete!: (snapshot: QuerySnapshot) => void;
  const code = "c".repeat(22);
  const snapshots: QuerySnapshotStore = { resolve: () => new Promise(resolve => { complete = resolve; }), save: async (_key, value) => value };
  window.history.replaceState(null, "", `/runs?q=@${code}`);
  const api = mount({ schema, clientRows: rows, storage: { ...memoryStorageAdapter(), snapshots },
    itemDetails: { storage: propertyStorage }, syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  const edited = { ...linkedQuery, limit: 77 };
  act(() => api().setQuery(edited));
  await settle();
  const editedUrl = window.location.href;
  await act(async () => complete({ version: 1, code, token: encodeQuery(linkedQuery), createdAt: 1 }));
  await settle();
  expect(api().query).toEqual(edited);
  expect(window.location.href).toBe(editedUrl);
  expect(api().error).toBeNull();
});

it("keeps a failed remote link blocked after stored detail views hydrate", async () => {
  const propertyStorage = await storedDetailViews();
  let fail!: (error: Error) => void;
  const code = "d".repeat(22);
  const snapshots: QuerySnapshotStore = { resolve: () => new Promise((_resolve, reject) => { fail = reject; }), save: async (_key, value) => value };
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  window.history.replaceState(null, "", `/runs?q=@${code}`);
  const api = mount({ schema, transport: { fetchRows }, storage: { ...memoryStorageAdapter(), snapshots },
    itemDetails: { storage: propertyStorage }, syncUrl: true, debounceMs: 0, links: { cache: memoryQuerySnapshotCache() } });
  await settle();
  await act(async () => fail(Error("offline")));
  await settle();
  expect(api().error?.message).toBe("offline");
  expect(fetchRows).not.toHaveBeenCalled();
  expect(api().rows).toEqual([]);
  expect(new URL(window.location.href).searchParams.get("q")).toBe("@" + code);
});

it("expired local references fail visibly without executing defaults", async () => {
  window.history.replaceState(null,"","/runs?q=@"+"a".repeat(22));
  const fetchRows = vi.fn(async()=>({rows,total:1}));
  const api = mount({schema,transport:{fetchRows},syncUrl:true,debounceMs:0,links:{cache:memoryQuerySnapshotCache()}});
  await settle();
  expect(api().error?.message).toContain("unavailable"); expect(fetchRows).not.toHaveBeenCalled();
  expect(api().rows).toEqual([]);
  await act(async () => { await expect(api().links.create()).rejects.toThrow("Resolve or reset"); });
});

it("does not let URL synchronization shadow a stored default during hydration", async () => {
  const savedQuery = {...EMPTY_QUERY,limit:25};
  const storage = {...memoryStorageAdapter(),loadDefaultSaved:async()=>({id:"default",name:"Default",savedAt:1,query:savedQuery})};
  const api = mount({schema,clientRows:rows,storage,syncUrl:true,debounceMs:0,links:{cache:memoryQuerySnapshotCache()}});
  await settle();
  expect(api().query).toEqual(savedQuery);
  const service = createQueryLinkService("runs",undefined,{cache:memoryQuerySnapshotCache()});
  expect(await service.resolve(window.location.href)).toEqual(savedQuery);
});

it("restores local references on browser back/forward without server writes", async () => {
  const cache = memoryQuerySnapshotCache();
  const service = createQueryLinkService("runs",undefined,{cache,maxUrlBytes:160});
  const local = service.local(large, window.location.href);
  const api = mount({schema,clientRows:rows,syncUrl:true,links:{cache,maxUrlBytes:160},debounceMs:0});
  await settle();
  await act(async()=>{window.history.pushState(null,"",local.url);window.dispatchEvent(new PopStateEvent("popstate"));});
  await settle();
  expect(api().query).toEqual(large); expect(api().links.kind).toBe("local");
});

it("late promotion and restoration cannot overwrite a newer query", async () => {
  let complete!: ()=>void;
  const snapshots: QuerySnapshotStore = {resolve:async()=>null,save:vi.fn((_key: string,s: QuerySnapshot)=>new Promise<QuerySnapshot>(r=>{complete=()=>r(s);}))};
  const storage = {...memoryStorageAdapter(),snapshots};
  const api = mount({schema,clientRows:rows,initialQuery:large,storage,syncUrl:true,links:{cache:memoryQuerySnapshotCache(),maxUrlBytes:160},debounceMs:0});
  let pending!: Promise<unknown>;
  act(()=>{pending=api().links.create();});
  act(()=>api().setQuery(EMPTY_QUERY));
  const current = window.location.href;
  await act(async()=>{complete();await pending;});
  expect(window.location.href).toBe(current); expect(api().query).toEqual(EMPTY_QUERY);
});

it("ignores hash/router history entries after its own inline and durable URL writes", async () => {
  const snapshots: QuerySnapshotStore = {save:vi.fn(async(_key,s)=>s),resolve:vi.fn(async()=>null)};
  const cache = memoryQuerySnapshotCache();
  const get = vi.spyOn(cache,"get");
  const loadDefaultSaved = vi.fn(async()=>null);
  const fetchRows = vi.fn(async()=>({rows,total:1}));
  const storage = {...memoryStorageAdapter(),loadDefaultSaved,snapshots};
  const api = mount({schema,storage,transport:{fetchRows},syncUrl:true,links:{cache},debounceMs:0});
  await settle(); act(()=>api().setQuery({...EMPTY_QUERY,limit:25})); await settle();
  for (const durable of [false,true]) {
    if (durable) await act(async()=>{await api().links.create();});
    const displayedRows = api().rows; const historyAvailable = api().canUndo;
    fetchRows.mockClear(); get.mockClear(); loadDefaultSaved.mockClear();
    await act(async()=>{
      const url = new URL(window.location.href);url.hash="other";url.searchParams.set("section","another");
      window.history.pushState({host:"route"},"",url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(api().query.limit).toBe(25);expect(api().rows).toBe(displayedRows);expect(api().canUndo).toBe(historyAvailable);
    expect(fetchRows).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(loadDefaultSaved).not.toHaveBeenCalled();
  }
});

it("keeps a parameter-less view and undo history on unrelated navigation", async () => {
  const fetchRows = vi.fn(async()=>({rows,total:1}));
  const api = mount({schema,initialQuery:EMPTY_QUERY,transport:{fetchRows},syncUrl:true,links:{maxUrlBytes:10},debounceMs:0});
  act(()=>api().setQuery({...EMPTY_QUERY,limit:25}));await settle();
  expect(new URL(window.location.href).searchParams.has("q")).toBe(false);
  const displayed = api().rows;fetchRows.mockClear();
  await act(async()=>{window.history.pushState(null,"","/runs?section=next#other");window.dispatchEvent(new PopStateEvent("popstate"));});
  await settle();
  expect(api().query.limit).toBe(25);expect(api().canUndo).toBe(true);expect(api().rows).toBe(displayed);
  expect(fetchRows).not.toHaveBeenCalled();
});

it("restores once with an inline storage adapter and keeps subsequent edits", async () => {
  const backing = memoryStorageAdapter();
  const loadLast = vi.fn(async()=>({...EMPTY_QUERY,limit:25}));
  const loadDefaultSaved = vi.fn(async()=>null);
  const listSaved = vi.fn(async()=>[]);
  const api = mount(()=>({schema,clientRows:rows,storage:{...backing,loadLast,loadDefaultSaved,listSaved},syncUrl:true,debounceMs:0}));
  await settle();
  expect(api().query.limit).toBe(25);expect(loadLast).toHaveBeenCalledOnce();expect(listSaved).toHaveBeenCalledOnce();
  expect(loadDefaultSaved).toHaveBeenCalledTimes(2); // one named-save list refresh, one initial restore
  act(()=>api().setQuery({...EMPTY_QUERY,limit:77}));await settle();
  expect(api().query.limit).toBe(77);expect(api().canUndo).toBe(true);
  expect(loadLast).toHaveBeenCalledOnce();expect(listSaved).toHaveBeenCalledOnce();
  expect(loadDefaultSaved).toHaveBeenCalledTimes(2);
});

it.each(["loadLast", "loadDefaultSaved"] as const)("executes defaults when optional %s rejects", async method => {
  const storage = { ...memoryStorageAdapter(), [method]: vi.fn(async () => { throw Error("offline"); }) };
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  const api = mount({ schema, storage, transport: { fetchRows }, syncUrl: true, debounceMs: 0 });
  await settle();
  expect(api().error).toBeNull();
  expect(api().rows).toEqual(rows);
  expect(fetchRows).toHaveBeenCalledOnce();
  expect(api().saved.loading).toBe(false);
});

it("falls back to defaults on navigation without a query when storage fails", async () => {
  const storage = { ...memoryStorageAdapter(), loadDefaultSaved: vi.fn(async () => { throw Error("offline"); }) };
  const api = mount({ schema, storage, clientRows: rows, initialQuery: { ...EMPTY_QUERY, limit: 77 }, syncUrl: true, debounceMs: 0 });
  await settle();
  await act(async () => {
    window.history.pushState(null, "", "/runs?section=other");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await settle();
  expect(api().query.limit).toBe(100);
  expect(api().error).toBeNull();
  expect(api().rows).toEqual(rows);
});

it("restores stored defaults with an empty query URL parameter", async () => {
  window.history.replaceState(null, "", "/runs?q=");
  const storage = memoryStorageAdapter();
  const saved = await storage.saveNamed("runs", "Default", { ...EMPTY_QUERY, limit: 25 }, 1);
  await storage.setDefaultSaved!("runs", saved.id);
  const api = mount({ schema, storage, clientRows: rows, syncUrl: true, debounceMs: 0 });
  await settle();
  expect(api().query.limit).toBe(25);
  expect(api().error).toBeNull();
  expect(api().rows).toEqual(rows);
});

it("blocks execution for duplicate empty query parameters", async () => {
  window.history.replaceState(null, "", "/runs?q=&q=");
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  const api = mount({ schema, transport: { fetchRows }, syncUrl: true, debounceMs: 0 });
  await settle();
  expect(api().error?.message).toContain("conflicting");
  expect(fetchRows).not.toHaveBeenCalled();
});
