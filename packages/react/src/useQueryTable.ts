// useQueryTable — the one hook that owns everything.
//
// The headless brain of the table: it holds the QueryState, keeps it in sync
// with the URL (`?q=`) and the StorageAdapter, orchestrates fetches through the
// Transport (debounced + abortable), and exposes intent-level mutators so a UI
// never hand-edits QueryState. @query-table/ui is a thin layer over this; you
// can also build an entirely custom table on it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_QUERY,
  applyQuery,
  decodeQuery,
  encodeQuery,
  localStorageAdapter,
  readFieldValue,
  selectedFields,
  toServerQuery,
} from "@query-table/core";
import type {
  QueryState,
  WhereClause,
  OrderByClause,
  RowId,
  FieldDef,
  FieldSchema,
  Transport,
  StorageAdapter,
  DistinctValuesResult,
} from "@query-table/core";
import { useSelection, type SelectionApi } from "./useSelection";
import { useSelect, type SelectApi } from "./useSelect";
import { useSavedQueries, type SavedQueriesApi } from "./useSavedQueries";

export interface UseQueryTableOptions<Row> {
  schema: FieldSchema<Row>;
  /** Data access. Omit for a purely client-side table driven by `clientRows`. */
  transport?: Transport<Row>;
  /** All rows, for client-side mode (applyQuery runs locally over these). */
  clientRows?: Row[];
  /** Saved/last-query persistence. Defaults to localStorageAdapter(). */
  storage?: StorageAdapter;
  /** Seed query — typically the server-decoded `?q=` for SSR/first paint. When
   *  omitted the hook resolves: URL → storage.loadLast → schema defaults. */
  initialQuery?: QueryState;
  /** Mirror QueryState to `?q=` via history.replaceState. Default true. */
  syncUrl?: boolean;
  /** Debounce (ms) between a query change and the fetch it triggers. Default 200. */
  debounceMs?: number;
  /** Injected clock for deterministic saved-query timestamps. Default Date.now. */
  now?: () => number;
}

export interface QueryTableApi<Row> {
  // state
  query: QueryState;
  /** Schema defaults used for reset controls. */
  defaults: QueryState;
  setQuery: (next: QueryState | ((prev: QueryState) => QueryState)) => void;

  // data
  rows: Row[];
  total: number | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  refreshRow: (id: RowId) => Promise<void>;

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

  // resolved view
  visibleFields: FieldDef<Row>[];
  rowId: (row: Row) => RowId | null;
}

function defaultsFor<Row>(schema: FieldSchema<Row>): QueryState {
  return {
    select: schema.defaultSelect ?? [],
    where: [],
    orderBy: schema.defaultSort ?? [],
    limit: schema.defaultLimit ?? EMPTY_QUERY.limit,
    offset: 0,
  };
}

function cloneQueryState(q: QueryState): QueryState {
  return {
    select: q.select.map((column) => ({ ...column })),
    where: q.where.map((clause) => ({ ...clause })),
    orderBy: q.orderBy.map((term) => ({ ...term })),
    limit: q.limit,
    offset: q.offset,
  };
}

function resolveInitial<Row>(opts: UseQueryTableOptions<Row>): { q: QueryState; fromUrl: boolean } {
  if (opts.initialQuery) return { q: opts.initialQuery, fromUrl: false };
  if (typeof window !== "undefined") {
    const token = new URLSearchParams(window.location.search).get("q");
    if (token) return { q: decodeQuery(token), fromUrl: true };
  }
  return { q: defaultsFor(opts.schema), fromUrl: false };
}

export function useQueryTable<Row>(opts: UseQueryTableOptions<Row>): QueryTableApi<Row> {
  const { schema, transport, clientRows, initialQuery, syncUrl = true, debounceMs = 200 } = opts;
  const storage = useMemo(() => opts.storage ?? localStorageAdapter(), [opts.storage]);
  const now = opts.now ?? Date.now;
  const defaults = useMemo(() => defaultsFor(schema), [schema]);

  const initRef = useRef(resolveInitial(opts));
  const [query, setQueryState] = useState<QueryState>(initRef.current.q);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const setQuery = useCallback<QueryTableApi<Row>["setQuery"]>((next) => {
    setQueryState((prev) => (typeof next === "function" ? (next as (p: QueryState) => QueryState)(prev) : next));
  }, []);

  // Restore the last query on mount when nothing seeded the view.
  useEffect(() => {
    if (initRef.current.fromUrl || initialQuery) return;
    let cancelled = false;
    void storage.loadLast(schema.name).then((last) => {
      if (!cancelled && last) setQueryState(last);
    });
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
  const saved = useSavedQueries(
    schema.name,
    query,
    (q) => setQueryState(q),
    storage,
    now,
  );

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

  const setSort = useCallback((orderBy: OrderByClause[]) => setQuery((q) => ({ ...q, offset: 0, orderBy })), [setQuery]);
  const toggleSort = useCallback(
    (field: string, additive = false) =>
      setQuery((q) => ({ ...q, offset: 0, orderBy: nextOrderBy(q.orderBy, field, additive) })),
    [setQuery],
  );

  const setLimit = useCallback((limit: number) => patch({ limit: Math.max(1, Math.round(limit)), offset: 0 }), [patch]);
  const setOffset = useCallback((offset: number) => patch({ offset: Math.max(0, Math.round(offset)) }), [patch]);
  const nextPage = useCallback(() => setQuery((q) => ({ ...q, offset: q.offset + q.limit })), [setQuery]);
  const prevPage = useCallback(() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) })), [setQuery]);

  const filterValues = useCallback(
    async (field: string, search: string): Promise<DistinctValuesResult> => {
      if (!transport?.fetchDistinctValues) return { values: [], hasMore: false };
      return transport.fetchDistinctValues({ field, search });
    },
    [transport],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const refreshRow = useCallback(
    async (id: RowId) => {
      if (!transport?.fetchRow) return;
      const updated = await transport.fetchRow(id);
      setRows((prev) => prev.map((r) => (rowId(r) === id ? updated ?? r : r)));
    },
    [transport, rowId],
  );

  const visibleFields = useMemo(() => selectedFields(schema, query), [schema, query]);

  return {
    query,
    defaults,
    setQuery,
    rows,
    total,
    loading,
    error,
    refresh,
    refreshRow,
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
