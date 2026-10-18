import { normalizePropertyView, type PropertyViewState } from "./properties";
import type { MetricDisplay, MetricLayout, MetricDistribution, MetricSort, MetricScope, MetricDateGrouping } from "./metricTypes";
import { normalizeMetricOptions } from "./metricNormalize";
import type { GroupingState, SummaryColumn, RepresentativeOrder } from "./grouping";
import { parseCellDisplay, type CellDisplay } from "./cellDisplay";
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
  | "matches_regex"
  | "not_matches_regex"
  | "length_gt"
  | "length_lt"
  | "length_eq"
  // array (textarray) containment
  | "includes"
  // nullity — valid for EVERY type; for arrays, "empty" vs "non-empty"
  | "is_null"
  | "is_not_null";

/** A single filter predicate (a "literal" in CNF terms). `value` is always the
 *  raw string the UI captured; coercion to number/bool/date happens at
 *  apply/compile time based on the field's declared type (never on the value's
 *  runtime shape). Datetime comparisons also accept signed duration offsets
 *  such as "-1h" or "+8d2h10m", resolved relative to execution time.
 *  Unused for the nullary ops (`is_null`/`is_not_null`).
 *
 *  `negated` wraps the predicate in a logical NOT. It is only ever set for ops
 *  that have no complementary operator (`contains`/`starts_with`/`ends_with`/
 *  `includes`); ops with a complement negate by flipping the op itself (`>=`→`<`,
 *  `=`→`!=`, `is_null`→`is_not_null`, `matches_regex`→`not_matches_regex`) — see
 *  `negateClause` in ops.ts. NOT is null-exclusive: a NULL/empty value satisfies
 *  neither the predicate nor its negation, matching `not_matches_regex`. */
export interface WhereClause {
  field: string; // FieldDef.name
  op: FilterOp;
  value: string;
  negated?: boolean;
  setFilter?: SetFilterMetadata;
}

export type SetFilterMode = "any" | "all" | "none" | "empty";

/** Presentation-only identity; execution always uses the accompanying predicates. */
export interface SetFilterMetadata {
  id: string;
  mode: SetFilterMode;
  values: string[];
}

/** A disjunction of predicates — the inner OR of conjunctive normal form. Every
 *  member is a plain literal; nesting is intentionally not allowed yet (CNF
 *  only), but the object shape leaves room to grow. */
export interface OrGroup {
  any: WhereClause[];
  setFilter?: SetFilterMetadata;
}

/** One conjunct of the WHERE clause: either a single predicate or an OR group.
 *  `QueryState.where` is the AND of these terms, so the whole WHERE is
 *  conjunctive normal form — `(a) AND (b OR c) AND (d)`. A bare literal is
 *  equivalent to a one-element OR group; normalization flattens singleton groups
 *  back to a literal so equality/encoding stay canonical. */
export type WhereTerm = WhereClause | OrGroup;

/** Narrow a term to an OR group. A literal always carries `field`; a group never
 *  does and always carries an `any` array. */
export function isOrGroup(term: WhereTerm): term is OrGroup {
  return Array.isArray((term as OrGroup).any);
}

/** The predicate literals a term contributes, in order: the term itself for a
 *  literal, or its members for a group. Handy for anything that must visit every
 *  predicate regardless of grouping (field allowlisting, SELECT projection). */
export function predicatesOf(term: WhereTerm): WhereClause[] {
  return isOrGroup(term) ? term.any : [term];
}

/** One ORDER BY term. Array order in `QueryState.orderBy` is the sort priority. */
export interface OrderByClause {
  field: string; // FieldDef.name (server may sort a different expr via FieldDef.sort.field)
  dir: "asc" | "desc";
  /** NULL placement. Omitted = "last" (the historical default both projects used,
   *  preserved so old `?q=` links round-trip identically). */
  nulls?: "first" | "last";
  /** Sort by the first capture group of a regex match (or by the whole match
   *  when the pattern has no capture group). A non-match produces NULL. Regex
   *  syntax is interpreted by the executor (JavaScript locally, PostgreSQL on
   *  the bundled Go backend), so portable patterns should use their common
   *  syntax subset. */
  extract?: { regex: string };
}

/** One column in the SELECT list, plus the view state that travels with it.
 *  Order in `QueryState.select` is the left-to-right display order. */
