import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import {
  normalizeQueryState,
  queriesEqual,
  type SavedQuery,
  metricDateTime,
  metricDateNext,
  type AggregationBucket,
  type AggregationClause,
  type WhereTerm,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  DataTable,
  QueryBuilder,
  MetricsPanel,
  SelectionToolbar,
  Icon,
  ModalSurface,
  defaultRenderers,
  type MetricTheme,
  type RenderRegistry,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import { DATASETS, type Dataset } from "./data";
import { loadDataset, type LoadedDataset } from "./runtime";
import {
  showcaseComputedStore,
  showcaseQueryStorage,
  isExampleQuery,
} from "./storage";
import { SavedQueries, SaveQueryDialog } from "./SavedQueries";
import { GuidedTour, useGuidedTour } from "./tour";
import { useShowcaseExecution } from "./execution";
import { IntegrationGuide } from "./IntegrationGuide";
import "./showcase.css";

const theme: MetricTheme = {
  layers: [
    {
      id: "public-data",
      colors: [
        "#47786f",
        "#c69443",
        "#718cad",
        "#b77461",
        "#91809b",
        "#97a77f",
        "#5e777c",
        "#c1a386",
      ],
    },
  ],
};
const renderers: RenderRegistry = {
  ...defaultRenderers,
  "external-link": ({ value }) => {
    const url = String(value ?? "");
    return url.startsWith("https://world.openfoodfacts.org/product/") ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        View source ↗
      </a>
    ) : (
      <span>—</span>
    );
  },
};
const initial = () =>
  DATASETS.find(
    (dataset) =>
      dataset.id === new URLSearchParams(location.search).get("dataset"),
  ) ?? DATASETS[0]!;
