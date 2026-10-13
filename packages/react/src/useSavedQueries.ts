// useSavedQueries — named query snapshots over a StorageAdapter.
//
// "Last query" auto-restore and named saves both flow through the injected
// StorageAdapter (in-memory by default, explicitly durable when the caller
// provides one). Loading a saved query pushes its QueryState into the controller.

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryState, SavedQuery, StorageAdapter, QuerySnapshot } from "@pythia-software/query-table-core";

export interface SavedQueriesApi {
  items: SavedQuery[];
  loading: boolean;
  /** Saved query id used as the default view when no query is specified. */
  defaultId: string | null;
  /** Persist the current query under a name. Rejects on duplicate names. */
  save: (name: string) => Promise<SavedQuery>;
  /** Whether the storage adapter supports atomic updates. */
  canUpdate: boolean;
  /** Replace a saved query with the current state, retaining its id and default. */
  update: (id: string) => Promise<SavedQuery>;
  /** Load a saved query into the live controller. */
  load: (id: string) => void;
  /** Mark a saved query as the default view. No-op when storage lacks support. */
  setDefault: (id: string) => Promise<void>;
  /** Clear the saved-query default view. */
  clearDefault: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useSavedQueries(
  key: string,
  currentQuery: QueryState,
  applyQueryState: (q: QueryState) => void,
  storage: StorageAdapter,
  /** Injected clock so saves are deterministic/testable. */
  now: () => number,
  snapshot?: (query: QueryState) => Promise<QuerySnapshot | null>,
): SavedQueriesApi {
  const [items, setItems] = useState<SavedQuery[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const storageRef = useRef(storage);
  storageRef.current = storage;

  const refresh = useCallback(async () => {
    const storage = storageRef.current;
    setLoading(true);
    try {
      const [savedItems, defaultSaved] = await Promise.allSettled([
        storage.listSaved(key),
        storage.loadDefaultSaved?.(key) ?? Promise.resolve(null),
      ]);
      // Optional catalogue reads must not block the table or turn a committed
      // save into a reported failure. Keep the last successful data on failure.
      if (savedItems.status === "fulfilled") setItems(savedItems.value);
      if (defaultSaved.status === "fulfilled") setDefaultId(defaultSaved.value?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (name: string) => {
      name = name.trim();
      if (!name || name.length > 200) throw Error("Saved query name must be between 1 and 200 characters.");
      const immutable = await snapshot?.(currentQuery);
      const saved = await storage.saveNamed(key, name, currentQuery, now(), immutable?.code);
      await refresh();
      return saved;
    },
    [storage, key, currentQuery, now, refresh, snapshot],
  );

  const load = useCallback(
    (id: string) => {
      const found = items.find((q) => q.id === id);
      if (found) applyQueryState(found.query);
    },
    [items, applyQueryState],
  );

  const update = useCallback(
    async (id: string) => {
      if (!storage.updateNamed) throw Error("This storage adapter does not support saved-query updates.");
      const immutable = await snapshot?.(currentQuery);
      const saved = await storage.updateNamed(key, id, currentQuery, now(), immutable?.code);
      await refresh();
      return saved;
    },
    [storage, key, currentQuery, now, refresh, snapshot],
  );

  const setDefault = useCallback(
    async (id: string) => {
      await storage.setDefaultSaved?.(key, id);
      await refresh();
    },
    [storage, key, refresh],
  );

  const clearDefault = useCallback(async () => {
    await storage.setDefaultSaved?.(key, null);
    await refresh();
  }, [storage, key, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (id === defaultId) await storage.setDefaultSaved?.(key, null);
      await storage.deleteSaved(key, id);
      await refresh();
    },
    [storage, key, defaultId, refresh],
  );

  return { items, loading, defaultId, save, canUpdate: Boolean(storage.updateNamed), update, load, setDefault, clearDefault, remove };
}
