import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  metricComputationKey,
  metricPlans,
  hasRegex,
  type AggregationClause,
  type AggregationResult,
  type FieldSchema,
  type QueryState,
  type Transport,
} from "@pythia-software/query-table-core";
import { executeMetrics, type MetricExecutionContext } from "./metricExecution";

export interface AggregationsApiState {
  results: AggregationResult | null;
  loading: boolean;
  error: Error | null;
  preview: (
    clauses: AggregationClause[],
    signal?: AbortSignal,
  ) => Promise<AggregationResult>;
}
/** Fetch state is keyed by computation and scope, never card presentation. */
export function useAggregations<Row>(
  query: QueryState,
  schema: FieldSchema<Row>,
  transport: Transport<Row> | undefined,
  clientRows: Row[] | undefined,
  debounceMs: number,
  nonce: number,
  validateQuery?: (q: QueryState) => void,
  options: Omit<
    MetricExecutionContext<Row>,
    "schema" | "transport" | "clientRows"
  > = {},
): AggregationsApiState {
  const [results, setResults] = useState<AggregationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const latest = useRef({
    query,
    schema,
    transport,
    clientRows,
    options,
    validateQuery,
  });
  latest.current = {
    query,
    schema,
    transport,
    clientRows,
    options,
    validateQuery,
  };
  const preview = useCallback(
    async (clauses: AggregationClause[], signal?: AbortSignal) => {
      const current = latest.current;
      const draft = { ...current.query, aggregations: clauses };
      current.validateQuery?.(draft);
      return executeMetrics(
        draft,
        {
          schema: current.schema,
          transport: current.transport,
          clientRows: current.clientRows,
          ...current.options,
        },
        signal,
      );
    },
    [],
  );
  const shown = (query.aggregations ?? []).some((c) => c.scope === "shownRows");
  // A v2 server scopes shownRows from the query window and snapshot itself.
  // Only client/legacy/regex evaluation depends on the downloaded row page.
  const localPage =
    shown &&
    (!transport?.fetchMetrics ||
      transport.metricCapabilities?.version !== 2 ||
      (query.aggregations ?? []).some((clause) => {
        if (clause.scope !== "shownRows") return false;
        try {
          return metricPlans(clause, schema, options.resolveComputed).some(
            hasRegex,
          );
        } catch {
          return true;
        } // Validation reports invalid inputs through fetch state.
      }));
  const key = useMemo(
    () =>
      JSON.stringify([
        query.where,
        metricComputationKey(query.aggregations ?? []),
        shown ? [query.orderBy, query.limit, query.offset] : null,
      ]),
    [
      query.where,
      query.aggregations,
      query.orderBy,
      query.limit,
      query.offset,
      shown,
    ],
  );
  const dependencyKey = JSON.stringify([
    options.revisions ?? {},
    options.execution ?? null,
  ]);
  useEffect(() => {
    if (!latest.current.query.aggregations?.length) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setResults(null);
    // Automatic shown-page evaluation waits for the committed page. Explicit
    // previews still report missing inputs rather than using stale rows.
    if (localPage && transport && !options.rowsReady) {
      try {
        latest.current.validateQuery?.(latest.current.query);
        setError(options.rowsError ?? null);
        if (options.rowsError) setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e : Error(String(e)));
        setLoading(false);
      }
      return;
    }
    const timer = setTimeout(() => {
      setError(null);
      try {
        latest.current.validateQuery?.(latest.current.query);
      } catch (e) {
        setError(e instanceof Error ? e : Error(String(e)));
        setLoading(false);
        return;
      }
      void preview(latest.current.query.aggregations ?? [], ac.signal)
        .then((result) => {
          if (!ac.signal.aborted) setResults(result);
        })
        .catch((e) => {
          if (!ac.signal.aborted)
            setError(e instanceof Error ? e : Error(String(e)));
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, debounceMs);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [
    key,
    schema,
    transport,
    clientRows,
    debounceMs,
    nonce,
    validateQuery,
    dependencyKey,
    localPage,
    localPage ? options.shownRows : undefined,
    localPage ? options.rowsReady : undefined,
    localPage ? options.rowsError : undefined,
    preview,
  ]);
  return { results, loading, error, preview };
}
