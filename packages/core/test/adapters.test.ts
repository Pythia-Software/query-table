import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_QUERY, localStorageAdapter, memoryStorageAdapter } from "../src/index";

afterEach(() => vi.unstubAllGlobals());

function localStorageMock() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

it.each(["memory", "local"])("updates %s saved queries in place at capacity and retains their default selection", async kind => {
  localStorageMock();
  const storage = kind === "memory" ? memoryStorageAdapter() : localStorageAdapter();
  const saved = await storage.saveNamed("runs", "Pinned", EMPTY_QUERY, 1, "old-code");
  await storage.setDefaultSaved!("runs", saved.id);
  for (let i = 2; i <= 100; i++) await storage.saveNamed("runs", `Query ${i}`, EMPTY_QUERY, i);
  const query = { ...EMPTY_QUERY, limit: 25 };
  const updated = await storage.updateNamed!("runs", saved.id, query, 101, "new-code");
  expect(updated).toEqual({ ...saved, query, savedAt: 101, snapshotCode: "new-code" });
  expect(await storage.loadDefaultSaved!("runs")).toEqual(updated);
  expect(await storage.listSaved("runs")).toHaveLength(100);
  expect(await storage.loadDefaultSaved!("other")).toBeNull();
  await expect(storage.updateNamed!("runs", "missing", query, 102)).rejects.toThrow("does not exist");
  const withoutSnapshot = await storage.updateNamed!("runs", saved.id, EMPTY_QUERY, 103);
  expect(withoutSnapshot.snapshotCode).toBeUndefined();
  expect(await storage.loadDefaultSaved!("runs")).toEqual(withoutSnapshot);
});

it("keeps the original saved entry and default on a localStorage update write failure", async () => {
  const local = localStorageMock();
  const storage = localStorageAdapter();
  const original = await storage.saveNamed("runs", "Pinned", EMPTY_QUERY, 1, "old-code");
  await storage.setDefaultSaved!("runs", original.id);
  local.setItem.mockImplementationOnce(() => { throw Error("quota exhausted"); });
  await expect(storage.updateNamed!("runs", original.id, { ...EMPTY_QUERY, limit: 25 }, 2, "new-code"))
    .rejects.toThrow("quota exhausted");
  expect(await storage.listSaved("runs")).toEqual([original]);
  expect(await storage.loadDefaultSaved!("runs")).toEqual(original);
});
