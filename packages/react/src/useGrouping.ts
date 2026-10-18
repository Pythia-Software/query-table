import { useEffect, useRef, useState } from "react";
import {
  MAX_SUMMARY_COLUMNS,
  normalizeQueryState,
  predicatesOf,
  withGroupingKeys,
  withoutGrouping,
  type FieldSchema,
  type GroupedRow,
  type GroupingModel,
  queriesEqual,
  type GroupingView,
  type QueryState,
  type RepresentativeRow,
  type SelectColumn,
  type SummaryColumn,
  type SummaryOp,
} from "@pythia-software/query-table-core";
import type { QueryFilterApi } from "./useQueryFilters";
import type { QueryTableApi } from "./useQueryTable";

/** Source-stage controls. Rows/columns/metrics remain on the active result API. */
export type GroupingSourceApi<Row> = QueryFilterApi<Row> &
  Pick<QueryTableApi<Row>, "itemDetails" | "rowId"> & {
    schema: FieldSchema<Row>;
  };

export interface GroupingApi<Row> {
  inputsReady?: boolean;
  preview?: (query: QueryState, signal?: AbortSignal) => Promise<{ rows: GroupedRow[]; sourceTotal: number; total: number }>;
  supported: boolean;
  model: GroupingModel<Row>;
  api: QueryTableApi<Row>;
  source: GroupingSourceApi<Row>;
  grouped: QueryTableApi<Row>;
  schema: FieldSchema<Row>;
  view: GroupingView;
  /** Problems with link columns. They never block the grouped table: an
   * invalid link renders as plain text. Unregistered host targets are
   * reported when rendering. */
  diagnostics: string[];
  inputs: Row[];
  notice: string;
  setNotice: (notice: string) => void;
  changeKeys: (keys: string[]) => void;
  addSummary: (op: SummaryOp, field?: string) => void;
  changeSummary: (id: string, op: SummaryOp) => void;
  changeRepresentative: (rule: RepresentativeRow | null) => void;
  representativeImpact: () => string;
  applyColumns: (summaries: SummaryColumn[], columns: SelectColumn[]) => void;
}

/** Structural edits are one normal QueryState transaction: persistence,
 * sharing, undo and redo all retain the original source query and result view. */