export interface SelectColumn {
  field: string; // FieldDef.name, or @computed/<id> (source lives in ComputedColumnStore)
  /** Pixel width override. Omitted = FieldDef.select.width, else the type default. */
  width?: number;
  /** Table-cell presentation for this column in this layout, e.g.
   *  `{ kind: "text", lines: 3 }`. Takes precedence over the field's `render`
   *  and `display`; other surfaces (details, menus, metrics) keep the field's. */
  display?: CellDisplay;
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
  dateGrouping?: MetricDateGrouping;
  expression?: string;
  expressionY?: string;
  scope?: MetricScope;
  sort?: MetricSort[];
  groupLimit?: number;
  display?: MetricDisplay;
  layout?: MetricLayout;
  distribution?: MetricDistribution;
  diagnostics?: string[];
  /** Preserved source operation when this client does not implement it. */
  unsupportedOp?: string;
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

/** Detail affordances are presentation state, never backend SELECT fields. */
export type ItemPropertyMode = "hover" | "modal" | "expand";
export type ItemDetailMode = ItemPropertyMode | "page";
export interface ItemPageOptions {
  /** Empty uses the current page with the item modal and query state. */
  urlTemplate: string;
  target: "_blank" | "_self";
}
/** Reserved presentation column; never sent to a data source. */
export const ITEM_DETAILS_COLUMN = "__qt_item_details__";
export interface ItemDetailsState {
  modes: ItemDetailMode[];
  /** A self-contained view travels with shared links; saved-view IDs are device-local. */
  view?: PropertyViewState;
  /** Independent layouts for each modality. Legacy view is the fallback. */
  views?: Partial<Record<ItemPropertyMode, PropertyViewState>>;
  page?: ItemPageOptions;
  active?: { id: RowId; mode: "modal" | "expand" };
}

export interface QueryState {
  /** Optional row-producing stage. `grouping.source` is the original record
   * query (its WHERE runs first). This query selects/filters/sorts the groups;
   * its `where` therefore represents HAVING. Only one stage is supported. */
  grouping?: GroupingState;
  itemDetails?: ItemDetailsState;
  /** Ordered SELECT list + per-column widths. Empty = the schema's default columns. */
  select: SelectColumn[];
  /** Refit columns to each viewer's table viewport after loading. Manual width
   *  changes clear this view preference; omitted/false uses stored widths. */
  fitToScreen?: boolean;
  /** WHERE in conjunctive normal form: the AND of these terms, each a single
   *  predicate or an OR group. A flat list of literals (no groups) is the common
   *  case and the legacy shape, decoded unchanged. */
  where: WhereTerm[];
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
  "matches_regex",
  "not_matches_regex",
  "length_gt",
  "length_lt",
  "length_eq",
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

/** Validate one raw predicate into a bounded WhereClause, or null if malformed.
 *  Shared by top-level literals and the members of an OR group. */
function normalizeWhereClause(item: unknown): WhereClause | null {
  if (!isRecord(item)) return null;
  const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
  const value = typeof item.value === "string" && item.value.length <= MAX_FILTER_VALUE_LENGTH ? item.value : null;
  if (!field || typeof item.op !== "string" || !FILTER_OPS.has(item.op) || value == null) {
    return null;
  }
  const clause: WhereClause = { field, op: item.op as FilterOp, value };
  if (item.negated === true) clause.negated = true;
  return clause;
}

/** Deep-clone one WHERE term (literal or group) so a normalized/fallback state
 *  never aliases the caller's arrays. */
function cloneWhereTerm(term: WhereTerm): WhereTerm {
  const copy = isOrGroup(term) ? { ...term, any: term.any.map((c) => ({ ...c })) } : { ...term };
  if (term.setFilter) copy.setFilter = { ...term.setFilter, values: [...term.setFilter.values] };
  return copy;
}

function normalizeSetFilter(item: unknown): SetFilterMetadata | undefined {
  if (!isRecord(item)) return undefined;
  const id = boundedString(item.id, MAX_FIELD_NAME_LENGTH);
  if (!id || !["any", "all", "none", "empty"].includes(String(item.mode)) || !Array.isArray(item.values)) return undefined;
  if (item.values.length > MAX_WHERE_CLAUSES || !item.values.every((value) => typeof value === "string" && value.length <= MAX_FILTER_VALUE_LENGTH)) return undefined;
  return { id, mode: item.mode as SetFilterMode, values: [...item.values] as string[] };
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
      if (item.display !== undefined) {
        // A malformed presentation hint never hides the column; it falls back
        // to the field's own presentation.
        try { column.display = parseCellDisplay(item.display, `column ${field} display`); } catch { /* dropped */ }
      }
      select.push(column);
    }
  } else {
    select.push(...fallback.select.map((column) => ({ ...column, ...(column.display ? { display: JSON.parse(JSON.stringify(column.display)) as CellDisplay } : {}) })));
  }

