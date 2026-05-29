// useSelect — the SELECT list: visible columns, their order, and their widths,
// all persisted INTO the query (decision #5, so one URL renders identically
// anywhere). This API mutates QueryState.select; it holds no state of its own.
// Width changes should be debounced by the caller before they hit the query to
// avoid flooding history during a drag (useQueryTable does this).

import { useCallback, useMemo } from "react";
import type { QueryState, SelectColumn, FieldDef, FieldSchema } from "@query-table/core";
import { selectedFields } from "@query-table/core";

export interface SelectApi<Row> {
  /** Ordered visible columns (resolved: schema defaults when query.select is empty). */
  visible: SelectColumn[];
  /** The corresponding FieldDefs, same order. */
  fields: FieldDef<Row>[];
  /** Selectable fields not currently shown (for the "add column" picker). */
  hidden: FieldDef<Row>[];

  show: (field: string) => void;
  hide: (field: string) => void;
  /** Reorder via drag-drop: move `field` to `toIndex` in the visible order. */
  move: (field: string, toIndex: number) => void;
  /** Set a column's pixel width. */
  setWidth: (field: string, width: number) => void;
  /** Reset to the schema's default columns (clears query.select). */
  reset: () => void;
}

type SetQuery = (next: QueryState | ((prev: QueryState) => QueryState)) => void;

export function useSelect<Row>(query: QueryState, setQuery: SetQuery, schema: FieldSchema<Row>): SelectApi<Row> {
  const fields = useMemo(() => selectedFields(schema, query), [schema, query]);

  // The materialized SelectColumn[] (resolve defaults so the UI always has a
  // concrete, reorderable list even before the user customizes it).
  const visible = useMemo<SelectColumn[]>(() => fields.map((f) => columnFor(query.select, f.name)), [fields, query.select]);

  const hidden = useMemo<FieldDef<Row>[]>(() => {
    const shown = new Set(fields.map((f) => f.name));
    return schema.fields.filter((f) => !shown.has(f.name) && (f.select?.enabled ?? true));
  }, [schema, fields]);

  const writeSelect = useCallback(
    (mutate: (cols: SelectColumn[]) => SelectColumn[]) => {
      setQuery((prev) => {
        // Materialize current (resolved) columns the first time we diverge from defaults.
        const current = prev.select.length ? prev.select : visible;
        return { ...prev, select: mutate([...current]) };
      });
    },
    [setQuery, visible],
  );

  const show = useCallback((field: string) => writeSelect((c) => (c.some((x) => x.field === field) ? c : [...c, { field }])), [writeSelect]);
  const hide = useCallback((field: string) => writeSelect((c) => c.filter((x) => x.field !== field)), [writeSelect]);
  const move = useCallback(
    (field: string, toIndex: number) =>
      writeSelect((c) => {
        const from = c.findIndex((x) => x.field === field);
        if (from === -1) return c;
        const [item] = c.splice(from, 1);
        c.splice(Math.max(0, Math.min(toIndex, c.length)), 0, item!);
        return c;
      }),
    [writeSelect],
  );
  const setWidth = useCallback(
    (field: string, width: number) =>
      writeSelect((c) => c.map((x) => (x.field === field ? { ...x, width: Math.round(width) } : x))),
    [writeSelect],
  );
  const reset = useCallback(() => setQuery((prev) => ({ ...prev, select: [] })), [setQuery]);

  return { visible, fields, hidden, show, hide, move, setWidth, reset };
}

function columnFor(select: SelectColumn[], name: string): SelectColumn {
  const found = select.find((c) => c.field === name);
  return found ?? { field: name };
}
