// query.ts — the canonical query state shape.
//
// We lean into SQL vocabulary at every layer (per design feedback): a QueryState
// reads top-to-bottom like the statement it compiles to —
//
//     SELECT <select>  WHERE <where>  ORDER BY <orderBy>  LIMIT <limit> OFFSET <offset>
//
// Both "what data" (where/orderBy/limit/offset) and "how viewed" (select +
// per-column width) are serialized together so one URL reproduces the same table
// for any user on any device (decision #5).
//
// This shape is the union of the two sibling tables it replaces, with three
// deliberate upgrades over both: multi-sort (`orderBy` is an array), per-column
// width travels in `select`, and the full op set of both projects is merged.

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
