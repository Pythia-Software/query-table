import { useCallback, useMemo } from "react";
import {
  branchesOf,
  isOrGroup,
  isWhereConjunction,
  negateClause,
  opsForField,
  type FieldSchema,
  type WhereBranch,
  type WhereClause,
  type WhereTerm,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "./useQueryTable";

/** Edit the `predIndex`-th literal of an OR of conjunctions, counted in
 *  `predicatesOf` order; `edit` returning null removes it. Returns the term in
 *  canonical form: a conjunction of one is its literal, a group of one branch
 *  its literal(s), and an emptied group nothing. */
function editBranchPredicate(
  term: { any: WhereBranch[] },
  predIndex: number,
  edit: (clause: WhereClause) => WhereClause | null,
): WhereTerm[] {
  let k = 0;
  const any: WhereBranch[] = [];
  for (const member of term.any) {
    const kept: WhereClause[] = [];
    for (const clause of isWhereConjunction(member) ? member.all : [member]) {
      const next = k++ === predIndex ? edit(clause) : clause;
      if (next) kept.push(next);
    }
    if (kept.length === 1) any.push(kept[0]!);
    else if (kept.length > 1) any.push({ all: kept });
  }
  if (any.length > 1) return [{ any } as WhereTerm];
  const only = any[0];
  return !only ? [] : isWhereConjunction(only) ? only.all : [only];
}

/** Filter controls for either the result query or grouping's source query. */
export type QueryFilterApi<Row> = Pick<
  QueryTableApi<Row>,
  | "query"
  | "setQuery"
  | "loading"
  | "addFilter"
  | "updateFilter"
  | "removeFilter"
  | "clearFilters"
  | "updatePredicate"
  | "removePredicate"
  | "negatePredicate"
  | "reorderFilters"
  | "mergeFilters"
  | "filterValues"
  | "fieldStats"
>;

/** Bind filter intents to a query stage, including the source WHERE of grouping. */
export function useQueryFilters<Row>(
  schema: FieldSchema<Row>,
  setQuery: QueryTableApi<Row>["setQuery"],
) {
  const byName = useMemo(
    () => new Map(schema.fields.map((field) => [field.name, field])),
    [schema],
  );
  const addFilter = useCallback(
    (clause: WhereClause) =>
      setQuery((q) => ({ ...q, offset: 0, where: [...q.where, clause] })),
    [setQuery],
  );
  const updateFilter = useCallback(
    (index: number, clause: WhereClause) =>
      setQuery((q) => ({
        ...q,
        offset: 0,
        where: q.where.map((t, i) => (i === index ? clause : t)),
      })),
    [setQuery],
  );
  const removeFilter = useCallback(
    (index: number) =>
      setQuery((q) => ({
        ...q,
        offset: 0,
        where: q.where.filter((_, i) => i !== index),
      })),
    [setQuery],
  );
  const clearFilters = useCallback(
    () => setQuery((q) => ({ ...q, offset: 0, where: [] })),
    [setQuery],
  );

  const updatePredicate = useCallback<QueryTableApi<Row>["updatePredicate"]>(
    (termIndex, predIndex, clause) =>
      setQuery((q) => ({
        ...q,
        offset: 0,
        where: q.where.map((term, i) => {
          if (i !== termIndex) return term;
          if (isOrGroup(term))
            return {
              any: term.any.map((c, j) => (j === predIndex ? clause : c)),
            };
          if ("any" in term) return editBranchPredicate(term, predIndex, () => clause);
          return clause;
        }).flat(),
      })),
    [setQuery],
  );
  const removePredicate = useCallback<QueryTableApi<Row>["removePredicate"]>(
    (termIndex, predIndex) =>
      setQuery((q) => {
        const where: WhereTerm[] = [];
        q.where.forEach((term, i) => {
          if (i !== termIndex) {
            where.push(term);
            return;
          }
          if (isOrGroup(term)) {
            const members = term.any.filter((_, j) => j !== predIndex);
            if (members.length === 1) where.push(members[0]!);
            else if (members.length > 1) where.push({ any: members });
            return; // 0 members → drop the term
          }
          if ("any" in term) {
            where.push(...editBranchPredicate(term, predIndex, () => null));
            return;
          }
          // literal term → removing its predicate drops the whole term
        });
        return { ...q, offset: 0, where };
      }),
    [setQuery],
  );
  const negateOne = useCallback(
    (clause: WhereClause): WhereClause => {
      const field = byName.get(clause.field);
      return negateClause(clause, field ? opsForField(field) : undefined);
    },
    [byName],
  );
  const negatePredicate = useCallback<QueryTableApi<Row>["negatePredicate"]>(
    (termIndex, predIndex) =>
      setQuery((q) => ({
        ...q,
        offset: 0,
        where: q.where.map((term, i) => {
          if (i !== termIndex) return term;
          if (isOrGroup(term))
            return {
              any: term.any.map((c, j) => (j === predIndex ? negateOne(c) : c)),
            };
          if ("any" in term) return editBranchPredicate(term, predIndex, negateOne);
          return negateOne(term);
        }).flat(),
      })),
    [setQuery, negateOne],
  );
  const reorderFilters = useCallback<QueryTableApi<Row>["reorderFilters"]>(
    (fromIndex, toIndex) =>
      setQuery((q) => {
        if (fromIndex < 0 || fromIndex >= q.where.length) return q;
        const where = [...q.where];
        const [moved] = where.splice(fromIndex, 1);
        where.splice(Math.max(0, Math.min(toIndex, where.length)), 0, moved!);
        return { ...q, offset: 0, where };
      }),
    [setQuery],
  );
  const mergeFilters = useCallback<QueryTableApi<Row>["mergeFilters"]>(
    (sourceIndex, targetIndex) =>
      setQuery((q) => {
        if (sourceIndex === targetIndex) return q;
        const source = q.where[sourceIndex];
        const target = q.where[targetIndex];
        if (!source || !target) return q;
        // OR the two terms' branches, so a conjunction stays one branch.
        const merged = {
          any: [...branchesOf(target), ...branchesOf(source)].map(
            (branch): WhereBranch => (branch.length === 1 ? branch[0]! : { all: branch }),
          ),
        } as WhereTerm;
        const where: WhereTerm[] = [];
        q.where.forEach((term, i) => {
          if (i === sourceIndex) return; // remove the dragged term
          where.push(i === targetIndex ? merged : term);
        });
        return { ...q, offset: 0, where };
      }),
    [setQuery],
  );
  return {
    addFilter,
    updateFilter,
    removeFilter,
    clearFilters,
    updatePredicate,
    removePredicate,
    negatePredicate,
    reorderFilters,
    mergeFilters,
  };
}
