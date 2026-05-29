// schema.ts — the field schema: the contract that binds frontend and backend.
//
// A `FieldSchema` is the runtime, frontend-facing projection of a JSON schema
// document (schema/query-table.schema.json). The same document is projected on
// the backend into a Go `Schema` of SQL bindings. Codegen keeps the two in sync.
//
// `FieldDef` is organized to make two things obvious (per design feedback):
//
//   1. WHAT KIND of field it is — the `source` discriminated union. A `backend`
//      field is a column the server returns and can filter/sort; a `derived`
//      field is computed on the client (or render-only) and is never pushed to
//      the server. Each kind uses its own property subset, so you can't, say,
//      mark a client-only column as server-filterable.
//
//   2. CONFIG vs CODE. Everything except `source.accessor` and `render` is
//      declarative, serializable config grouped by capability (`filter`, `sort`,
//      `select`). The only code-bearing members are the derived `accessor` and
//      the `render` function — kept apart from the config so the two don't mix.

import type { FilterOp, OrderByClause, SelectColumn } from "./query";

export type FieldType =
  | "text"
  | "number"
  | "enum"
  | "datetime"
  | "bool"
  | "textarray"; // array-of-text; supports `includes`, and null-as-empty semantics

export type Align = "left" | "right" | "center";

/** A cell renderer is resolved by name against a `RenderRegistry` (in
 *  @query-table/ui) or supplied inline. The type lives in core so FieldDef can
 *  reference it, but core never imports React — `unknown` stands in for the node
 *  and @query-table/ui narrows it to `React.ReactNode`. */
export type CellRenderer<Row = any, V = unknown> = (ctx: {
  value: V;
  row: Row;
  field: FieldDef<Row, V>;
}) => unknown;

// ---- source: WHAT KIND of field (discriminated union) ---------------------

/** A column the backend returns and can filter/sort. Its SQL expression lives in
 *  the JSON schema doc's `bindings` (and the Go Schema), never on the frontend. */
export interface BackendField {
  kind: "backend";
  /** Dotted path into the API row when it differs from `name` (e.g. "enqueued_at.Time"). */
  path?: string;
  /** Computed SQL with no backing column (e.g. is_starred). Documentation hint
   *  surfaced to the picker; the actual expression is server-side. */
  synthetic?: boolean;
}

/** A value computed on the client, or a purely render-driven column. Never
 *  pushed to the server; client-side filtering/sorting (if any) reads `accessor`. */
export interface DerivedField<Row = any, V = unknown> {
  kind: "derived";
  /** Compute the value from the row for client filter/sort. Omit for render-only
   *  columns (the renderer reads the whole row from CellContext instead). */
  accessor?: (row: Row) => V;
}

export type FieldSource<Row = any, V = unknown> = BackendField | DerivedField<Row, V>;

// ---- capability config (declarative; serializable; shared with backend) ----

/** How filter-value candidates are offered. Autocomplete is the DEFAULT for
 *  every field (design feedback): the value input is a combobox backed by
 *  Transport.fetchDistinctValues, which takes a search string so large domains
 *  refine per keystroke on the backend. `static` is for closed domains you don't
 *  want a round-trip for; `freeform` opts out of suggestions entirely. */
export type FilterValues =
  | { source: "autocomplete" }
  | { source: "static"; options: string[] }
  | { source: "freeform" };

export interface FilterConfig {
  /** Whether this field is filterable. Default: backend ⇒ true, derived ⇒ false. */
  enabled?: boolean;
  /** Evaluate on the backend (predicate pushdown)? Default: backend ⇒ true.
   *  false ⇒ the clause is stripped from the server request and applied locally
   *  by applyQuery (the "serverFilter:false" derived/JSONB-less columns). */
  pushdown?: boolean;
  /** Override the default operator set for the field's type. */
  ops?: FilterOp[];
  /** Value-suggestion strategy. Default { source: "autocomplete" }. */
  values?: FilterValues;
}

export interface SortConfig {
  /** Whether this field is sortable. Default: backend ⇒ true, derived ⇒ false. */
  enabled?: boolean;
  /** Server field to ORDER BY when it differs from the display field
   *  (e.g. a "★" column whose server sort key is `is_starred`). */
  field?: string;
}

export interface SelectConfig {
  /** Can this appear as a visible column? Default true. false ⇒ filter-only field. */
  enabled?: boolean;
  /** Shown by default when QueryState.select is empty. */
  default?: boolean;
  /** Default column width (px); a per-column override rides in QueryState.select. */
  width?: number;
  align?: Align;
}

// ---- the field ------------------------------------------------------------

export interface FieldDef<Row = any, V = unknown> {
  // identity
  name: string; // canonical id; matches the backend binding key + Where/OrderBy `field`
  label: string;
  type: FieldType;

  // WHAT KIND of field (value origin + server capability)
  source: FieldSource<Row, V>;

  // capabilities (declarative config; omit for sensible per-source defaults)
  filter?: FilterConfig;
  sort?: SortConfig;
  select?: SelectConfig;

  // discovery (picker UX, declarative)
  group?: string; // grouping bucket
  aliases?: string[]; // extra search terms

  // presentation (the only code-bearing field): registry key or inline fn
  render?: string | CellRenderer<Row, V>;
}

