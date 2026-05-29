// apply.ts — client-side filter + multi-sort + paginate.
//
// applyQuery is the client mirror of the backend compiler. Three jobs:
//   1. The executor for purely client-side datasets (no backend at all).
//   2. The executor for derived / non-pushdown columns the backend can't filter.
//   3. Idempotent defense-in-depth over server-filtered fields (re-applying a
//      server-handled clause must not change the result).
//
// It must agree with backends/go's Compile on operator semantics:
//   - `contains`/`starts_with`/`ends_with` are case-insensitive
//   - textarray `is_null` = empty-or-missing; `is_not_null` = any element;
//     `includes` = case-insensitive membership
//   - NULLs sort per OrderByClause.nulls (default "last")
//   - multi-sort is a stable lexicographic fold over orderBy in priority order

import type { QueryState, WhereClause } from "./query";
import type { FieldSchema, FieldDef } from "./schema";
import { indexFields, readFieldValue } from "./schema";
import { coerceValue } from "./ops";

export interface ApplyResult<Row> {
  /** The page slice (after filter + sort + offset/limit). */
  rows: Row[];
  /** Total matching rows *before* pagination — powers "showing N of M". */
  total: number;
}

/** Filter + multi-sort + paginate `rows` per `q`, resolving field types/paths
 *  from `schema`. Pure; never mutates `rows`. Clauses/sorts on unknown fields are
 *  ignored (the backend already enforced its own allowlist). */
export function applyQuery<Row>(rows: Row[], q: QueryState, schema: FieldSchema<Row>): ApplyResult<Row> {
  const byName = indexFields(schema);

  let out = rows.filter((row) => q.where.every((cl) => matchesWith(byName, row, cl)));
  const total = out.length;

  if (q.orderBy.length) {
    const terms = q.orderBy
      .map((t) => ({ field: byName.get(t.field), dir: t.dir, nullsLast: (t.nulls ?? "last") === "last" }))
      .filter((t): t is { field: FieldDef<Row>; dir: "asc" | "desc"; nullsLast: boolean } => t.field != null);
    out = [...out].sort((a, b) => {
      for (const t of terms) {
        const av = readFieldValue(t.field, a);
        const bv = readFieldValue(t.field, b);
        const aNull = av == null;
        const bNull = bv == null;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          return (aNull ? 1 : -1) * (t.nullsLast ? 1 : -1);
        }
        const cmp = compare(av, bv);
        if (cmp !== 0) return t.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }

  const start = q.offset > 0 ? q.offset : 0;
  const end = q.limit > 0 ? start + q.limit : out.length;
  return { rows: out.slice(start, end), total };
}

/** Does one row satisfy one clause? Exposed for the CellMenu preview + tests. */
export function matchesClause<Row>(row: Row, clause: WhereClause, schema: FieldSchema<Row>): boolean {
  return matchesWith(indexFields(schema), row, clause);
}

function matchesWith<Row>(byName: Map<string, FieldDef<Row>>, row: Row, clause: WhereClause): boolean {
  const field = byName.get(clause.field);
  if (!field) return true; // unknown field → no client opinion
  const v = readFieldValue(field, row);

  // Nullity, with array-aware semantics.
  if (clause.op === "is_null") return Array.isArray(v) ? v.length === 0 : v == null || v === "";
  if (clause.op === "is_not_null") return Array.isArray(v) ? v.length > 0 : v != null && v !== "";

  // Empty value on a non-equality op is a "no filter" signal (matches the UI +
  // the Go compiler, which skip such clauses).
  if (clause.value === "" && clause.op !== "=" && clause.op !== "!=") return true;

  // `includes` is array membership (ARRAY_HAS): a null/missing array contains
  // nothing. Handle before the array/scalar split so null can't fall through.
  if (clause.op === "includes") {
    const arr = Array.isArray(v) ? v : [];
    const needle = clause.value.toLowerCase();
    return arr.some((x) => String(x).toLowerCase() === needle);
  }

  if (Array.isArray(v)) {
    const needle = clause.value.toLowerCase();
    const hay = v.map((x) => String(x).toLowerCase());
    switch (clause.op) {
      case "contains":
        return hay.some((s) => s.includes(needle));
      case "=":
        return hay.includes(needle);
      case "!=":
        return !hay.includes(needle);
      default:
        return true;
    }
  }

  switch (clause.op) {
    case "=":
      return String(v ?? "") === String(coerceSafe(field, clause.value));
    case "!=":
      return String(v ?? "") !== String(coerceSafe(field, clause.value));
    case ">":
      return compare(v, coerceSafe(field, clause.value)) > 0;
    case ">=":
      return compare(v, coerceSafe(field, clause.value)) >= 0;
    case "<":
      return compare(v, coerceSafe(field, clause.value)) < 0;
    case "<=":
      return compare(v, coerceSafe(field, clause.value)) <= 0;
    case "contains":
      return String(v ?? "").toLowerCase().includes(clause.value.toLowerCase());
    case "starts_with":
      return String(v ?? "").toLowerCase().startsWith(clause.value.toLowerCase());
    case "ends_with":
      return String(v ?? "").toLowerCase().endsWith(clause.value.toLowerCase());
    default:
      return true;
  }
}

/** Coerce per the field type, falling back to the raw string if coercion fails
 *  (so a malformed value degrades to a string compare rather than throwing). */
function coerceSafe(field: FieldDef, raw: string): string | number | boolean {
  try {
    return coerceValue(field.type, raw);
  } catch {
    return raw;
  }
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b));
}
