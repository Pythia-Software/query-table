// useQueryTable — the one hook that owns everything.
//
// The headless brain of the table: it holds the QueryState, keeps it in sync
// with the URL (`?q=`) and the StorageAdapter, orchestrates fetches through the
// Transport (debounced + abortable), and exposes intent-level mutators so a UI
// never hand-edits QueryState. @pythia-software/query-table-ui is a thin layer over this; you
// can also build an entirely custom table on it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_QUERY,
  applyQuery,
  decodeQuery,
  encodeQuery,
  memoryStorageAdapter,
  normalizeQueryState,
  readFieldValue,
  selectedFields,
  toServerQuery,
  queriesEqual,
} from "@pythia-software/query-table-core";

const AUTOCOMPLETE_LIMIT = 50;
const MAX_AUTO_REFRESH_POLLS = 1000;
import type {
  QueryState,
  WhereClause,
  OrderByClause,
  AggOp,
  AggregationClause,
  AggregationResult,
  RowId,
  FieldDef,
  FieldSchema,
  Transport,
  StorageAdapter,
  DistinctValuesResult,
} from "@pythia-software/query-table-core";
import { useAggregations } from "./useAggregations";
import { useSelection, type SelectionApi } from "./useSelection";
import { useSelect, type SelectApi } from "./useSelect";
import { useColumnDrag, type ColumnDragApi } from "./useColumnDrag";
import { useSavedQueries, type SavedQueriesApi } from "./useSavedQueries";

export interface UseQueryTableOptions<Row> {
  schema: FieldSchema<Row>;
  /** Data access. Omit for a purely client-side table driven by `clientRows`. */
  transport?: Transport<Row>;
  /** All rows, for client-side mode (applyQuery runs locally over these). */
  clientRows?: Row[];
  /** Saved/last-query persistence. Defaults to a non-durable in-memory adapter.
   * Pass localStorageAdapter() explicitly only when filter values are safe to
   * retain as cleartext JSON on the device. */
  storage?: StorageAdapter;
  /** Seed query, normalized and resource-bounded before use. When omitted the
   * hook resolves: opted-in URL → storage.loadLast → schema defaults. */
  initialQuery?: QueryState;
  /** Mirror QueryState to `?q=` via history.replaceState. Default false because
   * base64url is encoding, not encryption: filters will appear in browser
   * history, referrers, logs, analytics, and screenshots when enabled. */
  syncUrl?: boolean;
  /** Debounce (ms) between a query change and the fetch it triggers. Default 200. */
  debounceMs?: number;
  /** Injected clock for deterministic saved-query timestamps. Default Date.now. */
  now?: () => number;
  /** Side-effect to run on every refresh — both manual `api.refresh()` and each
   *  auto-refresh tick. Fires *in addition to* the internal `setNonce` re-query,
   *  so manual and auto stay identical. Use it in client mode (no transport) to
   *  bridge a UI refresh to your own server fetch without monkey-patching the
   *  returned `api`. Always read through a ref, so supplying it never tears down
   *  and recreates the auto-refresh interval. */
  onRefresh?: () => void;
}

export interface AutoRefreshConfig {
  frequencyMs: number;
  turnOffAfterMs: number;
}

export interface AutoRefreshStatus extends AutoRefreshConfig {
  startedAt: number;
  stopsAt: number;
  pollCount: number;
}

export interface AutoRefreshApi {
  status: AutoRefreshStatus | null;
  start: (config: AutoRefreshConfig) => void;
  stop: () => void;
}

/** A patch for one metric. `field`/`label` accept an explicit `undefined` to
 *  CLEAR them (e.g. switching to an op whose measure no longer applies); an
 *  absent key leaves the existing value untouched. */
export interface AggregationPatch {
  op?: AggOp;
  field?: string | undefined;
  groupBy?: string[];
  label?: string | undefined;
}

