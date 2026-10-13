import { useQueryFilters } from "./useQueryFilters";
import { useGroupingController, type GroupingApi, type GroupingSourceApi } from "./useGrouping";
import { createGroupingModel, prepareGrouping, withoutGrouping } from "@pythia-software/query-table-core";
import { ITEM_DETAILS_COLUMN, itemPageFields } from "@pythia-software/query-table-core";
import { useItemDetails, initialDetailModes, type ItemDetailsApi, type ItemDetailsOptions } from "./useItemDetails";
// useQueryTable — the one hook that owns everything.
//
// The headless brain of the table: it holds the QueryState, keeps it in sync
// with the URL (`?q=`) and the StorageAdapter, orchestrates fetches through the
// Transport (debounced + abortable), and exposes intent-level mutators so a UI
// never hand-edits QueryState. @pythia-software/query-table-ui is a thin layer over this; you
// can also build an entirely custom table on it.

import {
  executionRevision,
  validateComputedResponse,
} from "./computedExecution";
import {
  useComputedColumns,
  type ComputedColumnsApi,
} from "./useComputedColumns";
import type { FormulaWorkerFactory } from "./formulaWorker";
import type {
  ComputedColumnStore,
  ComputedExecution,
  RowComputedValues,
} from "@pythia-software/query-table-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_QUERY,
  applyQuery,
  memoryStorageAdapter,
  normalizeQueryState,
  readFieldValue,
  selectedFields,
  toServerQuery,
  queriesEqual,
  isOrGroup,
  predicatesOf,
  negateClause,
  opsForField,
  metricPlans,
  validateMetric,
  metricDependencies,
  isComputedField,
  computedFieldName,
  toServerQueryV2,
} from "@pythia-software/query-table-core";

const AUTOCOMPLETE_LIMIT = 50;
const MAX_AUTO_REFRESH_POLLS = 1000;
import type {
  QueryState,
  WhereClause,
  WhereTerm,
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
  FieldStats,
} from "@pythia-software/query-table-core";
import {
  useRequestActivity,
  type RequestActivityApi,
} from "./useRequestActivity";
import { useAggregations } from "./useAggregations";
import { useSelection, type SelectionApi } from "./useSelection";
import { useSelect, type SelectApi } from "./useSelect";
import { useColumnDrag, type ColumnDragApi } from "./useColumnDrag";
import { useSavedQueries, type SavedQueriesApi } from "./useSavedQueries";
import { useQueryLinks, type QueryLinksApi } from "./useQueryLinks";
import { createQueryLinkService, type QueryLinkOptions } from "@pythia-software/query-table-core";

export interface UseQueryTableOptions<Row> {
  /** Normalize external aliases without storing presentation in query state. Must be pure and not throw. */
  canonicalizeQuery?: (query: QueryState) => QueryState;
  /** Reject an entire query before rows or metrics execute. Errors retain editable query state. */
  validateQuery?: (query: QueryState) => void;

  /** Disable row-producing grouping for this instance. Enabled for complete client datasets by default. */
  grouping?: boolean;
  schema: FieldSchema<Row>;
  /** Data access. Omit for a purely client-side table driven by `clientRows`. */
  transport?: Transport<Row>;
  /** All rows, for client-side mode (applyQuery runs locally over these). */
  clientRows?: Row[];
  /** Saved/last-query persistence. Defaults to a non-durable in-memory adapter.
   * Pass localStorageAdapter() explicitly only when filter values are safe to
   * retain as cleartext JSON on the device. */
  storage?: StorageAdapter;
  /** Shared reusable definitions, independent of saved-query storage. */
  computedColumnStore?: ComputedColumnStore;
  /** Authoritative host handshake for versioned server SELECT, sorts, and metrics. */
  computedExecution?: ComputedExecution;
  /** Override the worker factory when CSP disallows blob workers. */
  formulaWorkerFactory?: FormulaWorkerFactory;
  /** Seed query, normalized and resource-bounded before use. When omitted the
   * hook resolves: opted-in URL → storage.loadLast → schema defaults. */
  initialQuery?: QueryState;
  /** Mirror QueryState to `?q=` via history.replaceState. Default false because
   * base64url is encoding, not encryption: filters will appear in browser
   * history, referrers, logs, analytics, and screenshots when enabled. */
  syncUrl?: boolean;
  /** URL budget and browser-local FIFO cache; remote snapshots come from storage.snapshots. */
  links?: QueryLinkOptions;
  /** Enable schema-driven click popovers, item modals and row expansion. */
  itemDetails?: boolean | ItemDetailsOptions<Row>;
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
export type AggregationPatch = { op?: AggOp; groupBy?: string[] } & {
  [K in keyof Omit<AggregationClause, "id" | "op" | "groupBy">]?:
    AggregationClause[K] | undefined;
};

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
  /** Evaluate a draft without modifying the query. */
  preview?: (
    clauses: AggregationClause[],
    signal?: AbortSignal,
  ) => Promise<AggregationResult>;
  /** Commit the complete draft as one undoable change. */
  replace?: (
    clauses: AggregationClause[],
    expected?: AggregationClause[],
  ) => void;
  /** Validate a clause, including reusable computed dependencies. */
  compile?: (clause: AggregationClause) => unknown;
  /** Invalidation token for page, refresh, schema, and definition changes. */
  contextKey?: string;
}

export interface QueryTableApi<Row> {
  /** Row-producing GROUP BY controls and source stage, when supported. */
  grouping?: GroupingApi<Row>;
  /** Current result schema; changes when entering or leaving grouping. */
  schema?: FieldSchema<Row>;
  links: QueryLinksApi;
  /** Built-in item details, enabled by the instance creator. */
  itemDetails?: ItemDetailsApi<Row>;
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