const computedColumnStore = showcaseComputedStore();

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="showcase-fatal">
        <h1>The demo could not open.</h1>
        <p>{this.state.error}</p>
        <button
          onClick={() => {
            const url = new URL(location.href);
            for (const key of [...url.searchParams.keys()])
              if (key.startsWith("q_")) url.searchParams.delete(key);
            location.assign(url);
          }}
        >
          Reload the default view
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Workspace({
  dataset,
  loaded,
}: {
  dataset: Dataset;
  loaded: LoadedDataset;
}) {
  const [openSource, setOpenSource] = useState(false);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const [queryCollapsed, setQueryCollapsed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [integration, setIntegration] = useState<"invite" | "slides" | null>(null);
  const offeredIntegration = useRef(false);
  const tourLaunch = useRef<HTMLButtonElement>(null);
  const integrationReturnFocus = useRef<HTMLElement | null>(null);
  const execution = useShowcaseExecution(loaded, dataset, computedColumnStore);
  const transport = useMemo(
    () => execution.backend.transport(),
    [execution.backend],
  );
  const storage = useMemo(() => showcaseQueryStorage(dataset), [dataset]);
  const api = useQueryTable({
    schema: dataset.schema,
    transport,
    storage,
    active: execution.ready,
    computedColumnStore: execution.store,
    computedExecution: execution.backend.execution,
    syncUrl: true,
    queryParameter: `q_${dataset.id}`,
    links: { maxUrlBytes: 12000 },
    itemDetails: true,
    debounceMs: 120,
  });
  const tour = useGuidedTour(api, dataset, {
    ready: execution.ready,
    revisions: execution.backend.execution.resolvedRevisions,
    async load(id) {
      await api.saved.load(id);
      onLoad(id);
    },
    async save(name) {
      const saved = await api.saved.save(name);
      onSaved(saved);
      return saved;
    },
    prepare(chapter) {
      api.setQuery(
        chapter === "views"
          ? dataset.recipes[dataset.id === "food" ? 2 : 1]!.query
          : dataset.defaults,
      );
      api.selection.clear();
      setSelectedId(null);
      setMessage("");
    },
  });
  const queryApi = {
    ...api,
    links: {
      ...api.links,
      async create(...args: Parameters<typeof api.links.create>) {
        const link = await api.links.create(...args);
        // Successful link creation also covers the native mobile share sheet.
        tour.record({ type: "share" });
        return link;
      },
    },
  };
  useEffect(() => {
    if (tour.finished && !offeredIntegration.current) {
      integrationReturnFocus.current = tourLaunch.current;
      setIntegration("invite");
    }
    offeredIntegration.current = tour.finished;
  }, [tour.finished]);
  function openIntegration(trigger: HTMLElement) {
    integrationReturnFocus.current = trigger;
    tour.end();
    setIntegration("slides");
  }
  const selected = api.saved.items.find((item) => item.id === selectedId);
  const matching = api.saved.items.find((item) =>
    queriesEqual(normalizeQueryState(item.query, api.defaults), api.query),
  );
  const activeId = selectedId ?? matching?.id ?? null;
  const dirty = selected
    ? !queriesEqual(
        normalizeQueryState(selected.query, api.defaults),
        api.query,
      )
    : !matching;
  const viewName = selected?.name ?? matching?.name ?? "Custom query";
  useEffect(() => {
    if (selectedId && !api.saved.loading && !selected) setSelectedId(null);
  }, [selectedId, selected, api.saved.loading]);
  useEffect(() => {
    if (!tour.active) return;
    setQueryCollapsed(false);
    if (tour.chapter?.id === "metrics") setMetricsCollapsed(false);
  }, [tour.active, tour.step?.id, tour.preview]);
  function onLoad(id: string) {
    setSelectedId(id);
    tour.record({ type: "load", id });
    setMessage("");
  }
  function onSaved(saved: SavedQuery) {
    setSelectedId(saved.id);
    tour.record({ type: "saved", saved });
    setMessage(`Saved “${saved.name}” in this browser.`);
  }
  async function updateView() {
    if (!selected) return;
    setUpdating(true);
    try {
      onSaved(await api.saved.update(selected.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  }
  function inspect(bucket: AggregationBucket, clause: AggregationClause) {
    const where: WhereTerm[] = clause.groupBy.flatMap<WhereTerm>(
      (field, index) => {
        const value = bucket.keys[index] ?? null;
        if (value === null) return [{ field, op: "is_null", value: "" }];
        if (clause.dateGrouping && index === 0) {
          const config = clause.dateGrouping,
            start = metricDateTime(value),
            end = metricDateNext(start, config.interval, config.timeZone);
          return [
            { field, op: ">=", value: new Date(start).toISOString() },
            { field, op: "<", value: new Date(end).toISOString() },
          ];
        }
        return [{ field, op: "=", value: String(value) }];
      },
    );
    if (!where.length) return;
    api.setQuery((previous) => ({
      ...previous,
      where: [...previous.where, ...where],
      offset: 0,
    }));
    tour.record({ type: "inspect" });
    setMessage(
      `Filtered by ${bucket.keys.map((value) => value ?? "missing value").join(" / ")}.`,
    );
  }
  async function downloadSelection() {
    setExporting(true);
    try {
      const ids = [...api.selection.selected];
      const rows = api.rows.filter((row) => {
        const identity = api.rowId(row);
        return identity !== null && ids.includes(identity);
      });
      const href = URL.createObjectURL(
        new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = href;
      link.download = `query-table-${dataset.id}-selected.json`;
      link.click();
      URL.revokeObjectURL(href);
      setMessage(`Exported ${rows.length} selected records from this page.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }
  const controls = (
    <>
      <span className="showcase-current-view" title={viewName}>
        <Icon name="bookmark" size={14} />
        <span>{viewName}</span>
        {dirty && <small>Modified</small>}
      </span>
      <button
        type="button"
        className="qt-btn showcase-save-button"
        aria-label="Save query"
        onClick={() => setSaving(true)}
        disabled={api.loading || !api.restoration.ready}
      >
        <Icon name="add" size={14} />
        Save query
      </button>
      {selected && !isExampleQuery(selected.id) && dirty && (
        <button
          type="button"
          className="qt-btn"
          onClick={() => void updateView()}
          disabled={updating || api.loading}
        >
          {updating ? "Updating…" : "Update saved query"}
        </button>
      )}
    </>
  );
  return (
    <>
      <div className="showcase-workspace-heading">
        <div>
          <h1>{dataset.title}</h1>
          <span>
            {loaded.manifest.rows.toLocaleString()} {dataset.noun}
          </span>
          <span className="showcase-local">
            <i />
            In your browser
          </span>
        </div>
        <div className="showcase-workspace-actions">
          <button type="button" className="showcase-text-button" onClick={event => openIntegration(event.currentTarget)}>
            Build with Query Table
          </button>
          <button
            type="button"
            className="showcase-text-button"
            onClick={() => setOpenSource(true)}
          >
            Data & sources
          </button>
          <button
            type="button"
            className="qt-btn showcase-tour-launch"
            ref={tourLaunch}
            onClick={() => {
              setQueryCollapsed(false);
              tour.start();
            }}
            disabled={
              api.saved.loading || api.loading || !api.restoration.ready
            }
          >
            <Icon name="arrowRight" size={15} />
            {tour.active ? "Restart tour" : "Take the tour"}
          </button>
        </div>
      </div>
      <div className="showcase-workspace">
        <aside className="showcase-sidebar">
          {tour.finished && (
            <p className="showcase-tour-finished" role="status">
              <Icon name="check" size={15} />
              Tour complete. Keep exploring.
            </p>
          )}
          <SavedQueries
            api={api}
            dataset={dataset}
            selectedId={activeId}
            onLoad={onLoad}
          />
        </aside>
        <div className="showcase-content">
          <section className="showcase-query" aria-label="Query editor">
            <QueryBuilder
              api={queryApi}
              fields={api.schema!.fields}
              total={api.total}
              running={api.loading}
              metricTheme={theme}
              collapsed={queryCollapsed}
              onCollapsedChange={setQueryCollapsed}
              savedQueryControls={controls}
            />
          </section>
          {(api.error || api.aggregations.error || execution.error) && (
            <div role="alert" className="showcase-error">
              <strong>This view needs a change.</strong>
              <span>
                {execution.error ??
                  (api.error ?? api.aggregations.error)?.message}
              </span>
              <button
                type="button"
                onClick={() => api.setQuery(dataset.defaults)}
              >
                Reset view
              </button>
            </div>
          )}
          <section className="showcase-table" aria-label="Results">
            <div className="showcase-section-heading">
              <h2>{api.query.grouping ? "Grouped results" : "Records"}</h2>
              <span>
                {api.total === null
                  ? "Loading…"
                  : `${api.total.toLocaleString()} matching ${api.query.grouping ? "groups" : dataset.noun}`}
              </span>
            </div>
            <SelectionToolbar
              selection={api.selection}
              actions={() => (
                <button
                  type="button"
                  className="qt-btn"
                  onClick={downloadSelection}
                  disabled={exporting}
                >
                  Export selected on this page
                </button>
              )}
            />
            <DataTable
              fields={api.visibleFields}
              rows={api.rows}
              query={api.query}
              onQueryChange={api.setQuery}
              total={api.total}
              rowId={api.rowId}
              selection={api.selection}
              columnDrag={api.columnDrag}
              loading={api.loading}
              renderers={renderers}
              itemDetails={api.itemDetails!}
              emptyMessage="No records match. Adjust a filter or open another saved query."
              maxHeight={430}
            />
          </section>
          <section className="showcase-metrics" aria-label="Metrics dashboard">
            <div className="showcase-section-heading">
              <h2>Metrics</h2>
              <button
                type="button"
                className="showcase-text-button"
                aria-expanded={!metricsCollapsed}
                onClick={() => setMetricsCollapsed((value) => !value)}
              >
                {metricsCollapsed ? "Show metrics" : "Hide metrics"}
                <Icon
                  name={metricsCollapsed ? "chevronRight" : "chevronDown"}
                  size={14}
                />
              </button>
            </div>
            {!metricsCollapsed && (
              <MetricsPanel
                api={api}
                aggregations={api.aggregations}
                fields={api.schema!.fields}
                renderers={renderers}
                theme={theme}
                onInspect={inspect}
              />
            )}
          </section>
          <p className="showcase-announcement" role="status" aria-live="polite">
            {message}
          </p>
        </div>
      </div>
      <GuidedTour tour={tour} />
      {integration && <IntegrationGuide mode={integration} returnFocus={integrationReturnFocus.current} onStart={() => setIntegration("slides")} onClose={() => setIntegration(null)} />}
      {saving && (
        <SaveQueryDialog
          api={api}
          onClose={() => setSaving(false)}
          onSaved={onSaved}
        />
      )}
      {openSource && (
        <ModalSurface
          title="Data & sources"
          onClose={() => setOpenSource(false)}
        >
          <div className="showcase-source">
            <h2>{loaded.manifest.source}</h2>
            <p>{loaded.manifest.cohort}</p>
            <p>{loaded.manifest.transformations}</p>
            <div>
              <a
                href={loaded.manifest.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Source ↗
              </a>
              <a
                href={loaded.manifest.licenseUrl}
                target="_blank"
                rel="noreferrer"
              >
                {loaded.manifest.license} ↗
              </a>
              <a href={`./data/${loaded.manifest.file}`} download>
                Download snapshot
              </a>
            </div>
            <small>
              Prepared{" "}
              {new Date(loaded.manifest.preparedAt).toLocaleDateString(
                "en-US",
                { year: "numeric", month: "short", day: "numeric" },
              )}{" "}
              · {(loaded.manifest.bytes / 1024 / 1024).toFixed(1)} MB
            </small>
          </div>
        </ModalSurface>
      )}
    </>
  );
}
function App() {
  const [appearance, setAppearance] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("query-table:showcase:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* Browser session still supports theme changes. */
    }
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
  }, [appearance]);
  const [dataset, setDataset] = useState(initial),
    [loaded, setLoaded] = useState<LoadedDataset | null>(null),
    [progress, setProgress] = useState("Starting…"),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let resource: LoadedDataset | undefined;
    setLoaded(null);
    setError(null);
    void loadDataset(dataset, controller.signal, setProgress)
      .then((result) => {
        resource = result;
        if (controller.signal.aborted) void result.dispose();
        else setLoaded(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      controller.abort();
      if (resource) void resource.dispose();
    };
  }, [dataset, retry]);
  useEffect(() => {
    const popstate = () => setDataset(initial());
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);
  function changeDataset(next: Dataset) {
    if (next.id === dataset.id) return;
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()])
      if (key.startsWith("q_") && key !== `q_${next.id}`)
        url.searchParams.delete(key);
    url.searchParams.set("dataset", next.id);
    history.pushState({}, "", url);
    setDataset(next);
  }
  return (
    <div
      className="showcase"
      style={{ "--dataset-color": dataset.color } as CSSProperties}
    >
      <header className="showcase-header">
        <a className="showcase-brand" href="./" aria-label="Query Table home">
          <img src="./favicon.svg" width="28" height="28" alt="" />
          <span>
            query<span className="brand-dot">.</span>table
          </span>
        </a>
        <nav className="dataset-picker" aria-label="Choose a dataset">
          {DATASETS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={item.id === dataset.id}
              onClick={() => changeDataset(item)}
            >
              {item.title}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="showcase-theme-button"
          aria-label={`Switch to ${appearance === "light" ? "dark" : "light"} mode`}
          onClick={() => {
            const next = appearance === "light" ? "dark" : "light";
            setAppearance(next);
            try {
              localStorage.setItem("query-table:showcase:theme", next);
            } catch {
              /* Session preference remains active. */
            }
          }}
        >
          <span aria-hidden="true">{appearance === "light" ? "☾" : "☀"}</span>
          {appearance === "light" ? "Dark mode" : "Light mode"}
        </button>
        <a
          className="showcase-github"
          href="https://github.com/Pythia-Software/query-table"
          target="_blank"
          rel="noreferrer"
        >
          GitHub <Icon name="externalLink" size={14} />
        </a>
      </header>
      <main>
        {error ? (
          <div className="showcase-error" role="alert">
            <strong>The dataset could not load.</strong>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : loaded && loaded.manifest.id === dataset.id ? (
          <Workspace key={dataset.id} dataset={dataset} loaded={loaded} />
        ) : (
          <div className="showcase-loading" role="status">
            <span className="loading-orbit" />
            <strong>{progress}</strong>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
