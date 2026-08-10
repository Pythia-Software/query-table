// encode.ts — URL serialization + the server-bound query subset.
//
// Two distinct serializations, deliberately kept apart:
//
//   1. encodeQuery / decodeQuery  — the *whole* QueryState (incl. view state:
//      select columns + widths) ⇄ a base64url `?q=` token. This is what makes
//      reload, back/forward, bookmarks, and "send a coworker your view" all work
//      (decisions #4 + #5). Defaults are omitted to keep the token short.
//
//   2. toServerQuery              — the subset the backend acts on: pushdown
//      WHERE clauses, server-sortable ORDER BY (remapped through sort.field), the
//      page window, and the field names to SELECT (so the backend evaluates the
//      computed/synthetic columns the view needs — requested ∪ always-needed,
//      design decision #2). Per-column widths never leave the client.
//
// Back-compat: decodeQuery accepts legacy compact shapes: `o` as a single
// object (pre-multi-sort) and `c`/`s` as a string[] (pre-width).

import { EMPTY_QUERY, MAX_QUERY_TOKEN_LENGTH, normalizeQueryState } from "./query";
import type { QueryState, WhereClause, OrderByClause, SelectColumn, AggregationClause } from "./query";
import type { FieldSchema } from "./schema";
import { indexFields, isFilterable, isPushdownFilter, isSortable, resolveFieldName, selectedFields } from "./schema";

// ---- base64url (browser + node) -------------------------------------------

function toBase64Url(json: string): string {
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(json, "utf8").toString("base64");
  } else {
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    b64 = btoa(bin);
  }
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- compact wire form ----------------------------------------------------
// Keys are short to keep `?q=` small; any field at its default is omitted.
//   s = select (as [field] or [field, width] tuples)
//   w = where, o = orderBy, l = limit, f = offset

interface CompactQuery {
  s?: Array<[string] | [string, number]> | string[]; // string[] = legacy
  w?: WhereClause[];
  o?: OrderByClause[] | OrderByClause; // object accepted for legacy decode
  l?: number;
  f?: number;
  g?: AggregationClause[]; // aggregation metrics (omitted when none)
  c?: string[]; // legacy alias for select column names
}

/** QueryState → base64url token (omitting defaults). All-default query → "". */
export function encodeQuery(q: QueryState): string {
  q = normalizeQueryState(q);
  const c: CompactQuery = {};
  if (q.select.length)
    c.s = q.select.map((col): [string] | [string, number] => (col.width != null ? [col.field, col.width] : [col.field]));
  if (q.where.length) c.w = q.where;
  if (q.orderBy.length) c.o = q.orderBy;
  c.l = q.limit;
  if (q.offset) c.f = q.offset;
  if (q.aggregations?.length) c.g = q.aggregations;
  if (Object.keys(c).length === 0) return "";
  return toBase64Url(JSON.stringify(c));
}

/** base64url token → QueryState. Tolerant: bad input and legacy shapes both
 *  normalize to a valid QueryState (never throws). */
export function decodeQuery(token: string): QueryState {
  if (!token) return { ...EMPTY_QUERY };
  if (token.length > MAX_QUERY_TOKEN_LENGTH) return { ...EMPTY_QUERY };
  try {
    const c = JSON.parse(fromBase64Url(token)) as CompactQuery;
    const out = normalizeQueryState({
      select: normalizeSelect(c.s ?? c.c),
      where: Array.isArray(c.w) ? c.w : [],
      orderBy: normalizeOrderBy(c.o),
      limit: c.l,
      offset: c.f,
      aggregations: c.g,
    });
    return out;
  } catch {
    return { ...EMPTY_QUERY };
  }
}

function normalizeSelect(s: CompactQuery["s"] | CompactQuery["c"]): SelectColumn[] {
  if (!Array.isArray(s)) return [];
  return s
    .map((item): SelectColumn | null => {
      if (typeof item === "string") return { field: item }; // legacy string[]
      if (Array.isArray(item) && typeof item[0] === "string") {
        return typeof item[1] === "number" ? { field: item[0], width: item[1] } : { field: item[0] };
      }
      return null;
    })
    .filter((x): x is SelectColumn => x != null);
}

function normalizeOrderBy(o: CompactQuery["o"]): OrderByClause[] {
  if (!o) return [];
  if (Array.isArray(o)) return o;
  return [o]; // legacy single-object form → one-element array
}

// ---- server-bound subset --------------------------------------------------

/** The backend request derived from a QueryState + its schema. Mirrors the Go
 *  `WireQuery`. View-only state (column widths) is intentionally absent. */
