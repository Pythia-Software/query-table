import type { MetricKey, MetricValue, MetricScope, MetricDistributionResult, MetricDiagnostic } from "./metricTypes";
import { deflateSync, Inflate } from "fflate";
import { createSetFilter, readSetFilter } from "./setFilter";
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

import { EMPTY_QUERY, MAX_QUERY_TOKEN_LENGTH, normalizeQueryState, predicatesOf } from "./query";
import { stripSetFilter } from "./setFilter";
import type { QueryState, WhereTerm, OrderByClause, SelectColumn, AggregationClause, SetFilterMode } from "./query";
import type { FieldSchema, FieldDef } from "./schema";
import type { CellDisplay } from "./cellDisplay";
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
//   s = select (as [field], [field, width] or [field, width | null, display]
//       tuples; older decoders read the first two members and ignore display)
//   w = where, o = orderBy, l = limit, f = offset
//   fs = fit to the viewer's screen

type CompactColumn = [string] | [string, number] | [string, number | null, CellDisplay];

interface CompactQuery {
  s?: CompactColumn[] | string[]; // string[] = legacy
  w?: WhereTerm[];
  o?: OrderByClause[] | OrderByClause; // object accepted for legacy decode
  l?: number;
  f?: number;
  g?: AggregationClause[]; // aggregation metrics (omitted when none)
  d?: QueryState["itemDetails"];
  c?: string[]; // legacy alias for select column names
  fs?: boolean;
  b?: QueryState["grouping"];
}

/** Canonical query projected into the URL wire form. */
function compactQuery(q: QueryState): CompactQuery {
  q = normalizeQueryState(q);
  const c: CompactQuery = {};
  if (q.select.length)
    c.s = q.select.map((col): CompactColumn =>
      col.display ? [col.field, col.width ?? null, col.display]
        : col.width != null ? [col.field, col.width] : [col.field]);
  if (q.where.length) c.w = q.where;
  if (q.orderBy.length) c.o = q.orderBy;
  c.l = q.limit;
  if (q.offset) c.f = q.offset;
  if (q.aggregations?.length) c.g = q.aggregations;
  if (q.itemDetails) c.d = q.itemDetails;
  if (q.fitToScreen) c.fs = true;
  if (q.grouping) c.b = q.grouping;
  return c;
}

export const MAX_QUERY_STATE_BYTES = 4 * 1024 * 1024;
export class QueryDecodeError extends Error {
  constructor(public readonly code: "invalid" | "too_large" | "unsupported_version", message: string) {
    super(message); this.name = "QueryDecodeError";
  }
}

// v2 keeps execution state unchanged, but represents intact set editors once.
// Equal property layouts share one entry rather than repeating every modality.
function packQuery(c: CompactQuery): Record<string, unknown> {
  const packed: Record<string, unknown> = { ...c };
  if (c.l === EMPTY_QUERY.limit) delete packed.l;
  if (c.w) {
    const terms: unknown[] = [];
    for (let i = 0; i < c.w.length; i++) {
      const set = readSetFilter(c.w, i);
      if (set) {
        terms.push(["set", set.field, set.metadata.mode, set.metadata.values, set.metadata.id]);
        i += set.count - 1;
      } else terms.push(c.w[i]);
    }
    packed.w = terms;
  }
  if (c.d?.views) {
    const pool: unknown[] = [];
    const refs: Record<string, number> = {};
    for (const [mode, view] of Object.entries(c.d.views)) {
      let index = pool.findIndex(v => JSON.stringify(v) === JSON.stringify(view));
      if (index < 0) { index = pool.length; pool.push(view); }
      refs[mode] = index;
    }
    packed.d = { ...c.d, views: { pool, refs } };
  }
  return packed;
}

