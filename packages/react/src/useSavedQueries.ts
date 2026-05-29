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
  /** Persist the current query under a name. */
  save: (name: string) => Promise<void>;
  /** Load a saved query into the live controller (and thus the URL). */
  load: (id: string) => void;
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await storage.listSaved(key));
    } finally {
      setLoading(false);
    }
  }, [storage, key]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (name: string) => {
      await storage.saveNamed(key, name, currentQuery, now());
      await refresh();
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

  const remove = useCallback(
    async (id: string) => {
      await storage.deleteSaved(key, id);
      await refresh();
    },
    [storage, key, refresh],
  );

  return { items, loading, save, load, remove };
}
