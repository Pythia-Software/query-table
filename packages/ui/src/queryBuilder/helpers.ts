// Shared leaf helpers for the QueryBuilder rows: cx, useFieldHasNull, positive-op
// filtering, clause-as-text / collapsed-summary builders, and chip width sizing.

import type { QueryFilterApi } from "@pythia-software/query-table-react";
import {
  useEffect,
  useState,
} from "react";
import type {
  FieldDef,
  FilterOp,
  OrderByClause,
  WhereClause,
  WhereTerm,
} from "@pythia-software/query-table-core";
import {
  NULLARY_OPS,
  branchesOf,
  isWhereGroup,
  opsForField,
} from "@pythia-software/query-table-core";

export const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

export function useFieldHasNull<Row>(
  api: QueryFilterApi<Row>,
  fieldName: string | undefined,
): boolean | undefined {
  const [hasNull, setHasNull] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!fieldName) return;
    let cancelled = false;
    const ac = new AbortController();

    void api
      .filterValues(fieldName, "", ac.signal)
      .then((r) => {
        if (!cancelled && typeof r.hasNull === "boolean") {
          setHasNull(r.hasNull);
        }
      })
      .catch(() => {
        if (!cancelled) setHasNull(undefined);
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [api.filterValues, fieldName]);

  return hasNull;
}

/** Operators dropped from the WHERE op dropdowns: their negation is expressed by
 *  the canonical positive op plus the NOT toggle instead (design: "just support
 *  NOT"). Legacy queries carrying these ops still decode/compile fine, and a
 *  clause already on one keeps showing it (see PredicateEditor). */
const CONVERGED_NEGATIVE_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  "!=",
  "is_not_null",
  "not_matches_regex",
]);

/** The op options offered for a field in the WHERE builder — its positive ops,
 *  with the converged negatives removed (NOT toggle covers those). */
export function positiveOpsForField<Row>(field: FieldDef<Row>): FilterOp[] {
  return opsForField(field).filter((op) => !CONVERGED_NEGATIVE_OPS.has(op));
}

function predicateAsText<Row>(
  clause: WhereClause,
  byName: Map<string, FieldDef<Row>>,
): string {
  const field = byName.get(clause.field)?.label ?? clause.field;
  if (clause.value === "0" && clause.op === "length_eq") {
    return `${field} is ${clause.negated ? "not " : ""}empty string`;
  }
  if (clause.value === "0" && clause.op === "length_gt" && !clause.negated)
    return `${field} is not empty string`;
  const op = clause.op.replace(/_/g, " ");
  const not = clause.negated ? "not " : "";
  if (NULLARY_OPS.has(clause.op)) return `${field} ${not}${op}`;
  const strategy = byName.get(clause.field)?.filter?.values;
  const option =
    strategy?.source === "static"
      ? strategy.options.find(
          (o) => typeof o !== "string" && o.value === clause.value,
        )
      : undefined;
  const value =
    clause.value === ""
      ? "''"
      : typeof option === "object"
        ? option.label
        : clause.value;
  return `${field} ${not}${op} ${value}`;
}

export function whereTermAsText<Row>(
  term: WhereTerm,
  byName: Map<string, FieldDef<Row>>,
): string {
  if (isWhereGroup(term))
    return `(${branchesOf(term)
      .map((branch) =>
        branch.length === 1
          ? predicateAsText(branch[0]!, byName)
          : `(${branch.map((c) => predicateAsText(c, byName)).join(" and ")})`,
      )
      .join(" or ")})`;
  return predicateAsText(term, byName);
}

/** The connective shown before each literal of a term, in `predicatesOf`
 *  order: none for the first, AND within a conjunction branch, else OR. */
export function predicateJoiners(term: WhereTerm): ("AND" | "OR" | null)[] {
  return branchesOf(term).flatMap((branch, b) =>
    branch.map((_, i) => (i > 0 ? "AND" : b > 0 ? "OR" : null)),
  );
}

export function orderByAsText<Row>(
  term: OrderByClause,
  byName: Map<string, FieldDef<Row>>,
): string {
  const field = byName.get(term.field)?.label ?? term.field;
  const expression = term.extract
    ? `regex_extract(${field}, /${term.extract.regex}/)`
    : field;
  const nulls = term.nulls ? ` nulls ${term.nulls}` : "";
  return `${expression} ${term.dir}${nulls}`;
}

function chipFieldWidthChars(text: string, fallback = 5, max = 30): number {
  return Math.min(max, Math.max(fallback, (text || "").length + 1));
}

export function chipFieldWidthForInput(
  text: string,
  fieldType: string | undefined,
  fallback = 5,
  padding = 0,
): number {
  const cap = fieldType === "number" ? 10 : 30;
  return chipFieldWidthChars(text, fallback, cap) + padding;
}

function chipFieldWidthForSelect(text: string, fallback = 3, max = 30): number {
  return chipFieldWidthChars(text, fallback, max) + 2;
}

export function buildCollapsedSummary<Row>(
  where: WhereTerm[],
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  const whereText = whereClauseSummaryText(where, byName);
  const orderText =
    orderBy.length === 0
      ? "(default)"
      : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
  return `WHERE ${whereText} ORDER BY ${orderText}`;
}

export function whereClauseSummaryText<Row>(
  where: WhereTerm[],
  byName: Map<string, FieldDef<Row>>,
): string {
  return where.length === 0
    ? "all rows"
    : where.map((t) => whereTermAsText(t, byName)).join(" and ");
}

export function orderBySummaryText<Row>(
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  return orderBy.length === 0
    ? "(default)"
    : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
}