  requestActivity: RequestActivityApi;

  // data
  rows: Row[];
  total: number | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  autoRefresh: AutoRefreshApi;
  /** Refresh one legacy row, or schedule a full V2 page refresh so computed
   * values and page membership remain coherent. Track V2 completion via loading/error. */
  refreshRow: (id: RowId) => Promise<void>;

  // aggregation metrics (the dashboard panel above the table)
  aggregations: AggregationsApi;

  // filters — WHERE is CNF: `query.where` is an array of terms (a literal or an
  // OR group), ANDed together. The top-level intents address a whole term by
  // index; the predicate-level intents address one literal within a term.
  /** Append a predicate as its own AND term. */
  addFilter: (clause: WhereClause) => void;
  /** Replace the whole term at `index` with a single predicate. */
  updateFilter: (index: number, clause: WhereClause) => void;
  /** Remove the whole term at `index`. */
  removeFilter: (index: number) => void;
  clearFilters: () => void;
  /** Replace one predicate inside a term (predIndex 0 for a literal term). */
  updatePredicate: (
    termIndex: number,
    predIndex: number,
    clause: WhereClause,
  ) => void;
  /** Remove one predicate; a group of one flattens to a literal, an emptied term drops. */
  removePredicate: (termIndex: number, predIndex: number) => void;
  /** Logically invert one predicate (flips the op, else toggles its NOT flag). */
  negatePredicate: (termIndex: number, predIndex: number) => void;
  /** Move the term at `fromIndex` to `toIndex` (an index in the list with the
   *  dragged term removed, so a drag preview's slot maps straight to the result). */
  reorderFilters: (fromIndex: number, toIndex: number) => void;
  /** OR-merge the term at `sourceIndex` into the term at `targetIndex`: the
   *  target becomes (or stays) an OR group holding both terms' predicates, and
   *  the source term is removed. This is the drag-onto-another-filter gesture. */
  mergeFilters: (sourceIndex: number, targetIndex: number) => void;
  /** Reset the complete query state back to schema defaults. */
  resetAll: () => void;
  /** Keystroke-driven filter-value autocomplete (Transport.fetchDistinctValues). */
  filterValues: (
    field: string,
    search: string,
  ) => Promise<DistinctValuesResult>;
  /** Dataset-wide field statistics for catalogue and picker affordances. */
  fieldStats: (
    fields: string[],
    signal?: AbortSignal,
  ) => Promise<Record<string, FieldStats>>;

  // sorting (multi-sort): click header sets/cycles primary; shift-click appends.
  toggleSort: (field: string, additive?: boolean) => void;
  setSort: (orderBy: OrderByClause[]) => void;

