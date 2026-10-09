import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Transport } from "@pythia-software/query-table-core";

export interface RequestActivityEntry {
  id: number;
  kind: string;
  startedAt: number;
  status: "pending" | "success" | "error" | "aborted";
  durationMs?: number;
  error?: string;
}
export interface RequestActivityApi {
  /** Newest first; bounded to the latest 100 calls. Query values and results are never retained. */
  entries: readonly RequestActivityEntry[];
  clear: () => void;
}
const methods = new Set([
  "fetchRows",
  "fetchRowsV2",
  "fetchMetrics",
  "fetchAggregations",
  "fetchRow",
  "fetchDistinctValues",
  "fetchFieldStats",
]);

/** Observe the transport boundary without changing receiver, arguments or errors. */
export function observeTransport<Row>(
  transport: Transport<Row>,
  publish: (entry: RequestActivityEntry) => void,
  nextId: () => number,
): Transport<Row> {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(Object.create(transport) as Transport<Row>, {
    get(_target, key) {
      const method = Reflect.get(transport, key, transport);
      if (!methods.has(String(key)) || typeof method !== "function")
        return method;
      if (!wrappers.has(key))
        wrappers.set(key, async (...args: unknown[]) => {
          const signal = args[1] as AbortSignal | undefined;
          const start = performance.now();
          const entry: RequestActivityEntry = {
            id: nextId(),
            kind: String(key).replace(/^fetch/, ""),
            startedAt: Date.now(),
            status: "pending",
          };
          publish(entry);
          let done = false;
          const finish = (
            status: RequestActivityEntry["status"],
            error?: unknown,
          ) => {
            if (done) return;
            done = true;
            publish({
              ...entry,
              status,
              durationMs: Math.max(0, performance.now() - start),
              ...(error !== undefined
                ? {
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                : {}),
            });
          };
          const abort = () => finish("aborted");
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            const result = await method.apply(transport, args);
            finish(signal?.aborted ? "aborted" : "success");
            return result;
          } catch (error) {
            finish(
              signal?.aborted ||
                (error instanceof Error && error.name === "AbortError")
                ? "aborted"
                : "error",
              error,
            );
            throw error;
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        });
      return wrappers.get(key);
    },
  });
}

export function useRequestActivity<Row>(source: Transport<Row> | undefined) {
  const [entries, setEntries] = useState<RequestActivityEntry[]>([]);
  const sequence = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publish = useCallback((entry: RequestActivityEntry) => {
    if (mounted.current)
      setEntries((previous) =>
        [entry, ...previous.filter((e) => e.id !== entry.id)]
          .sort((a, b) => b.id - a.id)
          .slice(0, 100),
      );
  }, []);
  const transport = useMemo(
    () =>
      source
        ? observeTransport(source, publish, () => ++sequence.current)
        : undefined,
    [source, publish],
  );
  const clear = useCallback(
    () =>
      setEntries((previous) => previous.filter((e) => e.status === "pending")),
    [],
  );
  const activity: RequestActivityApi = useMemo(
    () => ({ entries, clear }),
    [entries, clear],
  );
  return { transport, activity };
}
