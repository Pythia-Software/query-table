import { useState } from "react";
import { loadSchema, type RowId } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  DataTable,
  MetricsPanel,
  QueryBuilder,
  SelectionToolbar,
  defaultRenderers,
  type RenderRegistry,
  type CellContext,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

import runsDoc from "../../schema/examples/runs.schema.json";
import { RUNS, type Run } from "./data";
import { CollapsibleSection } from "./CollapsibleSection";

const schema = loadSchema<Run>(runsDoc);

const renderers: RenderRegistry<Run> = {
  ...defaultRenderers,
  overall_pill: ({ value }: CellContext<Run>) =>
    value ? <span className={`qt-pill--${String(value).toLowerCase()}`}>{String(value)}</span> : <span>—</span>,
  tag_marker: ({ value }: CellContext<Run>) => <span title="priority">{value ? "★" : "☆"}</span>,
  link_run: ({ value }: CellContext<Run>) => <a href={`#run-${value}`}>{String(value)}</a>,
  code_tags: ({ value }: CellContext<Run>) => (
    <>
      {((value as string[] | null) ?? []).map((s) => (
        <span key={s} className="qt-pill--fail">
          {s}
        </span>
      ))}
    </>
  ),
  detail_link: () => <button>view</button>,
};

export function App() {
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

  const api = useQueryTable<Run>({
    schema,
    clientRows: RUNS,
    syncUrl: true,
  });
  const metricCount = api.aggregations.clauses.length;
  const metricLabel = `${metricCount} metric${metricCount === 1 ? "" : "s"}`;
  const tableSummary = `${api.rows.length} row${api.rows.length === 1 ? "" : "s"}${api.total != null ? ` (of ${api.total} total)` : ""}`;

  return (
    <div style={{ maxWidth: 1100, margin: "24px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20 }}>query-table — local demo</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        Client-side mode over {RUNS.length} mock rows. Drag the <code>select</code> chips and the table
        headers to reorder columns; drag the <code>order by</code> chips to re-prioritize sort.
      </p>

      <QueryBuilder api={api} fields={schema.fields} total={api.total} running={api.loading} />

      <CollapsibleSection
        title="Metrics"
        collapsed={metricsCollapsed}
        onToggle={setMetricsCollapsed}
        collapsedSummary={metricLabel}
        className="qt-qt-section--metrics"
      >
        <MetricsPanel aggregations={api.aggregations} fields={schema.fields} renderers={renderers} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Table"
        collapsed={tableCollapsed}
        onToggle={setTableCollapsed}
        collapsedSummary={tableSummary}
        className="qt-qt-section--table"
      >
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
      </CollapsibleSection>
    </div>
  );
}
