// "Series" settings of a metric: trailing windows, running values and shares.
import {
  MAX_METRIC_WINDOW_PERIODS,
  type AggregationClause,
  type FieldDef,
  type MetricShare,
  type MetricWindow,
} from "@pythia-software/query-table-core";
import { Settings } from "./controls";

const windowOf = (
  periods: MetricWindow["periods"],
  mean: boolean,
  partial: boolean,
): MetricWindow => ({
  periods,
  ...(mean ? { reduce: "mean" as const } : {}),
  ...(partial ? { partial: "include" as const } : {}),
});
/** Trailing windows, running values and shares. A window turns on empty
 * dates, which it needs to span every interval. */
export function MetricSeriesSettings({
  clause,
  fields,
  settings,
  onChange,
}: {
  clause: AggregationClause;
  fields: readonly FieldDef[];
  settings: { open: boolean; onOpenChange: (open: boolean) => void };
  onChange: (values: {
    [K in keyof AggregationClause]?: AggregationClause[K] | undefined;
  }) => void;
}) {
  const { window, share, dateGrouping } = clause;
  const first =
    fields.find((f) => f.name === clause.groupBy[0])?.label ??
    clause.groupBy[0];
  const cyclic =
    dateGrouping?.interval === "hourOfDay" ||
    dateGrouping?.interval === "dayOfWeek";
  const unit =
    dateGrouping?.interval === "hourOfDay"
      ? "hour of the day"
      : dateGrouping?.interval === "dayOfWeek"
        ? "weekday"
        : dateGrouping && (dateGrouping.every ?? 1) > 1
          ? `${dateGrouping.every}-${dateGrouping.interval} bucket`
          : (dateGrouping?.interval ?? "interval");
  const mode = !window ? "none" : window.periods === "all" ? "all" : "trailing";
  const setWindow = (next: MetricWindow | undefined) =>
    onChange({
      window: next,
      ...(next && dateGrouping && !dateGrouping.includeEmpty
        ? { dateGrouping: { ...dateGrouping, includeEmpty: true } }
        : {}),
      // A share of the total cannot be windowed, and its option is hidden.
      ...(next && share === "total" ? { share: undefined } : {}),
    });
  const summary = [
    !window
      ? ""
      : window.periods === "all"
        ? "Running"
        : `Trailing ${window.periods} ${unit}s`,
    window?.reduce === "mean" ? `mean per ${unit}` : "",
    share === "group0"
      ? `share of each ${dateGrouping ? unit : first}`
      : share === "total"
        ? "share of total"
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Settings
      title="Window & share"
      {...settings}
      summary={summary || "Values as computed"}
    >
      {dateGrouping && !cyclic && (
        <>
          <label>
            Window
            <select
              aria-label="Window"
              value={mode}
              onChange={(e) =>
                setWindow(
                  e.target.value === "none"
                    ? undefined
                    : windowOf(
                        e.target.value === "all"
                          ? "all"
                          : window && window.periods !== "all"
                            ? window.periods
                            : 7,
                        window?.reduce === "mean",
                        // A running value has no partial windows.
                        e.target.value !== "all" && window?.partial === "include",
                      ),
                )
              }
            >
              <option value="none">None</option>
              <option value="trailing">Trailing {unit}s</option>
              <option value="all">Running from the first {unit}</option>
            </select>
          </label>
          {window && window.periods !== "all" && (
            <label>
              {`${unit[0]!.toUpperCase()}${unit.slice(1)}s per window`}
              <input
                aria-label="Window length"
                type="number"
                min={2}
                max={MAX_METRIC_WINDOW_PERIODS}
                value={window.periods}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber;
                  if (
                    Number.isInteger(n) &&
                    n >= 2 &&
                    n <= MAX_METRIC_WINDOW_PERIODS
                  )
                    setWindow({ ...window, periods: n });
                }}
              />
            </label>
          )}
          {window && (
            <>
              <label>
                Combine
                <select
                  aria-label="Combine window"
                  value={window.reduce ?? "total"}
                  onChange={(e) =>
                    setWindow(
                      windowOf(
                        window.periods,
                        e.target.value === "mean",
                        window.partial === "include",
                      ),
                    )
                  }
                >
                  <option value="total">Total over the window</option>
                  <option value="mean">Mean per {unit}</option>
                </select>
              </label>
              {window.periods !== "all" && (
                <label className="qt-metric-date-toggle">
                  <input
                    type="checkbox"
                    aria-label="Show partial windows"
                    checked={window.partial === "include"}
                    onChange={(e) =>
                      setWindow(
                        windowOf(
                          window.periods,
                          window.reduce === "mean",
                          e.target.checked,
                        ),
                      )
                    }
                  />
                  Show windows that start before the range
                </label>
              )}
              <p className="qt-metric-help">
                A total evaluates the metric over every row in the window, so
                ratios and averages pool their parts. A mean per {unit}{" "}
                averages a single sum, count or distinct count.
              </p>
            </>
          )}
        </>
      )}
      <label>
        Show values as
        <select
          aria-label="Show values as"
          value={share ?? "values"}
          onChange={(e) =>
            onChange({
              share:
                e.target.value === "values"
                  ? undefined
                  : (e.target.value as MetricShare),
            })
          }
        >
          <option value="values">Values</option>
          {clause.groupBy.length > 1 && (
            <option value="group0">
              Share of each {dateGrouping ? unit : first}
            </option>
          )}
          {!window && <option value="total">Share of all groups</option>}
        </select>
      </label>
      {share && (
        <p className="qt-metric-help">
          Divides each group by a total of the same sum or count, including
          groups past the group limit.
        </p>
      )}
    </Settings>
  );
}