  // WHERE is CNF: an array of terms, each a literal or an `{ any: [...] }` OR
  // group. MAX_WHERE_CLAUSES bounds the TOTAL predicate count across all terms
  // (legacy flat lists are all literals, so the cap is unchanged for them).
  // Singleton/empty groups are canonicalized (flattened / dropped).
  const where: WhereTerm[] = [];
  if (Array.isArray(raw.where)) {
    let literalBudget = MAX_WHERE_CLAUSES;
    for (const item of raw.where) {
      if (literalBudget <= 0) break;
      const start = where.length;
      if (isRecord(item) && Array.isArray((item as { any?: unknown }).any)) {
        const members: WhereClause[] = [];
        for (const inner of (item as { any: unknown[] }).any) {
          if (literalBudget <= 0) break;
          const clause = normalizeWhereClause(inner);
          if (clause) {
            members.push(clause);
            literalBudget--;
          }
        }
        if (members.length === 1) where.push(members[0]!);
        else if (members.length > 1) where.push({ any: members });
        // 0 members → drop the term entirely
      } else {
        const clause = normalizeWhereClause(item);
        if (clause) {
          where.push(clause);
          literalBudget--;
        }
      }
      if (where.length > start && isRecord(item)) {
        const metadata = normalizeSetFilter(item.setFilter);
        if (metadata) where[start]!.setFilter = metadata;
      }
    }
  } else {
    where.push(...fallback.where.map(cloneWhereTerm));
  }

  const orderBy: OrderByClause[] = [];
  if (Array.isArray(raw.orderBy)) {
    for (const item of raw.orderBy.slice(0, MAX_ORDER_BY_TERMS)) {
      if (!isRecord(item)) continue;
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      if (!field || (item.dir !== "asc" && item.dir !== "desc")) continue;
      const term: OrderByClause = { field, dir: item.dir };
      if (item.nulls === "first" || item.nulls === "last") term.nulls = item.nulls;
      if (
        isRecord(item.extract) &&
        typeof item.extract.regex === "string" &&
        item.extract.regex.length <= MAX_FILTER_VALUE_LENGTH
      ) {
        term.extract = { regex: item.extract.regex };
      }
      orderBy.push(term);
    }
  } else {
    orderBy.push(
      ...fallback.orderBy.map((term) => (term.extract ? { ...term, extract: { ...term.extract } } : { ...term })),
    );
  }

  const out: QueryState = {
    select,
    where,
    orderBy,
    limit: boundedInteger(raw.limit, fallback.limit, 1, MAX_QUERY_LIMIT),
    offset: boundedInteger(raw.offset, fallback.offset, 0, MAX_QUERY_OFFSET),
  };

  if (raw.fitToScreen === true) out.fitToScreen = true;

  if (raw.grouping != null) out.grouping = normalizeGroupingState(raw.grouping);

  if (Array.isArray(raw.aggregations)) {
    const aggregations: AggregationClause[] = [];
    for (const item of raw.aggregations.slice(0, MAX_AGGREGATIONS)) {
      if (!isRecord(item)) continue;
      const id = boundedString(item.id, MAX_FIELD_NAME_LENGTH);
      if (!id) continue;
      const validOp = typeof item.op === "string" && AGG_OPS.has(item.op);
      const rawGroups: unknown[] = Array.isArray(item.groupBy) ? item.groupBy : [];
      const groupBy = rawGroups
        .slice(0, MAX_GROUP_BY_FIELDS)
        .map((field) => boundedString(field, MAX_FIELD_NAME_LENGTH))
        .filter((field): field is string => field != null);
      const aggregation: AggregationClause = { id, op: validOp ? item.op as AggOp : "count", groupBy };
      const field = boundedString(item.field, MAX_FIELD_NAME_LENGTH);
      const label = boundedString(item.label, MAX_LABEL_LENGTH);
      if (field) aggregation.field = field;
      if (label) aggregation.label = label;
      Object.assign(aggregation, normalizeMetricOptions(item));
      if (!Array.isArray(item.groupBy) || rawGroups.length > MAX_GROUP_BY_FIELDS || groupBy.length !== rawGroups.length) aggregation.diagnostics = [...(aggregation.diagnostics ?? []), "Invalid metric grouping fields or grouping budget exceeded."];
      const unsupportedOp = boundedString(item.unsupportedOp ?? (!validOp ? item.op : undefined), MAX_FIELD_NAME_LENGTH);
      if (unsupportedOp) aggregation.unsupportedOp = unsupportedOp;
      if (item.field !== undefined && !field) aggregation.diagnostics = [...(aggregation.diagnostics ?? []), "Invalid metric measure field."];
      if (!validOp && typeof item.expression !== "string") aggregation.diagnostics = [...(aggregation.diagnostics ?? []), "Unsupported aggregate operation."];
      aggregations.push(aggregation);
    }
    if (aggregations.length > 0) out.aggregations = aggregations;
  } else if (fallback.aggregations?.length) {
    out.aggregations = normalizeQueryState({ aggregations: fallback.aggregations }).aggregations!;
  }

