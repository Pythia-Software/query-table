// query.ts — the canonical query state shape.
//
// We lean into SQL vocabulary at every layer (per design feedback): a QueryState
// reads top-to-bottom like the statement it compiles to —
//
//     SELECT <select>  WHERE <where>  ORDER BY <orderBy>  LIMIT <limit> OFFSET <offset>
//
// Both "what data" (where/orderBy/limit/offset) and "how viewed" (select +
// per-column width) can be serialized together when a consumer explicitly opts
// into URL synchronization.

/** All filter operators across both source projects, unioned. Every value can
 *  be NULL, so `is_null`/`is_not_null` are valid for every field type. */
export type FilterOp =
  // comparison — number / datetime (and =,!= for any scalar)
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  // text matching
  | "contains"
  | "starts_with"
  | "ends_with"
  // array (textarray) containment
  | "includes"
  // nullity — valid for EVERY type; for arrays, "empty" vs "non-empty"
  | "is_null"
  | "is_not_null";

/** A single AND-combined filter. `value` is always the raw string the UI
 *  captured; coercion to number/bool/date happens at apply/compile time based on
 *  the field's declared type (never on the value's runtime shape). Unused for
 *  the nullary ops (`is_null`/`is_not_null`). */
export interface WhereClause {
  field: string; // FieldDef.name
  op: FilterOp;
  value: string;
}

/** One ORDER BY term. Array order in `QueryState.orderBy` is the sort priority. */
export interface OrderByClause {
  field: string; // FieldDef.name (server may sort a different expr via FieldDef.sort.field)
  dir: "asc" | "desc";
  /** NULL placement. Omitted = "last" (the historical default both projects used,
   *  preserved so old `?q=` links round-trip identically). */
  nulls?: "first" | "last";
}

/** One column in the SELECT list, plus the view state that travels with it.
 *  Order in `QueryState.select` is the left-to-right display order. */
export interface SelectColumn {
  field: string; // FieldDef.name
  /** Pixel width override. Omitted = FieldDef.select.width, else the type default. */
  width?: number;
}

/** A single aggregate operation. `count` is the only op that needs no measure
 *  column (it counts rows); the rest reduce one column's values. The server-side
 *  matrix (backends/go aggOpAllowed + the TS AGG_OPS_BY_TYPE) decides which ops a
 *  field's type permits. */
export type AggOp = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";

/** One optional "metric" pinned above the table: a single aggregate over a single
 *  measure column, optionally broken down by one or more group columns.
 *
 *  Scope is deliberately the *whole filtered set* — the same WHERE as the table,
 *  but NOT its ORDER BY / LIMIT / OFFSET. It is always evaluated on the server
 *  (a real GROUP BY), so it reflects every matching row, not just the visible
 *  page. Lives inside QueryState so it round-trips through `?q=`, saved queries,
 *  and undo/redo for free — a saved query is a saved dashboard. */
export interface AggregationClause {
  /** Stable id; keys the metric panel and survives a `?q=` round-trip. */
  id: string;
  op: AggOp;
  /** Measure column (FieldDef.name). Omit only for `count` (⇒ COUNT(*)). */
  field?: string;
  /** Group-by columns, in axis order. `[]` = a single grand-total value.
   *  One ⇒ a list/bar breakdown; two ⇒ an x/y pivot; three+ ⇒ a flat table. */
  groupBy: string[];
  /** Panel header override; defaults to a derived label like "avg total". */
  label?: string;
}

export interface QueryState {
  /** Ordered SELECT list + per-column widths. Empty = the schema's default columns. */
  select: SelectColumn[];
  /** AND-combined filters. */
  where: WhereClause[];
  /** Multi-sort terms in priority order. Empty = the schema's default sort. */
  orderBy: OrderByClause[];
  /** Page size. */
  limit: number;
  /** Page offset (rows). */
  offset: number;
  /** Optional aggregate metrics shown above the table. Omitted/empty = none.
   *  Each runs as its own server GROUP BY over the WHERE-filtered set (no paging). */
  aggregations?: AggregationClause[];
}

/** A row's stable identity, used for selection and per-row refresh. */
export type RowId = string | number;

/** The query a fresh table starts from before schema defaults are layered on.
 *  Empty `select`/`orderBy`/`where` mean "defer to the schema", which also keeps
 *  encoded `?q=` tokens short (defaults are omitted). */
export const EMPTY_QUERY: QueryState = {
  select: [],
  where: [],
  orderBy: [],
  limit: 100,
  offset: 0,
};

/** Structural limits applied whenever query state crosses a trust boundary
 * (URL, storage, an imperative setQuery call, or a server projection). Row
 * limits may use the full safe-integer range; consumers and their backends own
 * any smaller operational cap appropriate for their dataset. */
export const MAX_QUERY_LIMIT = Number.MAX_SAFE_INTEGER;
export const MAX_QUERY_OFFSET = 1_000_000;
export const MAX_SELECT_COLUMNS = 200;
export const MAX_WHERE_CLAUSES = 100;
export const MAX_ORDER_BY_TERMS = 20;
export const MAX_AGGREGATIONS = 20;
export const MAX_GROUP_BY_FIELDS = 20;
export const MAX_QUERY_TOKEN_LENGTH = 2 * 1024 * 1024;

