import { useState } from "react";
import {
  DataTable,
  Icon,
  MetricsPanel,
  QueryBuilder,
  GroupedColumnsEditor,
  defaultRenderers,
  type RenderRegistry,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import { CollapsibleSection } from "../CollapsibleSection";
import { DEMO_METRIC_THEME } from "../metrics";
import { inputRows, type Row } from "./model";
import { useGroupingDemo } from "./useGroupingDemo";
import "../demo.css";
import "./grouping.css";
import "./groupingThemes.css";
const renderers: RenderRegistry<Row> = {
  ...defaultRenderers,
  overall_pill: ({ value }) =>
    value ? (
      <span className={`qt-pill--${String(value).toLowerCase()}`}>
        {String(value)}
      </span>
    ) : (
      <span>—</span>
    ),
  tag_marker: ({ value }) => (
    <span aria-label={value ? "Priority" : "Not priority"}>
      <Icon name="star" filled={Boolean(value)} />
    </span>
  ),
  link_run: ({ value }) => (
    <span className="qt-group-run-id">#{String(value)}</span>
  ),
  code_tags: ({ value }) => (
    <span>{((value as string[] | null) ?? []).join(", ") || "—"}</span>
  ),
};

export function GroupingDemo() {
  const demo = useGroupingDemo();
  const { api } = demo;
  const grouping = !!api.query.grouping;
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);
  const [palette, setPalette] = useState("default");
  return (
    <div className="qt-grouping-page" data-theme={palette}>
      <main className="qt-demo qt-grouping-demo">
        <header className="qt-demo-header">
          <p className="qt-demo-eyebrow">Grouping playground</p>
          <h1>query-table</h1>
          <a className="qt-group-original" href="/">
            Main playground
          </a>
        </header>
        <nav className="qt-group-views" aria-label="Saved views">
          <span className="qt-muted">Saved views</span>
          {api.saved.items.map((item) => (
            <button
              type="button"
              className="qt-btn"
              key={item.id}
              aria-pressed={demo.matchesSaved(item)}
              onClick={() => api.saved.load(item.id)}
            >
              {item.name}
            </button>
          ))}
          <label className="qt-group-palette">
            Palette
            <select
              className="qt-input"
              aria-label="Preview palette"
              value={palette}
              onChange={(event) => setPalette(event.target.value)}
            >
              <option value="default">Query-table</option>
              <option value="pharos-cream">Pharos · cream</option>
              <option value="pharos-forest">Pharos · forest</option>
            </select>
          </label>
        </nav>
        <QueryBuilder
          compact
          api={api}
          fields={api.schema!.fields}
          total={api.total}
          running={api.loading}
          metricTheme={DEMO_METRIC_THEME}
          {...(!grouping
            ? {
                selectPresentation: {
                  renderEditor: (onClose: () => void) => (
                    <GroupedColumnsEditor
                      controller={api.grouping!}
                      onClose={onClose}
                      renderers={renderers}
                    />
                  ),
                },
              }
            : {})}
        />
        {demo.startNotice && (
          <p className="qt-group-notice" role="status">
            {demo.startNotice}
          </p>
        )}
        {!!api.aggregations.clauses.length && (
          <CollapsibleSection
            title="Metrics"
            collapsed={metricsCollapsed}
            onToggle={setMetricsCollapsed}
            collapsedSummary={`${api.aggregations.clauses.length} metrics`}
            className="qt-qt-section--metrics"
          >
            <MetricsPanel
              api={api}
              aggregations={api.aggregations}
              fields={api.schema!.fields}
              renderers={renderers}
              theme={DEMO_METRIC_THEME}
            />
          </CollapsibleSection>
        )}
        <CollapsibleSection
          title="Table"
          collapsed={tableCollapsed}
          onToggle={setTableCollapsed}
          collapsedSummary={`${api.total ?? 0} ${grouping ? "groups" : "runs"}`}
          className="qt-qt-section--table"
        >
          <DataTable
            fields={api.visibleFields}
            rows={api.rows}
            query={api.query}
            onQueryChange={api.setQuery}
            total={api.total}
            renderers={renderers}
            rowId={api.rowId}
            columnDrag={api.columnDrag}
            loading={api.loading}
          />
        </CollapsibleSection>
        <p className="qt-group-footnote">
          {inputRows.length} sample runs · Standard query-table library
        </p>
      </main>
    </div>
  );
}
