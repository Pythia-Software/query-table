import { useCallback, useState } from "react";
import {
  decodeQuery,
  encodeQuery,
  loadSchema,
  localStorageAdapter,
  normalizeQueryState,
  type LinkTargets,
  type RowId,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  Icon,
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
import { DEMO_METRICS, DEMO_METRIC_THEME } from "./metrics";
import { RUNS, type Run } from "./data";
import {
  DATE_EXAMPLE_RUNS,
  DATE_EXAMPLE_QUERY,
  dateExampleSchema,
} from "./dateMetricWorkbench";
import { CollapsibleSection } from "./CollapsibleSection";
import { SavedQueryControlsPrototype } from "./SavedQueryControlsPrototype";
import { savedQueriesPrototypeStorage } from "./savedQueriesPrototypeStorage";
import "./demo.css";

const schema = loadSchema<Run>(runsDoc);
const prototypeSchema = { ...schema, name: `${schema.name}:saved-queries-prototype` };
const prototypeStorage = savedQueriesPrototypeStorage(normalizeQueryState({
  select: schema.defaultSelect ?? [],
  where: [],
  orderBy: schema.defaultSort ?? [],
  limit: schema.defaultLimit ?? 100,
  offset: 0,
  aggregations: DEMO_METRICS.slice(0, 3),
}));
const dateSchema = dateExampleSchema(schema);
const storage = localStorageAdapter();
// The demo has a durable seeded dashboard; saved query/URL restoration still wins.
const demoStorage = {
  ...storage,
  loadLast: async (name: string) =>
    (await storage.loadLast(name)) ??
    (name === dateSchema.name
      ? DATE_EXAMPLE_QUERY
      : {
          select: schema.defaultSelect ?? [],
          where: [],
          orderBy: schema.defaultSort ?? [],
          limit: schema.defaultLimit ?? 100,
          offset: 0,
          aggregations: DEMO_METRICS,
        }),
};
const runIdField = schema.fields.find((f) => f.name === "id");
if (runIdField)
  runIdField.aggregate = { ...runIdField.aggregate, groupable: true };
const errorCodesField = schema.fields.find(
  (field) => field.name === "error_codes",
);
if (errorCodesField) {
  errorCodesField.filter = {
    ...errorCodesField.filter,
    editor: "set",
    arrayCaseSensitive: true,
    values: {
      source: "static",
      options: [
        { value: "timeout", label: "Timeout" },
        { value: "validation", label: "Validation" },
      ],
    },
  };
}

const renderers: RenderRegistry<Run> = {
  ...defaultRenderers,
  overall_pill: ({ value }: CellContext<Run>) =>
    value ? (
      <span className={`qt-pill--${String(value).toLowerCase()}`}>
        {String(value)}
      </span>
    ) : (
      <span>—</span>
    ),
  tag_marker: ({ value }: CellContext<Run>) => (
    <span role="img" aria-label={value ? "Priority" : "Not priority"}>
      <Icon name="star" filled={Boolean(value)} />
    </span>
  ),
  link_run: ({ value }: CellContext<Run>) => (
    <a href={`#run-${value}`}>{String(value)}</a>
  ),
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

/** Group link columns with `to: { kind: "query", target: "runs" }` open the
 * composed query in this table. The href is a real URL, so modifier clicks
 * open it in a new tab; plain clicks stay client-side via onNavigate. */
const LINK_TARGETS: LinkTargets = {
  runs: (query) => `/?q=${encodeQuery(query)}`,
};

export function App({ dateExample = false, savedQueriesPrototype = false }: {
  dateExample?: boolean;
  savedQueriesPrototype?: boolean;
}) {
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

  const api = useQueryTable<Run>({
    schema: savedQueriesPrototype ? prototypeSchema : dateExample ? dateSchema : schema,
    clientRows: dateExample ? DATE_EXAMPLE_RUNS : RUNS,
    storage: savedQueriesPrototype ? prototypeStorage : demoStorage,
    syncUrl: true,
  });
  const { setQuery } = api;
  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.href);
    const token = url.searchParams.get("q");
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !token) return false;
    setQuery(decodeQuery(token));
    return true;
  }, [setQuery]);
  const metricCount = api.aggregations.clauses.length;
  const metricLabel = `${metricCount} metric${metricCount === 1 ? "" : "s"}`;
  const tableSummary = `${api.rows.length} row${api.rows.length === 1 ? "" : "s"}${api.total != null ? ` (of ${api.total} total)` : ""}`;

  return (
    <main className={`qt-demo${savedQueriesPrototype ? " qt-saved-queries-demo" : ""}`}>
      <header className="qt-demo-header">
        <p className="qt-demo-eyebrow">{savedQueriesPrototype ? "Saved queries · Prototype" : "Interactive playground"}</p>
        <h1>query-table{dateExample ? " · Date metric example" : ""}</h1>
        {savedQueriesPrototype && <a className="qt-save-prototype-compare" href="/">Compare current UI <Icon name="arrowRight" size={12} /></a>}
      </header>
      {savedQueriesPrototype ? (
        <p className="qt-demo-intro">
          Choose a query, make changes, and save when you’re ready.
        </p>
      ) : dateExample ? (
        <p className="qt-demo-intro">
          96 runs across October 1–14, with seven empty days. Open{" "}
          <strong>Edit metrics</strong>, choose <strong>Runs by day</strong>,
          and expand <strong>Grouping</strong> to try empty dates in the
          existing workbench.
        </p>
      ) : (
        <p className="qt-demo-intro">
          <span className="qt-demo-desktop-copy">
            Client-side mode over {RUNS.length} mock rows. Drag the{" "}
            <code>select</code> chips and the table headers to reorder columns;
            drag the <code>order by</code> chips to re-prioritize sort.
          </span>
          <span className="qt-demo-mobile-copy">
            Explore {RUNS.length} mock rows. Tap the pencil to edit or remove a
            clause, drag handles to reorder, and swipe the table to see every
            column.
          </span>
        </p>
      )}

      {savedQueriesPrototype ? null : dateExample ? (
        <p className="qt-demo-intro">
          <a href="/">← Back to the main playground</a>
        </p>
      ) : (
        <>
          <p className="qt-demo-intro">
            <a href="/postgres">
              Explore 500,000 PostgreSQL rows with the Go backend and adjustable
              latency
            </a>
          </p>
          <p className="qt-demo-intro"><a href="/cells">Explore formatted cells and JSON in item details</a></p>
          <p className="qt-demo-intro">
            <a href="/grouping">Explore grouped saved views and representative rows</a>
          </p>
          <p className="qt-demo-intro">
            <a href="/objects">Customize and save views of individual objects</a>
          </p>
          <p className="qt-demo-intro">
            <a href="/date-metrics">
              Try date grouping with empty dates in a metric definition
            </a>
          </p>
          <p className="qt-demo-intro">
            <a href="/date-metrics-workbench">
              Try empty dates in the existing metric workbench
            </a>
          </p>
        </>
      )}

      <QueryBuilder
        api={api}
        fields={api.schema!.fields}
        total={api.total}
        running={api.loading}
        metricTheme={DEMO_METRIC_THEME}
        savedQueryControls={savedQueriesPrototype ? <SavedQueryControlsPrototype api={api} /> : undefined}
      />

      <CollapsibleSection
        title="Metrics"
        collapsed={metricsCollapsed}
        onToggle={setMetricsCollapsed}
        collapsedSummary={metricLabel}
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
          linkTargets={LINK_TARGETS}
          onNavigate={navigate}
          rowId={api.rowId}
          selection={api.selection}
          columnDrag={api.columnDrag}
          loading={api.loading}
          emptyMessage="No runs match this query."
        />
      </CollapsibleSection>
    </main>
  );
}
