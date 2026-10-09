import {
  distributionProblem,
  metricPresentationProblem,
} from "./metricPresentation";
// MetricsPanel — the dashboard strip above the table.
//
// Renders the optional aggregation metrics (see @pythia-software/query-table-core
// AggregationClause). Each metric's shape follows its group-by arity:
//   0 group-by  → one big number
//   1 group-by  → a ranked bar list (label · value · share bar)
//   2 group-by  → an x/y pivot table (rows = axis 0, cols = axis 1)
//   3+ group-by → a flat table, one column per group key + the value
//
// Values are formatted through the measure field's own renderer where it makes
// sense (so AVG(total_ms) reads "3.2s", not "3200"), falling back to a locale
// number. Counts are always plain integers.

import { useState, useMemo, type ReactNode } from "react";
import { EMPTY_QUERY } from "@pythia-software/query-table-core";
import type { AggOp, FieldDef } from "@pythia-software/query-table-core";
import type { AggregationsApi } from "@pythia-software/query-table-react";
import { MetricsEditor } from "./MetricsEditor";
import { Icon } from "./Icon";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { MetricChart } from "./MetricChart";
import {
  createMetricColorResolver,
  metricThemeStyle,
  typedMetricKey,
  metricTupleKey,
  type MetricTheme,
  type MetricClassNames,
} from "./metricColors";
import { metricScale } from "./metricChartHelpers";
import { formatMetricOutput } from "./metricFormat";
import type {
  MetricBucket as AggregationBucket,
  RenderingClause as AggregationClause,
  MetricValue,
  MetricRenderResult,
} from "./metricTypes";
import { resolveRenderer, type RenderRegistry } from "./renderers";

export interface MetricsPanelProps<Row> {
  /** Enables quick editing using the transactional metrics editor. */
  api?: QueryTableApi<Row>;
  onEditMetric?: (id: string) => void;
  onEditDashboard?: () => void;
  /** The aggregation API from useQueryTable (clauses + results + status). */
  aggregations: AggregationsApi;
  /** All schema fields, to resolve labels + the measure field's renderer. */
  fields: FieldDef<Row>[];
  /** Cell renderers (same registry as the table) for formatting measure values. */
  renderers?: RenderRegistry<Row>;
  /** Hidden entirely when there are no metrics unless this is set. */
  emptyMessage?: string;
  classNames?: MetricClassNames;
  theme?: MetricTheme;
  locale?: string;
  onInspect?: (bucket: AggregationBucket, clause: AggregationClause) => void;
}

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

const OP_LABELS: Record<AggOp, string> = {
  count: "Count",
  count_distinct: "Distinct",
  sum: "Sum",
  avg: "Avg",
  min: "Min",
  max: "Max",
};

const NULL_KEY = "∅";

export function MetricsPanel<Row>({
  aggregations,
  api,
  onEditMetric,
  onEditDashboard,
  fields,
  renderers,
  emptyMessage,
  classNames,
  theme,
  locale,
  onInspect,
}: MetricsPanelProps<Row>): ReactNode {
  const { clauses, results, loading, error } = aggregations;
  const [editing, setEditing] = useState<{
    id?: string;
    view: "editor" | "dashboard";
  } | null>(null);
  const editMetric =
    onEditMetric ??
    (api ? (id: string) => setEditing({ id, view: "editor" }) : undefined);
  const editDashboard =
    onEditDashboard ??
    (api ? () => setEditing({ view: "dashboard" }) : undefined);

  if (clauses.length === 0) {
    return emptyMessage ? (
      <div
        className={cx("qt-metrics", classNames?.root)}
        style={metricThemeStyle(theme)}
      >
        {emptyMessage}
      </div>
    ) : null;
  }

  const resultById = new Map((results?.metrics ?? []).map((m) => [m.id, m]));

  return (
    <div
      className={cx("qt-metrics", classNames?.root)}
      style={metricThemeStyle(theme)}
    >
      {editDashboard && (
        <button
          type="button"
          className="qt-btn qt-metrics-edit"
          aria-label="Edit dashboard layout"
          title="Edit dashboard layout"
          onClick={editDashboard}
        >
          <Icon name="pencil" />
        </button>
      )}
      {editing && api && (
        <MetricsEditor
          api={api}
          fields={api.computed.catalogue}
          initialView={editing.view}
          {...(editing.id ? { initialMetricId: editing.id } : {})}
          {...(theme ? { theme } : {})}
          {...(locale ? { locale } : {})}
          onClose={() => setEditing(null)}
        />
      )}
      {error ? (
        <div className="qt-metrics-error">Metrics failed: {error.message}</div>
      ) : null}
      {clauses.map((clause) => (
        <MetricCard
          key={clause.id}
          clause={clause}
          result={resultById.get(clause.id)}
          loading={loading && !resultById.has(clause.id)}
          fields={fields}
          theme={theme}
          locale={locale}
          onInspect={onInspect}
          onEdit={editMetric ? () => editMetric(clause.id) : undefined}
          classNames={classNames}
          renderers={renderers}
          className={classNames?.metric}
        />
      ))}
    </div>
  );
}