function unpackQuery(c: Record<string, unknown>): CompactQuery {
  if (Array.isArray(c.w)) c.w = c.w.flatMap((term: unknown) => {
    if (!Array.isArray(term)) return [term];
    if (term.length !== 5 || term[0] !== "set" || typeof term[1] !== "string" ||
      typeof term[2] !== "string" || !["any", "all", "none", "empty"].includes(term[2]) || !Array.isArray(term[3]) ||
      term[3].length > 100 || !term[3].every((v: unknown) => typeof v === "string" && v.length <= 10000) || typeof term[4] !== "string")
      throw new QueryDecodeError("invalid", "Invalid set filter in query link.");
    return createSetFilter(term[1], term[2] as SetFilterMode, term[3] as string[], term[4]);
  });
  const details = c.d;
  const views = details && typeof details === "object" && "views" in details ? details.views : undefined;
  if (details && typeof details === "object" && views && typeof views === "object" && "pool" in views) {
    const pool = views.pool;
    const refs = "refs" in views ? views.refs : undefined;
    if (!Array.isArray(pool) || pool.length > 3 || !refs || typeof refs !== "object" || Array.isArray(refs))
      throw new QueryDecodeError("invalid", "Invalid property views in query link.");
    c.d = { ...details, views: Object.fromEntries(Object.entries(refs).map(([mode, index]) => {
      if (!["hover", "modal", "expand"].includes(mode) || !Number.isInteger(index) || (index as number) < 0 || (index as number) >= pool.length)
        throw new QueryDecodeError("invalid", "Invalid property view reference.");
      return [mode, pool[index as number]];
    })) };
  }
  return c as CompactQuery;
}