export function useGroupingController<Row>(
  api: QueryTableApi<Row>,
  source: GroupingSourceApi<Row>,
  model: GroupingModel<Row>,
  inputs: Row[],
  supported: boolean,
  viewRevision: number,
  execution: Pick<GroupingApi<Row>, "inputsReady" | "preview"> = {},
): GroupingApi<Row> {
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [viewRevision]);
  const previous = useRef<{ query: QueryState; revision: number } | null>(null);
  const stage = api.query.grouping;
  const view: GroupingView = {
    version: 2,
    mode: stage ? "groups" : "rows",
    keys: stage?.keys ?? [],
    summaries: stage?.summaries ?? [],
    representative: stage?.representative ?? null,
    input: source.query,
    result: withoutGrouping(api.query),
  };
  const outputSchema = {
    ...api.schema!,
    fields: api.computed.catalogue,
  } as unknown as FieldSchema<GroupedRow>;
  function changeKeys(keys: string[]) {
    if (keys.length && !supported) return;
    const cached =
      previous.current?.revision === viewRevision
        ? previous.current.query
        : null;
    const canRestore = (current: QueryState) =>
      !current.grouping && cached?.grouping &&
      queriesEqual(cached.grouping.source, current) &&
      JSON.stringify(cached.grouping.keys) === JSON.stringify(keys);
    // Reject at the intent boundary, where callers can display the error.
    // Throwing inside a state updater instead fails React's next render.
    if (keys.length)
      model.validate(canRestore(api.query) ? cached!.grouping! : {
        ...(stage ?? { summaries: [], representative: null }),
        keys,
      });
    if (!keys.length && stage)
      previous.current = { query: api.query, revision: viewRevision };
    api.setQuery((current) => {
      // Restore a previous grouped layout only for the same explicit keys.
      if (keys.length && !current.grouping && cached?.grouping && canRestore(current))
        return {
          ...cached,
          grouping: { ...cached.grouping, source: current },
        };
      return withGroupingKeys(current, keys);
    });
    setNotice(
      stage && api.query.aggregations?.length && keys.length
        ? "Grouping changed. Group metrics cleared; Undo restores them."
        : "",
    );
    api.selection.clear();
  }
  function applyColumns(summaries: SummaryColumn[], columns: SelectColumn[]) {
    if (!stage) {
      api.setQuery((q) => ({ ...q, select: columns }));
      return;
    }
    model.validate({ ...stage, summaries });
    const changed = new Set(
      stage.summaries
        .filter((before) => {
          const after = summaries.find((column) => column.id === before.id);
          return (
            !after ||
            before.op !== after.op ||
            before.field !== after.field ||
            before.expression !== after.expression
          );
        })
        .map((column) => column.id),
    );
    api.setQuery((q) =>
      q.grouping
        ? {
            ...q,
            grouping: { ...q.grouping, summaries },
            select: columns,
            ...(changed.size
              ? {
                  offset: 0,
                  aggregations: [],
                  where: q.where.filter(
                    (term) =>
                      !predicatesOf(term).some((p) => changed.has(p.field)),
                  ),
                  orderBy: q.orderBy.filter((term) => !changed.has(term.field)),
                }
              : {}),
          }
        : q,
    );
    setNotice(
      changed.size &&
        (api.query.where.some((term) =>
          predicatesOf(term).some((p) => changed.has(p.field)),
        ) ||
          api.query.orderBy.some((term) => changed.has(term.field)) ||
          api.query.aggregations?.length)
        ? "Columns updated. Affected filters, sorts, and metrics cleared; Undo restores them."
        : "",
    );
  }
  function addSummary(op: SummaryOp, field?: string) {
    if (!stage || (op === "row" && !stage.representative)) return;
    const existing = stage.summaries.find(
      (column) => column.op === op && column.field === field,
    );
    if (!existing && stage.summaries.length >= MAX_SUMMARY_COLUMNS) {
      setNotice(
        `A grouped view supports up to ${MAX_SUMMARY_COLUMNS} aggregate columns.`,
      );
      return;
    }
    const column = existing ?? {
      id: `summary_${crypto.randomUUID().replace(/-/g, "")}`,
      op,
      ...(field ? { field } : {}),
    };
    applyColumns(
      existing ? stage.summaries : [...stage.summaries, column],
      api.select.visible.some((c) => c.field === column.id)
        ? api.select.visible
        : [...api.select.visible, { field: column.id }],
    );
  }
  function changeSummary(id: string, op: SummaryOp) {
    if (!stage) return;
    applyColumns(
      stage.summaries.map((column) => {
        if (column.id !== id) return column;
        // A row value keeps the source field's rendering, not an aggregate format.
        const { display: _display, ...rest } = column;
        return op === "row" ? { ...rest, op } : { ...column, op };
      }),
      api.select.visible,
    );
  }
  function representativeImpact() {
    if (!stage) return "";
    const before = api.query;
    const after = model.reconcileRepresentative(
      before,
      stage.summaries,
      outputSchema,
      false,
    );
    return [
      before.where.length !== after.where.length ? "row-value filters" : "",
      before.orderBy.length !== after.orderBy.length ? "row-value sorts" : "",
      (before.aggregations?.length ?? 0) !== (after.aggregations?.length ?? 0)
        ? "dependent metrics"
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  function changeRepresentative(representative: RepresentativeRow | null) {
    if (
      !stage ||
      JSON.stringify(stage.representative) === JSON.stringify(representative)
    )
      return;
    const summaries = representative
      ? stage.summaries
      : stage.summaries.filter((column) => column.op !== "row");
    model.validate({ ...stage, summaries, representative });
    const impact = representativeImpact();
    api.setQuery((q) =>
      q.grouping
        ? normalizeQueryState({
            ...model.reconcileRepresentative(
              q,
              stage.summaries,
              outputSchema,
              !representative,
            ),
            grouping: { ...q.grouping, summaries, representative },
          })
        : q,
    );
    setNotice(
      impact
        ? `Representative row changed. Cleared ${impact}; Undo restores them.`
        : "",
    );
  }
  return {
    ...execution,
    supported,
    model,
    api,
    source,
    grouped: api,
    schema: api.schema!,
    view,
    diagnostics: stage ? model.linkDiagnostics(stage) : [],
    inputs,
    notice,
    setNotice,
    changeKeys,
    addSummary,
    changeSummary,
    applyColumns,
    changeRepresentative,
    representativeImpact,
  };
}