export interface AggregationsApi {
  /** The metric specs currently in the query. */
  clauses: AggregationClause[];
  /** Server (or client-mirror) results, one entry per clause; null when none. */
  results: AggregationResult | null;
  loading: boolean;
  error: Error | null;
  /** Append a metric. Defaults to "count all rows"; pass a partial to override.
   *  Returns the generated id. */
  add: (partial?: Partial<Omit<AggregationClause, "id">>) => string;
  /** Patch a metric by id. */
  update: (id: string, patch: AggregationPatch) => void;
  /** Reorder: move the metric `id` to `toIndex` (an index in the list with the
   *  metric removed, so a drag preview's slot maps straight to the result). */
  move: (id: string, toIndex: number) => void;
  /** Remove a metric by id. */
  remove: (id: string) => void;
  /** Remove all metrics. */
  clear: () => void;
}

export interface QueryTableApi<Row> {
  // state
  query: QueryState;
  /** Schema defaults used for reset controls. */
  defaults: QueryState;
  setQuery: (next: QueryState | ((prev: QueryState) => QueryState)) => void;
  /** Can move back to a previously applied local query state. */
  canUndo: boolean;
  /** Can move forward to a previously undone local query state. */
  canRedo: boolean;
  /** Move backward through local, unsaved query history. */
  undo: () => void;
  /** Move forward through local, unsaved query history. */
  redo: () => void;

  // data
  rows: Row[];
  total: number | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  autoRefresh: AutoRefreshApi;
  refreshRow: (id: RowId) => Promise<void>;

  // aggregation metrics (the dashboard panel above the table)
  aggregations: AggregationsApi;

  // filters
  addFilter: (clause: WhereClause) => void;
  updateFilter: (index: number, clause: WhereClause) => void;
  removeFilter: (index: number) => void;
  clearFilters: () => void;
  /** Reset the complete query state back to schema defaults. */
  resetAll: () => void;
  /** Keystroke-driven filter-value autocomplete (Transport.fetchDistinctValues). */
  filterValues: (field: string, search: string) => Promise<DistinctValuesResult>;

  // sorting (multi-sort): click header sets/cycles primary; shift-click appends.
  toggleSort: (field: string, additive?: boolean) => void;
  setSort: (orderBy: OrderByClause[]) => void;

