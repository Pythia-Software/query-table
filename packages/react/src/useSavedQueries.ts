// useSavedQueries — named query snapshots over a StorageAdapter.
//
// "Last query" auto-restore and named saves both flow through the injected
// StorageAdapter (localStorage by default, backend-backed if the data layer
// provides one — decision #4). Loading a saved query pushes its QueryState into
// the controller, which re-encodes the URL — so a saved query is equally a
// shareable link.

import { useCallback, useEffect, useState } from "react";
import type { QueryState, SavedQuery, StorageAdapter } from "@query-table/core";

export interface SavedQueriesApi {
  items: SavedQuery[];
  loading: boolean;
  /** Saved query id used as the default view when no query is specified. */
  defaultId: string | null;
  /** Persist the current query under a name. Rejects on duplicate names. */
  save: (name: string) => Promise<SavedQuery>;
  /** Load a saved query into the live controller (and thus the URL). */
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
): SavedQueriesApi {
  const [items, setItems] = useState<SavedQuery[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [savedItems, defaultSaved] = await Promise.all([
        storage.listSaved(key),
        storage.loadDefaultSaved?.(key) ?? Promise.resolve(null),
      ]);
      setItems(savedItems);
      setDefaultId(defaultSaved?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, [storage, key]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (name: string) => {
      const saved = await storage.saveNamed(key, name, currentQuery, now());
      await refresh();
      return saved;
    },
    [storage, key, currentQuery, now, refresh],
  );

  const load = useCallback(
    (id: string) => {
      const found = items.find((q) => q.id === id);
      if (found) applyQueryState(found.query);
    },
    [items, applyQueryState],
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

  return { items, loading, defaultId, save, load, setDefault, clearDefault, remove };
}
