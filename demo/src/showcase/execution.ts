import { useEffect, useMemo, useState } from "react";
import { DuckDBBackend } from "@pythia-software/query-table-duckdb";
import type {
  ComputedColumn,
  ComputedColumnStore,
} from "@pythia-software/query-table-core";
import type { LoadedDataset } from "./runtime";
import type { Dataset } from "./data";

/** Refresh the authoritative DuckDB formula handshake when the local catalogue changes. */
export function useShowcaseExecution(
  loaded: LoadedDataset,
  dataset: Dataset,
  source: ComputedColumnStore,
) {
  const [columns, setColumns] = useState<ComputedColumn[] | null>(null);
  const [snapshot, setSnapshot] = useState({
    backend: loaded.backend,
    key: "[]",
  });
  const [error, setError] = useState<string | null>(null);
  const store = useMemo<ComputedColumnStore>(
    () => ({
      ...source,
      async save(name, draft, revision) {
        const current = await source.list(name);
        // Validate before persisting: unsupported SQL formulas remain editable drafts.
        new DuckDBBackend({
          ...loaded.backend.options,
          computedColumns: [
            ...current.filter((column) => column.id !== draft.id),
            { ...draft, revision: "draft" },
          ],
        });
        return source.save(name, draft, revision);
      },
    }),
    [source, loaded],
  );
  useEffect(() => {
    let stopped = false;
    const refresh = () =>
      void source
        .list(dataset.schema.name)
        .then((next) => {
          if (!stopped)
            setColumns((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next,
            );
        })
        .catch((e) => {
          if (!stopped) setError(String(e));
        });
    refresh();
    const changed = (event: StorageEvent) => {
      if (
        event.key === `query-table:showcase:computed:v1:${dataset.schema.name}`
      )
        refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", changed);
    const unsubscribe = source.subscribe?.(dataset.schema.name, refresh);
    return () => {
      stopped = true;
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", changed);
    };
  }, [source, dataset]);
  const key = JSON.stringify(columns ?? []);
  useEffect(() => {
    if (!columns) return;
    let cancelled = false;
    let resource:
      Awaited<ReturnType<LoadedDataset["createBackend"]>> | undefined;
    setError(null);
    if (!columns.length) {
      setSnapshot({ backend: loaded.backend, key });
      return;
    }
    void loaded
      .createBackend(columns)
      .then((next) => {
        resource = next;
        if (cancelled) void next.dispose();
        else setSnapshot({ backend: next.backend, key });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (resource) void resource.dispose();
    };
  }, [loaded, key]);
  return {
    backend: snapshot.backend,
    store,
    ready: columns !== null && snapshot.key === key && !error,
    error,
  };
}
