// Confidence-interval settings of a metric (Wilson proportion / Poisson rate).
import {
  DEFAULT_METRIC_INTERVAL_LEVEL,
  METRIC_INTERVAL_LEVELS,
  type MetricDisplay,
  type MetricInterval,
} from "@pythia-software/query-table-core";
import { formatMetricIntervalLevel } from "../metricChartHelpers";
import { Settings } from "./controls";

/** Offered levels, within the range engines accept. */
const INTERVAL_LEVELS = [0.9, 0.95, 0.99].filter(
  (l) => l >= METRIC_INTERVAL_LEVELS.min && l <= METRIC_INTERVAL_LEVELS.max,
);
const INTERVAL_KINDS: Array<[MetricInterval["kind"], string]> = [
  ["proportion", "Proportion (Wilson)"],
  ["rate", "Rate (Poisson)"],
];
/** A confidence interval on each value: Wilson for a proportion, exact
 * Poisson for a rate. A kind that cannot apply to the metric is disabled,
 * with validation's reason as its title; a chosen one stays selectable. */
export function MetricIntervalSettings({
  interval,
  reasons,
  display,
  locale,
  settings,
  onChange,
  onDisplayChange,
}: {
  interval: MetricInterval | undefined;
  reasons: Partial<Record<MetricInterval["kind"], string>>;
  display: MetricDisplay;
  locale: string | undefined;
  settings: { open: boolean; onOpenChange: (open: boolean) => void };
  onChange: (interval: MetricInterval | undefined) => void;
  onDisplayChange: (show: boolean) => void;
}) {
  const level = interval?.level ?? DEFAULT_METRIC_INTERVAL_LEVEL;
  // The default level is left implicit, so saved metrics stay minimal.
  const withLevel = (kind: MetricInterval["kind"], next: number): MetricInterval =>
    next === DEFAULT_METRIC_INTERVAL_LEVEL ? { kind } : { kind, level: next };
  const levels = INTERVAL_LEVELS.includes(level)
    ? INTERVAL_LEVELS
    : [...INTERVAL_LEVELS, level].sort((a, b) => a - b);
  const drawn = ["bar-vertical", "bar-horizontal", "line"].includes(display.kind);
  const problem = interval && reasons[interval.kind];
  return (
    <Settings
      title="Confidence interval"
      {...settings}
      summary={
        interval
          ? `${formatMetricIntervalLevel(level, locale)} ${interval.kind === "rate" ? "rate (Poisson)" : "proportion (Wilson)"}`
          : "None"
      }
    >
      <label>
        Confidence interval
        <select
          aria-label="Confidence interval"
          value={interval?.kind ?? "none"}
          onChange={(e) =>
            onChange(
              e.target.value === "none"
                ? undefined
                : withLevel(e.target.value as MetricInterval["kind"], level),
            )
          }
        >
          <option value="none">None</option>
          {INTERVAL_KINDS.map(([kind, label]) => (
            <option
              key={kind}
              value={kind}
              disabled={!!reasons[kind] && interval?.kind !== kind}
              title={reasons[kind]}
            >
              {label}
            </option>
          ))}
        </select>
      </label>
      {interval && (
        <>
          <label>
            Confidence level
            <select
              aria-label="Confidence level"
              value={String(level)}
              onChange={(e) => onChange(withLevel(interval.kind, Number(e.target.value)))}
            >
              {levels.map((l) => (
                <option key={l} value={String(l)}>
                  {formatMetricIntervalLevel(l, locale)}
                </option>
              ))}
            </select>
          </label>
          {drawn && (
            <label className="qt-metric-date-toggle">
              <input
                type="checkbox"
                aria-label="Show interval whiskers and bands"
                checked={display.showIntervals !== false}
                onChange={(e) => onDisplayChange(e.target.checked)}
              />
              Show interval whiskers and bands
            </label>
          )}
        </>
      )}
      <p className="qt-metric-help">
        {problem ??
          (interval?.kind === "rate"
            ? "An exact Poisson interval for a count per exposure. Hover a value for its interval."
            : interval
              ? "A Wilson interval for a share of units. Hover a value for its interval."
              : "Bounds each value: a Wilson interval for a proportion, an exact Poisson interval for a rate. Unavailable kinds give their reason on hover.")}
      </p>
    </Settings>
  );
}
