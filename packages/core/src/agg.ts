// agg.ts — which aggregate ops a field type allows, and which fields can be a
// measure or a group-by key. The single source of truth shared by the
// QueryBuilder's metric editor, the client-side applyAggregations, and (mirrored
// independently in backends/go) the SQL compiler. Never trust the client: the Go
// `aggOpAllowed` enforces the same matrix before any GROUP BY is built.

import type { AggOp } from "./query";
import type { FieldType, FieldDef } from "./schema";

/** Default aggregate ops per field type. A FieldDef.aggregate.ops overrides this.
 *  `count`/`count_distinct` work on anything countable; sum/avg are numeric-only;
 *  min/max need an ordered domain (numbers, datetimes, and lexical text/enum). */
export const AGG_OPS_BY_TYPE: Record<FieldType, AggOp[]> = {
  number: ["count", "count_distinct", "sum", "avg", "min", "max"],
  datetime: ["count", "count_distinct", "min", "max"],
  enum: ["count", "count_distinct", "min", "max"],
  text: ["count", "count_distinct", "min", "max"],
  bool: ["count", "count_distinct"],
  textarray: ["count"],
};

/** Ops that reduce a measure column. `count` is the only op that may omit a
 *  field (counting rows), so it's the only one absent here. */
export const AGG_OPS_NEEDING_FIELD: ReadonlySet<AggOp> = new Set<AggOp>([
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
]);

/** Whether an op requires a measure column. */
export function aggOpNeedsField(op: AggOp): boolean {
  return AGG_OPS_NEEDING_FIELD.has(op);
}

/** Effective aggregate ops for a field (its override, else the type default). */
export function aggOpsForField(field: Pick<FieldDef, "type" | "aggregate">): AggOp[] {
  return field.aggregate?.ops ?? AGG_OPS_BY_TYPE[field.type];
}

/** Whether an op is valid for a type per the default matrix (Go aggOpAllowed is
 *  the server mirror; keep them in lockstep). */
export function aggOpAllowedForType(type: FieldType, op: AggOp): boolean {
  return AGG_OPS_BY_TYPE[type].includes(op);
}

/** Can this field be the MEASURE of a metric? Only backend fields (they have SQL
 *  to aggregate); derived/render-only columns are never pushed to the server. An
 *  explicit `aggregate.measure` wins over the type default. */
export function isMeasurable(field: FieldDef): boolean {
  if (field.source.kind !== "backend") return false;
  if (field.aggregate?.measure != null) return field.aggregate.measure;
  return aggOpsForField(field).length > 0;
}

/** Can this field be a GROUP BY key? Backend fields only. Default: low-cardinality
 *  types (enum/text/bool); numbers/datetimes need bucketing (out of scope) so they
 *  default off, but `aggregate.groupable: true` opts any backend field in. */
export function isGroupable(field: FieldDef): boolean {
  if (field.source.kind !== "backend") return false;
  if (field.aggregate?.groupable != null) return field.aggregate.groupable;
  return field.type === "enum" || field.type === "text" || field.type === "bool";
}