  if (isRecord(raw.itemDetails) && Array.isArray(raw.itemDetails.modes)) {
    const modes = [...new Set(raw.itemDetails.modes.filter(
      (mode): mode is ItemDetailMode => typeof mode === "string" && ["hover", "modal", "expand", "page"].includes(mode),
    ))];
    const details: ItemDetailsState = { modes };
    if (isRecord(raw.itemDetails.page) && typeof raw.itemDetails.page.urlTemplate === "string"
      && raw.itemDetails.page.urlTemplate.length <= 8000) {
      details.page = { urlTemplate: raw.itemDetails.page.urlTemplate,
        target: raw.itemDetails.page.target === "_self" ? "_self" : "_blank" };
    }
    if (raw.itemDetails.view !== undefined) {
      try { details.view = normalizePropertyView(raw.itemDetails.view); } catch { /* Ignore malformed view snapshots. */ }
    }
    if (isRecord(raw.itemDetails.views)) {
      const views: NonNullable<ItemDetailsState["views"]> = {};
      for (const mode of ["hover", "modal", "expand"] as const) {
        try {
          if (raw.itemDetails.views[mode] !== undefined) views[mode] = normalizePropertyView(raw.itemDetails.views[mode]);
        } catch { /* Ignore malformed modality snapshots. */ }
      }
      if (Object.keys(views).length) details.views = views;
    }
    const active = raw.itemDetails.active;
    if (isRecord(active) && (active.mode === "modal" || active.mode === "expand") && modes.includes(active.mode)
      && ((typeof active.id === "string" && active.id.length > 0 && active.id.length <= 1000)
        || (typeof active.id === "number" && Number.isFinite(active.id)))) {
      details.active = { id: active.id as RowId, mode: active.mode };
    }
    out.itemDetails = details;
  }

  return out;
}

/** Retain an invalid stage as a diagnostic rather than silently executing an
 * ungrouped query. Strip nesting before normalizing the source snapshot. */
