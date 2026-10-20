import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  metricComputationKey,
  type AggregationClause,
  type AggregationResult,
  type FieldSchema,
  type QueryState,
  type Transport,
} from "@pythia-software/query-table-core";
import { executeMetrics, usesLocalMetricPage, type MetricExecutionContext } from "./metricExecution";

export interface AggregationsApiState {
  results: AggregationResult | null;
  loading: boolean;
  error: Error | null;
  preview: (
    clauses: AggregationClause[],
    signal?: AbortSignal,
  ) => Promise<AggregationResult>;
}

type BatchState = Pick<AggregationsApiState, "results" | "loading" | "error">;

function localPage<Row>(clause: AggregationClause, context: MetricExecutionContext<Row>) {
  try {
    return usesLocalMetricPage(clause, context);
  } catch {
    // Keep invalid page inputs behind the readiness gate; execution reports
    // their diagnostics once the page is available.
    return !context.executeV3 && clause.scope === "shownRows";
  }
}

/** Separate lifecycles let remote populations run while a local page loads. */
function useMetricBatch<Row>(
  query: QueryState,
  clauses: AggregationClause[],
  context: MetricExecutionContext<Row>,
  debounceMs: number,
  nonce: number,
  validateQuery: ((q: QueryState) => void) | undefined,
  enabled: boolean,
  page: boolean,
): BatchState {
  const shown = clauses.some(c => c.scope === "shownRows");
  const key = JSON.stringify([
    query.where,
    metricComputationKey(clauses),
    shown ? [query.orderBy, query.limit, query.offset] : null,
    context.revisions ?? {}, context.execution ?? null, context.now,
    context.strictLocalMetrics, context.queryContextKey,
    page ? context.shownFields : null,
  ]);
  const localDataset = !context.executeV3 &&
    !(context.transport?.fetchMetrics && context.transport.metricCapabilities?.version === 2) &&
    !context.transport?.fetchAggregations;
  // Standalone callers can derive the page from a complete client dataset.
  // useQueryTable supplies an explicit gate for its committed-page lifecycle.
  const pageReady = context.rowsReady ?? (localDataset && context.clientRows !== undefined);
  const validationToken = useMemo(() => ({}), [
    key, context.schema, context.transport, nonce, validateQuery, enabled,
  ]);
  const token = useMemo(() => ({}), [
    key, context.schema, context.transport,
    localDataset ? context.clientRows : undefined,
    debounceMs, nonce, validateQuery, enabled, page, context.workerFactory,
    page ? context.shownRows : undefined,
    page ? context.rowsReady : undefined,
    page ? context.rowsError : undefined,
  ]);
  const latest = useRef({ query, clauses, context, validateQuery });
  latest.current = { query, clauses, context, validateQuery };
  const [state, setState] = useState<BatchState & { token: object; validationToken?: object }>(
    { token, results: null, loading: enabled && clauses.length > 0, error: null },
  );
  useEffect(() => {
    if (!enabled || !latest.current.clauses.length) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      const current = latest.current;
      // Validate even while waiting so an invalid query remains repairable.
      try {
        current.validateQuery?.(current.query);
      } catch (e) {
        setState({ token, validationToken, results: null, loading: false, error: e instanceof Error ? e : Error(String(e)) });
        return;
      }
      if (page && !pageReady) return;
      void executeMetrics({ ...current.query, aggregations: current.clauses }, current.context, ac.signal)
        .then(results => {
          if (!ac.signal.aborted) setState({ token, results, loading: false, error: null });
        })
        .catch(e => {
          if (!ac.signal.aborted) setState({ token, results: null, loading: false, error: e instanceof Error ? e : Error(String(e)) });
        });
    }, debounceMs);
    return () => { ac.abort(); clearTimeout(timer); };
  }, [token]);
  if (!enabled || !clauses.length) return { results: null, loading: false, error: null };
  // Query rejection does not become obsolete just because a host allocates
  // another rows array while repairing the same invalid query.
  if (state.validationToken === validationToken && state.error) return state;
  if (page && !pageReady && context.rowsError)
    return { results: null, loading: false, error: context.rowsError };
  // Invalidate during render too: an old page must never look current between
  // the host's render and the effect that starts its replacement request.
  if (state.token !== token) return { results: null, loading: true, error: null };
  return state;
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
  options: Omit<MetricExecutionContext<Row>, "schema" | "transport" | "clientRows"> = {},
  enabled = true,
): AggregationsApiState {
  const context = { schema, transport, clientRows, ...options };
  const clauses = query.aggregations ?? [];
  const pageClauses = clauses.filter(c => localPage(c, context));
  const otherClauses = clauses.filter(c => !pageClauses.includes(c));
  const other = useMetricBatch(query, otherClauses, context, debounceMs, nonce, validateQuery, enabled, false);
  const page = useMetricBatch(query, pageClauses, context, debounceMs, nonce, validateQuery, enabled, true);

  const previewKey = JSON.stringify([
    query.where, query.orderBy, query.limit, query.offset,
    metricComputationKey(clauses), options.revisions, options.execution,
    options.now, options.strictLocalMetrics, options.queryContextKey,
  ]);
  const previewToken = useMemo(() => ({}), [previewKey, schema, transport, nonce, validateQuery, enabled, options.workerFactory]);
  const pageKey = JSON.stringify([query.orderBy, query.limit, query.offset, options.shownFields]);
  const pageToken = useMemo(() => ({}), [previewToken, pageKey, clientRows, options.shownRows, options.rowsReady, options.rowsError]);
  const latest = useRef({ query, context, validateQuery, enabled, previewToken, pageToken });
  latest.current = { query, context, validateQuery, enabled, previewToken, pageToken };
  const previews = useRef(new Set<{
    controller: AbortController;
    page: boolean;
    previewToken: object;
    pageToken: object;
  }>());
  useEffect(() => () => {
    for (const pending of previews.current)
      if (pending.previewToken === previewToken) pending.controller.abort();
  }, [previewToken]);
  useEffect(() => () => {
    for (const pending of previews.current)
      if (pending.page && pending.pageToken === pageToken) pending.controller.abort();
  }, [pageToken]);
  const preview = useCallback(async (draftClauses: AggregationClause[], signal?: AbortSignal) => {
    const current = latest.current;
    if (!current.enabled) throw Error("Resolve the query link before previewing metrics.");
    const draft = { ...current.query, aggregations: draftClauses };
    current.validateQuery?.(draft);
    const pending = {
      controller: new AbortController(),
      page: draftClauses.some(c => localPage(c, current.context)),
      previewToken: current.previewToken,
      pageToken: current.pageToken,
    };
    const cancel = () => pending.controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    previews.current.add(pending);
    try {
      const result = await executeMetrics(draft, current.context, pending.controller.signal);
      if (pending.controller.signal.aborted || current.previewToken !== latest.current.previewToken ||
        (pending.page && current.pageToken !== latest.current.pageToken))
        throw new DOMException("Aborted", "AbortError");
      return result;
    } finally {
      previews.current.delete(pending);
      signal?.removeEventListener("abort", cancel);
    }
  }, []);

  const orderKey = JSON.stringify(clauses.map(c => c.id));
  const results = useMemo(() => {
    if (!pageClauses.length) return other.results;
    if (!otherClauses.length) return page.results;
    if (!page.results || !other.results) return null;
    const byId = new Map([...page.results.metrics, ...other.results.metrics].map(m => [m.id, m]));
    return { metrics: clauses.flatMap(c => byId.get(c.id) ?? []) };
  }, [orderKey, pageClauses.length, otherClauses.length, page.results, other.results]);
  return { results, loading: page.loading || other.loading, error: page.error ?? other.error, preview };
}