const MAX_FIELD_NAME_LENGTH = 256;
const MAX_FILTER_VALUE_LENGTH = 10_000;
const MAX_LABEL_LENGTH = 1_000;
const MIN_COLUMN_WIDTH = 24;
const MAX_COLUMN_WIDTH = 2_000;

const FILTER_OPS: ReadonlySet<string> = new Set([
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "starts_with",
  "ends_with",
  "includes",
  "is_null",
  "is_not_null",
]);

const AGG_OPS: ReadonlySet<string> = new Set(["count", "count_distinct", "sum", "avg", "min", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Convert unknown input into a bounded, structurally valid QueryState.
 * Invalid members are dropped; invalid scalar paging values use the supplied
 * fallback. This function is intentionally schema-agnostic—field allowlisting
 * still happens in toServerQuery and in the backend compiler. */
export function normalizeQueryState(input: unknown, fallback: QueryState = EMPTY_QUERY): QueryState {
  const raw = isRecord(input) ? input : {};

  const select: SelectColumn[] = [];
  if (Array.isArray(raw.select)) {
    for (const item of raw.select.slice(0, MAX_SELECT_COLUMNS)) {
      if (!isRecord(item)) continue;
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      if (!field) continue;
      const column: SelectColumn = { field };
      if (typeof item.width === "number" && Number.isFinite(item.width)) {
        column.width = boundedInteger(item.width, MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
      }
      select.push(column);
    }
  } else {
    select.push(...fallback.select.map((column) => ({ ...column })));
  }

  const where: WhereClause[] = [];
  if (Array.isArray(raw.where)) {
    for (const item of raw.where.slice(0, MAX_WHERE_CLAUSES)) {
      if (!isRecord(item)) continue;
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      const value = typeof item.value === "string" && item.value.length <= MAX_FILTER_VALUE_LENGTH ? item.value : null;
      if (!field || typeof item.op !== "string" || !FILTER_OPS.has(item.op) || value == null) continue;
      where.push({ field, op: item.op as FilterOp, value });
    }
  } else {
    where.push(...fallback.where.map((clause) => ({ ...clause })));
  }

  const orderBy: OrderByClause[] = [];
  if (Array.isArray(raw.orderBy)) {
    for (const item of raw.orderBy.slice(0, MAX_ORDER_BY_TERMS)) {
      if (!isRecord(item)) continue;
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      if (!field || (item.dir !== "asc" && item.dir !== "desc")) continue;
      const term: OrderByClause = { field, dir: item.dir };
      if (item.nulls === "first" || item.nulls === "last") term.nulls = item.nulls;
      orderBy.push(term);
    }
  } else {
    orderBy.push(...fallback.orderBy.map((term) => ({ ...term })));
  }

  const out: QueryState = {
    select,
    where,
    orderBy,
    limit: boundedInteger(raw.limit, fallback.limit, 1, MAX_QUERY_LIMIT),
    offset: boundedInteger(raw.offset, fallback.offset, 0, MAX_QUERY_OFFSET),
  };

  if (Array.isArray(raw.aggregations)) {
    const aggregations: AggregationClause[] = [];
    for (const item of raw.aggregations.slice(0, MAX_AGGREGATIONS)) {
      if (!isRecord(item)) continue;
      const id = boundedString(item.id, MAX_FIELD_NAME_LENGTH);
      if (!id || typeof item.op !== "string" || !AGG_OPS.has(item.op) || !Array.isArray(item.groupBy)) continue;
      const groupBy = item.groupBy
        .slice(0, MAX_GROUP_BY_FIELDS)
        .map((field) => boundedString(field, MAX_FIELD_NAME_LENGTH))
        .filter((field): field is string => field != null);
      const aggregation: AggregationClause = { id, op: item.op as AggOp, groupBy };
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      const label = boundedString(item.label, MAX_LABEL_LENGTH);
      if (field) aggregation.field = field;
      if (label) aggregation.label = label;
      aggregations.push(aggregation);
    }
    if (aggregations.length > 0) out.aggregations = aggregations;
  } else if (fallback.aggregations?.length) {
    out.aggregations = fallback.aggregations.map((aggregation) => ({ ...aggregation, groupBy: [...aggregation.groupBy] }));
  }

  return out;
}

/** Structural equality on two queries — used to decide whether a `?q=` write or a
 *  refetch is actually needed (avoids history spam / redundant fetches). */
export function queriesEqual(a: QueryState, b: QueryState): boolean {
  if (a === b) return true;
  if (a.limit !== b.limit || a.offset !== b.offset) return false;
  if (!sameArray(a.where, b.where)) return false;
  if (!sameArray(a.orderBy, b.orderBy)) return false;
  if (!sameArray(a.select, b.select)) return false;
  if (!sameArray(a.aggregations ?? [], b.aggregations ?? [])) return false;
  return true;
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Members are flat records of primitives — JSON compare is correct and cheap here.
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}