/** The frontend's loaded schema for one dataset. */
export interface FieldSchema<Row = any> {
  /** Dataset id, also the localStorage namespace for saved queries. */
  name: string;
  /** Field that yields a row's stable id for selection / per-row refresh. */
  idField: string;
  fields: FieldDef<Row>[];
  /** Sort applied when QueryState.orderBy is empty. */
  defaultSort?: OrderByClause[];
  /** Columns shown when QueryState.select is empty. */
  defaultSelect?: SelectColumn[];
  /** Page size for a fresh query. */
  defaultLimit?: number;
}

// ---- derived capability helpers (the per-source defaults, in one place) ----

export function isFilterable(f: FieldDef): boolean {
  return f.filter?.enabled ?? f.source.kind === "backend";
}
export function isPushdownFilter(f: FieldDef): boolean {
  return isFilterable(f) && (f.filter?.pushdown ?? f.source.kind === "backend");
}
export function isSortable(f: FieldDef): boolean {
  return f.sort?.enabled ?? f.source.kind === "backend";
}
export function isSelectable(f: FieldDef): boolean {
  return f.select?.enabled ?? true;
}
export function filterValues(f: FieldDef): FilterValues {
  return f.filter?.values ?? { source: "autocomplete" };
}

// ---- schema operations ----------------------------------------------------

/** Index fields by name for O(1) lookup. */
export function indexFields<Row>(schema: FieldSchema<Row>): Map<string, FieldDef<Row>> {
  return new Map(schema.fields.map((f) => [f.name, f]));
}

/** Resolve the ordered, selectable FieldDefs for a query, falling back to schema
 *  defaults, then to every `select.default` field. Unknown/duplicate/unselectable
 *  names in `select` are dropped. */
export function selectedFields<Row>(
  schema: FieldSchema<Row>,
  q: { select: SelectColumn[] },
): FieldDef<Row>[] {
  const byName = indexFields(schema);
  const order =
    q.select.length > 0
      ? q.select.map((c) => c.field)
      : (schema.defaultSelect ?? schema.fields.filter((f) => f.select?.default).map((f) => ({ field: f.name }))).map(
          (c) => c.field,
        );
  const seen = new Set<string>();
  const out: FieldDef<Row>[] = [];
  for (const name of order) {
    if (seen.has(name)) continue;
    const f = byName.get(name);
    if (!f || !isSelectable(f)) continue;
    seen.add(name);
    out.push(f);
  }
  return out;
}

/** Read a field's value from a row: derived `accessor` if present, else the
 *  backend `path` (dotted) / `name`. Returns null when any path segment is missing. */
export function readFieldValue<Row, V = unknown>(field: FieldDef<Row, V>, row: Row): V | null {
  if (row == null) return null;
  if (field.source.kind === "derived" && field.source.accessor) {
    return field.source.accessor(row);
  }
  const path = (field.source.kind === "backend" && field.source.path) || field.name;
  const r = row as Record<string, unknown>;
  if (path in r) return (r[path] ?? null) as V | null;
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return (cur ?? null) as V | null;
}

/** Parse + validate a raw JSON schema document into a FieldSchema. The doc is the
 *  same one the Go backend loads; here we drop backend `bindings` (the frontend
 *  never sees SQL) and leave `render` as a string key the consumer maps to a
 *  renderer at runtime. Throws with a readable message on a malformed document. */
export function loadSchema<Row = any>(doc: unknown): FieldSchema<Row> {
  const d = doc as Record<string, any>;
  if (!d || typeof d !== "object") throw new Error("schema: document is not an object");
  if (typeof d.name !== "string") throw new Error("schema: missing `name`");
  if (typeof d.idField !== "string") throw new Error("schema: missing `idField`");
  if (!Array.isArray(d.fields) || d.fields.length === 0) throw new Error("schema: `fields` must be a non-empty array");

  const fields: FieldDef<Row>[] = d.fields.map((raw: any, i: number) => projectField<Row>(raw, i));
  return {
    name: d.name,
    idField: d.idField,
    fields,
    defaultSort: d.defaultSort,
    defaultSelect: d.defaultSelect,
    defaultLimit: d.defaultLimit,
  };
}

function projectField<Row>(raw: any, i: number): FieldDef<Row> {
  if (!raw || typeof raw.name !== "string") throw new Error(`schema: field[${i}] missing \`name\``);
  if (typeof raw.label !== "string") throw new Error(`schema: field ${raw.name} missing \`label\``);
  if (typeof raw.type !== "string") throw new Error(`schema: field ${raw.name} missing \`type\``);

  // `source` accepts a string shorthand ("backend"|"derived") or an object.
  const rs = raw.source ?? (raw.bindings ? "backend" : "derived");
  let source: FieldSource<Row>;
  if (typeof rs === "string") {
    source = rs === "derived" ? { kind: "derived" } : { kind: "backend" };
  } else if (rs.kind === "derived") {
    source = { kind: "derived" }; // accessor is code → attached at runtime, never from JSON
  } else {
    source = { kind: "backend", path: rs.path, synthetic: rs.synthetic };
  }

  return {
    name: raw.name,
    label: raw.label,
    type: raw.type,
    source,
    filter: raw.filter,
    sort: raw.sort,
    select: raw.select,
    group: raw.group,
    aliases: raw.aliases,
    render: raw.render, // string key from JSON; consumer may override with a fn
  };
}