  // select + pagination + selection + saved
  select: SelectApi<Row>;
  computed: ComputedColumnsApi<Row>;
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

function detailColumnSchema<Row>(schema: FieldSchema<Row>, enabled: boolean): FieldSchema<Row> {
  if (!enabled) return schema;
  return { ...schema,
    defaultSelect: [...(schema.defaultSelect ?? selectedFields(schema, { select: [] }).map(field => ({ field: field.name }))), { field: ITEM_DETAILS_COLUMN }],
    fields: [...schema.fields, { name: ITEM_DETAILS_COLUMN, label: "Detail", type: "text",
      source: { kind: "derived", accessor: () => null }, select: { default: true, width: 112 },
      filter: { enabled: false }, sort: { enabled: false }, aggregate: { measure: false, groupable: false },
      property: { enabled: false },
    }],
  };
}
function defaultsFor<Row>(schema: FieldSchema<Row>, details = false): QueryState {
  schema = detailColumnSchema(schema, details);
  return normalizeQueryState({
    select: schema.defaultSelect ?? [],
    where: [],
    orderBy: schema.defaultSort ?? [],
    limit: schema.defaultLimit ?? EMPTY_QUERY.limit,
    offset: 0,
  });
}

function cloneWhereTerm(term: WhereTerm): WhereTerm {
  const copy = isOrGroup(term)
    ? { ...term, any: term.any.map((c) => ({ ...c })) }
    : { ...term };
  if (term.setFilter)
    copy.setFilter = { ...term.setFilter, values: [...term.setFilter.values] };
  return copy;
}

function cloneQueryState(q: QueryState): QueryState {
  const clone: QueryState = {
    select: q.select.map((column) => ({ ...column })),
    where: q.where.map(cloneWhereTerm),
    orderBy: q.orderBy.map((term) =>
      term.extract ? { ...term, extract: { ...term.extract } } : { ...term },
    ),
    limit: q.limit,
    offset: q.offset,
  };
  if (q.fitToScreen) clone.fitToScreen = true;
  if (q.aggregations)
    clone.aggregations = JSON.parse(
      JSON.stringify(q.aggregations),
    ) as AggregationClause[];
  if (q.grouping) clone.grouping = normalizeQueryState(q).grouping!;
  if (q.itemDetails) clone.itemDetails = JSON.parse(JSON.stringify(q.itemDetails)) as NonNullable<QueryState["itemDetails"]>;
  return clone;
}

/** Apply a patch to a metric, building a fresh clause so optional `field`/`label`
 *  can be dropped (passing them as `undefined` clears; omitting the key keeps the
 *  current value) without ever materializing an `undefined`-valued property. */
function mergeAggregation(
  a: AggregationClause,
  patch: AggregationPatch,
): AggregationClause {
  const next = { ...a, ...patch } as AggregationClause;
  for (const key of Object.keys(next) as Array<keyof AggregationClause>) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

function isNullLike(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function asDistinctValue(value: unknown): string | null {
  if (isNullLike(value)) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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

function distinctValuesFromRows<Row>(
  field: FieldDef<Row>,
  rows: Row[],
  search: string,
): { values: string[]; hasMore: boolean } {
  const target = search.trim().toLowerCase();
  const values: string[] = [];
  const seen = new Set<string>();
  let hasMore = false;

  rowsLoop: for (const row of rows) {
    const value = readFieldValue(field, row);
    const candidates =
      field.type === "textarray" && Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const raw = asDistinctValue(candidate);
      if (raw == null || seen.has(raw)) continue;
      if (target && !raw.toLowerCase().includes(target)) continue;

      if (values.length < AUTOCOMPLETE_LIMIT) {
        seen.add(raw);
        values.push(raw);
        continue;
      }

      hasMore = true;
      break rowsLoop;
    }
  }

  return { values: values.sort((a, b) => a.localeCompare(b)), hasMore };
}

function hasQueryLink(url: string, parameter: string): boolean {
  const values = new URL(url).searchParams.getAll(parameter);
  return values.length > 1 || (values.length === 1 && values[0] !== "");
}

function resolveInitial<Row>(opts: UseQueryTableOptions<Row>): {
  q: QueryState;
  fromUrl: boolean;
} {
  const defaults = defaultsFor(opts.schema, Boolean(opts.itemDetails));
  if (opts.initialQuery)
    return {
      q: normalizeQueryState(opts.initialQuery, defaults),
      fromUrl: false,
    };
  if (opts.syncUrl === true && typeof window !== "undefined") {
    const parameter = typeof opts.itemDetails === "object" ? opts.itemDetails.queryParameter ?? "q" : "q";
    if (hasQueryLink(window.location.href, parameter))
      return {
        q: defaults,
        fromUrl: true,
      };
  }
  return { q: defaults, fromUrl: false };
}

export function useQueryTable<Row>(
  opts: UseQueryTableOptions<Row>,
): QueryTableApi<Row> {
  const {
    schema: sourceSchema,
    transport: sourceTransport,
    clientRows: sourceRows,
    initialQuery,
    syncUrl = false,
    debounceMs = 200,
  } = opts;
  const { transport, activity: requestActivity } =
    useRequestActivity(sourceTransport);
  const storage = useMemo(
    () => opts.storage ?? memoryStorageAdapter(),
    [opts.storage],
  );
  const parameter = typeof opts.itemDetails === "object" ? opts.itemDetails.queryParameter ?? "q" : "q";
  const linkService = useMemo(() => createQueryLinkService(sourceSchema.name, storage.snapshots, opts.links),
    [sourceSchema.name, storage.snapshots, opts.links?.cache, opts.links?.maxUrlBytes]);
  const now = opts.now ?? Date.now;
  const nowRef = useRef(now);
  const onRefreshRef = useRef(opts.onRefresh);
  const defaults = useMemo(() => defaultsFor(sourceSchema, Boolean(opts.itemDetails)), [sourceSchema, Boolean(opts.itemDetails)]);

  const initRef = useRef(resolveInitial(opts));
  const [restoration, setRestoration] = useState<{ loading: boolean; error: Error | null }>({ loading: initRef.current.fromUrl, error: null });
  const [storageReady, setStorageReady] = useState(Boolean(initialQuery));
  const manualQueryEpoch = useRef(0);
  const aggIdRef = useRef(0);
  // A null baseline follows current host defaults. Explicit views keep their
  // snapshot, scoped to the source so reset cannot restore another table.
  const savedBaseline = useRef<{ source: string; query: QueryState } | null>(
    initRef.current.q.grouping
      ? { source: sourceSchema.name, query: cloneQueryState(initRef.current.q) }
      : null,
  );
  const viewRevision = useRef(0);
  const [queryHistory, setQueryHistory] = useState<{ query: QueryState; past: QueryState[]; future: QueryState[] }>(
    () => ({ query: initRef.current.q, past: [], future: [] }),
  );
  const storedQuery = queryHistory.query;
  const [nonce, setNonce] = useState(0);
  const query = useMemo(
    () => opts.canonicalizeQuery?.(storedQuery) ?? storedQuery,
    [storedQuery, opts.canonicalizeQuery],
  );
  const groupingModel = useMemo(() => createGroupingModel(sourceSchema), [sourceSchema]);
  const groupingSupported = !sourceTransport && sourceRows !== undefined && opts.grouping !== false;
  const groupKey = JSON.stringify(query.grouping ?? null);
  // Capture the grouped evaluation clock with its population. Debounced rows,
  // metric previews and committed metrics must use the same relative bounds.
  const groupingNow = useMemo(() => query.grouping ? Date.now() : undefined,
    [sourceRows, sourceSchema, groupingSupported, groupKey, nonce]);
  const prepared = useMemo(() => {
    if (!query.grouping) return null;
    try {
      if (!groupingSupported) throw new Error("Row grouping requires complete client rows; this table's data source does not support grouped queries.");
      return { ...prepareGrouping(sourceRows!, sourceSchema, query.grouping, { now: groupingNow! }), error: null };
    } catch (error) {
      return { inputs: [] as Row[], rows: [], error: error as Error };
    }
  }, [sourceRows, sourceSchema, groupingModel, groupingSupported, groupKey, nonce, groupingNow]);
  // Result fields depend on the projection, not the current population. Keep
  // their identity across refresh/WHERE changes so committed rows stay visible
  // during debounce, while real shape changes still invalidate them below.
  const projectionKey = JSON.stringify(query.grouping
    ? [query.grouping.keys, query.grouping.summaries] : null);
  const schema = useMemo(() => (query.grouping
    ? groupingModel.resultSchema(query.grouping.keys, query.grouping.summaries)
    : sourceSchema) as FieldSchema<Row>, [sourceSchema, groupingModel, projectionKey]);
  const clientRows = (prepared?.rows ?? sourceRows) as Row[] | undefined;
  const executionQuery = useMemo(() => withoutGrouping(query), [query]);
  const byName = useMemo(() => new Map(schema.fields.map(field => [field.name, field])), [schema]);
  const detailsEnabled = Boolean(opts.itemDetails) && !query.grouping;
  const validateExecution = useCallback((q: QueryState) => {
    if (prepared?.error) throw prepared.error;
    // Previews carry draft metrics in q. Reattach the source stage without
    // replacing those drafts with the currently committed dashboard.
    opts.validateQuery?.(query.grouping ? { ...q, grouping: query.grouping } : q);
  }, [prepared?.error, opts.validateQuery, query.grouping]);
  const [committedRows, setRows] = useState<Row[]>([]);
  const [serverComputed, setServerComputed] = useState<
    Map<RowId, RowComputedValues>
  >(new Map());
  const [committedFields, setCommittedFields] = useState<string[]>([]);
  const [serverExecution, setServerExecution] = useState<
    ComputedExecution | undefined
  >();
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [committedPage, setCommittedPage] = useState<string | null>(null);
  const [committedSource, setCommittedSource] = useState<{
    schema: FieldSchema<Row>;
    transport: Transport<Row> | undefined;
    clientRows: Row[] | undefined;
  } | null>(null);
  // A schema transition changes row shape and identity. Never render records
  // from the previous result shape while the next page is being prepared.
  const rows = useMemo(() => committedSource?.schema === schema ? committedRows : [], [committedSource?.schema, schema, committedRows]);
  const [autoRefreshStatus, setAutoRefreshStatus] =
    useState<AutoRefreshStatus | null>(null);

  useEffect(() => {
    nowRef.current = now;
  }, [now]);

  useEffect(() => {
    onRefreshRef.current = opts.onRefresh;
  }, [opts.onRefresh]);

  const setQuery = useCallback<QueryTableApi<Row>["setQuery"]>(
    (next) => {
      manualQueryEpoch.current++;
      setStorageReady(true);
      setRestoration(previous => !previous.loading && !previous.error ? previous : { loading: false, error: null });
      setQueryHistory((history) => {
        const prev = history.query;
        const candidate =
          typeof next === "function"
            ? (next as (p: QueryState) => QueryState)(prev)
            : next;
        const nextQuery = normalizeQueryState(candidate, defaults);
        if (queriesEqual(prev, nextQuery)) return history;
        return { query: cloneQueryState(nextQuery), past: [...history.past, cloneQueryState(prev)], future: [] };
      });
    },
    [defaults],
  );

  const sourceQuery = query.grouping?.source ?? query;
  const setSourceQuery = useCallback<QueryTableApi<Row>["setQuery"]>((next) => {
    setQuery(current => {
      const previous = current.grouping?.source ?? current;
      const source = withoutGrouping(typeof next === "function" ? next(previous) : next);
      return current.grouping ? { ...current, offset: 0, grouping: { ...current.grouping, source } } : source;
    });
  }, [setQuery]);
  const sourceFilters = useQueryFilters(sourceSchema, setSourceQuery);

  // Track only this table's URL parameter, including duplicates. Host routes,
  // anchors and unrelated history.state changes do not restore table state.
  const observedQueryUrl = useRef<string | null>(null);
  const recordQueryUrl = useCallback((url: string) => {
    observedQueryUrl.current = JSON.stringify(new URL(url).searchParams.getAll(parameter));
  }, [parameter]);
  const links = useQueryLinks(query, linkService, syncUrl, storageReady && !restoration.loading && !restoration.error,
    parameter, opts.links?.maxUrlBytes ?? 2000, recordQueryUrl);
  const restoreSources = useRef({ storage, linkService, defaults, initialQuery });
  restoreSources.current = { storage, linkService, defaults, initialQuery };

  // Resolve URL references before rows, metrics, persistence, or address-bar writes.
  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();
    let generation = 0;
    async function restore(navigation = false) {
      const { storage, linkService, defaults } = restoreSources.current;
      const run = ++generation;
      const epoch = manualQueryEpoch.current;
      controller.abort(); controller = new AbortController();
      setStorageReady(false);
      const explicitLink = syncUrl && typeof window !== "undefined" && hasQueryLink(window.location.href, parameter);
      if (navigation || explicitLink)
        setRestoration({ loading: true, error: null });
      try {
        const fromUrl = syncUrl && typeof window !== "undefined" ? await linkService.resolve(window.location.href, parameter, controller.signal) : null;
        const defaultSaved = fromUrl ? null : await storage.loadDefaultSaved?.(sourceSchema.name);
        const restored = fromUrl ?? defaultSaved?.query ?? (navigation ? defaults : await storage.loadLast(sourceSchema.name));
        if (!cancelled && run === generation && epoch === manualQueryEpoch.current) {
          if (restored) {
            const normalized = normalizeQueryState(restored, defaults);
            savedBaseline.current = defaultSaved || fromUrl?.grouping
              ? { source: sourceSchema.name, query: cloneQueryState(normalized) }
              : null;
            viewRevision.current++;
            setQueryHistory({ query: normalized, past: [], future: [] });
          }
          setStorageReady(true);
          setRestoration(previous => !previous.loading && !previous.error ? previous : { loading: false, error: null });
        }
      } catch (e) {
        if (!cancelled && run === generation && epoch === manualQueryEpoch.current) {
          if (explicitLink) {
            setRestoration({ loading: false, error: e instanceof Error ? e : Error(String(e)) });
          } else {
            // Last/default saved queries are optional restoration sources.
            // A failed host read should still leave a usable default table.
            setQueryHistory({ query: defaults, past: [], future: [] });
            setRestoration({ loading: false, error: null });
          }
          setStorageReady(true);
        }
      }
    }
    if (typeof window !== "undefined") recordQueryUrl(window.location.href);
    if (!restoreSources.current.initialQuery) void restore();
    const navigate = () => {
      const key = JSON.stringify(new URL(window.location.href).searchParams.getAll(parameter));
      if (key === observedQueryUrl.current) return;
      observedQueryUrl.current = key;
      void restore(true);
    };
    if (syncUrl && typeof window !== "undefined") window.addEventListener("popstate", navigate);
    return () => {
      cancelled = true; controller.abort();
      if (syncUrl && typeof window !== "undefined") window.removeEventListener("popstate", navigate);
    };
  }, [sourceSchema.name, syncUrl, parameter, recordQueryUrl]);

  const { api: computed, displaySchema } = useComputedColumns({
    schema,
    query: executionQuery,
    rows,
    serverComputed,
    ...(serverExecution ? { serverExecution } : {}),
    ...(opts.computedExecution ? { execution: opts.computedExecution } : {}),
    ...(opts.computedColumnStore ? { store: opts.computedColumnStore } : {}),
    ...(opts.formulaWorkerFactory
      ? { workerFactory: opts.formulaWorkerFactory }
      : {}),
    ...(transport ? { transport } : {}),
    ...(clientRows ? { clientRows } : {}),
  });

  const resolveComputed = useCallback(
    (name: string) =>
      isComputedField(name)
        ? computed.compile(`[${name.replace(/]/g, "]] ".trim())}]`)
        : undefined,
    [computed.compile],
  );
  const metricCompile = useCallback(
    (clause: AggregationClause) => {
      const diagnostics = validateMetric(
        clause,
        displaySchema,
        resolveComputed,
      );
      if (diagnostics.length)
        throw new Error(diagnostics.map((d) => d.message).join(" "));
      return metricPlans(clause, displaySchema, resolveComputed);
    },
    [displaySchema, resolveComputed],
  );
  const computedRevisions = useMemo(
    () =>
      Object.fromEntries(computed.definitions.map((d) => [d.id, d.revision])),
    [computed.definitions],
  );
  const definitionKey = JSON.stringify(computedRevisions);

  // Fetch (debounced + abortable). Transport mode, or client-side applyQuery.
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const serverRowQuery = useMemo(() => {
    const execution = opts.computedExecution;
    const detailConfig = typeof opts.itemDetails === "object" ? opts.itemDetails : undefined;
    const page = query.itemDetails?.page ?? detailConfig?.page;
    const pageEnabled = Boolean(opts.itemDetails) && (query.itemDetails?.modes ?? initialDetailModes(detailConfig)).includes("page")
      && (!detailConfig?.modes || detailConfig.modes.includes("page"));
    const pageFields = pageEnabled ? itemPageFields(page?.urlTemplate ?? "") : [];
    // Page templates can use fields outside the visible projection. Ask the
    // transport for those dependencies through its usual SELECT planning.
    const requestQuery = pageFields.length ? { ...executionQuery, select: [...(query.select.length ? query.select : defaults.select),
      ...pageFields.filter(name => displaySchema.fields.some(field => field.name === name)).map(field => ({ field }))] } : executionQuery;
    const v2Request =
      execution && transport?.fetchRowsV2
        ? toServerQueryV2(requestQuery, displaySchema, execution)
        : undefined;
    const request = v2Request ?? toServerQuery(requestQuery, displaySchema);
    if (v2Request)
      for (const definition of computed.definitions) {
        if (
          (execution?.fields[computedFieldName(definition.id)]?.select ||
            v2Request.orderBy.some(
              (term) => term.field === computedFieldName(definition.id),
            )) &&
          executionRevision(execution, definition.id) !== undefined &&
          executionRevision(execution, definition.id) !== definition.revision
        )
          v2Request.diagnostics.push({
            from: 0,
            to: 1,
            code: "definition_changed",
            message:
              "Computed definitions changed. Refresh the server execution handshake.",
          });
      }
    // A shown-row metric may refer to columns outside the visible projection.
    for (const clause of query.aggregations ?? [])
      if (clause.scope === "shownRows") {
        try {
          for (const name of metricDependencies(
            clause,
            schema,
            resolveComputed,
          )) {
            const field = schema.fields.find((f) => f.name === name);
            if (field?.source.kind === "backend") request.select.push(name);
            else
              for (const dep of field?.source.kind === "derived"
                ? (field.source.dependencies ?? [])
                : [])
                request.select.push(dep);
          }
        } catch {
          /* Invalid metric stays editable and fails metric validation. */
        }
      }
    request.select = [...new Set(request.select)].sort();
    return request;
  }, [
    queryKey,
    displaySchema,
    transport,
    computedRevisions,
    schema,
    resolveComputed,
    opts.computedExecution,
    opts.itemDetails,
    defaults,
  ]);
  // Keep presentation-only query changes out of the expensive row pipeline.
  // Widths do not leave the client at all, and SELECT does not affect client-side
  // filtering/sorting/paging. The full queryKey still drives URL + persistence.
  const rowQueryKey = useMemo(
    () =>
      transport
        ? `server:${JSON.stringify(serverRowQuery)}`
        : `client:${JSON.stringify([query.where, query.orderBy, query.limit, query.offset])}`,
    [
      transport,
      serverRowQuery,
      query.where,
      query.orderBy,
      query.limit,
      query.offset,
    ],
  );
  const executionKey = JSON.stringify(opts.computedExecution ?? null);
  const pageContext = `${schema.name}:${rowQueryKey}:${nonce}:${executionKey}`;
  useEffect(() => {
    if (restoration.loading || restoration.error) {
      setRows(previous => previous.length ? [] : previous); setTotal(null); setCommittedPage(null); setLoading(false);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        validateExecution(query);
        if (transport) {
          const useV2 = "version" in serverRowQuery && transport.fetchRowsV2;
          if (
            "diagnostics" in serverRowQuery &&
            Array.isArray(serverRowQuery.diagnostics) &&
            serverRowQuery.diagnostics.length
          )
            throw Error(
              serverRowQuery.diagnostics.map((d) => d.message).join(" "),
            );
          if (!useV2 && query.orderBy.some((s) => isComputedField(s.field)))
            throw Error(
              "Global computed sorting requires a server execution handshake and fetchRowsV2.",
            );
          const res = useV2
            ? await transport.fetchRowsV2!(
                serverRowQuery as ReturnType<typeof toServerQueryV2<Row>>,
                ac.signal,
              )
            : await transport.fetchRows(serverRowQuery, ac.signal);
          if (useV2)
            validateComputedResponse(
              serverRowQuery as ReturnType<typeof toServerQueryV2<Row>>,
              res as import("@pythia-software/query-table-core").FetchRowsResultV2<Row>,
              schema,
            );
          if (!cancelled) {
            setCommittedFields(serverRowQuery.select);
            setServerExecution(
              useV2
                ? (
                    res as import("@pythia-software/query-table-core").FetchRowsResultV2<Row>
                  ).execution
                : undefined,
            );
            if ("computed" in res && Array.isArray(res.computed))
              setServerComputed(
                new Map(res.computed.map((c) => [c.id, c.values])),
              );
            else setServerComputed(new Map());
            setRows(res.rows);
            setTotal(res.total);
            setCommittedPage(pageContext);
            setCommittedSource({ schema, transport, clientRows });
          }
        } else {
          const res = applyQuery(clientRows ?? [], executionQuery, schema,
            groupingNow !== undefined ? { now: groupingNow } : {});
          if (!cancelled) {
            setRows(res.rows);
            setTotal(res.total);
            setCommittedPage(pageContext);
            setCommittedSource({ schema, transport, clientRows });
          }
        }
      } catch (e) {
        if (!cancelled && !ac.signal.aborted) {
          setError(e as Error);
          setRows([]);
          setTotal(null);
          setCommittedPage(null);
        }
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
    // rowQueryKey captures only row-affecting query state; clientRows/nonce
    // force refetch. Presentation changes still sync/persist via queryKey below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rowQueryKey,
    transport,
    clientRows,
    schema,
    debounceMs,
    nonce,
    validateExecution,
    executionKey,
    groupingNow,
    restoration,
  ]);

  // Persist last query (debounced).
  useEffect(() => {
    if (!storageReady || restoration.loading || restoration.error) return;
    const t = setTimeout(() => void storage.saveLast(sourceSchema.name, query), 400);
    return () => clearTimeout(t);
  }, [queryKey, storage, sourceSchema.name, query, restoration, storageReady]);

  // Resolved id accessor.
  const idField = useMemo(
    () => schema.fields.find((f) => f.name === schema.idField),
    [schema],
  );
  const rowId = useCallback(
    (row: Row): RowId | null =>
      (() => {
        const value = idField ? readFieldValue(idField, row) : (row as Record<string, unknown> | null)?.[schema.idField];
        return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
      })(),
    [idField, schema.idField],
  );

  // Sub-APIs.
  const displayedIds = useMemo(
    () => rows.map(rowId).filter((id): id is RowId => id != null),
    [rows, rowId],
  );
  const selection = useSelection(displayedIds);
  const identityScope = JSON.stringify([sourceSchema.name, query.grouping?.keys ?? null]);
  useEffect(() => { selection.clear(); }, [identityScope, selection.clear]);
  const columnSchema = useMemo(() => detailColumnSchema(displaySchema, detailsEnabled), [displaySchema, detailsEnabled]);
  const resultDefaults = useMemo(() => query.grouping ? defaultsFor(schema) : defaults, [Boolean(query.grouping), schema, defaults]);
  const select = useSelect(query, setQuery, columnSchema);
  const columnDrag = useColumnDrag();
  const savedQueries = useSavedQueries(
    sourceSchema.name,
    query,
    (q) => {
      const normalized = normalizeQueryState(q, defaults);
      savedBaseline.current = { source: sourceSchema.name, query: cloneQueryState(normalized) };
      viewRevision.current++;
      setQuery(normalized);
    },
    storage,
    now,
    links.snapshot,
  );
  const saved: SavedQueriesApi = { ...savedQueries, save: async name => {
    const item = await savedQueries.save(name);
    savedBaseline.current = { source: sourceSchema.name, query: cloneQueryState(normalizeQueryState(item.query, defaults)) };
    viewRevision.current++;
    return item;
  } };
  const pageReady =
    committedPage === pageContext &&
    committedSource?.schema === schema &&
    committedSource?.transport === transport &&
    committedSource?.clientRows === clientRows &&
    !error;
  const dataToken = useRef(0);
  const dataVersion = useMemo(
    () => ++dataToken.current,
    [schema, transport, clientRows, nonce, definitionKey, executionKey],
  );
  const aggState = useAggregations(
    executionQuery,
    schema,
    transport,
    clientRows,
    debounceMs,
    nonce,
    validateExecution,
    {
      ...(groupingNow !== undefined ? { now: groupingNow, strictLocalMetrics: true } : {}),
      shownRows: rows,
      rowsReady: pageReady,
      rowsError: error,
      ...(transport ? { shownFields: committedFields } : {}),
      resolveComputed,
      revisions: computedRevisions,
      ...(opts.computedExecution
        ? {
            execution:
              pageReady && serverExecution
                ? serverExecution
                : opts.computedExecution,
          }
        : {}),
      ...(opts.formulaWorkerFactory
        ? { workerFactory: opts.formulaWorkerFactory }
        : {}),
    },
    !restoration.loading && !restoration.error,
  );
  const queryRef = useRef(query);
  queryRef.current = query;
  const replaceAggregations = useCallback(
    (clauses: AggregationClause[], expected?: AggregationClause[]) => {
      if (
        expected &&
        JSON.stringify(queryRef.current.aggregations ?? []) !==
          JSON.stringify(expected)
      )
        throw new Error(
          "Metrics changed while editing. Reopen the editor to use the latest configuration.",
        );
      for (const clause of clauses) metricCompile(clause);
      setQuery((q) => ({
        ...q,
        aggregations: JSON.parse(
          JSON.stringify(clauses),
        ) as AggregationClause[],
      }));
    },
    [setQuery, metricCompile],
  );

  const canUndo = queryHistory.past.length > 0;
  const canRedo = queryHistory.future.length > 0;

  const undo = useCallback(() => {
    setQueryHistory((history) => {
      const previous = history.past[history.past.length - 1];
      if (!previous) return history;
      return { query: cloneQueryState(previous), past: history.past.slice(0, -1), future: [...history.future, cloneQueryState(history.query)] };
    });
  }, []);

  const redo = useCallback(() => {
    setQueryHistory((history) => {
      const next = history.future[history.future.length - 1];
      if (!next) return history;
      return { query: cloneQueryState(next), past: [...history.past, cloneQueryState(history.query)], future: history.future.slice(0, -1) };
    });
  }, []);

  // ---- intent helpers (keep offset/url/storage coherent) ----
  const patch = useCallback(
    (p: Partial<QueryState>) => setQuery((prev) => ({ ...prev, ...p })),
    [setQuery],
  );

  const { addFilter, updateFilter, removeFilter, clearFilters, updatePredicate, removePredicate, negatePredicate, reorderFilters, mergeFilters } = useQueryFilters(schema, setQuery);

  const resetAll = useCallback(
    () => {
      const baseline = savedBaseline.current;
      viewRevision.current++;
      setQuery(cloneQueryState(baseline?.source === sourceSchema.name ? baseline.query : defaults));
    },
    [setQuery, defaults, sourceSchema.name],
  );

  // ---- aggregation metric mutators (don't touch paging — scope is the whole set) ----
  const addAggregation = useCallback<AggregationsApi["add"]>(
    (partial) => {
      const id = `a${nowRef.current()}-${aggIdRef.current++}`;
      const clause: AggregationClause = {
        id,
        op: "count",
        groupBy: [],
        ...partial,
      };
      setQuery((q) => ({
        ...q,
        aggregations: [...(q.aggregations ?? []), clause],
      }));
      return id;
    },
    [setQuery],
  );
  const updateAggregation = useCallback<AggregationsApi["update"]>(
    (id, patch) =>
      setQuery((q) => ({
        ...q,
        aggregations: (q.aggregations ?? []).map((a) =>
          a.id === id ? mergeAggregation(a, patch) : a,
        ),
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
    (id) =>
      setQuery((q) => ({
        ...q,
        aggregations: (q.aggregations ?? []).filter((a) => a.id !== id),
      })),
    [setQuery],
  );
  const clearAggregations = useCallback<AggregationsApi["clear"]>(
    () => setQuery((q) => ({ ...q, aggregations: [] })),
    [setQuery],
  );

  const setSort = useCallback(
    (orderBy: OrderByClause[]) =>
      setQuery((q) => ({ ...q, offset: 0, orderBy })),
    [setQuery],
  );
  const toggleSort = useCallback(
    (field: string, additive = false) =>
      setQuery((q) => ({
        ...q,
        offset: 0,
        orderBy: nextOrderBy(q.orderBy, field, additive),
      })),
    [setQuery],
  );

  const setLimit = useCallback(
    (limit: number) => patch({ limit, offset: 0 }),
    [patch],
  );
  const setOffset = useCallback((offset: number) => patch({ offset }), [patch]);
  const nextPage = useCallback(
    () => setQuery((q) => ({ ...q, offset: q.offset + q.limit })),
    [setQuery],
  );
  const prevPage = useCallback(
    () => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) })),
    [setQuery],
  );

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

  const fieldStats = useCallback<QueryTableApi<Row>["fieldStats"]>(
    async (fields, signal) => {
      const requested = [...new Set(fields)];
      if (transport?.fetchFieldStats) {
        const backendFields = requested.filter(
          (name) => byName.get(name)?.source.kind === "backend",
        );
        return backendFields.length
          ? transport.fetchFieldStats(backendFields, signal)
          : {};
      }
      if (!clientRows) return {};

      const result: Record<string, FieldStats> = {};
      for (const name of requested) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const field = byName.get(name);
        if (!field) continue;
        const distinct = new Set<string>();
        for (const row of clientRows) {
          const value = readFieldValue(field, row);
          if (value !== null) distinct.add(JSON.stringify(value));
        }
        result[name] = { distinct: distinct.size };
      }
      return result;
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
      const pollCount =
        frequencyMs > 0 && turnOffAfterMs > 0
          ? Math.floor(turnOffAfterMs / frequencyMs)
          : 0;
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
        setAutoRefreshStatus((current) =>
          current?.stopsAt === autoRefreshStopsAt ? null : current,
        );
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
      () =>
        setAutoRefreshStatus((current) =>
          current?.stopsAt === autoRefreshStopsAt ? null : current,
        ),
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
      if (opts.computedExecution && transport?.fetchRowsV2) {
        // Base rows and computed sidecars belong to one committed page. A
        // single-row fetch cannot replace either independently, and changes
        // to a computed sort may also change page membership.
        refresh();
        return;
      }
      if (!transport?.fetchRow) return;
      const updated = await transport.fetchRow(id);
      setRows((prev) =>
        prev.map((r) => (rowId(r) === id ? (updated ?? r) : r)),
      );
    },
    [transport, rowId, opts.computedExecution, refresh],
  );

