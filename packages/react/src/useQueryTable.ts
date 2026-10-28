import { useQueryFilters } from "./useQueryFilters";
import { useGroupingController, type GroupingApi, type GroupingSourceApi } from "./useGrouping";
import { createGroupingModel, prepareGrouping, withoutGrouping,
  sourceExecutionSchema, toQueryRequestV3, validateQueryResultV3, metricPopulationError } from "@pythia-software/query-table-core";
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

  /** Pause execution and URL synchronization while a mounted host view is hidden. */
  active?: boolean;
  /** Capture evaluation time for grouped executions and remote query requests. */
  evaluationNow?: () => number;
  /** Normalize external aliases without storing presentation in query state. Must be pure and not throw. */
  canonicalizeQuery?: (query: QueryState) => QueryState;
  /** Reject an entire query before rows or metrics execute. Errors retain editable query state. */
  validateQuery?: (query: QueryState) => void;

  /** Disable row-producing grouping for this instance. Enabled for complete client datasets by default. */
  grouping?: boolean;
  schema: FieldSchema<Row>;
  /** Row data access. Omit to filter, sort, and page `clientRows` locally. */
  transport?: Transport<Row>;
  /** Metric-only data access; defaults to transport and never selects server row mode. */
  metricTransport?: Transport<Row>;
  /** Authoritative metric handshake; defaults to the existing row execution selection. */
  metricExecution?: ComputedExecution;
  /** Additional host readiness gate for committed-page metrics and previews.
   * Does not delay remote allMatching requests. Re-evaluated on each render. */
  metricRowsReady?: (query: QueryState) => boolean;
  /** Dataset already available in memory. Remote grouping/aggregation belongs
   * on the server; do not download a population to supply this option. */
  clientRows?: Row[];
  /** Saved/last-query persistence. Defaults to a non-durable in-memory adapter.
   * Pass localStorageAdapter() explicitly only when filter values are safe to
   * retain as cleartext JSON on the device. */
  storage?: StorageAdapter;
  /** When `storage.saveLast` records the last-used query: "always" (default)
   * 400 ms after every change, or "succeeded" once rows and every metric of
   * that exact query have loaded. A failure, timeout or cancellation keeps the
   * previous last-used query; explicit links, named saves and the default are
   * separate choices and are never touched by it. */
  persistLast?: "always" | "succeeded";
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
  /** Collection URL parameter, independent of item views. Takes precedence
   * over the legacy itemDetails.queryParameter; otherwise defaults to q. */
  queryParameter?: string;
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

