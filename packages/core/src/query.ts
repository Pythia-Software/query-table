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
