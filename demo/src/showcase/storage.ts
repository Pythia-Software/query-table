import {
  localStorageAdapter,
  memoryStorageAdapter,
  normalizeQueryState,
  validateComputedColumn,
  type ComputedColumn,
  type ComputedColumnStore,
  type StorageAdapter,
} from "@pythia-software/query-table-core";
import type { Dataset } from "./data";

let sessionQueries: StorageAdapter | undefined;
function queryStore(): StorageAdapter {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.getItem("query-table:showcase:storage-check");
      return localStorageAdapter();
    }
  } catch {
    /* Sandboxed browsers still get working session saves. */
  }
  return (sessionQueries ??= memoryStorageAdapter());
}

/** Demo-only opt-in persistence. Public data and formulas stay in this browser. */
export function showcaseComputedStore(): ComputedColumnStore {
  const memory = new Map<string, ComputedColumn[]>(),
    listeners = new Map<string, Set<() => void>>();
  const read = (dataset: string): ComputedColumn[] => {
    if (memory.has(dataset)) return memory.get(dataset)!;
    try {
      const value = JSON.parse(
        localStorage.getItem(`query-table:showcase:computed:v1:${dataset}`) ??
          "[]",
      );
      if (!Array.isArray(value) || value.length > 100) return [];
      return value.map(validateComputedColumn);
    } catch {
      return memory.get(dataset) ?? [];
    }
  };
  return {
    async list(dataset, signal) {
      signal?.throwIfAborted();
      return read(dataset);
    },
    async save(dataset, draft, expectedRevision) {
      const columns = read(dataset),
        current = columns.find((column) => column.id === draft.id);
      if ((current?.revision ?? null) !== expectedRevision)
        throw Error("This definition changed. Reload before saving.");
      const next = validateComputedColumn({
        ...draft,
        revision: crypto.randomUUID(),
      });
      const updated = [
        ...columns.filter((column) => column.id !== draft.id),
        next,
      ];
      if (updated.length > 100 || JSON.stringify(updated).length > 1000000)
        throw Error("The demo formula catalogue is full.");
      try {
        localStorage.setItem(
          `query-table:showcase:computed:v1:${dataset}`,
          JSON.stringify(updated),
        );
        memory.delete(dataset);
      } catch {
        memory.set(dataset, updated);
      }
      listeners.get(dataset)?.forEach((listener) => listener());
      return next;
    },
    subscribe(dataset, listener) {
      const set = listeners.get(dataset) ?? new Set();
      set.add(listener);
      listeners.set(dataset, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** Built-in examples share the controller's catalogue with personal saves. */
export function showcaseQueryStorage(dataset: Dataset): StorageAdapter {
  const store = queryStore();
  const examples = dataset.recipes.map((recipe, index) => ({
    id: exampleQueryId(dataset.id, index),
    name: recipe.name,
    savedAt: Date.UTC(2025, 0, 1) + index,
    query: normalizeQueryState(recipe.query),
  }));
  const isExample = (id: string) =>
    examples.some((example) => example.id === id);
  return {
    ...store,
    async loadLast(key) {
      return (await store.loadLast(key)) ?? dataset.defaults;
    },
    async listSaved(key) {
      return [
        ...examples.map((example) => ({
          ...example,
          query: normalizeQueryState(example.query),
        })),
        ...(await store.listSaved(key)),
      ];
    },
    async saveNamed(key, name, query, savedAt, snapshotCode) {
      if (examples.some((example) => example.name === name.trim()))
        throw Error("Choose a different name from the example queries.");
      return store.saveNamed(key, name, query, savedAt, snapshotCode);
    },
    async updateNamed(key, id, query, savedAt, snapshotCode) {
      if (isExample(id)) throw Error("Save a copy to change an example query.");
      return store.updateNamed!(key, id, query, savedAt, snapshotCode);
    },
    async deleteSaved(key, id) {
      if (isExample(id))
        throw Error("Example queries stay available for the tour.");
      return store.deleteSaved(key, id);
    },
    async setDefaultSaved(key, id) {
      if (id && isExample(id))
        throw Error("Choose a personal saved query as your default view.");
      return store.setDefaultSaved!(key, id);
    },
  };
}
export const exampleQueryId = (dataset: string, index: number) =>
  `example:${dataset}:${index}`;
export const isExampleQuery = (id: string) => id.startsWith("example:");
