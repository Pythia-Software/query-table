import { loadSchema, type RowId } from "@query-table/core";
import { useQueryTable } from "@query-table/react";
import {
  DataTable,
  QueryBuilder,
  SelectionToolbar,
  defaultRenderers,
  type RenderRegistry,
  type CellContext,
} from "@query-table/ui";
import "@query-table/ui/theme.css";

import runsDoc from "../../schema/examples/runs.schema.json";
import { RUNS, type Run } from "./data";

const schema = loadSchema<Run>(runsDoc);

const renderers: RenderRegistry<Run> = {
  ...defaultRenderers,
  overall_pill: ({ value }: CellContext<Run>) =>
    value ? <span className={`qt-pill--${String(value).toLowerCase()}`}>{String(value)}</span> : <span>—</span>,
  tag_marker: ({ value }: CellContext<Run>) => <button title="rerun-after-deploy">{value ? "★" : "☆"}</button>,
  link_run: ({ value }: CellContext<Run>) => <a href={`#run-${value}`}>{String(value)}</a>,
  step_tags: ({ value }: CellContext<Run>) => (
    <>
      {((value as string[] | null) ?? []).map((s) => (
        <span key={s} className="qt-pill--fail">
          {s}
        </span>
      ))}
    </>
  ),
  artifact_link: () => <button>view</button>,
};

export function App() {
  const api = useQueryTable<Run>({
    schema,
    clientRows: RUNS,
    syncUrl: true,
  });

  return (
    <div style={{ maxWidth: 1100, margin: "24px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20 }}>query-table — local demo</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        Client-side mode over {RUNS.length} mock rows. Drag the <code>select</code> chips and the table
        headers to reorder columns; drag the <code>order by</code> chips to re-prioritize sort.
      </p>

      <QueryBuilder api={api} fields={schema.fields} total={api.total} running={api.loading} />

      <SelectionToolbar
        selection={api.selection}
        actions={(ids: RowId[]) => <button>Re-run {ids.length}</button>}
      />

      <DataTable
        fields={api.visibleFields}
        rows={api.rows}
        query={api.query}
        onQueryChange={api.setQuery}
        total={api.total}
        renderers={renderers}
        rowId={(r: Run) => r.id}
        selection={api.selection}
        columnDrag={api.columnDrag}
        loading={api.loading}
        emptyMessage="No runs match this query."
      />
    </div>
  );
}