export interface ServerQuery {
  /** field names to return — visible columns ∪ fields referenced by where/orderBy. */
  select: string[];
  /** only clauses on pushdown-filterable fields. */
  where: WhereClause[];
  /** only terms on server-sortable fields, with `field` already remapped to the
   *  field's server sort key (FieldDef.sort.field) when set. */
  orderBy: OrderByClause[];
  limit: number;
  offset: number;
}

/** Project a QueryState into the server request, dropping client-only filters,
 *  client-only sorts, and remapping sort fields through `sort.field`. */
export function toServerQuery<Row>(q: QueryState, schema: FieldSchema<Row>): ServerQuery {
  q = normalizeQueryState(q);
  const byName = indexFields(schema);
  const resolveField = (name: string) => resolveFieldName(schema, name) ?? name;

  const where = q.where.filter((cl) => {
    const field = resolveField(cl.field);
    const f = byName.get(field);
    return f != null && isPushdownFilter(f);
  });

  const orderBy: OrderByClause[] = [];
  for (const term of q.orderBy) {
    const field = resolveField(term.field);
    const f = byName.get(field);
    if (!f || !isSortable(f) || f.source.kind !== "backend") continue;
    orderBy.push({ ...term, field: f.sort?.field ?? f.name });
  }

  // SELECT = the BACKEND columns the response rows must carry: visible backend
  // columns, the id (for selection/refresh), and any backend column a
  // CLIENT-SIDE filter reads. Derived/render-only columns are computed on the
  // client and have no SQL to select; pushdown filters/sorts run in SQL and need
  // not be returned (design decision #2: requested ∪ always-needed).
  const select = new Set<string>(
    selectedFields(schema, q)
      .filter((f) => f.source.kind === "backend")
      .map((f) => f.name),
  );
  select.add(schema.idField);
  for (const cl of q.where) {
    const field = resolveField(cl.field);
    const f = byName.get(field);
    if (f && isFilterable(f) && !isPushdownFilter(f) && f.source.kind === "backend") select.add(field);
  }

  return { select: [...select], where, orderBy, limit: q.limit, offset: q.offset };
}

// ---- aggregation server subset --------------------------------------------

/** The backend request for the metric panel. Scope is the whole filtered set:
 *  the SAME pushdown WHERE as the rows query, but NO ORDER BY / LIMIT / OFFSET —
 *  metrics describe every matching row, not the visible page. Mirrors the Go
 *  AggSpec list. */
export interface AggregationRequest {
  where: WhereClause[];
  aggregations: AggregationClause[];
}

/** One group's result. `keys` has one entry per AggregationClause.groupBy field,
 *  in axis order (`[]` for a grand total); a null key is the NULL/empty bucket. */
export interface AggregationBucket {
  keys: (string | null)[];
  /** The metric: a number for count/sum/avg, or the column's value for min/max
   *  (which may be a string for text/datetime). null when undefined (e.g. avg of
   *  an all-null column). */
  value: number | string | null;
  /** COUNT(*) of rows in the group — always present, even when `value` isn't a
   *  count, so the panel can show group sizes / shares. */
  count: number;
}

export interface AggregationResultEntry {
  /** Echoes AggregationClause.id. */
  id: string;
  buckets: AggregationBucket[];
}

export interface AggregationResult {
  /** One entry per requested aggregation, in request order. */
  metrics: AggregationResultEntry[];
}

/** Project a QueryState into the metric request: the pushdown WHERE subset (same
 *  rule as toServerQuery) plus the aggregations whose measure + group fields are
 *  all server-capable backend columns. Aggregations referencing a derived /
 *  unknown field are dropped — the server has no SQL for them. */
export function toAggregationQuery<Row>(q: QueryState, schema: FieldSchema<Row>): AggregationRequest {
  q = normalizeQueryState(q);
  const byName = indexFields(schema);
  const resolveField = (name: string) => resolveFieldName(schema, name) ?? name;

  const where = q.where.filter((cl) => {
    const f = byName.get(resolveField(cl.field));
    return f != null && isPushdownFilter(f);
  });

  const isBackend = (name: string | undefined): boolean => {
    if (name == null) return true; // omitted measure (count(*)) is fine
    const field = resolveField(name);
    const f = byName.get(field);
    return f != null && f.source.kind === "backend";
  };

  const aggregations = (q.aggregations ?? []).filter(
    (a) => isBackend(a.field) && a.groupBy.every((g) => isBackend(g)),
  );

  return { where, aggregations };
}