/** The outcome of executing one exact query; see `QueryTableApi.execution`. */
export interface QueryExecutionReceipt {
  /** The query whose rows and metrics this receipt describes. */
  query: QueryState;
  /** Execution identity: changes with every row- or metric-affecting edit and
   * refresh, but not with presentation such as widths. */
  key: string;
  /** Increases with every new execution identity of this table. */
  generation: number;
  /** "succeeded" only when rows and every metric loaded; an empty result,
   * including a page past the end, is a success. */
  status: "running" | "succeeded" | "failed";
  rows: "running" | "succeeded" | "failed";
  /** "none" when the query has no metrics. A metric error fails the receipt. */
  metrics: "none" | "running" | "succeeded" | "failed";
  /** The row or metric error behind a failure. */
  error: Error | null;
}
export interface QueryTableApi<Row> {
  /** Dependent source fetches can use ready without parsing display errors. */
  restoration: { status: "resolving" | "ready" | "error"; ready: boolean; error: Error | null };
  /** Execution of the current query, separate from restoration. Null while
   * restoring, after a restoration error and while the table is inactive, so
   * a cancelled or hidden table never publishes a stale receipt. */
  execution: QueryExecutionReceipt | null;
  /** Call after a host pushState/router update, with an absolute URL or a location
   * relative to window.location.href. Supersedes prior resolution;
   * abort or an intervening query edit prevents stale publication. */
  restoreLocation: (location: string | URL, signal?: AbortSignal) => Promise<void>;
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
  /** Move backward through local, unsaved query history. Empty history leaves
   * incoming link restoration and errors unchanged. */
  undo: () => void;
  /** Move forward through local, unsaved query history. Empty history leaves
   * incoming link restoration and errors unchanged. */
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

function queryParameter<Row>(opts: UseQueryTableOptions<Row>): string {
  return opts.queryParameter ?? (typeof opts.itemDetails === "object" ? opts.itemDetails.queryParameter : undefined) ?? "q";
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
  if (opts.syncUrl === true && opts.active !== false && typeof window !== "undefined") {
    const parameter = queryParameter(opts);
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
    clientRows: providedRows,
    initialQuery,
    debounceMs = 200,
  } = opts;
  const active = opts.active !== false;
  const urlSyncEnabled = opts.syncUrl === true;
  const syncUrl = urlSyncEnabled && active;
  const { transport: metadataTransport, metricTransport, activity: requestActivity } =
    useRequestActivity(sourceTransport, opts.metricTransport);
  const transport = metadataTransport;
  const storage = useMemo(
    () => opts.storage ?? memoryStorageAdapter(),
    [opts.storage],
  );
  const parameter = queryParameter(opts);
  const linkService = useMemo(() => createQueryLinkService(sourceSchema.name, storage.snapshots, opts.links),
    [sourceSchema.name, storage.snapshots, opts.links?.cache, opts.links?.maxUrlBytes]);
  const now = opts.now ?? Date.now;
  const nowRef = useRef(now);
  const onRefreshRef = useRef(opts.onRefresh);
  const defaults = useMemo(() => defaultsFor(sourceSchema, Boolean(opts.itemDetails)), [sourceSchema, Boolean(opts.itemDetails)]);

  const initRef = useRef(resolveInitial(opts));
  const [restoration, setRestoration] = useState<{ loading: boolean; error: Error | null }>({ loading: initRef.current.fromUrl, error: null });
  const [storageReady, setStorageReady] = useState(Boolean(initialQuery));
  const restorationCurrent = useRef({ storageReady, restoration, active });
  restorationCurrent.current = { storageReady, restoration, active };
  const manualQueryEpoch = useRef(0);
  const restoreController = useRef<AbortController | null>(null);
  const restoreHandler = useRef<((location: string, signal?: AbortSignal) => Promise<void>) | null>(null);
  const initialRestore = useRef<(() => Promise<void>) | null>(null);
  const initialRestorationStarted = useRef(false);
  const restoreLocation = useCallback((location: string | URL, signal?: AbortSignal) => {
    if (!restoreHandler.current) return Promise.reject(Error("Query controller is not mounted."));
    return restoreHandler.current(String(location), signal);
  }, []);
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
  // Keep history current even when React batches several edits or
  // undo/redo calls. History updates stay pure and cancellation stays outside
  // React state updaters, which may run more than once.
  const queryHistoryRef = useRef(queryHistory);
  const updateQueryHistory = useCallback((update: (history: typeof queryHistory) => typeof queryHistory) => {
    const previous = queryHistoryRef.current;
    const next = update(previous);
    if (next === previous) return;
    queryHistoryRef.current = next;
    setQueryHistory(next);
  }, []);
  const storedQuery = queryHistory.query;
  const [nonce, setNonce] = useState(0);
  const query = useMemo(
    () => opts.canonicalizeQuery?.(storedQuery) ?? storedQuery,
    [storedQuery, opts.canonicalizeQuery],
  );
  const sourceCatalogue = useMemo(() => sourceExecutionSchema(sourceSchema, opts.computedExecution), [sourceSchema, opts.computedExecution]);
  const sourceRows = providedRows;
  const groupingModel = useMemo(() => createGroupingModel(sourceCatalogue), [sourceCatalogue]);
  const remoteGrouping = !!transport?.fetchQueryV3 && transport.queryCapabilities?.version === 3 && transport.queryCapabilities.groupedRows;
  const groupingSupported = ((!transport && sourceRows !== undefined) || remoteGrouping) && opts.grouping !== false;
  const groupKey = JSON.stringify(query.grouping ?? null);
  // Capture the grouped evaluation clock with its population. Debounced rows,
  // metric previews and committed metrics must use the same relative bounds.
  // Ordinary V3 requests capture their clock when each execution begins.
  const groupingNow = useMemo(() => query.grouping ? (opts.evaluationNow ?? Date.now)() : undefined,
    [sourceRows, sourceSchema, groupingSupported, groupKey, nonce, opts.evaluationNow]);
  const prepared = useMemo(() => {
    if (!query.grouping) return null;
    try {
      if (!groupingSupported) throw new Error("Grouped queries require a server with grouped-query support or a dataset already in memory.");
      if (remoteGrouping) { groupingModel.validate(query.grouping); return { inputs: [] as Row[], rows: [], error: null }; }
      return { ...prepareGrouping(sourceRows!, sourceCatalogue, query.grouping, { now: groupingNow! }), error: null };
    } catch (error) {
      return { inputs: [] as Row[], rows: [], error: error as Error };
    }
  }, [sourceRows, sourceCatalogue, groupingModel, groupingSupported, groupKey, nonce, groupingNow, remoteGrouping]);
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
  const groupDetailsEnabled = Boolean(opts.itemDetails) && Boolean(query.grouping);
  // Normalization clones grouping even for presentation edits. Only a change
  // in its content should invalidate row and metric execution.
  const validateExecution = useCallback((q: QueryState) => {
    if (prepared?.error) throw prepared.error;
    // Previews carry draft metrics in q. Reattach the source stage without
    // replacing those drafts with the currently committed dashboard.
    opts.validateQuery?.(query.grouping ? { ...q, grouping: query.grouping } : q);
  }, [prepared?.error, opts.validateQuery, groupKey]);
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
  // The page context whose execution set `error`; errors of superseded runs do not describe the current query.
  const [failedPage, setFailedPage] = useState<string | null>(null);
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
      initialRestorationStarted.current = true;
      restoreController.current?.abort();
      setStorageReady(true);
      setRestoration(previous => !previous.loading && !previous.error ? previous : { loading: false, error: null });
      updateQueryHistory((history) => {
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
    [defaults, updateQueryHistory],
  );

  const sourceQuery = query.grouping?.source ?? query;
  const setSourceQuery = useCallback<QueryTableApi<Row>["setQuery"]>((next) => {
    setQuery(current => {
      const previous = current.grouping?.source ?? current;
      const source = withoutGrouping(typeof next === "function" ? next(previous) : next);
      return current.grouping ? { ...current, offset: 0, grouping: { ...current.grouping, source } } : source;
    });
  }, [setQuery]);
  const sourceFilters = useQueryFilters(sourceCatalogue, setSourceQuery);

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
    initialRestorationStarted.current = Boolean(restoreSources.current.initialQuery);
    async function restore(navigation = false, location = typeof window !== "undefined" ? window.location.href : "", signal?: AbortSignal) {
      initialRestorationStarted.current = true;
      const { storage, linkService, defaults } = restoreSources.current;
      const run = ++generation;
      const epoch = manualQueryEpoch.current;
      controller.abort(); controller = new AbortController();
      restoreController.current = controller;
      const currentController = controller;
      const abort = () => currentController.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) currentController.abort();
      setStorageReady(false);
      const explicitLink = !!location && (navigation || urlSyncEnabled) && hasQueryLink(location, parameter);
      setRestoration({ loading: true, error: null });
      try {
        if (currentController.signal.aborted) throw new DOMException("Query restoration cancelled.", "AbortError");
        const fromUrl = location && (navigation || urlSyncEnabled) ? await linkService.resolve(location, parameter, currentController.signal) : null;
        const defaultSaved = fromUrl ? null : await storage.loadDefaultSaved?.(sourceSchema.name);
        const restored = fromUrl ?? defaultSaved?.query ?? (navigation ? defaults : await storage.loadLast(sourceSchema.name));
        if (currentController.signal.aborted) throw new DOMException("Query restoration cancelled.", "AbortError");
        if (!cancelled && run === generation && epoch === manualQueryEpoch.current) {
          if (restored) {
            const normalized = normalizeQueryState(restored, defaults);
            savedBaseline.current = defaultSaved || fromUrl?.grouping
              ? { source: sourceSchema.name, query: cloneQueryState(normalized) }
              : null;
            viewRevision.current++;
            updateQueryHistory(() => ({ query: normalized, past: [], future: [] }));
          }
          setStorageReady(true);
          setRestoration(previous => !previous.loading && !previous.error ? previous : { loading: false, error: null });
        }
      } catch (e) {
        if (!cancelled && run === generation && epoch === manualQueryEpoch.current) {
          if (explicitLink || navigation && currentController.signal.aborted) {
            setRestoration({ loading: false, error: e instanceof Error ? e : Error(String(e)) });
          } else {
            // Last/default saved queries are optional restoration sources.
            // A failed host read should still leave a usable default table.
            updateQueryHistory(() => ({ query: defaults, past: [], future: [] }));
            setRestoration({ loading: false, error: null });
          }
          setStorageReady(true);
        }
        if (navigation && !cancelled && run === generation && epoch === manualQueryEpoch.current) throw e;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
    restoreHandler.current = async (location, signal) => {
      location = new URL(location, typeof window !== "undefined" ? window.location.href : undefined).href;
      const key = JSON.stringify(new URL(location).searchParams.getAll(parameter));
      const current = restorationCurrent.current;
      if (key === observedQueryUrl.current && current.storageReady && !current.restoration.loading && !current.restoration.error) return;
      recordQueryUrl(location);
      await restore(true, location, signal);
    };
    initialRestore.current = () => restore();
    if (typeof window !== "undefined") recordQueryUrl(window.location.href);
    const navigate = () => {
      if (!restorationCurrent.current.active) return;
      const key = JSON.stringify(new URL(window.location.href).searchParams.getAll(parameter));
      if (key === observedQueryUrl.current) return;
      observedQueryUrl.current = key;
      void restore(true).catch(() => { /* Restoration state owns the display error. */ });
    };
    if (urlSyncEnabled && typeof window !== "undefined") window.addEventListener("popstate", navigate);
    return () => {
      cancelled = true; controller.abort();
      restoreHandler.current = null;
      initialRestore.current = null;
      if (urlSyncEnabled && typeof window !== "undefined") window.removeEventListener("popstate", navigate);
    };
  }, [sourceSchema.name, urlSyncEnabled, parameter, recordQueryUrl, updateQueryHistory]);
  // Activation pauses a mounted controller; it only initiates restoration if
  // this dataset has never started, preserving edits and history on tab switches.
  useEffect(() => {
    if (active && !initialRestorationStarted.current) void initialRestore.current?.();
  }, [active, sourceSchema.name, urlSyncEnabled, parameter, recordQueryUrl]);

  const { api: computed, displaySchema } = useComputedColumns({
    schema,
    query: executionQuery,
    sourceSchema,
    previewQuery: query,
    ...(groupingNow !== undefined ? { now: groupingNow } : {}),
    rows,
    serverComputed,
    ...(serverExecution ? { serverExecution } : {}),
    ...(opts.computedExecution ? { execution: opts.computedExecution } : {}),
    ...(metricTransport ? { metricTransport } : {}),
    ...(opts.metricExecution ? { metricExecution: opts.metricExecution } : {}),
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
  const metricCompileSchema = useMemo(() => opts.metricExecution
    ? sourceExecutionSchema(displaySchema, opts.metricExecution, computed.definitions)
    : displaySchema, [displaySchema, opts.metricExecution, computed.definitions]);
  const metricCompile = useCallback(
    (clause: AggregationClause) => {
      const diagnostics = validateMetric(
        clause,
        metricCompileSchema,
        resolveComputed,
      );
      if (diagnostics.length)
        throw new Error(diagnostics.map((d) => d.message).join(" "));
      return metricPlans(clause, metricCompileSchema, resolveComputed);
    },
    [metricCompileSchema, resolveComputed],
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
        ? `server:${JSON.stringify(serverRowQuery)}:${transport.fetchQueryV3 ? JSON.stringify([groupKey, groupingNow,
          query.select.map(column => column.field), query.where, query.orderBy, query.limit, query.offset]) : ""}`
        : `client:${JSON.stringify([query.where, query.orderBy, query.limit, query.offset])}`,
    [
      transport,
      serverRowQuery,
      groupKey,
      groupingNow,
      query.select,
      query.where,
      query.orderBy,
      query.limit,
      query.offset,
    ],
  );
  const executionKey = JSON.stringify(opts.computedExecution ?? null);
  const pageContext = `${schema.name}:${rowQueryKey}:${nonce}:${executionKey}`;
  useEffect(() => {
    if (!active || !storageReady || restoration.loading || restoration.error) {
      setRows(previous => previous.length ? [] : previous); setTotal(null); setCommittedPage(null); setLoading(false);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      setFailedPage(null);
      try {
        validateExecution(query);
        if (transport) {
          if (transport.fetchQueryV3 && transport.queryCapabilities?.version === 3 &&
            (query.grouping || query.select.some(column => isComputedField(column.field)) || query.orderBy.some(term => isComputedField(term.field)) ||
              query.where.some(term => ("any" in term ? term.any : [term]).some(predicate => isComputedField(predicate.field))) ||
              !transport.fetchRows && !(transport.fetchRowsV2 && opts.computedExecution))) {
            const request = toQueryRequestV3({ ...query, aggregations: [], select: [...query.select.filter(column => isComputedField(column.field)),
              ...serverRowQuery.select.map(field => ({ field }))] }, sourceSchema,
              transport.queryCapabilities, opts.computedExecution, { now: groupingNow ?? (opts.evaluationNow ?? Date.now)() });
            if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
            const result = await transport.fetchQueryV3(request, ac.signal);
            validateQueryResultV3(result, request, query.grouping ? schema : sourceCatalogue);
            if (!cancelled) {
              setCommittedFields(request.result.select); setServerExecution(result.execution);
              setServerComputed(new Map(result.rows.map(row => [row[schema.idField] as RowId,
                Object.fromEntries(Object.entries(row).filter(([name]) => isComputedField(name)).map(([name, value]) =>
                  [name.slice(10), value && typeof value === "object" && "computedError" in value
                    ? { value: null, error: { code: String(value.computedError) } } : { value: value as import("@pythia-software/query-table-core").MetricValue }]))])));
              setRows(result.rows as Row[]); setTotal(result.total); setCommittedPage(pageContext);
              setCommittedSource({ schema, transport, clientRows });
            }
            return;
          }
          const useV2 = "version" in serverRowQuery && transport.fetchRowsV2;
          if (!useV2 && !transport.fetchRows)
            throw Error("Row execution requires fetchRows, negotiated fetchRowsV2, or negotiated fetchQueryV3.");
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
            : await transport.fetchRows!(serverRowQuery, ac.signal);
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
          setFailedPage(pageContext);
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
    active,
    storageReady,
  ]);

  // Persist last query (debounced). The "succeeded" policy waits for the
  // execution receipt below.
  const persistLast = opts.persistLast ?? "always";
  useEffect(() => {
    if (persistLast !== "always" || !storageReady || restoration.loading || restoration.error) return;
    const t = setTimeout(() => void storage.saveLast(sourceSchema.name, query), 400);
    return () => clearTimeout(t);
  }, [persistLast, queryKey, storage, sourceSchema.name, query, restoration, storageReady]);

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
  const columnSchema = useMemo(() => detailColumnSchema(displaySchema, detailsEnabled || groupDetailsEnabled), [displaySchema, detailsEnabled, groupDetailsEnabled]);
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
    [schema, transport, clientRows, rows, nonce, definitionKey, executionKey, metricTransport, opts.metricExecution],
  );
  const metricRowsReady = pageReady && (opts.metricRowsReady?.(query) ?? true);
  const metricExecution = opts.metricExecution ?? (opts.computedExecution
    ? pageReady && serverExecution ? serverExecution : opts.computedExecution
    : undefined);
  const v3MetricExecution = opts.metricExecution ?? opts.computedExecution;
  const metricSourceCatalogue = useMemo(() => sourceExecutionSchema(sourceSchema, v3MetricExecution),
    [sourceSchema, v3MetricExecution]);
  const executeV3Metrics = useCallback(async (metricQuery: QueryState, signal?: AbortSignal) => {
    if (!metricTransport?.fetchQueryV3 || metricTransport.queryCapabilities?.version !== 3) throw Error("The v3 query executor is unavailable.");
    const capabilities = metricTransport.queryCapabilities;
    // Unsupported population controls fail their own cards, never the batch.
    const refused = new Map<string, string>();
    for (const clause of metricQuery.aggregations ?? []) {
      const issue = metricPopulationError(clause, { filters: capabilities.metricFilters, minCount: capabilities.metricMinCount });
      if (issue) refused.set(clause.id, issue);
    }
    const runnable = (metricQuery.aggregations ?? []).filter(clause => !refused.has(clause.id));
    let metrics: AggregationResult["metrics"] = [];
    if (runnable.length) {
      const scoped = { ...metricQuery, aggregations: runnable };
      const request = toQueryRequestV3(query.grouping ? { ...scoped, grouping: query.grouping } : scoped,
        sourceSchema, capabilities, v3MetricExecution, { now: groupingNow ?? (opts.evaluationNow ?? Date.now)(), rows: false });
      if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
      const result = await metricTransport.fetchQueryV3(request, signal);
      validateQueryResultV3(result, request, query.grouping ? schema : metricSourceCatalogue);
      metrics = result.metrics;
    }
    if (!refused.size) return { metrics };
    const byId = new Map(metrics.map(metric => [metric.id, metric]));
    return { metrics: (metricQuery.aggregations ?? []).flatMap((clause): AggregationResult["metrics"] => {
      const issue = refused.get(clause.id);
      if (issue) return [{ id: clause.id, buckets: [], error: issue }];
      const metric = byId.get(clause.id);
      return metric ? [metric] : [];
    }) };
  }, [metricTransport, sourceSchema, metricSourceCatalogue, schema, v3MetricExecution, groupKey, groupingNow, opts.evaluationNow]);
  const previewGrouping = useCallback(async (draft: QueryState, signal?: AbortSignal) => {
    if (!active || !storageReady || restoration.loading || restoration.error) throw Error("Wait for query restoration before previewing groups.");
    if (!transport?.fetchQueryV3 || !transport.queryCapabilities?.groupedRows || !draft.grouping) throw Error("The server group preview is unavailable.");
    const request = toQueryRequestV3({ ...draft, aggregations: [] }, sourceSchema, transport.queryCapabilities,
      opts.computedExecution, { now: groupingNow ?? (opts.evaluationNow ?? Date.now)() });
    if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
    const result = await transport.fetchQueryV3(request, signal);
    validateQueryResultV3(result, request, groupingModel.resultSchema(draft.grouping.keys, draft.grouping.summaries));
    return { rows: result.rows, total: result.total, sourceTotal: result.sourceTotal };
  }, [transport, sourceSchema, opts.computedExecution, groupingModel, groupingNow, opts.evaluationNow, active, storageReady, restoration.loading, restoration.error]);
  const aggState = useAggregations(
    executionQuery,
    schema,
    metricTransport,
    clientRows,
    debounceMs,
    nonce,
    validateExecution,
    {
      ...(metricTransport?.fetchQueryV3 && metricTransport.queryCapabilities?.version === 3 &&
        (query.grouping || query.aggregations?.some(metric => metric.dateGrouping) ||
          query.where.some(term => ("any" in term ? term.any : [term]).some(predicate => isComputedField(predicate.field))))
        ? { executeV3: executeV3Metrics, queryContextKey: groupKey } : {}),
      ...(groupingNow !== undefined ? { now: groupingNow, strictLocalMetrics: true } : {}),
      shownRows: rows,
      rowsReady: metricRowsReady,
      rowsError: error,
      ...(transport ? { shownFields: committedFields } : {}),
      resolveComputed,
      revisions: computedRevisions,
      ...(metricExecution ? { execution: metricExecution } : {}),
      ...(opts.formulaWorkerFactory
        ? { workerFactory: opts.formulaWorkerFactory }
        : {}),
    },
    active && storageReady && !restoration.loading && !restoration.error,
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
    if (!queryHistoryRef.current.past.length) return;
    manualQueryEpoch.current++;
    restoreController.current?.abort();
    setStorageReady(true);
    setRestoration({ loading: false, error: null });
    updateQueryHistory((history) => {
      const previous = history.past[history.past.length - 1];
      if (!previous) return history;
      return { query: cloneQueryState(previous), past: history.past.slice(0, -1), future: [...history.future, cloneQueryState(history.query)] };
    });
  }, [updateQueryHistory]);

  const redo = useCallback(() => {
    if (!queryHistoryRef.current.future.length) return;
    manualQueryEpoch.current++;
    restoreController.current?.abort();
    setStorageReady(true);
    setRestoration({ loading: false, error: null });
    updateQueryHistory((history) => {
      const next = history.future[history.future.length - 1];
      if (!next) return history;
      return { query: cloneQueryState(next), past: [...history.past, cloneQueryState(history.query)], future: history.future.slice(0, -1) };
    });
  }, [updateQueryHistory]);

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
      if (!metadataTransport?.fetchDistinctValues || query.grouping && !query.grouping.keys.includes(field)) {
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
      return metadataTransport.fetchDistinctValues({ field, search });
    },
    [metadataTransport, byName, clientRows, groupKey],
  );

  const fieldStats = useCallback<QueryTableApi<Row>["fieldStats"]>(
    async (fields, signal) => {
      const requested = [...new Set(fields)];
      if (metadataTransport?.fetchFieldStats && !query.grouping) {
        const backendFields = requested.filter(
          (name) => byName.get(name)?.source.kind === "backend",
        );
        return backendFields.length
          ? metadataTransport.fetchFieldStats(backendFields, signal)
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
    [metadataTransport, byName, clientRows, groupKey],
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
      contextKey: `${dataVersion}:${pageContext}:${metricRowsReady}:${JSON.stringify(query.where)}`,
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
      metricRowsReady,
      dataVersion,
      query.where,
    ],
  );

  // One receipt per execution identity. Rows and metrics are keyed by the
  // current page context and metric state, so a slower earlier execution can
  // never mark this one healthy.
  const executionIdentity = JSON.stringify([pageContext, query.aggregations ?? [], query.where, groupKey, nonce]);
  const executionGeneration = useRef({ key: "", generation: 0 });
  if (executionGeneration.current.key !== executionIdentity)
    executionGeneration.current = { key: executionIdentity, generation: executionGeneration.current.generation + 1 };
  const execution = useMemo((): QueryExecutionReceipt | null => {
    if (!active || !storageReady || restoration.loading || restoration.error) return null;
    const rowsStatus = pageReady ? "succeeded" : error && failedPage === pageContext ? "failed" : "running";
    const metricError = aggState.error ?? aggState.results?.metrics.find(entry => entry.error)?.error;
    const metricsStatus = !(query.aggregations?.length) ? "none"
      : aggState.loading || (!aggState.results && !aggState.error) ? "running"
      : metricError ? "failed" : "succeeded";
    const status = rowsStatus === "failed" || metricsStatus === "failed" ? "failed"
      : rowsStatus === "succeeded" && metricsStatus !== "running" ? "succeeded" : "running";
    return {
      query, key: executionIdentity, generation: executionGeneration.current.generation,
      status, rows: rowsStatus, metrics: metricsStatus,
      error: rowsStatus === "failed" ? error : metricError ? (metricError instanceof Error ? metricError : Error(String(metricError))) : null,
    };
  }, [active, storageReady, restoration.loading, restoration.error, pageReady, error, failedPage, pageContext,
    aggState.error, aggState.results, aggState.loading, query, executionIdentity]);
  const succeededQuery = execution?.status === "succeeded" ? execution.query : null;
  useEffect(() => {
    if (persistLast !== "succeeded" || !succeededQuery) return;
    const t = setTimeout(() => void storage.saveLast(sourceSchema.name, succeededQuery), 400);
    return () => clearTimeout(t);
  }, [persistLast, succeededQuery, storage, sourceSchema.name]);

  const sourceRowId = useCallback((row: Row): RowId | null => {
    const field = sourceSchema.fields.find(f => f.name === sourceSchema.idField);
    const value = field ? readFieldValue(field, row) : (row as Record<string, unknown>)[sourceSchema.idField];
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
  }, [sourceSchema]);

  const itemDetails = useItemDetails({
    schema: query.grouping ? sourceSchema : displaySchema,
    query: sourceQuery, setQuery: setSourceQuery, options: opts.itemDetails,
    rows: query.grouping ? sourceRows ?? [] : rows, clientRows: sourceRows,
    rowId: sourceRowId, transport: metadataTransport, refreshKey: nonce, links, queryParameter: parameter,
    queryReady: storageReady && !restoration.loading && !restoration.error,
  });

  // Group Detail reads grouped rows already held, by their group identity; it
  // never loads a source item by that ID. Rows seen for this population stay
  // readable across pages and sorts, and a changed population drops them.
  const groupPopulation = query.grouping ? JSON.stringify([query.grouping, query.where, nonce]) : "";
  const groupRecords = useRef({ population: "", rows: new Map<RowId, Row>() });
  if (groupRecords.current.population !== groupPopulation) groupRecords.current = { population: groupPopulation, rows: new Map() };
  // Only rows committed for the current page context belong to this population.
  const groupsSettled = groupDetailsEnabled && pageReady && !restoration.loading;
  if (groupsSettled) for (const row of rows) {
    const id = rowId(row);
    if (id != null) groupRecords.current.rows.set(id, row);
  }
  const groupDetailOptions = useMemo((): ItemDetailsOptions<Row> | undefined => {
    if (!groupDetailsEnabled) return undefined;
    const config = typeof opts.itemDetails === "object" ? opts.itemDetails : undefined;
    // Page templates address source items, so groups offer the in-place modes.
    const modes = (config?.modes ?? ["hover", "modal", "expand"]).filter(mode => mode !== "page");
    return { modes, defaultModes: initialDetailModes(config).filter(mode => (modes as string[]).includes(mode)),
      objectType: `${config?.objectType ?? sourceSchema.name}:groups`,
      ...(config?.storage ? { storage: config.storage } : {}) };
  }, [groupDetailsEnabled, opts.itemDetails, sourceSchema.name]);
  // Group properties default to every key and summary, links included.
  const groupDetailSchema = useMemo(() => ({ ...displaySchema,
    defaultSelect: displaySchema.fields.filter(field => field.name !== displaySchema.idField).map(field => ({ field: field.name })),
    fields: displaySchema.fields.map(field =>
      field.name === displaySchema.idField ? { ...field, property: { enabled: false } } : field) }), [displaySchema]);
  // Property-view writes that land after grouping ends must not reach the source query.
  const setGroupQuery = useCallback<QueryTableApi<Row>["setQuery"]>((next) => setQuery(current =>
    current.grouping ? typeof next === "function" ? next(current) : next : current), [setQuery]);
  const groupDetails = useItemDetails({
    schema: groupDetailSchema, query, setQuery: setGroupQuery, options: groupDetailOptions, rows, clientRows: undefined,
    rowId, transport: undefined, refreshKey: nonce, links, queryParameter: parameter,
    queryReady: storageReady && !restoration.loading && !restoration.error,
    lookupRow: (id) => {
      const row = groupRecords.current.rows.get(id);
      return row ? { row } : groupsSettled || error ? null : undefined;
    },
    subject: "group",
  });

  const api: QueryTableApi<Row> = {
    restoration: { status: restoration.error ? "error" : !storageReady || restoration.loading ? "resolving" : "ready",
      ready: active && storageReady && !restoration.loading && !restoration.error, error: restoration.error },
    execution,
    restoreLocation,
    links,
    schema: columnSchema,
    ...(itemDetails && detailsEnabled ? { itemDetails } : groupDetails ? { itemDetails: groupDetails } : {}),
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
    schema: sourceCatalogue,
    filterValues: async (name, search) => {
      if (metadataTransport?.fetchDistinctValues) return metadataTransport.fetchDistinctValues({ field: name, search });
      const field = groupingModel.sourceField(name);
      return field && sourceRows ? { ...distinctValuesFromRows(field, sourceRows, search), hasNull: fieldHasNullInRows(field, sourceRows) } : { values: [], hasMore: false };
    },
    fieldStats: async (names, signal) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const requested = [...new Set(names)];
      if (metadataTransport?.fetchFieldStats) {
        const backendFields = requested.filter(
          name => sourceCatalogue.fields.find(field => field.name === name)?.source.kind === "backend",
        );
        return backendFields.length ? metadataTransport.fetchFieldStats(backendFields, signal) : {};
      }
      return Object.fromEntries(requested.flatMap(name => {
        const field = groupingModel.sourceField(name);
        return field && sourceRows ? [[name, { distinct: new Set(sourceRows.map(row => JSON.stringify(readFieldValue(field, row)))).size }]] : [];
      }));
    },
  };
  const grouping = useGroupingController(api, sourceApi, groupingModel, prepared?.inputs ?? sourceRows ?? [], groupingSupported, viewRevision.current,
    { inputsReady: !remoteGrouping, ...(remoteGrouping ? { preview: previewGrouping } : {}) });
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