/** v2 JSON or raw-DEFLATE UTF-8, whichever produces the shorter URL token. */
export function encodeQuery(q: QueryState): string {
  const json = JSON.stringify(packQuery(compactQuery(q)));
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_QUERY_STATE_BYTES) throw new QueryDecodeError("too_large", "Query state exceeds the storage limit.");
  const plain = "2j." + toBase64Url(json);
  const compressed = "2d." + bytesToBase64(deflateSync(bytes));
  const token = compressed.length < plain.length ? compressed : plain;
  if (token.length > MAX_QUERY_TOKEN_LENGTH) throw new QueryDecodeError("too_large", "Encoded query state exceeds the storage limit.");
  return token;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function inflateToken(token: string): string {
  const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  const input = Uint8Array.from(bin, c => c.charCodeAt(0));
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const stream = new Inflate((chunk, final) => {
    size += chunk.length;
    if (size > MAX_QUERY_STATE_BYTES) throw new QueryDecodeError("too_large", "Expanded query state exceeds the storage limit.");
    chunks.push(chunk); complete = final;
  });
  // Small input chunks bound allocations before the expanded-size check.
  for (let i = 0; i < input.length; i += 256) stream.push(input.subarray(i, i + 256), i + 256 >= input.length);
  if (!complete) throw new QueryDecodeError("invalid", "Incomplete compressed query link.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** base64url token → QueryState. Tolerant: bad input and legacy shapes both
 *  normalize to a valid QueryState (never throws). */
export function decodeQuery(token: string): QueryState {
  try { return decodeToken(token, false); } catch { return { ...EMPTY_QUERY }; }
}

/** Navigation uses this decoder so corrupt links cannot silently run defaults. */
export function decodeQueryStrict(token: string): QueryState {
  return decodeToken(token, true);
}
function decodeToken(token: string, strict: boolean): QueryState {
  if (!token) return { ...EMPTY_QUERY };
  if (token.length > MAX_QUERY_TOKEN_LENGTH) throw new QueryDecodeError("too_large", "Query link exceeds the storage limit.");
  try {
    const versioned = token.includes(".");
    if (versioned && !token.startsWith("2j.") && !token.startsWith("2d."))
      throw new QueryDecodeError("unsupported_version", "Unsupported query link version.");
    const payload = versioned ? token.slice(3) : token;
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw new QueryDecodeError("invalid", "Invalid query link encoding.");
    const json = token.startsWith("2d.") ? inflateToken(payload) : fromBase64Url(payload);
    if (new TextEncoder().encode(json).length > MAX_QUERY_STATE_BYTES) throw new QueryDecodeError("too_large", "Query state exceeds the storage limit.");
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || ["w", "g"].some(k => raw[k] !== undefined && !Array.isArray(raw[k])))
      throw new QueryDecodeError("invalid", "Invalid query link state.");
    const c = versioned ? unpackQuery(raw) : raw as CompactQuery;
    if (strict && c.w) {
      if (c.w.some((term: WhereTerm) => !term || typeof term !== "object")) throw new QueryDecodeError("invalid", "Invalid query predicates.");
      const count = c.w.reduce((n: number, term: WhereTerm) => n + predicatesOf(term).length, 0);
      const normalized = normalizeQueryState({ where: c.w });
      const normalizedCount = normalized.where.reduce((n, term) => n + predicatesOf(term).length, 0);
      if (count > 100 || count !== normalizedCount || c.w.some((term: WhereTerm) => predicatesOf(term).some(clause =>
        !clause || typeof clause !== "object" || (clause.negated !== undefined && typeof clause.negated !== "boolean"))))
        throw new QueryDecodeError("invalid", "Invalid query predicates or predicate budget exceeded.");
    }
    const out = normalizeQueryState({
      select: normalizeSelect(c.s ?? c.c),
      where: Array.isArray(c.w) ? c.w : [],
      orderBy: normalizeOrderBy(c.o),
      limit: c.l,
      offset: c.f,
      aggregations: c.g,
      itemDetails: c.d,
      fitToScreen: c.fs,
      grouping: c.b,
    });
    if (strict && c.g && out.aggregations?.length !== c.g.length) throw new QueryDecodeError("invalid", "Invalid query metrics.");
    return out;
  } catch (error) {
    if (error instanceof QueryDecodeError) throw error;
    throw new QueryDecodeError("invalid", "Invalid or incomplete query link.");
  }
}

function normalizeSelect(s: CompactQuery["s"] | CompactQuery["c"]): SelectColumn[] {
  if (!Array.isArray(s)) return [];
  return s
    .map((item): SelectColumn | null => {
      if (typeof item === "string") return { field: item }; // legacy string[]
      if (Array.isArray(item) && typeof item[0] === "string") {
        const column: SelectColumn = { field: item[0] };
        if (typeof item[1] === "number") column.width = item[1];
        // normalizeQueryState validates the display and drops a malformed one.
        if (item[2] !== undefined) column.display = item[2] as CellDisplay;
        return column;
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
  /** only terms whose every predicate is on a pushdown-filterable field. */
  where: WhereTerm[];
  /** only terms on server-sortable fields, with `field` already remapped to the
   *  field's server sort key (FieldDef.sort.field) when set. */
  orderBy: OrderByClause[];
  limit: number;
  offset: number;
}

/** Project a QueryState into the server request, dropping client-only filters,
 *  client-only sorts, and remapping sort fields through `sort.field`. */
export function toServerQuery<Row>(q: QueryState, schema: FieldSchema<Row>): ServerQuery {
  if (q.grouping) throw new Error("This transport does not support grouped queries. Enable the v3 query executor.");
  q = normalizeQueryState(q);
  const byName = indexFields(schema);
  const resolveField = (name: string) => resolveFieldName(schema, name) ?? name;

  const where = q.where.filter((term) => termIsPushdown(term, byName, resolveField)).map(stripSetFilter);

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
  for (const field of selectedFields(schema, q)) {
    if (field.source.kind === "derived") {
      for (const name of field.source.dependencies ?? []) {
        if (byName.get(name)?.source.kind === "backend") select.add(name);
      }
    }
  }
  select.add(schema.idField);
  for (const term of q.where) {
    for (const cl of predicatesOf(term)) {
      const field = resolveField(cl.field);
      const f = byName.get(field);
      if (f && isFilterable(f) && !isPushdownFilter(f) && f.source.kind === "backend") select.add(field);
    }
  }

  return { select: [...select].sort(), where, orderBy, limit: q.limit, offset: q.offset };
}

/** A term can push down only if EVERY predicate it contains is on a
 *  pushdown-filterable field. An OR group is all-or-nothing: dropping one
 *  disjunct would change the set the group matches, so a group with any
 *  non-pushdown member stays client-side in full. */
function termIsPushdown<Row>(
  term: WhereTerm,
  byName: Map<string, FieldDef<Row>>,
  resolveField: (name: string) => string,
): boolean {
  return predicatesOf(term).every((cl) => {
    const f = byName.get(resolveField(cl.field));
    return f != null && isPushdownFilter(f);
  });
}

// ---- aggregation server subset --------------------------------------------

/** The backend request for the metric panel. Scope is the whole filtered set:
 *  the SAME pushdown WHERE as the rows query, but NO ORDER BY / LIMIT / OFFSET —
 *  metrics describe every matching row, not the visible page. Mirrors the Go
 *  AggSpec list. */
export interface AggregationRequest {
  diagnostics?: MetricDiagnostic[];
  where: WhereTerm[];
  aggregations: AggregationClause[];
}

/** One group's result. `keys` has one entry per AggregationClause.groupBy field,
 *  in axis order (`[]` for a grand total); a null key is the NULL/empty bucket. */
export interface AggregationBucket {
  keys: MetricKey[];
  error?: string;
  y?: MetricValue;
  yError?: string;
  components?: {expression:string; value:MetricValue}[];
  nullCount?: number;
  inputErrorCount?: number;
  distribution?: MetricDistributionResult;
  /** The metric: a number for count/sum/avg, or the column's value for min/max
   *  (which may be a string for text/datetime). null when undefined (e.g. avg of
   *  an all-null column). */
  value: MetricValue;
  /** COUNT(*) of rows in the group — always present, even when `value` isn't a
   *  count, so the panel can show group sizes / shares. */
  count: number;
}

export interface AggregationResultEntry {
  /** Exact omitted additive quantity; unavailable for ratios/averages/distinct. */
  other?: AggregationBucket;
  error?: string;
  scope?: MetricScope;
  processedRows?: number;
  groupCount?: number;
  coverage?: "exact" | "partial";
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
  if (q.grouping) throw new Error("Metrics over grouped rows require grouped-query execution.");
  const suppliedPredicateCount = q.where.reduce((n,t)=>n+predicatesOf(t).length,0);
  q = normalizeQueryState(q);
  if (q.aggregations?.some(a => a.dateGrouping)) throw new Error("Date grouping currently requires local metric execution.");
  if (q.aggregations?.some(a => a.diagnostics?.length || a.expression !== undefined || a.expressionY !== undefined || a.distribution || a.scope === "shownRows" || a.sort?.length || a.groupLimit)) throw new Error("Metric definition requires the version 2 metric transport.");
  const byName = indexFields(schema);
  const resolveField = (name: string) => resolveFieldName(schema, name) ?? name;

  const where = q.where.filter((term) => termIsPushdown(term, byName, resolveField)).map(stripSetFilter);

  const isBackend = (name: string | undefined): boolean => {
    if (name == null) return true; // omitted measure (count(*)) is fine
    const field = resolveField(name);
    const f = byName.get(field);
    return f != null && f.source.kind === "backend";
  };

  const aggregations = (q.aggregations ?? []).filter(
    (a) => isBackend(a.field) && a.groupBy.every((g) => isBackend(g)),
  );

  const diagnostics: MetricDiagnostic[] = [];
  for (const c of q.aggregations ?? []) if (!aggregations.includes(c)) diagnostics.push({ metricId: c.id, code: "unsupported_metric", message: "Metric requires unavailable backend fields.", from: 0, to: 1 });
  if (where.length !== q.where.length || suppliedPredicateCount !== q.where.reduce((n,t)=>n+predicatesOf(t).length,0)) diagnostics.push({ code: "residual_filter", message: "All-matching metrics are unavailable with residual client-only filters.", from: 0, to: 1 });
  return { where, aggregations, ...(diagnostics.length ? { diagnostics } : {}) };
}