function normalizeGroupingState(value: unknown): GroupingState {
  const raw = isRecord(value) ? value : {};
  const diagnostics: string[] = [];
  // Each problem gets its own message; the stage still refuses to execute.
  const fail = (message: string) => { diagnostics.push(`Invalid grouping: ${message}`); };
  const keys = Array.isArray(raw.keys) ? raw.keys.slice(0, MAX_GROUP_BY_FIELDS).filter((key): key is string => !!boundedString(key, MAX_FIELD_NAME_LENGTH)) : [];
  if (!Array.isArray(raw.keys) || !keys.length || keys.length !== raw.keys.length || new Set(keys).size !== keys.length)
    fail(`keys must list 1–${MAX_GROUP_BY_FIELDS} distinct field names.`);
  const summaries: SummaryColumn[] = [];
  if (!Array.isArray(raw.summaries) || raw.summaries.length > 64) fail("summaries must be a list of at most 64 columns.");
  const summaryIds = new Set<string>();
  for (const [index, item] of (Array.isArray(raw.summaries) ? raw.summaries.slice(0, 64) : []).entries()) {
    const name = isRecord(item) && boundedString(item.id, MAX_FIELD_NAME_LENGTH) ? `summary "${item.id as string}"` : `summary ${index + 1}`;
    if (!isRecord(item) || !boundedString(item.id, MAX_FIELD_NAME_LENGTH)) { fail(`${name} needs an id of 1–${MAX_FIELD_NAME_LENGTH} characters.`); continue; }
    if (typeof item.op !== "string" || (!AGG_OPS.has(item.op) && item.op !== "row" && item.op !== "formula")) {
      fail(`${name} has unsupported op ${JSON.stringify(String(item.op).slice(0, 40))}; use count, count_distinct, sum, avg, min, max, row, or formula${String(item.op).toLowerCase() === "median" ? ' (for a median, use op "formula" with expression "MEDIAN([field])")' : ""}.`);
      continue;
    }
    const column: SummaryColumn = { id: item.id as string, op: item.op as SummaryColumn["op"] };
    // Collisions with source fields need the schema and are reported by
    // createGroupingModel().validate(); keys and duplicates are visible here.
    if (summaryIds.has(column.id)) fail(`${name} uses the same id as another summary column.`);
    else if (keys.includes(column.id)) fail(`${name} uses the same id as group key "${column.id}"; summary ids must differ from source field names.`);
    summaryIds.add(column.id);
    if (item.field !== undefined) {
      if (!boundedString(item.field, MAX_FIELD_NAME_LENGTH)) fail(`${name} has an invalid field name.`);
      else column.field = item.field as string;
    }
    if (item.op === "formula") {
      if (typeof item.expression !== "string" || item.expression.length > 10_000) fail(`${name} needs an expression of at most 10,000 characters.`);
      else column.expression = item.expression;
    }
    if (item.label !== undefined) {
      if (typeof item.label !== "string" || item.label.length > MAX_LABEL_LENGTH) fail(`${name} label must be text of at most ${MAX_LABEL_LENGTH.toLocaleString("en-US")} characters.`);
      else column.label = item.label;
    }
    if (item.display !== undefined) {
      try { column.display = parseCellDisplay(item.display, `${name} display`); }
      catch (error) { fail(`${error instanceof Error ? error.message : String(error)}.`); }
    }
    summaries.push(column);
  }
  let representative: GroupingState["representative"] = null;
  if (raw.representative != null) {
    const ordering = isRecord(raw.representative) ? raw.representative.orderBy : undefined;
    const orderBy: RepresentativeOrder[] = [];
    if (!Array.isArray(ordering) || !ordering.length || ordering.length > 8) fail("representative ordering must list 1–8 fields.");
    for (const term of Array.isArray(ordering) ? ordering.slice(0, 8) : []) {
      if (!isRecord(term) || !boundedString(term.field, MAX_FIELD_NAME_LENGTH) || !["asc", "desc"].includes(String(term.dir)) || (term.nulls !== undefined && !["first", "last"].includes(String(term.nulls)))) {
        fail('each representative ordering term needs a field, dir "asc" or "desc", and optional nulls "first" or "last".');
        continue;
      }
      orderBy.push({ field: term.field as string, dir: term.dir as "asc" | "desc", nulls: term.nulls === "first" ? "first" : "last" });
    }
    representative = { orderBy };
  }
  if (!isRecord(raw.source)) fail("source must be the record query that is grouped.");
  else if (raw.source.grouping != null) fail("only one grouping stage is supported; the source query cannot itself be grouped.");
  const { grouping: _nested, ...source } = isRecord(raw.source) ? raw.source : {};
  // Retain earlier diagnostics (bounded) instead of collapsing them.
  if (Array.isArray(raw.diagnostics))
    for (const message of raw.diagnostics.slice(0, 20))
      diagnostics.push(typeof message === "string" && message ? message.slice(0, MAX_LABEL_LENGTH) : "Invalid grouping definition.");
  const normalizedSource = normalizeQueryState(source);
  if (Array.isArray(source.where)) {
    const supplied = source.where.reduce((count: number, term: unknown) => count + (isRecord(term) && Array.isArray(term.any) ? term.any.length : 1), 0);
    if (supplied !== normalizedSource.where.reduce((count, term) => count + predicatesOf(term).length, 0)) fail("source filters contain malformed predicates or exceed the predicate budget.");
  }
  return { keys, summaries, representative, source: normalizedSource, ...(diagnostics.length ? { diagnostics: [...new Set(diagnostics)] } : {}) };
}

/** Structural equality on two queries — used to decide whether a `?q=` write or a
 *  refetch is actually needed (avoids history spam / redundant fetches). */
export function queriesEqual(a: QueryState, b: QueryState): boolean {
  if (a === b) return true;
  if (a.limit !== b.limit || a.offset !== b.offset) return false;
  if ((a.fitToScreen === true) !== (b.fitToScreen === true)) return false;
  if (!sameArray(a.where, b.where)) return false;
  if (!sameArray(a.orderBy, b.orderBy)) return false;
  if (!sameArray(a.select, b.select)) return false;
  if (!sameArray(a.aggregations ?? [], b.aggregations ?? [])) return false;
  if (JSON.stringify(a.itemDetails) !== JSON.stringify(b.itemDetails)) return false;
  if (JSON.stringify(a.grouping) !== JSON.stringify(b.grouping)) return false;
  return true;
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Members are records of primitives (WHERE terms may nest one `any` array of
    // them) — a structural JSON compare is correct and cheap here.
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}
