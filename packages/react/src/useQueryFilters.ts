import { useCallback, useMemo } from "react";
import {
  isOrGroup,
  predicatesOf,
  negateClause,
  opsForField,
  type FieldSchema,
  type WhereClause,
  type WhereTerm,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "./useQueryTable";

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
          return clause;
        }),
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
          return negateOne(term);
        }),
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
        const merged: WhereTerm = {
          any: [...predicatesOf(target), ...predicatesOf(source)],
        };
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
