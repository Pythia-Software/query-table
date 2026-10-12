import { useState } from "react";
import {
  MetricCard,
  formatMetricOutput,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import "./demo.css";
import "./dateMetricsPrototype.css";
import {
  DATE_METRIC_FIELDS,
  EXAMPLE_ORDERS,
  INITIAL_DATE_METRIC,
  QUERY_RANGE,
  previewDateMetric,
  type DateMetricDefinition,
} from "./dateMetricExample";

const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(date));

export function DateMetricsPrototype() {
  const [applied, setApplied] = useState(INITIAL_DATE_METRIC);
  const [draft, setDraft] = useState<DateMetricDefinition>({
    ...INITIAL_DATE_METRIC,
    dateGrouping: { ...INITIAL_DATE_METRIC.dateGrouping, includeEmpty: true },
  });
  const [dataset, setDataset] = useState("sparse");
  const [notice, setNotice] = useState("");
  const patchGrouping = (
    patch: Partial<DateMetricDefinition["dateGrouping"]>,
  ) =>
    setDraft((previous) => ({
      ...previous,
      dateGrouping: { ...previous.dateGrouping, ...patch },
    }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  let preview: ReturnType<typeof previewDateMetric> | undefined,
    problem: string | undefined;
  try {
    preview = previewDateMetric(
      draft,
      dataset === "sparse" ? EXAMPLE_ORDERS : [],
    );
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const interval = draft.dateGrouping.interval;
  const emptyValue = draft.op === "avg" ? "No value" : "Zero";
  const chartClause: DateMetricDefinition = {
    ...draft,
    display: {
      ...draft.display!,
      xLabel: "Order date",
      yLabel: draft.op === "count" ? "Orders" : "Order value ($)",
      format: { kind: "number", decimals: draft.op === "count" ? 0 : 2 },
      xScale: preview?.extent ?? {},
    },
  };
  const [inspected, setInspected] = useState<string | null>(null);

  return (
    <main className="date-prototype">
      <header className="date-prototype-header">
        <div>
          <a className="date-prototype-back" href="/">
            query-table / metrics
          </a>
          <h1>
            Orders over time{" "}
            <span className="date-prototype-badge">Prototype</span>
          </h1>
          <p>A date grouping that includes the quiet days.</p>
        </div>
        <label className="date-prototype-scenario">
          Example data
          <select
            aria-label="Example data"
            value={dataset}
            onChange={(e) => {
              setDataset(e.target.value);
              setInspected(null);
            }}
          >
            <option value="sparse">Orders on 7 of 14 days</option>
            <option value="empty">No matching orders</option>
          </select>
        </label>
      </header>
      <div className="date-prototype-query">
        <span>Query date filter</span>
        <strong>Oct 1 – 14, 2026</strong>
        <span>All matching orders · UTC</span>
      </div>
      <div className="date-prototype-workbench">
        <section
          className="date-prototype-definition"
          aria-label="Metric definition"
        >
          <div className="date-prototype-pane-title">
            <h2>Metric definition</h2>
            <span>{dirty ? "Draft" : "Applied"}</span>
          </div>
          <label>
            Metric name
            <input
              aria-label="Metric name"
              value={draft.label ?? ""}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label>
            Measure
            <select
              aria-label="Measure"
              value={draft.op}
              onChange={(e) => {
                const op = e.target.value as "count" | "sum" | "avg";
                setDraft({
                  ...draft,
                  op,
                  expression:
                    op === "count" ? "COUNT()" : `${op.toUpperCase()}([total])`,
                  ...(op === "count" ? {} : { field: "total" }),
                });
                setInspected(null);
              }}
            >
              <option value="count">COUNT() · Number of orders</option>
              <option value="sum">SUM([total]) · Revenue</option>
              <option value="avg">AVG([total]) · Average order value</option>
            </select>
          </label>
          <div className="date-prototype-group">
            <h3>Group by date</h3>
            <label>
              Date field
              <select
                aria-label="Date field"
                value="placed_at"
                onChange={() => {}}
              >
                <option value="placed_at">Order date · placed_at</option>
              </select>
            </label>
            <label>
              Interval
              <select
                aria-label="Date interval"
                value={interval}
                onChange={(e) => {
                  patchGrouping({
                    interval: e.target.value as typeof interval,
                  });
                  setInspected(null);
                }}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </label>
            <label className="date-prototype-toggle">
              <input
                type="checkbox"
                aria-label="Include empty dates"
                checked={draft.dateGrouping.includeEmpty}
                onChange={(e) => {
                  patchGrouping({ includeEmpty: e.target.checked });
                  setInspected(null);
                }}
              />
              <span>Include empty dates</span>
            </label>
            <p className="date-prototype-help">
              Add a bucket for every {interval}, even when no orders match.
            </p>
            {draft.dateGrouping.includeEmpty && (
              <div className="date-prototype-range">
                <label>
                  Complete dates across
                  <select
                    aria-label="Date range"
                    value={draft.dateGrouping.range}
                    onChange={(e) => {
                      patchGrouping({
                        range: e.target
                          .value as DateMetricDefinition["dateGrouping"]["range"],
                      });
                      setInspected(null);
                    }}
                  >
                    <option value="query">Query date range</option>
                    <option value="observed">
                      First to last observed date
                    </option>
                    <option value="custom">Custom date range</option>
                  </select>
                </label>
                {draft.dateGrouping.range === "custom" ? (
                  <div className="date-prototype-date-inputs">
                    <label>
                      From
                      <input
                        type="date"
                        aria-label="Range start"
                        value={draft.dateGrouping.start}
                        onChange={(e) =>
                          patchGrouping({ start: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Through
                      <input
                        type="date"
                        aria-label="Range end"
                        value={draft.dateGrouping.end}
                        onChange={(e) => patchGrouping({ end: e.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <p className="date-prototype-help">
                    {draft.dateGrouping.range === "query"
                      ? `${dateLabel(QUERY_RANGE.start)} – ${dateLabel(QUERY_RANGE.end)}, 2026`
                      : dataset === "empty"
                        ? "No observed dates to complete."
                        : "Oct 2 – 13, 2026"}
                  </p>
                )}
                <div className="date-prototype-empty-rule">
                  <span>Empty bucket value</span>
                  <strong>{emptyValue}</strong>
                  <p>
                    {draft.op === "avg"
                      ? "An empty date has no average. The line breaks at that date."
                      : "No matching orders contribute 0. Existing values keep their meaning."}
                  </p>
                </div>
              </div>
            )}
            <p className="date-prototype-help">
              {interval === "week" ? "Weeks begin on Monday. " : ""}Calendar
              boundaries use UTC.
            </p>
          </div>
          <footer className="date-prototype-actions">
            <button
              className="qt-btn"
              disabled={!dirty}
              onClick={() => {
                setDraft(applied);
                setNotice("Draft discarded.");
                setInspected(null);
              }}
            >
              Cancel
            </button>
            <button
              className="qt-btn qt-btn--primary"
              disabled={!dirty || !!problem || !draft.label?.trim()}
              onClick={() => {
                setApplied(draft);
                setNotice("Metric applied for this example.");
              }}
            >
              Apply metric
            </button>
          </footer>
          <p className="date-prototype-notice" role="status">
            {notice || "Changes update the preview immediately."}
          </p>
        </section>
        <section className="date-prototype-preview" aria-label="Metric preview">
          <div className="date-prototype-preview-head">
            <div>
              <h2>Live preview</h2>
              <p>
                {draft.dateGrouping.includeEmpty
                  ? "Every date has a place on the timeline."
                  : "Only dates with matching orders are returned."}
              </p>
            </div>
            <div className="date-prototype-tabs" aria-label="Metric display">
              {(
                [
                  ["line", "Line"],
                  ["bar-vertical", "Bars"],
                  ["table", "Table"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  className="qt-btn"
                  key={kind}
                  aria-pressed={draft.display?.kind === kind}
                  onClick={() =>
                    setDraft({ ...draft, display: { ...draft.display!, kind } })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {problem ? (
            <p className="date-prototype-error" role="alert">
              {problem}
            </p>
          ) : (
            preview && (
              <>
                <div
                  className="date-prototype-chart"
                  data-testid="date-metric-chart"
                >
                  <MetricCard
                    clause={chartClause}
                    fields={DATE_METRIC_FIELDS}
                    buckets={preview.buckets}
                    result={{
                      buckets: preview.buckets,
                      groupCount: preview.buckets.length,
                      coverage: "exact",
                    }}
                    locale="en-US"
                    onInspect={(bucket) =>
                      setInspected(
                        `${dateLabel(String(bucket.keys[0]))} · ${bucket.count} matching orders${bucket.count === 0 ? " · Empty date bucket" : ""}`,
                      )
                    }
                  />
                </div>
                <div className="date-prototype-summary" role="status">
                  <strong>
                    {preview.buckets.length}{" "}
                    {interval === "day"
                      ? "daily"
                      : interval === "week"
                        ? "weekly"
                        : "monthly"}{" "}
                    buckets
                  </strong>
                  <span>{preview.emptyBuckets} empty</span>
                  <span>{preview.matchingRows} matching orders</span>
                </div>
                {inspected && (
                  <p className="date-prototype-inspected" role="status">
                    {inspected}
                  </p>
                )}
                <div className="date-prototype-buckets">
                  <div className="date-prototype-bucket-head">
                    <h3>Metric buckets</h3>
                    <span>Same definition, same values</span>
                  </div>
                  <div className="date-prototype-bucket-strip">
                    {preview.buckets.map((bucket) => (
                      <div
                        key={String(bucket.keys[0])}
                        className={`date-prototype-bucket${bucket.count === 0 ? " is-empty" : ""}`}
                        data-empty={bucket.count === 0}
                      >
                        <span>{dateLabel(String(bucket.keys[0]))}</span>
                        <strong>
                          {bucket.value === null
                            ? "—"
                            : formatMetricOutput(
                                bucket.value,
                                {
                                  kind: "number",
                                  decimals: draft.op === "count" ? 0 : 2,
                                },
                                "en-US",
                              ).text}
                        </strong>
                        <small>
                          {bucket.count === 0
                            ? "Empty"
                            : `${bucket.count} orders`}
                        </small>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="date-prototype-comparison">
                  <h3>
                    {draft.dateGrouping.includeEmpty
                      ? "What changed?"
                      : "Try including empty dates"}
                  </h3>
                  <p>
                    {draft.op === "avg"
                      ? "Dates without orders have no average. Including them makes the gaps explicit instead of connecting across missing days."
                      : draft.dateGrouping.includeEmpty
                        ? "The graph now drops to zero on dates without orders, including the first and last day of the query range."
                        : "The line connects the observed dates. Turn on “Include empty dates” to see when activity fell to zero."}
                  </p>
                </div>
              </>
            )
          )}
        </section>
      </div>
    </main>
  );
}
