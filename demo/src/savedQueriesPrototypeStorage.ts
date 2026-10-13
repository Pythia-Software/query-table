import {
  localStorageAdapter,
  normalizeQueryState,
  type QueryState,
  type StorageAdapter,
} from "@pythia-software/query-table-core";

/** App supplies a separate schema namespace, keeping prototype saves isolated. */
export function savedQueriesPrototypeStorage(initialQuery: QueryState): StorageAdapter {
  const storage = localStorageAdapter();
  const seeds = new Map<string, Promise<void>>();
  function seed(key: string): Promise<void> {
    if (!seeds.has(key)) {
      seeds.set(key, (async () => {
        if ((await storage.listSaved(key)).length) return;
        const now = Date.now();
        await storage.saveNamed(key, "All runs", initialQuery, now - 3);
        await storage.saveNamed(key, "Failed runs", normalizeQueryState({
          ...initialQuery, where: [{ field: "overall", op: "=", value: "FAIL" }],
        } satisfies QueryState), now - 2);
        await storage.saveNamed(key, "Linux runs", normalizeQueryState({
          ...initialQuery, where: [{ field: "platform", op: "=", value: "linux" }],
        } satisfies QueryState), now - 1);
      })());
    }
    return seeds.get(key)!;
  }
  return {
    ...storage,
    async loadLast(key) {
      await seed(key);
      return (await storage.loadLast(key)) ?? initialQuery;
    },
    async listSaved(key) {
      await seed(key);
      return storage.listSaved(key);
    },
    async loadDefaultSaved(key) {
      await seed(key);
      return storage.loadDefaultSaved?.(key) ?? null;
    },
  };
}
