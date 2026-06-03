// adapters.ts — the pluggable seams. Everything project-specific is injected
// here so the package core stays generic.
//
//   - Transport     : how rows + filter-value suggestions are fetched.
//   - StorageAdapter: where saved/last queries live (localStorage default;
//                     backend-backed when the data layer provides one).

import type { QueryState, RowId } from "./query";
import type { ServerQuery, AggregationRequest, AggregationResult } from "./encode";

// ---- Transport ------------------------------------------------------------

export interface FetchRowsResult<Row> {
  rows: Row[];
  /** Total matching rows before pagination (for "N of M" + paging bounds). */
  total: number;
}

/** A keystroke-driven distinct-value lookup. Autocomplete is the DEFAULT value
 *  source for every field (design feedback), so this is how the filter combobox
 *  finds options. `search` is the user's current input; the backend returns the
 *  best matches and whether it truncated (so the UI can prompt "keep typing"). */
export interface DistinctValuesQuery {
  field: string;
  /** Current substring/prefix the user has typed (empty = top values). */
  search: string;
  /** Max suggestions to return (default chosen by the adapter, ~50). */
  limit?: number;
}

export interface DistinctValuesResult {
  values: string[];
  /** true when more matches exist than were returned — refine by typing. */
  hasMore: boolean;
  /** True if the selected field has at least one NULL in the source dataset.
   *  False if that field is guaranteed non-null. Omitted when the backend does
   *  not compute this metadata. */
  hasNull?: boolean;
}

/** Per-field metadata for the field picker (xlsx-collect's distinct/min/max). */
export interface FieldStats {
  distinct?: number;
  min?: string | number;
  max?: string | number;
}

export interface Transport<Row = any> {
  /** Run a server query. The only required method — a purely client-side table
   *  can omit a Transport entirely and rely on applyQuery over local rows. */
  fetchRows(query: ServerQuery, signal?: AbortSignal): Promise<FetchRowsResult<Row>>;

  /** Distinct values for filter autocomplete. Strongly recommended: without it,
   *  fields fall back to freeform input. The backend should match `search`
   *  server-side (e.g. ILIKE prefix) and cap at `limit` so large domains stay
   *  fast and refine per keystroke. */
  fetchDistinctValues?(q: DistinctValuesQuery, signal?: AbortSignal): Promise<DistinctValuesResult>;

  /** Run the metric panel's GROUP BY queries (one per requested aggregation),
   *  scoped to the WHERE-filtered set with no paging. Optional: without it, the
   *  metric panel falls back to applyAggregations over local rows (client mode).
   *  Implementations compile each AggSpec with backends/go CompileAggregation,
   *  sharing the same WHERE as fetchRows. */
  fetchAggregations?(q: AggregationRequest, signal?: AbortSignal): Promise<AggregationResult>;

  /** Re-fetch a single row by id, for in-place updates without a full re-query
   *  (xlsx-collect's per-row refresh). Optional. */
  fetchRow?(id: RowId, signal?: AbortSignal): Promise<Row | null>;

  /** Stats for the field picker. Optional. */
  fetchFieldStats?(fields: string[], signal?: AbortSignal): Promise<Record<string, FieldStats>>;
}

// ---- Saved queries --------------------------------------------------------

export interface SavedQuery {
  id: string;
  name: string;
  /** Epoch millis; injected by the caller so core stays deterministic/testable. */
  savedAt: number;
  query: QueryState;
}

/** Persistence for the "last" query (auto-restored) and named saved queries. All
 *  methods are namespaced by `key` (the schema/dataset name) so multiple tables
 *  on one origin don't collide. Async to allow backend implementations; the
 *  default localStorage adapter resolves synchronously. */
export interface StorageAdapter {
  loadLast(key: string): Promise<QueryState | null>;
  saveLast(key: string, query: QueryState): Promise<void>;

  listSaved(key: string): Promise<SavedQuery[]>;
  /** Load the saved query selected as the default view for this key. Optional so
   *  existing backend adapters keep working until they add first-class support. */
  loadDefaultSaved?(key: string): Promise<SavedQuery | null>;
  /** Set or clear the saved query used as the default view for this key. */
  setDefaultSaved?(key: string, id: string | null): Promise<void>;
  /** Persist a named query snapshot. Rejects when a saved query with the same
   *  name already exists in the key namespace. */
  saveNamed(key: string, name: string, query: QueryState, savedAt: number): Promise<SavedQuery>;
  deleteSaved(key: string, id: string): Promise<void>;
}

const LAST_PREFIX = "query-table:last:";
const SAVED_PREFIX = "query-table:saved:";
const DEFAULT_PREFIX = "query-table:default:";

/** Default StorageAdapter over window.localStorage. Returns a no-op adapter when
 *  localStorage is unavailable (SSR / sandboxed). */
export function localStorageAdapter(): StorageAdapter {
  const ls: Storage | null = (() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null; // access can throw in some sandboxes
    }
  })();

  const readSaved = (key: string): SavedQuery[] => {
    if (!ls) return [];
    try {
      const raw = ls.getItem(SAVED_PREFIX + key);
      const arr = raw ? (JSON.parse(raw) as SavedQuery[]) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  const writeSaved = (key: string, items: SavedQuery[]): void => {
    if (ls) ls.setItem(SAVED_PREFIX + key, JSON.stringify(items));
  };
  const readDefaultId = (key: string): string | null => {
    if (!ls) return null;
    return ls.getItem(DEFAULT_PREFIX + key);
  };
  const writeDefaultId = (key: string, id: string | null): void => {
    if (!ls) return;
    if (id) ls.setItem(DEFAULT_PREFIX + key, id);
    else ls.removeItem(DEFAULT_PREFIX + key);
  };

  return {
    async loadLast(key) {
      if (!ls) return null;
      try {
        const raw = ls.getItem(LAST_PREFIX + key);
        return raw ? (JSON.parse(raw) as QueryState) : null;
      } catch {
        return null;
      }
    },
    async saveLast(key, query) {
      if (ls) ls.setItem(LAST_PREFIX + key, JSON.stringify(query));
    },
    async listSaved(key) {
      return readSaved(key).sort((a, b) => b.savedAt - a.savedAt);
    },
    async loadDefaultSaved(key) {
      const id = readDefaultId(key);
      if (!id) return null;
      const found = readSaved(key).find((q) => q.id === id);
      if (!found) writeDefaultId(key, null);
      return found ?? null;
    },
    async setDefaultSaved(key, id) {
      if (id && !readSaved(key).some((q) => q.id === id)) {
        throw new Error(`Saved query "${id}" does not exist.`);
      }
      writeDefaultId(key, id);
    },
    async saveNamed(key, name, query, savedAt) {
      const items = readSaved(key);
      if (items.some((q) => q.name === name)) {
        throw new Error(`Saved query "${name}" already exists.`);
      }
      const item: SavedQuery = { id: `${savedAt}-${Math.round((savedAt * 9301 + 49297) % 233280)}`, name, savedAt, query };
      items.push(item);
      writeSaved(key, items);
      return item;
    },
    async deleteSaved(key, id) {
      writeSaved(
        key,
        readSaved(key).filter((q) => q.id !== id),
      );
      if (readDefaultId(key) === id) writeDefaultId(key, null);
    },
  };
}
