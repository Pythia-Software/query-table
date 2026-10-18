import { useCallback, useMemo, type ReactNode } from "react";
import type {
  FieldDef,
  QueryState,
  WhereTerm,
} from "@pythia-software/query-table-core";
import {
  useQueryFilters,
  type QueryFilterApi,
  type QueryTableApi,
} from "@pythia-software/query-table-react";
import { QueryFilterRow } from "./QueryBuilder";

/** The table's WHERE chips, bound to one metric's own predicate instead of
 * the table query. Updates are functional so chained intents compose. */
export function MetricWhereEditor<Row>({
  api,
  fields,
  where,
  onChange,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  where: WhereTerm[];
  onChange: (update: (where: WhereTerm[]) => WhereTerm[]) => void;
}): ReactNode {
  // Filter intents only resolve field definitions; identity is irrelevant.
  const schema = useMemo(
    () => ({ name: api.schema?.name ?? "metric", idField: api.schema?.idField ?? "", fields }),
    [api.schema, fields],
  );
  const query = useMemo(() => ({ ...api.query, where }), [api.query, where]);
  const setQuery = useCallback(
    (next: QueryState | ((previous: QueryState) => QueryState)) =>
      onChange((current) =>
        (typeof next === "function"
          ? next({ ...api.query, where: current })
          : next
        ).where,
      ),
    [api.query, onChange],
  );
  const intents = useQueryFilters(schema, setQuery);
  const scoped: QueryFilterApi<Row> = {
    ...intents,
    query,
    setQuery,
    loading: false,
    filterValues: api.filterValues,
    fieldStats: api.fieldStats,
  };
  return <QueryFilterRow api={scoped} fields={fields} />;
}