  const visibleFields = useMemo(
    () => selectedFields(columnSchema, query),
    [columnSchema, query],
  );

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
      preview: aggState.preview,
      replace: replaceAggregations,
      compile: metricCompile,
      contextKey: `${dataVersion}:${pageContext}:${pageReady}:${JSON.stringify(query.where)}`,
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
      aggState.preview,
      replaceAggregations,
      metricCompile,
      pageContext,
      pageReady,
      dataVersion,
      query.where,
    ],
  );

  const sourceRowId = useCallback((row: Row): RowId | null => {
    const field = sourceSchema.fields.find(f => f.name === sourceSchema.idField);
    const value = field ? readFieldValue(field, row) : (row as Record<string, unknown>)[sourceSchema.idField];
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
  }, [sourceSchema]);

  const itemDetails = useItemDetails({
    schema: query.grouping ? sourceSchema : displaySchema,
    query: sourceQuery, setQuery: setSourceQuery, options: opts.itemDetails,
    rows: query.grouping ? sourceRows ?? [] : rows, clientRows: sourceRows,
    rowId: sourceRowId, transport, refreshKey: nonce, links,
    queryReady: storageReady && !restoration.loading && !restoration.error,
  });

  const api: QueryTableApi<Row> = {
    links,
    schema: columnSchema,
    ...(itemDetails && detailsEnabled ? { itemDetails } : {}),
    query,
    defaults: resultDefaults,
    setQuery,
    rows,
    total,
    loading: loading || restoration.loading,
    error: restoration.error ?? error,
    requestActivity,
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
    updatePredicate,
    removePredicate,
    negatePredicate,
    reorderFilters,
    mergeFilters,
    resetAll,
    filterValues,
    fieldStats,
    toggleSort,
    setSort,
    select,
    computed,
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
  const sourceApi: GroupingSourceApi<Row> = {
    ...sourceFilters, loading, rowId: sourceRowId, query: sourceQuery, setQuery: setSourceQuery,
    ...(itemDetails ? { itemDetails } : {}),
    schema: sourceSchema,
    filterValues: async (name, search) => {
      const field = groupingModel.sourceField(name);
      return field && sourceRows ? { ...distinctValuesFromRows(field, sourceRows, search), hasNull: fieldHasNullInRows(field, sourceRows) } : { values: [], hasMore: false };
    },
    fieldStats: async (names) => Object.fromEntries(names.flatMap(name => {
      const field = groupingModel.sourceField(name);
      return field && sourceRows ? [[name, { distinct: new Set(sourceRows.map(row => JSON.stringify(readFieldValue(field, row)))).size }]] : [];
    })),
  };
  const grouping = useGroupingController(api, sourceApi, groupingModel, prepared?.inputs ?? sourceRows ?? [], groupingSupported, viewRevision.current);
  return {
    ...api,
    ...(groupingSupported || query.grouping ? { grouping } : {}),
    select: { ...select, hide: field => query.grouping?.keys.includes(field)
      ? grouping.changeKeys(query.grouping.keys.filter(key => key !== field)) : select.hide(field) },
  };
}

/** Multi-sort header click logic.
 *   - plain click on the sole sorted column → flip its direction
 *   - plain click on another column → make it the only sort (desc)
 *   - shift-click a new column → append it (desc) as a secondary term
 *   - shift-click an existing term → cycle desc → asc → remove */
function nextOrderBy(
  existing: OrderByClause[],
  field: string,
  additive: boolean,
): OrderByClause[] {
  const i = existing.findIndex((s) => s.field === field);
  if (!additive) {
    if (i === 0 && existing.length === 1) {
      const flipped: "asc" | "desc" =
        existing[0]!.dir === "desc" ? "asc" : "desc";
      return [{ ...existing[0]!, dir: flipped }];
    }
    return [{ field, dir: "desc" }];
  }
  if (i === -1) return [...existing, { field, dir: "desc" }];
  const cur = existing[i]!;
  if (cur.dir === "desc") {
    const next = [...existing];
    next[i] = { ...cur, dir: "asc" };
    return next;
  }
  return existing.filter((_, k) => k !== i); // asc → remove
}