  // select + pagination + selection + saved
  select: SelectApi<Row>;
  setLimit: (limit: number) => void;
  setOffset: (offset: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  selection: SelectionApi;
  saved: SavedQueriesApi;
  /** Shared, transient column-reorder drag state (table headers + select chips). */
  columnDrag: ColumnDragApi;

  // resolved view
  visibleFields: FieldDef<Row>[];
  rowId: (row: Row) => RowId | null;
}

function defaultsFor<Row>(schema: FieldSchema<Row>): QueryState {
  return normalizeQueryState({
    select: schema.defaultSelect ?? [],
    where: [],
    orderBy: schema.defaultSort ?? [],
    limit: schema.defaultLimit ?? EMPTY_QUERY.limit,
    offset: 0,
  });
}

function cloneQueryState(q: QueryState): QueryState {
  const clone: QueryState = {
    select: q.select.map((column) => ({ ...column })),
    where: q.where.map((clause) => ({ ...clause })),
    orderBy: q.orderBy.map((term) => ({ ...term })),
    limit: q.limit,
    offset: q.offset,
  };
  if (q.aggregations) clone.aggregations = q.aggregations.map((a) => ({ ...a, groupBy: [...a.groupBy] }));
  return clone;
}

/** Apply a patch to a metric, building a fresh clause so optional `field`/`label`
 *  can be dropped (passing them as `undefined` clears; omitting the key keeps the
 *  current value) without ever materializing an `undefined`-valued property. */
function mergeAggregation(a: AggregationClause, patch: AggregationPatch): AggregationClause {
  const next: AggregationClause = {
    id: a.id,
    op: patch.op ?? a.op,
    groupBy: patch.groupBy ?? a.groupBy,
  };
  const field = "field" in patch ? patch.field : a.field;
  if (field) next.field = field;
  const label = "label" in patch ? patch.label : a.label;
  if (label) next.label = label;
  return next;
}

function isNullLike(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function asDistinctValue(value: unknown): string | null {
  if (isNullLike(value)) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function fieldHasNullInRows<Row>(field: FieldDef<Row>, rows: Row[]): boolean {
  for (const row of rows) {
    if (isNullLike(readFieldValue(field, row))) return true;
  }
  return false;
}

function distinctValuesFromRows<Row>(field: FieldDef<Row>, rows: Row[], search: string): { values: string[]; hasMore: boolean } {
  const target = search.trim().toLowerCase();
  const values: string[] = [];
  const seen = new Set<string>();
  let hasMore = false;

  for (const row of rows) {
    const raw = asDistinctValue(readFieldValue(field, row));
    if (raw == null || seen.has(raw)) continue;
    if (target && !raw.toLowerCase().includes(target)) continue;

    if (values.length < AUTOCOMPLETE_LIMIT) {
      seen.add(raw);
      values.push(raw);
      continue;
    }

    hasMore = true;
    break;
  }

  return { values: values.sort((a, b) => a.localeCompare(b)), hasMore };
}

function resolveInitial<Row>(opts: UseQueryTableOptions<Row>): { q: QueryState; fromUrl: boolean } {
  const defaults = defaultsFor(opts.schema);
  if (opts.initialQuery) return { q: normalizeQueryState(opts.initialQuery, defaults), fromUrl: false };
  if (opts.syncUrl === true && typeof window !== "undefined") {
    const token = new URLSearchParams(window.location.search).get("q");
    if (token) return { q: normalizeQueryState(decodeQuery(token), defaults), fromUrl: true };
  }
  return { q: defaults, fromUrl: false };
}

export function useQueryTable<Row>(opts: UseQueryTableOptions<Row>): QueryTableApi<Row> {
  const { schema, transport, clientRows, initialQuery, syncUrl = false, debounceMs = 200 } = opts;
  const storage = useMemo(() => opts.storage ?? memoryStorageAdapter(), [opts.storage]);
  const now = opts.now ?? Date.now;
  const nowRef = useRef(now);
  const onRefreshRef = useRef(opts.onRefresh);
  const defaults = useMemo(() => defaultsFor(schema), [schema]);
  const byName = useMemo(() => new Map(schema.fields.map((f) => [f.name, f])), [schema]);

  const initRef = useRef(resolveInitial(opts));
  const aggIdRef = useRef(0);
  const [query, setQueryState] = useState<QueryState>(initRef.current.q);
  const undoStack = useRef<QueryState[]>([cloneQueryState(initRef.current.q)]);
  const redoStack = useRef<QueryState[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const [autoRefreshStatus, setAutoRefreshStatus] = useState<AutoRefreshStatus | null>(null);

  useEffect(() => {
    nowRef.current = now;
  }, [now]);

  useEffect(() => {
    onRefreshRef.current = opts.onRefresh;
  }, [opts.onRefresh]);

  const setQuery = useCallback<QueryTableApi<Row>["setQuery"]>((next) => {
    setQueryState((prev) => {
      const candidate = typeof next === "function" ? (next as (p: QueryState) => QueryState)(prev) : next;
      const nextQuery = normalizeQueryState(candidate, defaults);
      if (queriesEqual(prev, nextQuery)) return prev;
      undoStack.current.push(cloneQueryState(prev));
      redoStack.current = [];
      return cloneQueryState(nextQuery);
    });
  }, [defaults]);

  // Restore the default saved query (preferred) or last query on mount when
  // nothing explicit seeded the view.
  useEffect(() => {
    if (initRef.current.fromUrl || initialQuery) return;
    let cancelled = false;
    void (async () => {
      const defaultSaved = await storage.loadDefaultSaved?.(schema.name);
      const restored = defaultSaved?.query ?? (await storage.loadLast(schema.name));
      if (!cancelled && restored) {
        const normalized = normalizeQueryState(restored, defaults);
        undoStack.current = [cloneQueryState(normalized)];
        redoStack.current = [];
        setQueryState(normalized);
      }
    })();
    return () => {
      cancelled = true;
    };
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch (debounced + abortable). Transport mode, or client-side applyQuery.
  const queryKey = useMemo(() => encodeQuery(query), [query]);
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        if (transport) {
          const res = await transport.fetchRows(toServerQuery(query, schema), ac.signal);
          if (!cancelled) {
            setRows(res.rows);
            setTotal(res.total);
          }
        } else {
          const res = applyQuery(clientRows ?? [], query, schema);
          if (!cancelled) {
            setRows(res.rows);
            setTotal(res.total);
          }
        }
      } catch (e) {
        if (!cancelled && !ac.signal.aborted) setError(e as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const t = setTimeout(run, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
      ac.abort();
    };
    // queryKey captures query value; clientRows/nonce force refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, transport, clientRows, schema, debounceMs, nonce]);

  // URL sync.
  useEffect(() => {
    if (!syncUrl || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const token = encodeQuery(query);
    if (token) url.searchParams.set("q", token);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url.toString());
  }, [queryKey, syncUrl, query]);

  // Persist last query (debounced).
  useEffect(() => {
    const t = setTimeout(() => void storage.saveLast(schema.name, query), 400);
    return () => clearTimeout(t);
  }, [queryKey, storage, schema.name, query]);

  // Resolved id accessor.
  const idField = useMemo(() => schema.fields.find((f) => f.name === schema.idField), [schema]);
  const rowId = useCallback(
    (row: Row): RowId | null => (idField ? (readFieldValue(idField, row) as RowId | null) : null),
    [idField],
  );

  // Sub-APIs.
  const displayedIds = useMemo(() => rows.map(rowId).filter((id): id is RowId => id != null), [rows, rowId]);
  const selection = useSelection(displayedIds);
  const select = useSelect(query, setQuery, schema);
  const columnDrag = useColumnDrag();
  const saved = useSavedQueries(
    schema.name,
    query,
    (q) => setQuery(q),
    storage,
    now,
  );
  const aggState = useAggregations(query, schema, transport, clientRows, debounceMs, nonce);

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  const undo = useCallback(() => {
    setQueryState((prev) => {
      const previous = undoStack.current.pop();
      if (!previous) return prev;
      redoStack.current.push(cloneQueryState(prev));
      return cloneQueryState(previous);
    });
  }, []);

  const redo = useCallback(() => {
    setQueryState((prev) => {
      const next = redoStack.current.pop();
      if (!next) return prev;
      undoStack.current.push(cloneQueryState(prev));
      return cloneQueryState(next);
    });
  }, []);

  // ---- intent helpers (keep offset/url/storage coherent) ----
  const patch = useCallback((p: Partial<QueryState>) => setQuery((prev) => ({ ...prev, ...p })), [setQuery]);

  const addFilter = useCallback((clause: WhereClause) => setQuery((q) => ({ ...q, offset: 0, where: [...q.where, clause] })), [setQuery]);
  const updateFilter = useCallback(
    (index: number, clause: WhereClause) =>
      setQuery((q) => ({ ...q, offset: 0, where: q.where.map((c, i) => (i === index ? clause : c)) })),
    [setQuery],
  );
  const removeFilter = useCallback(
    (index: number) => setQuery((q) => ({ ...q, offset: 0, where: q.where.filter((_, i) => i !== index) })),
    [setQuery],
  );
  const clearFilters = useCallback(() => setQuery((q) => ({ ...q, offset: 0, where: [] })), [setQuery]);
  const resetAll = useCallback(() => setQuery(() => cloneQueryState(defaults)), [setQuery, defaults]);

  // ---- aggregation metric mutators (don't touch paging — scope is the whole set) ----
  const addAggregation = useCallback<AggregationsApi["add"]>(
    (partial) => {
      const id = `a${nowRef.current()}-${aggIdRef.current++}`;
      const clause: AggregationClause = { id, op: "count", groupBy: [], ...partial };
      setQuery((q) => ({ ...q, aggregations: [...(q.aggregations ?? []), clause] }));
      return id;
    },
    [setQuery],
  );
  const updateAggregation = useCallback<AggregationsApi["update"]>(
    (id, patch) =>
      setQuery((q) => ({
        ...q,
        aggregations: (q.aggregations ?? []).map((a) => (a.id === id ? mergeAggregation(a, patch) : a)),
      })),
    [setQuery],
  );
  const moveAggregation = useCallback<AggregationsApi["move"]>(
    (id, toIndex) =>
      setQuery((q) => {
        const current = q.aggregations ?? [];
        const from = current.findIndex((a) => a.id === id);
        if (from === -1) return q;
        const next = [...current];
        const [item] = next.splice(from, 1);
        next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, item!);
        return { ...q, aggregations: next };
      }),
    [setQuery],
  );
  const removeAggregation = useCallback<AggregationsApi["remove"]>(
    (id) => setQuery((q) => ({ ...q, aggregations: (q.aggregations ?? []).filter((a) => a.id !== id) })),
    [setQuery],
  );
  const clearAggregations = useCallback<AggregationsApi["clear"]>(
    () => setQuery((q) => ({ ...q, aggregations: [] })),
    [setQuery],
  );

  const setSort = useCallback((orderBy: OrderByClause[]) => setQuery((q) => ({ ...q, offset: 0, orderBy })), [setQuery]);
  const toggleSort = useCallback(
    (field: string, additive = false) =>
      setQuery((q) => ({ ...q, offset: 0, orderBy: nextOrderBy(q.orderBy, field, additive) })),
    [setQuery],
  );

  const setLimit = useCallback((limit: number) => patch({ limit, offset: 0 }), [patch]);
  const setOffset = useCallback((offset: number) => patch({ offset }), [patch]);
  const nextPage = useCallback(() => setQuery((q) => ({ ...q, offset: q.offset + q.limit })), [setQuery]);
  const prevPage = useCallback(() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) })), [setQuery]);

  const filterValues = useCallback(
    async (field: string, search: string): Promise<DistinctValuesResult> => {
      if (!transport?.fetchDistinctValues) {
        const f = byName.get(field);
        if (!f || !clientRows) return { values: [], hasMore: false };

        const fieldHasNull = fieldHasNullInRows(f, clientRows);
        const matches = distinctValuesFromRows(f, clientRows, search);

        return {
          values: matches.values,
          hasMore: matches.hasMore,
          hasNull: fieldHasNull,
        };
      }
      return transport.fetchDistinctValues({ field, search });
    },
    [transport, byName, clientRows],
  );

  // Single refresh seam: re-runs the internal query (setNonce) and fires the
  // consumer's onRefresh, if any. Both the manual `api.refresh()` and every
  // auto-refresh tick go through here, so they stay observably identical. Read
  // onRefresh through a ref to keep this callback (and the interval that depends
  // on it) stable across renders.
  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
    onRefreshRef.current?.();
  }, []);
  const stopAutoRefresh = useCallback(() => setAutoRefreshStatus(null), []);
  const startAutoRefresh = useCallback(
    ({ frequencyMs, turnOffAfterMs }: AutoRefreshConfig) => {
      const pollCount = frequencyMs > 0 && turnOffAfterMs > 0 ? Math.floor(turnOffAfterMs / frequencyMs) : 0;
      if (pollCount < 1 || pollCount > MAX_AUTO_REFRESH_POLLS) {
        throw new Error("Auto-refresh must schedule between 1 and 1000 polls.");
      }

      const startedAt = nowRef.current();
      refresh();
      setAutoRefreshStatus({
        frequencyMs,
        turnOffAfterMs,
        startedAt,
        stopsAt: startedAt + turnOffAfterMs,
        pollCount: 1,
      });
    },
    [refresh],
  );

