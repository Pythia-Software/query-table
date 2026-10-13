// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorageAdapter, type FieldSchema, type QueryState, type StorageAdapter } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../../packages/ui/src/QueryBuilder";
import { SavedQueryControlsPrototype } from "../src/SavedQueryControlsPrototype";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; name: string };
const schema: FieldSchema<Row> = {
  name: "saved-query-prototype-test", idField: "id", defaultLimit: 25,
  defaultSelect: [{ field: "name" }],
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};
const initialQuery: QueryState = { select: [{ field: "name" }], where: [], orderBy: [], limit: 25, offset: 0 };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let container: HTMLDivElement;
let root: Root;
let api: QueryTableApi<Row>;
const status = () => container.querySelector('.qt-save-prototype [role="status"]')!.textContent;
const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="Query"]')!;
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === text);
const actionMenu = () => container.querySelector('button[aria-label="Query actions"]');
async function click(text: string) { await act(async () => { button(text)!.click(); }); }
async function choose(id: string) {
  await act(async () => { picker().value = id; picker().dispatchEvent(new Event("change", { bubbles: true })); });
}
async function edit(limit: number) { await act(async () => { api.setQuery({ ...api.query, limit }); }); }
async function fixture() {
  const backing = memoryStorageAdapter();
  const first = await backing.saveNamed(schema.name, "All rows", initialQuery, 1);
  const second = await backing.saveNamed(schema.name, "Short list", { ...initialQuery, limit: 10 }, 2);
  const storage: StorageAdapter = { ...backing, loadLast: async () => initialQuery };
  return { storage, first, second };
}
async function mount(storage: StorageAdapter) {
  function Table() {
    api = useQueryTable<Row>({ schema, clientRows: [], storage, debounceMs: 0 });
    return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total,
      savedQueryControls: createElement(SavedQueryControlsPrototype<Row>, { api }) });
  }
  await act(async () => { root.render(createElement(Table)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("saved-query prototype in QueryBuilder", () => {
  it("shows loading, hides built-in save controls, and clears saved confirmation after three seconds", async () => {
    const { storage, first, second } = await fixture();
    const catalogue = deferred();
    await mount({ ...storage, listSaved: async key => { await catalogue.promise; return storage.listSaved(key); } });
    expect(status()).toBe("Loading queries…");
    expect(picker().disabled).toBe(true);
    expect(button("Save query")).toBeUndefined();
    expect(container.querySelector(".qt-qb-saved")).toBeNull();
    expect(button("Saved")).toBeUndefined();

    await act(async () => { catalogue.resolve(); });
    expect(picker().value).toBe(first.id);
    expect(status()).toBe("Saved");
    expect(actionMenu()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(status()).toBe("Saved");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(status()).toBe("");

    await choose(second.id);
    expect(status()).toBe("Saved");
    await edit(20);
    expect(picker().value).toBe(second.id);
    expect(button("Save changes")).toBeDefined();
    expect(actionMenu()).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(status()).toBe("Unsaved changes");
    expect(container.textContent).not.toContain("Update Query");
  });

  it("retains edits on failed saves and confirms a successful retry only after persistence", async () => {
    const { storage, first } = await fixture();
    let write = deferred();
    await mount({ ...storage, updateNamed: async (...args) => { await write.promise; return storage.updateNamed!(...args); } });
    await edit(40);
    await click("Save changes");
    expect(status()).toBe("Saving…");
    expect(picker().disabled).toBe(true);
    expect(actionMenu()).toBeNull();
    expect((await storage.listSaved(schema.name)).find(item => item.id === first.id)!.query.limit).toBe(25);

    await act(async () => { write.reject(Error("Storage unavailable")); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Storage unavailable");
    expect(api.query.limit).toBe(40);
    expect(status()).toBe("Unsaved changes");
    expect(button("Save changes")).toBeDefined();

    write = deferred();
    await click("Save changes");
    await act(async () => { write.resolve(); });
    expect(status()).toBe("Saved");
    expect(actionMenu()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((await storage.listSaved(schema.name)).find(item => item.id === first.id)!.query.limit).toBe(40);
  });

  it("guards switching and preserves edits made while save-and-switch is pending", async () => {
    const { storage, first, second } = await fixture();
    const write = deferred();
    await mount({ ...storage, updateNamed: async (...args) => { await write.promise; return storage.updateNamed!(...args); } });
    await edit(40);
    await choose(second.id);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(api.query.limit).toBe(40);
    await click("Keep editing");
    expect(picker().value).toBe(first.id);
    expect(api.query.limit).toBe(40);

    await choose(second.id);
    await click("Save and switch");
    await edit(50);
    await act(async () => { write.resolve(); });
    expect(picker().value).toBe(first.id);
    expect(api.query.limit).toBe(50);
    expect(status()).toBe("Unsaved changes");
    expect((await storage.listSaved(schema.name)).find(item => item.id === first.id)!.query.limit).toBe(40);

    await choose(second.id);
    await click("Discard and switch");
    expect(picker().value).toBe(second.id);
    expect(api.query.limit).toBe(10);
    expect(status()).toBe("Saved");
  });
});
