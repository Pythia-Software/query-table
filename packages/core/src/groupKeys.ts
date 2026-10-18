// groupKeys.ts — exact predicates selecting one group's key tuple.
//
// Shared by `groupSourceQuery` (drilldown) and query-kind link columns, so a
// link's key filters are exactly the filters drilling into the group adds.

import { isFilterable, resolveField, type FieldDef, type FieldSchema } from "./schema";
import type { WhereClause } from "./query";

/** Filters accept datetimes as ISO instants with an explicit offset. */
export function datetimeValue(value: unknown): string | null {
  const time =
    value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
    : typeof value === "string" && value !== "" ? Date.parse(value)
    : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** One equality (or `is_null`) predicate selecting a group key, or null when
 * the field cannot express it exactly. */
export function keyClause(field: FieldDef | undefined, value: unknown): WhereClause | null {
  if (!field || field.type === "textarray" || !isFilterable(field)) return null;
  if (value == null) return { field: field.name, op: "is_null", value: "" };
  if (field.type === "datetime") {
    const iso = datetimeValue(value);
    return iso === null ? null : { field: field.name, op: "=", value: iso };
  }
  if (typeof value === "number" ? !Number.isFinite(value) : typeof value !== "string" && typeof value !== "boolean")
    return null;
  return { field: field.name, op: "=", value: String(value) };
}

/** `=` (or `is_null`) per key, in key order, or null when any key cannot be
 * matched exactly (textarray, unknown or unfilterable fields, unparseable
 * datetimes). */
export function groupKeyTerms(keys: readonly string[], group: Record<string, unknown>, schema: FieldSchema): WhereClause[] | null {
  const terms: WhereClause[] = [];
  for (const key of keys) {
    const term = keyClause(resolveField(schema, key), group[key]);
    if (!term) return null;
    terms.push(term);
  }
  return terms;
}
