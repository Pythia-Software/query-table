import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  httpComputedColumnStore,
  loadSchema,
  localStorageAdapter,
  type ComputedColumnStore,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  DataTable,
  MetricsPanel,
  QueryBuilder,
  defaultRenderers,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import document from "../server/schema.json";
import { CollapsibleSection } from "./CollapsibleSection";
import { DEMO_METRIC_THEME } from "./metrics";
import { POSTGRES_INITIAL_QUERY } from "./postgresMetrics";
import {
  createPostgresTransport,
  type DemoBootstrap,
  type DemoLatency,
  type DemoRequest,
  type DemoMetricTiming,
  type PostgresRun,
} from "./postgresTransport";
import "./demo.css";
import "./postgresDemo.css";

const schema = loadSchema<PostgresRun>(document);
const local = localStorageAdapter();
const storage = {
  ...local,
  loadLast: async (key: string) =>
    (await local.loadLast(key)) ?? POSTGRES_INITIAL_QUERY,
};
const latencyKey = "query-table:postgres-demo:latency";
function loadLatency(): DemoLatency {
  try {
    const value = JSON.parse(
      localStorage.getItem(latencyKey) ?? "null",
    ) as DemoLatency | null;
    if (
      value &&
      [value.db, value.response].every(
        (n) => Number.isInteger(n) && n >= 0 && n <= 5000,
      )
    )
      return value;
  } catch {}
  return { db: 300, response: 500 };
}
async function bootstrap(signal?: AbortSignal): Promise<DemoBootstrap> {
  const response = await fetch(
    "/api/postgres/bootstrap",
    signal ? { signal } : {},
  );
  if (!response.ok)
    throw new Error("The Go/PostgreSQL demo server is unavailable.");
  return response.json() as Promise<DemoBootstrap>;
}
export function PostgresDemo() {
  const [connection, setConnection] = useState<DemoBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    bootstrap(controller.signal)
      .then((value) => {
        setConnection(value);
        setError(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [retry]);
  const reload = useCallback(async () => {
    const value = await bootstrap();
    setConnection(value);
  }, []);
  return connection ? (
    <ConnectedDemo connection={connection} reload={reload} />
  ) : (
    <main className="qt-demo qt-postgres-demo">
      <h1>Go + PostgreSQL playground</h1>
      <p role="status">{error ?? "Connecting to the local Go server…"}</p>
      {error && (
        <>
          <p>
            Start the real-data demo from this workspace:{" "}
            <code>npm run demo:postgres</code>.
          </p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry connection
          </button>
        </>
      )}
      <a href="/">Open the small client demo</a>
    </main>
  );
}
function ConnectedDemo({
  connection,
  reload,
}: {
  connection: DemoBootstrap;
  reload: () => Promise<void>;
}) {
  const [latency, setLatency] = useState(loadLatency);
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [tableCollapsed, setTableCollapsed] = useState(false);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const executionRef = useRef(connection.execution);
  executionRef.current = connection.execution;
  const latencyRef = useRef(latency);
  latencyRef.current = latency;
  const onRequest = useCallback((request: DemoRequest) => {
    setRequests((previous) =>
      [request, ...previous.filter((item) => item.id !== request.id)]
        .sort((a, b) => b.id - a.id)
        .slice(0, 30),
    );
  }, []);
  const transport = useMemo(
    () =>
      createPostgresTransport(
        () => executionRef.current,
        () => latencyRef.current,
        onRequest,
      ),
    [onRequest],
  );
  const store = useMemo<ComputedColumnStore>(() => {
    const delegate = httpComputedColumnStore("/api/postgres/computed");
    return {
      ...delegate,
      async save(dataset, column, revision) {
        const saved = await delegate.save(dataset, column, revision);
        await reload();
        return saved;
      },
    };
  }, [reload]);
  const api = useQueryTable<PostgresRun>({
    schema,
    transport,
    computedColumnStore: store,
    computedExecution: connection.execution,
    storage,
    syncUrl: true,
    debounceMs: 250,
  });
  useEffect(() => {
    try {
      localStorage.setItem(latencyKey, JSON.stringify(latency));
    } catch {}
  }, [latency]);
  const pending = requests.filter(
    (request) => request.status === "pending",
  ).length;
  const aborted = requests.filter(
    (request) => request.status === "aborted",
  ).length;
  const timingById = new Map<string, DemoMetricTiming>();
  for (const request of requests)
    for (const metric of request.metrics ?? []) {
      if (!timingById.has(metric.id)) timingById.set(metric.id, metric);
    }
  const metricTimings = [...timingById.values()].sort(
    (a, b) => b.sqlMs - a.sqlMs,
  );
  const setDelay = (key: keyof DemoLatency, value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      setLatency((previous) => ({
        ...previous,
        [key]: Math.min(5000, Math.max(0, Math.round(parsed))),
      }));
  };
  return (
    <main className="qt-demo qt-postgres-demo">
      <header className="qt-demo-header">
        <p className="qt-demo-eyebrow">Go + PostgreSQL playground</p>
        <h1>query-table</h1>
      </header>
      <p className="qt-demo-intro">
        {connection.rows.toLocaleString()} deterministic runs in PostgreSQL{" "}
        {connection.postgresVersion} ·{" "}
        {(connection.bytes / 1024 / 1024).toFixed(1)} MB on disk · 100 rows per
        page initially.
      </p>
      <section className="qt-demo-latency" aria-label="Latency controls">
        <div className="qt-demo-latency-inputs">
          <label>
            Database delay (ms)
            <input
              type="number"
              min="0"
              max="5000"
              step="100"
              value={latency.db}
              onChange={(event) => setDelay("db", event.target.value)}
            />
          </label>
          <label>
            Response delay (ms)
            <input
              type="number"
              min="0"
              max="5000"
              step="100"
              value={latency.response}
              onChange={(event) => setDelay("response", event.target.value)}
            />
          </label>
          <label>
            Preset
            <select
              aria-label="Latency preset"
              value={
                latency.db === 0 && latency.response === 0
                  ? "none"
                  : latency.db === 300 && latency.response === 500
                    ? "normal"
                    : latency.db === 1500 && latency.response === 2000
                      ? "slow"
                      : "custom"
              }
              onChange={(event) => {
                const presets: Record<string, DemoLatency> = {
                  none: { db: 0, response: 0 },
                  normal: { db: 300, response: 500 },
                  slow: { db: 1500, response: 2000 },
                };
                const preset = presets[event.target.value];
                if (preset) setLatency(preset);
              }}
            >
              <option value="none">No artificial delay</option>
              <option value="normal">Typical · 300 + 500 ms</option>
              <option value="slow">Slow · 1500 + 2000 ms</option>
              <option value="custom" disabled>
                Custom
              </option>
            </select>
          </label>
          <button type="button" onClick={() => api.refresh()}>
            Refresh data
          </button>
          <button
            type="button"
            onClick={() => api.setQuery(POSTGRES_INITIAL_QUERY)}
          >
            Restore demo dashboard
          </button>
        </div>
        <p>
          Delay applies once per data request. Database delay is a real
          cancellable PostgreSQL wait; response delay starts after SQL
          completes. Changes apply to the next request.
        </p>
        <p className="qt-demo-live-status" role="status">
          {pending ? `${pending} requests in flight` : "No requests in flight"}{" "}
          · {aborted} canceled in recent history ·{" "}
          {api.aggregations.loading ? "Computing dashboard…" : "Dashboard idle"}
        </p>
      </section>
      {api.error && (
        <p className="qt-demo-connection-error" role="alert">
          {api.error.message}{" "}
          <button
            type="button"
            onClick={() => {
              void reload().then(() => api.refresh());
            }}
          >
            Reconnect and retry
          </button>
        </p>
      )}
      <QueryBuilder
        api={api}
        fields={api.computed.catalogue}
        total={api.total}
        running={api.loading}
        metricTheme={DEMO_METRIC_THEME}
        requestActivityDetails={
          <>
            <details className="qt-demo-requests">
              <summary>
                Request activity · {pending} pending · timings separate real SQL
                from artificial latency
              </summary>
              <div className="qt-demo-request-table">
                <table>
                  <thead>
                    <tr>
                      <th>Request</th>
                      <th>State</th>
                      <th>Total</th>
                      <th>Real SQL</th>
                      <th>DB wait</th>
                      <th>Response wait</th>
                      <th>Statements</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.slice(0, 10).map((request) => (
                      <tr key={request.id} data-status={request.status}>
                        <td>
                          #{request.id} {request.kind}
                        </td>
                        <td>
                          {request.status}
                          {request.error && (
                            <span title={request.error}>
                              {" "}
                              · {request.error}
                            </span>
                          )}
                        </td>
                        <td>
                          {request.duration === undefined
                            ? "running…"
                            : `${Math.round(request.duration)} ms`}
                        </td>
                        <td>
                          {request.sqlMs === undefined
                            ? "—"
                            : `${request.sqlMs} ms`}
                        </td>
                        <td>
                          {request.dbDelayMs === undefined
                            ? "—"
                            : `${request.dbDelayMs} ms`}
                        </td>
                        <td>
                          {request.responseDelayMs === undefined
                            ? "—"
                            : `${request.responseDelayMs} ms`}
                        </td>
                        <td>{request.statements ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {metricTimings.length > 0 && (
                <details className="qt-demo-metric-timings">
                  <summary>
                    Latest timing for each metric · slowest first
                  </summary>
                  <div className="qt-demo-request-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>SQL</th>
                          <th>Planner</th>
                          <th>Stages</th>
                          <th>SQL bytes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metricTimings.map((metric) => (
                          <tr key={metric.id}>
                            <td>
                              {api.aggregations.clauses.find(
                                (clause) => clause.id === metric.id,
                              )?.label ?? metric.id}
                            </td>
                            <td>{metric.sqlMs} ms</td>
                            <td>{metric.planMs} ms</td>
                            <td>{metric.stages}</td>
                            <td>{metric.sqlBytes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </details>
          </>
        }
      />
      <CollapsibleSection
        title="Metrics"
        collapsed={metricsCollapsed}
        onToggle={setMetricsCollapsed}
        collapsedSummary={`${api.aggregations.clauses.length} metrics`}
        className="qt-qt-section--metrics"
      >
        {api.aggregations.loading && (
          <p className="qt-demo-refresh-note" role="status">
            Computing metrics over{" "}
            {api.total?.toLocaleString() ?? connection.rows.toLocaleString()}{" "}
            matching rows.
          </p>
        )}
        <MetricsPanel
          api={api}
          aggregations={api.aggregations}
          fields={api.computed.catalogue}
          theme={DEMO_METRIC_THEME}
        />
      </CollapsibleSection>
      <CollapsibleSection
        title="Table"
        collapsed={tableCollapsed}
        onToggle={setTableCollapsed}
        collapsedSummary={`${api.rows.length} of ${api.total?.toLocaleString() ?? "…"} rows`}
        className="qt-qt-section--table"
      >
        <p className="qt-demo-refresh-note">
          Computed throughput is calculated in PostgreSQL before sorting and
          pagination. Sort it descending to inspect the fastest runs across the
          entire population.
        </p>
        <DataTable
          fields={api.visibleFields}
          rows={api.rows}
          query={api.query}
          onQueryChange={api.setQuery}
          total={api.total}
          renderers={defaultRenderers}
          rowId={(row) => row.id}
          selection={api.selection}
          columnDrag={api.columnDrag}
          loading={api.loading}
          emptyMessage="No runs match this query."
        />
      </CollapsibleSection>
      <footer className="qt-demo-backend-info">
        <a href="/">Small client demo</a>
        <span>
          Execution profile {connection.profile} · shared MVCC snapshot{" "}
          {connection.execution.snapshot}
        </span>
      </footer>
    </main>
  );
}