export interface MetricCardProps<Row> {
  onEdit?: (() => void) | undefined;
  clause: AggregationClause;
  buckets?: AggregationBucket[] | undefined;
  result?: MetricRenderResult | undefined;
  fields: FieldDef<Row>[];
  loading?: boolean | undefined;
  renderers?: RenderRegistry<Row> | undefined;
  theme?: MetricTheme | undefined;
  locale?: string | undefined;
  className?: string | undefined;
  classNames?: MetricClassNames | undefined;
  onInspect?:
    | ((bucket: AggregationBucket, clause: AggregationClause) => void)
    | undefined;
}

export function MetricCard<Row>({
  clause,
  buckets: explicitBuckets,
  onEdit,
  result,
  fields,
  loading = false,
  renderers,
  theme,
  locale,
  className,
  classNames,
  onInspect,
}: MetricCardProps<Row>): ReactNode {
  const buckets = explicitBuckets ?? result?.buckets ?? [];
  const byName = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  const measure = clause.field ? byName.get(clause.field) : undefined;
  const groupLabels = clause.groupBy.map((g) => byName.get(g)?.label ?? g);
  const decimals = cardDecimals(buckets);
  const fmt = (v: MetricValue): ReactNode => {
    if (clause.display?.format) {
      const out = formatMetricOutput(v, clause.display.format, locale);
      return (
        <span
          title={out.error}
          className={out.error ? "qt-metric-format-error" : undefined}
        >
          {out.text}
        </span>
      );
    }
    if (clause.expression)
      return formatMetricOutput(
        v,
        typeof v === "number" ? { kind: "number", decimals } : undefined,
        locale,
      ).text;
    return formatMetricValue(v, clause.op, measure, renderers, decimals);
  };
  const kind = clause.display?.kind ?? "auto";
  const chart = [
    "bar-horizontal",
    "bar-vertical",
    "line",
    "pie",
    "donut",
    "scatter",
    "box",
    "histogram",
  ].includes(kind);
  const layout = clause.layout;
  const size = layout
    ? {
        flexBasis: `${layout.widthRem}rem`,
        flexGrow: 1,
        width: `${layout.widthRem}rem`,
        height: `${layout.heightRem}rem`,
        minWidth: `${layout.minWidthRem}rem`,
        minHeight: `${layout.minHeightRem}rem`,
      }
    : {};
  const invalidDistribution = [
    ...buckets,
    ...(result?.other ? [result.other] : []),
  ]
    .map((b) => distributionProblem(b.distribution))
    .find(Boolean);
  const problem =
    result?.error ??
    metricPresentationProblem(clause) ??
    invalidDistribution ??
    ((kind === "value" || (kind === "auto" && !clause.groupBy.length)) &&
    (buckets.length > 1 || buckets.some((b) => b.keys.length > 0))
      ? "Value display requires one ungrouped result. Choose Table or List, or correct the result grouping."
      : undefined);
  let body: ReactNode;
  if (problem)
    body = (
      <div className="qt-metrics-error" role="status">
        {problem}
      </div>
    );
  else if (loading && buckets.length === 0)
    body = <div className="qt-metric-loading">…</div>;
  else if (!buckets.length)
    body = <div className="qt-metric-empty">no data</div>;
  else if (chart)
    body = (
      <MetricChart
        clause={clause}
        buckets={buckets}
        result={result}
        theme={theme}
        locale={locale}
        classNames={classNames}
        onInspect={onInspect ? (b) => onInspect(b, clause) : undefined}
      />
    );
  else if (kind === "value" || (kind === "auto" && clause.groupBy.length === 0))
    body = <BigNumber bucket={buckets[0]!} fmt={fmt} />;
  else if (kind === "list" || (kind === "auto" && clause.groupBy.length === 1))
    body = (
      <BarList clause={clause} theme={theme} buckets={buckets} fmt={fmt} />
    );
  else if (clause.groupBy.length === 2)
    body = (
      <Pivot
        clause={clause}
        buckets={buckets}
        fmt={fmt}
        rowLabel={groupLabels[0]!}
        colLabel={groupLabels[1]!}
      />
    );
  else
    body = (
      <FlatTable
        buckets={buckets}
        fmt={fmt}
        groupLabels={groupLabels}
        valueLabel={clause.display?.valueLabel ?? metricTitle(clause, measure)}
      />
    );
  return (
    <div
      className={cx(
        "qt-metric",
        `qt-metric--gb${Math.min(clause.groupBy.length, 3)}`,
        chart && "qt-metric--chart",
        className,
        classNames?.metric,
      )}
      style={{ ...metricThemeStyle(theme), ...size }}
    >
      {onEdit && (
        <button
          type="button"
          className="qt-btn qt-metric-edit"
          aria-label={`Edit metric ${metricTitle(clause, measure)}`}
          title="Edit metric"
          onClick={onEdit}
        >
          <Icon name="pencil" />
        </button>
      )}
      <div className="qt-metric-head">
        <span className={cx("qt-metric-title", classNames?.title)}>
          {metricTitle(clause, measure)}
        </span>
        {groupLabels.length > 0 && (
          <span className="qt-metric-by">by {groupLabels.join(" × ")}</span>
        )}
      </div>
      {result?.coverage === "partial" && (
        <p className="qt-metric-note" role="status">
          Partial results
        </p>
      )}
      {body}
      {result?.groupCount !== undefined &&
        result.groupCount > buckets.length && (
          <p className="qt-metric-note">
            {buckets.length} of {result.groupCount} groups returned. Increase
            the group limit to see more.
          </p>
        )}
    </div>
  );
}