  const autoRefreshFrequencyMs = autoRefreshStatus?.frequencyMs ?? null;
  const autoRefreshStopsAt = autoRefreshStatus?.stopsAt ?? null;

  useEffect(() => {
    if (autoRefreshFrequencyMs == null || autoRefreshStopsAt == null) return;

    const tick = () => {
      if (nowRef.current() >= autoRefreshStopsAt) {
        setAutoRefreshStatus((current) => (current?.stopsAt === autoRefreshStopsAt ? null : current));
        return;
      }

      refresh();
      setAutoRefreshStatus((current) => {
        if (!current) return current;
        if (current.stopsAt !== autoRefreshStopsAt) return current;
        return { ...current, pollCount: current.pollCount + 1 };
      });
    };

    const interval = setInterval(tick, autoRefreshFrequencyMs);
    const timeout = setTimeout(
      () => setAutoRefreshStatus((current) => (current?.stopsAt === autoRefreshStopsAt ? null : current)),
      Math.max(0, autoRefreshStopsAt - nowRef.current()),
    );

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [autoRefreshFrequencyMs, autoRefreshStopsAt, refresh]);

  const autoRefresh = useMemo<AutoRefreshApi>(
    () => ({
      status: autoRefreshStatus,
      start: startAutoRefresh,
      stop: stopAutoRefresh,
    }),
    [autoRefreshStatus, startAutoRefresh, stopAutoRefresh],
  );

  const refreshRow = useCallback(
    async (id: RowId) => {
      if (!transport?.fetchRow) return;
      const updated = await transport.fetchRow(id);
      setRows((prev) => prev.map((r) => (rowId(r) === id ? updated ?? r : r)));
    },
    [transport, rowId],
  );

  const visibleFields = useMemo(() => selectedFields(schema, query), [schema, query]);

  const aggregations = useMemo<AggregationsApi>(
    () => ({
      clauses: query.aggregations ?? [],
      results: aggState.results,
      loading: aggState.loading,
      error: aggState.error,
      add: addAggregation,
      update: updateAggregation,
      move: moveAggregation,
      remove: removeAggregation,
      clear: clearAggregations,
    }),
    [
      query.aggregations,
      aggState.results,
      aggState.loading,
      aggState.error,
      addAggregation,
      updateAggregation,
      moveAggregation,
      removeAggregation,
      clearAggregations,
    ],
  );

  return {
    query,
    defaults,
    setQuery,
    rows,
    total,
    loading,
    error,
    canUndo,
    canRedo,
    undo,
    redo,
    refresh,
    autoRefresh,
    refreshRow,
    aggregations,
    addFilter,
    updateFilter,
    removeFilter,
    clearFilters,
    resetAll,
    filterValues,
    toggleSort,
    setSort,
    select,
    setLimit,
    setOffset,
    nextPage,
    prevPage,
    selection,
    saved,
    columnDrag,
    visibleFields,
    rowId,
  };
}

/** Multi-sort header click logic.
 *   - plain click on the sole sorted column → flip its direction
 *   - plain click on another column → make it the only sort (desc)
 *   - shift-click a new column → append it (desc) as a secondary term
 *   - shift-click an existing term → cycle desc → asc → remove */
function nextOrderBy(existing: OrderByClause[], field: string, additive: boolean): OrderByClause[] {
  const i = existing.findIndex((s) => s.field === field);
  if (!additive) {
    if (i === 0 && existing.length === 1) {
      const flipped: "asc" | "desc" = existing[0]!.dir === "desc" ? "asc" : "desc";
      return [{ field, dir: flipped }];
    }
    return [{ field, dir: "desc" }];
  }
  if (i === -1) return [...existing, { field, dir: "desc" }];
  const cur = existing[i]!;
  if (cur.dir === "desc") {
    const next = [...existing];
    next[i] = { field, dir: "asc" };
    return next;
  }
  return existing.filter((_, k) => k !== i); // asc → remove
}