// ---- 0 group-by: one big number -------------------------------------------

function BigNumber({
  bucket,
  fmt,
}: {
  bucket: AggregationBucket;
  fmt: (v: MetricValue) => ReactNode;
}) {
  return (
    <div className="qt-metric-big">
      <span className="qt-metric-big-value">
        {bucket.error ?? fmt(bucket.value)}
      </span>
      <span className="qt-metric-big-sub">
        {bucket.count.toLocaleString()} rows
      </span>
    </div>
  );
}

// ---- 1 group-by: ranked bars ----------------------------------------------

function BarList({
  buckets,
  fmt,
  clause,
  theme,
}: {
  buckets: AggregationBucket[];
  fmt: (v: MetricValue) => ReactNode;
  clause: AggregationClause;
  theme: MetricTheme | undefined;
}) {
  const colors = createMetricColorResolver(theme),
    options = clause.display?.list;
  const showBars =
    options?.showBars !== false &&
    !buckets.some((b) => typeof b.value === "number" && b.value < 0);
  const axis = metricScale(
    buckets
      .filter((b) => !b.error && typeof b.value === "number")
      .map((b) => b.value as number),
    clause.display?.xScale,
    true,
  );
  return (
    <div className="qt-metric-bars">
      {buckets.map((b, i) => {
        const pct =
          typeof b.value === "number" && !b.error && axis.accepts(b.value)
            ? Math.max(0, Math.min(1, axis.fraction(b.value))) * 100
            : 0;
        return (
          <div
            className="qt-metric-bar-row"
            style={{
              gridTemplateColumns: `minmax(3.375rem, 38%) ${showBars ? "1fr " : ""}${options?.showValues !== false ? "auto" : ""}`,
            }}
            key={`${keyText(b.keys[0])}-${i}`}
          >
            <span className="qt-metric-bar-label" title={keyText(b.keys[0])}>
              {options?.useGroupColors && (
                <span
                  className="qt-metric-swatch"
                  style={{
                    background: colors.color(
                      clause.groupBy[0] ?? "",
                      b.keys[0] ?? null,
                    ),
                    marginInlineEnd: ".35rem",
                  }}
                />
              )}
              {b.keys.map(keyText).join(" / ")}
            </span>
            {showBars && (
              <span className="qt-metric-bar-track">
                <span
                  className="qt-metric-bar-fill"
                  style={{
                    width: `${pct}%`,
                    ...(options?.useGroupColors
                      ? {
                          background: colors.color(
                            clause.groupBy[0] ?? "",
                            b.keys[0] ?? null,
                          ),
                        }
                      : {}),
                  }}
                />
              </span>
            )}
            {options?.showValues !== false && (
              <span className="qt-metric-bar-value">
                {b.error ?? fmt(b.value)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- 2 group-by: x/y pivot ------------------------------------------------

function Pivot({
  buckets,
  fmt,
  rowLabel,
  colLabel,
  clause,
}: {
  buckets: AggregationBucket[];
  fmt: (v: MetricValue) => ReactNode;
  rowLabel: string;
  colLabel: string;
  clause: AggregationClause;
}) {
  const rowAxis = clause.display?.pivot?.swap ? 1 : 0,
    colAxis = 1 - rowAxis;
  if (rowAxis === 1) [rowLabel, colLabel] = [colLabel, rowLabel];
  const rowKeys = distinctKeys(buckets, rowAxis);
  const colKeys = distinctKeys(buckets, colAxis);
  const sortKeys = (values: MetricValue[], dir: "asc" | "desc" | undefined) => {
    if (dir)
      values.sort(
        (a, b) =>
          (typeof a === "number" && typeof b === "number"
            ? a - b
            : keyText(a).localeCompare(keyText(b))) * (dir === "asc" ? 1 : -1),
      );
  };
  sortKeys(rowKeys, clause.display?.pivot?.rowDir);
  sortKeys(colKeys, clause.display?.pivot?.columnDir);
  const cell = new Map<string, AggregationBucket>();
  for (const b of buckets)
    cell.set(
      metricTupleKey([b.keys[rowAxis] ?? null, b.keys[colAxis] ?? null]),
      b,
    );

  return (
    <div className="qt-metric-pivot-wrap">
      <table className="qt-metric-pivot">
        <thead>
          <tr>
            <th className="qt-metric-pivot-corner">
              <span className="qt-metric-pivot-axes">
                {rowLabel} <span className="qt-muted">\</span> {colLabel}
              </span>
            </th>
            {colKeys.map((c) => (
              <th key={typedMetricKey(c)} className="qt-metric-pivot-col">
                {keyNode(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((r) => (
            <tr key={typedMetricKey(r)}>
              <th className="qt-metric-pivot-row">{keyNode(r)}</th>
              {colKeys.map((c) => {
                const v = cell.get(metricTupleKey([r, c]));
                return (
                  <td key={typedMetricKey(c)} className="qt-metric-pivot-cell">
                    {v === undefined ? (
                      <span className="qt-muted">·</span>
                    ) : (
                      (v.error ?? fmt(v.value))
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 3+ group-by: flat table ----------------------------------------------

function FlatTable({
  buckets,
  fmt,
  groupLabels,
  valueLabel,
}: {
  buckets: AggregationBucket[];
  fmt: (v: MetricValue) => ReactNode;
  groupLabels: string[];
  valueLabel: string;
}) {
  return (
    <div className="qt-metric-pivot-wrap">
      <table className="qt-metric-flat">
        <thead>
          <tr>
            {groupLabels.map((g) => (
              <th key={g}>{g}</th>
            ))}
            <th className="qt-metric-flat-value">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => (
            <tr key={i}>
              {/* Index by column, not by b.keys: a bucket whose `keys` is shorter
                  than the header (a malformed/partial result) must still leave the
                  value in the value column rather than sliding it left. */}
              {groupLabels.map((_, j) => (
                <td key={j}>{keyNode(b.keys[j])}</td>
              ))}
              <td className="qt-metric-flat-value">
                {b.error ?? fmt(b.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

function metricTitle<Row>(
  clause: AggregationClause,
  measure: FieldDef<Row> | undefined,
): string {
  if (clause.label) return clause.label;
  if (clause.expression) return clause.expression;
  if (clause.op === "count" && !measure) return "Count";
  return `${OP_LABELS[clause.op]} ${measure?.label ?? clause.field ?? ""}`.trim();
}

// Default renderers that map a number to a unit-formatted string (and so already
// bound their own decimals). Any OTHER renderer (text/link/pill/number) is skipped
// for numeric aggregates — it would stringify the raw float — in favor of the
// card's shared decimal formatting.
const UNIT_RENDER_KEYS: ReadonlySet<string> = new Set([
  "duration_ms",
  "byte_size",
]);

function formatMetricValue<Row>(
  value: MetricValue,
  op: AggOp,
  measure: FieldDef<Row> | undefined,
  renderers: RenderRegistry<Row> | undefined,
  decimals: number,
): ReactNode {
  if (value == null) return <span className="qt-muted">—</span>;
  // Counts are dimensionless integers — never run them through a column renderer.
  if (op === "count" || op === "count_distinct") {
    return typeof value === "number" ? formatNumber(value, 0) : String(value);
  }
  if (typeof value === "number") {
    const key =
      typeof measure?.render === "string" ? measure.render : undefined;
    if (key && UNIT_RENDER_KEYS.has(key) && measure && renderers) {
      const node = tryRender(measure, renderers, value);
      if (node != null) return node;
    }
    return formatNumber(value, decimals);
  }
  // min/max over text or datetime → the column's renderer, else the raw string.
  if (measure && renderers) {
    const node = tryRender(measure, renderers, value);
    if (node != null) return node;
  }
  return String(value);
}

function tryRender<Row>(
  measure: FieldDef<Row>,
  renderers: RenderRegistry<Row>,
  value: number | string | boolean,
): ReactNode | null {
  try {
    const node = resolveRenderer(
      measure,
      renderers,
    )({
      value: value as never,
      row: {} as Row,
      field: measure,
      query: EMPTY_QUERY,
    });
    return node != null && node !== "" ? node : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// One decimal count for every numeric value in a card: 0 when all are integers
// (counts, integer measures), else enough places to give the largest-magnitude
// value ≈5 significant figures (so smaller values share that precision and no
// value shows a runaway float tail). Capped at 6.
export function cardDecimals(buckets: AggregationBucket[]): number {
  const nums = buckets
    .map((b) => b.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return 0;
  if (nums.every((v) => Number.isInteger(v))) return 0;
  const maxAbs = Math.max(...nums.map((v) => Math.abs(v)));
  const intDigits = maxAbs >= 1 ? Math.floor(Math.log10(maxAbs)) + 1 : 0;
  return Math.min(6, Math.max(0, 5 - intDigits));
}

function distinctKeys(
  buckets: AggregationBucket[],
  axis: number,
): MetricValue[] {
  const seen = new Set<string>();
  const out: MetricValue[] = [];
  for (const b of buckets) {
    const k = b.keys[axis] ?? null;
    const t = typedMetricKey(k);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(k);
    }
  }
  return out;
}

function keyText(k: MetricValue | undefined): string {
  return k == null ? NULL_KEY : String(k);
}

function keyNode(k: MetricValue | undefined): ReactNode {
  return k == null ? <span className="qt-muted">{NULL_KEY}</span> : String(k);
}
