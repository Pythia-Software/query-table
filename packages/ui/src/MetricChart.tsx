import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from "react";
import {
  createMetricColorResolver,
  metricTupleKey,
  typedMetricKey,
  type MetricClassNames,
  type MetricTheme,
} from "./metricColors";
import { formatMetricOutput } from "./metricFormat";
import {
  chronologicalBuckets,
  finiteMetricNumber,
  metricScale,
  metricGroupLabel,
  metricDateGroupFormat,
  metricPieSlices,
  metricBoxWhiskers,
  metricBoxOutliers,
} from "./metricChartHelpers";
import type {
  MetricBucket,
  MetricRenderResult,
  MetricValue,
  MetricValueFormat,
  RenderingClause,
} from "./metricTypes";

import { MetricTooltip } from "./MetricTooltip";

import { compactMetricScale, compactMetricTick, compactTickStep, compactCalendarLabels } from "./compactMetricChart";

interface ChartProps {
  compact?: boolean | undefined;
  clause: RenderingClause;
  buckets: MetricBucket[];
  result?: MetricRenderResult | undefined;
  theme?: MetricTheme | undefined;
  locale?: string | undefined;
  classNames?: MetricClassNames | undefined;
  onInspect?: ((bucket: MetricBucket) => void) | undefined;
}
function usePlotSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 400, height: 220 });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0)
        setSize(previous => {
          const width = Math.max(160, rect.width), height = Math.max(100, rect.height);
          return previous.width === width && previous.height === height ? previous : { width, height };
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}
export function MetricChart({
  compact = false,
  clause,
  buckets: inputBuckets,
  result,
  theme,
  locale,
  classNames,
  onInspect,
}: ChartProps): ReactNode {
  const { ref, width: W, height: H } = usePlotSize(),
    tooltipId = useId(),
    clipId = useId();
  // Calendar covers read left to right in time, regardless of result ranking.
  let buckets = inputBuckets;
  if (compact && clause.dateGrouping && ["line", "bar-vertical"].includes(clause.display?.kind ?? "")) {
    try { buckets = chronologicalBuckets(inputBuckets).map(point => point.bucket); } catch { /* validation below reports invalid coordinates */ }
  }
  const display = clause.display ?? { kind: "auto" },
    kind = display.kind,
    colors = createMetricColorResolver(theme);
  const fmt = (v: MetricValue | undefined, f: MetricValueFormat | undefined) =>
    formatMetricOutput(v, f, locale).text;
  const tickFmt = (v: number, format: MetricValueFormat | undefined, ticks: readonly number[] = []) =>
    compact ? compactMetricTick(v, format, locale, compactTickStep(ticks)) : format
      ? fmt(v, format)
      : v.toLocaleString(locale, { maximumSignificantDigits: 8 });
  const percent = (ratio: number) =>
    formatMetricOutput(
      ratio,
      {
        kind: "percent",
        decimals: display.format?.decimals ?? 1,
      },
      locale,
    ).text;
  const shade = (b: MetricBucket) =>
    b.keys.length
      ? colors.color(clause.groupBy[0] ?? "", b.keys[0] ?? null)
      : colors.token("accent");
  const groupLabel = (b: MetricBucket) => metricGroupLabel(b, clause, locale);
  const groupFormat = metricDateGroupFormat(clause);
  const detail = (b: MetricBucket) =>
    `${metricGroupLabel(b, clause, locale, true)}\n${b.error ?? fmt(b.value, kind === "scatter" ? display.xFormat : display.format)}${kind === "scatter" ? ` / ${b.yError ?? fmt(b.y, display.yFormat)}` : ""}\n${b.count.toLocaleString(locale)} rows`;
  const interaction = (
    b: MetricBucket,
    label = detail(b),
    inspectable = true,
    color = shade(b),
  ): SVGProps<SVGGElement> & { "data-qt-metric-color": string } => ({
    clipPath: ["pie", "donut"].includes(kind) ? undefined : `url(#${clipId})`,
    tabIndex: 0,
    role: onInspect && inspectable ? "button" : "img",
    "aria-label": label,
    "data-qt-metric-color": color,
    className: `qt-metric-mark ${classNames?.mark ?? ""}`,
    onClick: () => {
      if (inspectable) onInspect?.(b);
    },
    onKeyDown: (e) => {
      if (onInspect && inspectable && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onInspect(b);
      }
    },
  });
  const compactBox = compact && kind === "box";
  const left = compactBox ? 8 : compact ? 44 : Math.min(78, W * 0.24),
    right = W - (compactBox ? 8 : compact ? 8 : 32),
    top = compactBox ? 0 : 12,
    bottom = H - (compact ? 20 : 42),
    plotW = right - left,
    plotH = bottom - top;
  const text = (
    x: number,
    y: number,
    label: string,
    anchor: "start" | "middle" | "end" = "middle",
  ) => (
    <text
      x={compact && anchor === "middle" ? Math.max(label.length * 2.7 + 2, Math.min(W - label.length * 2.7 - 2, x)) : x}
      y={y}
      textAnchor={anchor}
      className={`qt-metric-axis ${classNames?.axis ?? ""}`}
    >
      {label}
    </text>
  );
  const grid = (x1: number, y1: number, x2: number, y2: number) => (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      className={`qt-metric-grid ${classNames?.grid ?? ""}`}
    />
  );
  let marks: ReactNode = null,
    axes: ReactNode = null,
    note = "",
    disclosure = "",
    problem: string | undefined;
  const scaleNotes: string[] = [];
  const scale = (
    values: number[],
    options: typeof display.xScale,
    zero = false,
    format?: MetricValueFormat,
  ) => {
    const axis = compact ? compactMetricScale(values, options, zero, format) : metricScale(values, options, zero);
    if (axis.error) problem = axis.error;
    if (axis.omitted)
      scaleNotes.push(
        `${axis.omitted} nonpositive values omitted from logarithmic axis.`,
      );
    return axis;
  };
  let legend: Array<{ key: string; label: string; color: string; value?: string; share?: string }> = Array.from(
    new Map(
      buckets.map((b) => [
        typedMetricKey(b.keys[0]),
        {
          key: typedMetricKey(b.keys[0]),
          label: String(b.keys[0] ?? "NULL"),
          color: shade(b),
        },
      ]),
    ).values(),
  );
  if (kind === "pie" || kind === "donut") {
    const pie = metricPieSlices(
      clause,
      buckets,
      result?.groupCount,
      result?.other,
      display.maxGroups ?? 8,
      display.showOther !== false,
    );
    problem =
      result?.coverage === "partial"
        ? "Pie requires exact coverage of the scoped rows."
        : pie.error;
    const cx = W / 2,
      cy = H / 2,
      r = Math.max(10, Math.min(W, H) / 2 - 15),
      inner = kind === "donut" ? r * 0.58 : 0;
    let angle = -Math.PI / 2;
    const point = (a: number, radius: number) =>
      `${cx + Math.cos(a) * radius} ${cy + Math.sin(a) * radius}`;
    marks = pie.slices.map((s, i) => {
      const start = angle;
      angle += (s.value / pie.total) * Math.PI * 2;
      const end = angle,
        large = end - start > Math.PI ? 1 : 0,
        color = s.other ? colors.token("other") : shade(s.bucket),
        label = `${s.other ? "Other (combined remainder)" : groupLabel(s.bucket)}: ${fmt(s.value, display.format)} (${percent(s.value / pie.total)} of ${fmt(pie.total, display.format)})`;
      return (
        <g key={i} {...interaction(s.bucket, label, !s.other, color)}>
          {s.value === pie.total ? (
            <circle
              cx={cx}
              cy={cy}
              r={inner ? (r + inner) / 2 : r}
              fill={inner ? "none" : color}
              stroke={inner ? color : "none"}
              strokeWidth={r - inner}
            />
          ) : (
            <path
              fill={color}
              d={
                inner
                  ? `M ${point(start, r)} A ${r} ${r} 0 ${large} 1 ${point(end, r)} L ${point(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`
                  : `M ${cx} ${cy} L ${point(start, r)} A ${r} ${r} 0 ${large} 1 ${point(end, r)} Z`
              }
            />
          )}
        </g>
      );
    });
    legend = pie.slices.map((s, i) => ({
      key: String(i),
      label: compact ? (s.other ? "Other" : groupLabel(s.bucket)) : `${s.other ? "Other (remainder)" : groupLabel(s.bucket)} · ${fmt(s.value, display.format)} · ${percent(s.value / pie.total)}`,
      ...(compact ? { value: fmt(s.value, display.format), share: percent(s.value / pie.total) } : {}),
      color: s.other ? colors.token("other") : shade(s.bucket),
    }));
    note = `Exact additive denominator: ${fmt(pie.total, display.format)}. ${display.showOther === false ? "Hidden remainder retains its share of the full denominator." : "Other combines remaining groups."} Hover a slice for its value.`;
  } else if (compactBox) {
    const step = 30, visible = buckets.slice(0, Math.max(1, Math.floor(plotH / step)));
    const summaries = visible.flatMap(b => !b.error && b.distribution?.kind === "box" && b.distribution.summary ? [b.distribution.summary] : []);
    const axis = scale(summaries.flatMap(s => [s.min, s.max]), display.xScale, false, display.format);
    const x = (v: number) => left + axis.fraction(v) * plotW;
    axes = axis.ticks.map((v, i) => <g key={i} className="qt-metric-box-axis-tick">
      {grid(x(v), top, x(v), bottom)}
      {text(x(v), bottom + 16, tickFmt(v, display.format, axis.ticks), i === 0 ? "start" : i === axis.ticks.length - 1 ? "end" : "middle")}
    </g>);
    marks = visible.map((b, i) => {
      const s = b.distribution?.kind === "box" ? b.distribution.summary : null;
      const y = top + i * step + 22, color = shade(b);
      const median = s ? `Median ${fmt(s.median, display.format)}` : "";
      const fullLabel = groupLabel(b);
      const chars = Math.max(4, Math.floor((plotW - median.length * 5.5 - 12) / 5.5));
      const shortLabel = fullLabel.length > chars ? `${fullLabel.slice(0, chars - 1)}…` : fullLabel;
      const whisker = s ? metricBoxWhiskers(s) : null;
      const outliers = s ? metricBoxOutliers(s) : [];
      const detailLabel = s
        ? `${fullLabel}\nMin ${fmt(s.min, display.format)} · Q1 ${fmt(s.q1, display.format)} · Median ${fmt(s.median, display.format)} · Q3 ${fmt(s.q3, display.format)} · Max ${fmt(s.max, display.format)} · Mean ${fmt(s.mean, display.format)}\nObserved whiskers ${fmt(s.low, display.format)} – ${fmt(s.high, display.format)}${s.low > s.q1 || s.high < s.q3 ? "\nInterpolated quartile extends beyond observed inliers; whisker meets the box edge." : ""}\n${s.n} samples · ${b.nullCount ?? 0} NULL · ${s.outlierCount} outliers (${outliers.length} retained markers). Shared ${display.xScale?.mode === "log" ? "logarithmic" : "linear"} axis.`
        : detail(b);
      return <g key={i} className="qt-metric-box-row">
        <text x={left} y={y - 12} textAnchor="start" className="qt-metric-axis qt-metric-box-label"><title>{fullLabel}</title>{shortLabel}</text>
        {text(right, y - 12, median, "end")}
        {s && whisker && !b.error && axis.accepts(s.min) ? <g {...interaction(b, detailLabel)}>
          <line className="qt-metric-box-whisker" x1={x(whisker.low)} x2={x(whisker.high)} y1={y} y2={y} stroke={color} strokeWidth={2} />
          {[whisker.low, whisker.high].map((v, j) => <line key={j} className="qt-metric-box-cap" x1={x(v)} x2={x(v)} y1={y - 4} y2={y + 4} stroke={color} />)}
          <rect className="qt-metric-box-quartiles" x={x(s.q1)} y={y - 5} width={Math.max(1, x(s.q3) - x(s.q1))} height={10} fill={color} fillOpacity={0.25} stroke={color} />
          <line x1={x(s.median)} x2={x(s.median)} y1={y - 5} y2={y + 5} stroke={color} strokeWidth={2} />
          {display.boxMean === true && <circle cx={x(s.mean)} cy={y} r={2} fill={colors.token("surface")} stroke={color} />}
          {outliers.map((v, j) => <circle key={j} className="qt-metric-box-outlier" cx={x(v)} cy={y} r={2.5} fill={color} />)}
          <rect x={left} y={y - 7} width={plotW} height={14} fill="transparent" />
        </g> : text((left + right) / 2, y + 4, b.error ? "Error" : s ? "Nonpositive samples" : "No samples")}
      </g>;
    });
    if (visible.length < buckets.length) disclosure = `${visible.length} of ${buckets.length} returned groups drawn.`;
    note = `Shared ${display.xScale?.mode === "log" ? "logarithmic" : "linear"} axis includes the visible cohorts’ full observed range. Hover a box for exact summaries and observed whiskers. Dots retain sampled outliers and true extremes.`;
  } else if (kind === "box") {
    const summaries = buckets.flatMap((b) =>
        !b.error && b.distribution?.kind === "box" && b.distribution.summary
          ? [b.distribution.summary]
          : [],
      ),
      axis = scale(
        summaries.flatMap((s) => [s.min, s.max]),
        display.xScale,
      ),
      x = (v: number) => left + axis.fraction(v) * plotW;
    const visible = buckets.slice(0, Math.max(1, Math.floor(plotH / 22))),
      step = plotH / Math.max(1, visible.length);
    axes = axis.ticks.map((v, i) => (
      <g key={i}>
        {grid(x(v), top, x(v), bottom)}
        {text(x(v), bottom + 18, tickFmt(v, display.format, axis.ticks))}
      </g>
    ));
    marks = visible.map((b, i) => {
      const s = b.distribution?.kind === "box" ? b.distribution.summary : null,
        y = top + step * (i + 0.5),
        color = shade(b);
      const whisker = s ? metricBoxWhiskers(s) : null, outliers = s ? metricBoxOutliers(s) : [];
      const label = s
        ? `${groupLabel(b)}\nMin ${fmt(s.min, display.format)} · Q1 ${fmt(s.q1, display.format)} · Median ${fmt(s.median, display.format)} · Q3 ${fmt(s.q3, display.format)} · Max ${fmt(s.max, display.format)} · Mean ${fmt(s.mean, display.format)}\nObserved whiskers ${fmt(s.low, display.format)} – ${fmt(s.high, display.format)}${s.low > s.q1 || s.high < s.q3 ? "\nInterpolated quartile extends beyond observed inliers; whisker meets the box edge." : ""}\n${s.n} samples · ${b.nullCount ?? 0} NULL · ${s.outlierCount} outliers (${outliers.length} retained markers)`
        : detail(b);
      return (
        <g key={i}>
          {text(left - 8, y + 4, groupLabel(b), "end")}
          {!s || b.error || !axis.accepts(s.min) ? (
            text(
              (left + right) / 2,
              y + 4,
              b.error ? "Error" : s ? "Nonpositive samples" : "No samples",
            )
          ) : (
            <g {...interaction(b, label)}>
              <line
                x1={x(whisker!.low)}
                x2={x(whisker!.high)}
                y1={y}
                y2={y}
                stroke={color}
                strokeWidth={2}
              />
              {[whisker!.low, whisker!.high].map((v, j) => (
                <line
                  key={j}
                  x1={x(v)}
                  x2={x(v)}
                  y1={y - 6}
                  y2={y + 6}
                  stroke={color}
                />
              ))}
              <rect
                x={x(s.q1)}
                y={y - 8}
                width={Math.max(1, x(s.q3) - x(s.q1))}
                height={16}
                fill={color}
                fillOpacity={0.25}
                stroke={color}
              />
              <line
                x1={x(s.median)}
                x2={x(s.median)}
                y1={y - 8}
                y2={y + 8}
                stroke={color}
                strokeWidth={2}
              />
              {display.boxMean !== false && (
                <circle
                  cx={x(s.mean)}
                  cy={y}
                  r={3}
                  fill={colors.token("surface")}
                  stroke={color}
                />
              )}
              <rect
                x={left}
                y={y - 11}
                width={plotW}
                height={22}
                fill="transparent"
              />
              {outliers.map((v, j) => (
                <circle key={j} cx={x(v)} cy={y} r={3} fill={color} />
              ))}
            </g>
          )}
        </g>
      );
    });
    if (visible.length < buckets.length)
      disclosure = `${visible.length} of ${buckets.length} returned groups drawn. Additional groups are not drawn.`;
    const missing = buckets.filter(
      (b) =>
        b.error || b.distribution?.kind !== "box" || !b.distribution.summary,
    ).length;
    const omittedOutliers = summaries.reduce(
      (n, s) => n + Math.max(0, s.outlierCount - metricBoxOutliers(s).length),
      0,
    );
    if (missing)
      disclosure += ` ${missing} groups have no summary or an error.`;
    if (omittedOutliers)
      disclosure += ` ${omittedOutliers} outlier markers omitted.`;
    note = `${visible.length} of ${buckets.length} groups drawn. Scale includes all returned summaries. Hover a box for its summary.`;
  } else if (kind === "histogram") {
    const valid = buckets.filter(
        (b) =>
          !b.error &&
          b.distribution?.kind === "histogram" &&
          b.distribution.n > 0,
      ),
      series = valid.slice(0, display.maxGroups ?? 6),
      first = series[0]?.distribution,
      edges = first?.kind === "histogram" ? first.edges : [],
      bins = edges.length - 1;
    if (clause.groupBy.length > 1)
      problem = "Histogram comparisons support at most one grouping key.";
    if (
      valid.some(
        (b) =>
          b.distribution?.kind === "histogram" &&
          (b.distribution.edges.length !== edges.length ||
            b.distribution.edges.some((v, i) => v !== edges[i]) ||
            b.distribution.counts.length !== bins ||
            b.distribution.counts.some((n) => !Number.isInteger(n) || n < 0) ||
            b.distribution.counts.reduce((a, n) => a + n, 0) !==
              b.distribution.n),
      )
    )
      problem =
        "Histogram results must use shared edges and conserve sample counts.";
    if (
      edges.some(
        (v, i) =>
          !Number.isFinite(v) ||
          (i > 0 && (v < edges[i - 1]! || (bins > 1 && v === edges[i - 1]))),
      )
    )
      problem = "Histogram edges must be finite and strictly increasing.";
    if (bins < 1) problem = "No numeric samples to summarize.";
    const counts = series.flatMap((b) =>
      b.distribution?.kind === "histogram" ? b.distribution.counts : [],
    );
    const ya = scale(counts, display.yScale, true),
      xa = scale(edges, display.xScale, false, display.xFormat);
    const y = (v: number) => bottom - ya.fraction(v) * plotH;
    axes = (
      <>
        {ya.ticks.map((v, i) => (
          <g key={i}>
            {grid(left, y(v), right, y(v))}
            {text(left - 7, y(v) + 4, compact ? tickFmt(v, undefined, ya.ticks) : v.toLocaleString(locale), "end")}
          </g>
        ))}
        {xa.ticks.map((v, i) => (
          <g key={i}>
            {text(
              left + xa.fraction(v) * plotW,
              bottom + 18,
              tickFmt(v, display.xFormat, xa.ticks),
            )}
          </g>
        ))}
      </>
    );
    marks = series.flatMap((b, j) =>
      b.distribution?.kind === "histogram"
        ? b.distribution.counts.map((n, i) => {
            if (
              !ya.accepts(n) ||
              !xa.accepts(edges[i]!) ||
              !xa.accepts(edges[i + 1]!)
            )
              return null;
            const pointInterval = edges[i] === edges[i + 1];
            const center = left + xa.fraction(edges[i]!) * plotW;
            const pointWidth = Math.min(64, plotW / 3);
            const binLeft = pointInterval ? center - pointWidth / 2 : center,
              binRight = pointInterval
                ? center + pointWidth / 2
                : left + xa.fraction(edges[i + 1]!) * plotW,
              binWidth = Math.max(1, binRight - binLeft),
              x = binLeft + (j * binWidth) / series.length,
              w = binWidth / series.length;
            const label = `${groupLabel(b)}\n${fmt(edges[i], display.xFormat)} ≤ value ${i === bins - 1 ? "≤" : "<"} ${fmt(edges[i + 1], display.xFormat)}\n${n} rows${compact ? "" : ` · ${b.distribution?.kind === "histogram" ? b.distribution.n : 0} numeric samples · ${b.nullCount ?? 0} NULL`}`;
            return (
              <g key={`${j}-${i}`} {...interaction(b, label)}>
                <rect
                  x={x}
                  y={y(n)}
                  width={Math.max(0.5, w - 1)}
                  height={Math.max(0, y(ya.baseline) - y(n))}
                  fill={shade(b)}
                />
                <rect
                  x={x}
                  y={Math.min(y(n), bottom - 6)}
                  width={w}
                  height={Math.max(6, bottom - y(n))}
                  fill="transparent"
                />
              </g>
            );
          })
        : [],
    );
    legend = series.map((b, i) => ({
      key: String(i),
      label: groupLabel(b),
      color: shade(b),
    }));
    if (series.length < buckets.length)
      disclosure = `${series.length} of ${buckets.length} returned groups drawn; ${buckets.length - valid.length} empty/error groups. Additional bins are not drawn.`;
    note = `${series.length} of ${result?.groupCount ?? buckets.length} groups drawn; Hover a bin for its count. Shared edges; final upper bound included. Frequencies are row counts.`;
  } else if (kind === "scatter") {
    const points = buckets.filter(
      (b) =>
        !b.error &&
        !b.yError &&
        finiteMetricNumber(b.value) &&
        finiteMetricNumber(b.y),
    );
    const xa = scale(
        points.map((b) => b.value as number),
        display.xScale,
        false,
        display.xFormat,
      ),
      ya = scale(
        points.map((b) => b.y as number),
        display.yScale,
        false,
        display.yFormat,
      ),
      x = (v: number) => left + xa.fraction(v) * plotW,
      y = (v: number) => bottom - ya.fraction(v) * plotH;
    axes = (
      <>
        {xa.ticks.map((v, i) => (
          <g key={`x${i}`}>
            {grid(x(v), top, x(v), bottom)}
            {text(x(v), bottom + 18, tickFmt(v, display.xFormat, xa.ticks))}
          </g>
        ))}
        {ya.ticks.map((v, i) => (
          <g key={`y${i}`}>
            {grid(left, y(v), right, y(v))}
            {text(left - 7, y(v) + 4, tickFmt(v, display.yFormat, ya.ticks), "end")}
          </g>
        ))}
      </>
    );
    marks = points
      .filter((b) => xa.accepts(b.value as number) && ya.accepts(b.y as number))
      .map((b, i) => (
        <g key={i} {...interaction(b)}>
          <circle
            cx={x(b.value as number)}
            cy={y(b.y as number)}
            r={4}
            fill={shade(b)}
          />
          <circle
            cx={x(b.value as number)}
            cy={y(b.y as number)}
            r={12}
            fill="transparent"
          />
        </g>
      ));
    if (points.length < buckets.length)
      disclosure = `${points.length} paired points; ${buckets.length - points.length} missing/error pairs.`;
    note = `${points.length} paired points; ${buckets.length - points.length} missing/error pairs. Coordinates use raw paired values.`;
  } else {
    if (buckets.some((b) => b.value !== null && !finiteMetricNumber(b.value)))
      problem = "This chart requires finite numeric values.";
    const horizontal = kind === "bar-horizontal",
      axis = scale(
        buckets.flatMap((b) =>
          !b.error && finiteMetricNumber(b.value) ? [b.value] : [],
        ),
        horizontal ? display.xScale : display.yScale,
        true,
        display.format,
      );
    const x = (v: number) => left + axis.fraction(v) * plotW,
      y = (v: number) => bottom - axis.fraction(v) * plotH;
    if (kind === "line") {
      try {
        const ordered = chronologicalBuckets(buckets),
          timeAxis = scale(
            ordered.map((p) => p.time),
            display.xScale,
            false,
            { kind: "datetime", sourceUnit: "epochMilliseconds" },
          ),
          tx = (v: number) => left + timeAxis.fraction(v) * plotW;
        const calendarLabels = compactCalendarLabels(compact ? ordered.map(({bucket, time}) => ({bucket, x: tx(time)})) : [], clause, locale);
        const timeLabel = (b: MetricBucket) =>
          compact && clause.dateGrouping ? calendarLabels.get(b) ?? "" :
          groupFormat
            ? formatMetricOutput(b.keys[0], groupFormat, locale).text
            : String(b.keys[0]);
        const series = new Map<string, typeof ordered>();
        for (const point of ordered) {
          const key = metricTupleKey(point.bucket.keys.slice(1));
          const entries = series.get(key) ?? [];
          entries.push(point);
          series.set(key, entries);
        }
        const times = [...new Set(ordered.map((p) => p.time))];
        const paths = [...series.entries()].map(([key, points]) => {
          let open = false,
            path = "";
          const byTime = new Map(points.map((p) => [p.time, p.bucket]));
          for (const time of times) {
            const bucket = byTime.get(time);
            if (
              !bucket ||
              bucket.error ||
              !finiteMetricNumber(bucket.value) ||
              !axis.accepts(bucket.value) ||
              !timeAxis.accepts(time)
            ) {
              open = false;
              continue;
            }
            path += `${open ? "L" : "M"}${tx(time)},${y(bucket.value)} `;
            open = true;
          }
          const first = points[0]!.bucket;
          const color =
            clause.groupBy.length > 1
              ? colors.color(clause.groupBy[1]!, first.keys[1] ?? null)
              : colors.token("accent");
          return {
            key,
            path,
            color,
            label: metricGroupLabel({ ...first, keys: first.keys.slice(1) }),
          };
        });
        marks = (
          <>
            {paths.map((series) => (
              <path
                key={series.key}
                clipPath={`url(#${clipId})`}
                d={series.path}
                fill="none"
                stroke={series.color}
                strokeWidth={2}
              />
            ))}
            {ordered.map(({ bucket: b, time }, i) =>
              !b.error &&
              finiteMetricNumber(b.value) &&
              axis.accepts(b.value) &&
              timeAxis.accepts(time) ? (
                <g key={i} {...interaction(b, detail(b), true, clause.groupBy.length > 1 ? colors.color(clause.groupBy[1]!, b.keys[1] ?? null) : colors.token("accent"))}>
                  <circle
                    cx={tx(time)}
                    cy={y(b.value)}
                    r={4}
                    fill={
                      clause.groupBy.length > 1
                        ? colors.color(clause.groupBy[1]!, b.keys[1] ?? null)
                        : colors.token("accent")
                    }
                  />
                  <circle
                    cx={tx(time)}
                    cy={y(b.value)}
                    r={12}
                    fill="transparent"
                  />
                </g>
              ) : null,
            )}
            {ordered
              .filter(
                (_, i) =>
                  compact && clause.dateGrouping ? calendarLabels.has(ordered[i]!.bucket) : i % Math.max(1, Math.ceil(ordered.length / 4)) === 0 ||
                  i === ordered.length - 1,
              )
              .filter(({ time }) => timeAxis.accepts(time))
              .filter(({ bucket, time }, i, points) => {
                // Reserve room for the final date instead of overlapping its
                // label with the preceding sampled tick on narrow cards.
                const last = points[points.length - 1]!;
                return (
                  i === points.length - 1 ||
                  tx(last.time) - tx(time) >
                    (timeLabel(bucket).length + timeLabel(last.bucket).length) *
                      3 +
                      12
                );
              })
              .map(({ bucket: b, time }, i) => (
                <g key={i}>{text(tx(time), bottom + 18, timeLabel(b))}</g>
              ))}
          </>
        );
        const missing = buckets.filter(
          (b) => b.error || !finiteMetricNumber(b.value),
        ).length;
        if (missing)
          disclosure = `${missing} missing/error points; lines break at gaps.`;
        note =
          "Chronological spacing; NULL/error values break the line. All returned points are drawn.";
        legend =
          clause.groupBy.length > 1
            ? paths.map((s) => ({ key: s.key, label: s.label, color: s.color }))
            : [];
      } catch {
        problem =
          "Line charts require strict ISO dates/timestamps or numeric group coordinates.";
      }
    } else {
      const visible = horizontal
          ? buckets.slice(0, Math.max(1, Math.floor(plotH / 20)))
          : buckets,
        step = (horizontal ? plotH : plotW) / Math.max(1, visible.length);
      const calendarLabels = compactCalendarLabels(compact && !horizontal ? visible.map((bucket, i) => ({ bucket, x: left + step * (i + .5) })) : [], clause, locale);
      marks = visible.map((b, i) => {
        const center = (horizontal ? top : left) + step * (i + 0.5),
          valid =
            !b.error && finiteMetricNumber(b.value) && axis.accepts(b.value),
          value = valid ? (b.value as number) : 0;
        return (
          <g key={i}>
            {(compact && clause.dateGrouping && !horizontal ? calendarLabels.has(b) : horizontal || step > 42 || i % Math.ceil(42 / step) === 0) &&
              text(
                horizontal ? left - 7 : center,
                horizontal ? center + 4 : bottom + 18,
                compact && clause.dateGrouping && !horizontal ? calendarLabels.get(b)! : !horizontal && groupFormat && b.keys.length === 1
                  ? formatMetricOutput(b.keys[0], groupFormat, locale).text
                  : groupLabel(b),
                horizontal ? "end" : "middle",
              )}
            {valid ? (
              <g {...interaction(b)}>
                <rect
                  x={
                    horizontal
                      ? Math.min(x(axis.baseline), x(value))
                      : center - step * 0.32
                  }
                  y={
                    horizontal
                      ? center - step * 0.3
                      : Math.min(y(axis.baseline), y(value))
                  }
                  width={
                    horizontal
                      ? Math.max(1, Math.abs(x(value) - x(axis.baseline)))
                      : step * 0.64
                  }
                  height={
                    horizontal
                      ? step * 0.6
                      : Math.max(1, Math.abs(y(value) - y(axis.baseline)))
                  }
                  fill={shade(b)}
                />
              </g>
            ) : horizontal ? (
              text((left + right) / 2, center + 4, b.error ? "Error" : "—")
            ) : null}
          </g>
        );
      });
      if (visible.length < buckets.length)
        disclosure = `${visible.length} of ${buckets.length} returned groups drawn. Additional groups are not drawn.`;
      const missing = buckets.filter(
        (b) => b.error || !finiteMetricNumber(b.value),
      ).length;
      if (missing) disclosure += ` ${missing} missing/error values.`;
      note = `${axis.accepts(0) ? "Signed values use a zero baseline." : "Logarithmic values use the positive domain minimum as baseline."} ${visible.length} of ${result?.groupCount ?? buckets.length} groups drawn; Hover a mark for its value.`;
    }
    axes = axis.ticks.map((v, i) => (
      <g key={i}>
        {horizontal
          ? grid(x(v), top, x(v), bottom)
          : grid(left, y(v), right, y(v))}
        {horizontal
          ? text(x(v), bottom + 18, compact ? tickFmt(v, display.format, axis.ticks) : fmt(v, display.format))
          : text(left - 7, y(v) + 4, tickFmt(v, display.format, axis.ticks), "end")}
      </g>
    ));
    axes = (
      <>
        {axes}
        {horizontal ? (
          <line
            x1={x(axis.baseline)}
            x2={x(axis.baseline)}
            y1={top}
            y2={bottom}
            stroke={colors.token("muted")}
          />
        ) : (
          <line
            x1={left}
            x2={right}
            y1={y(axis.baseline)}
            y2={y(axis.baseline)}
            stroke={colors.token("muted")}
          />
        )}
      </>
    );
  }
  if (
    kind !== "scatter" &&
    ["date", "time", "datetime"].includes(display.format?.kind ?? "")
  )
    problem =
      "Calendar outputs work in values, tables or lists. Use duration formatting for elapsed quantities.";
  const position =
    display.legendPosition ??
    (["pie", "donut", "scatter", "histogram"].includes(kind)
      ? "right"
      : "none");
  const xAxisLabel = display.xLabel ?? (kind === "scatter" ? "X value"
    : kind === "histogram" ? display.valueLabel ?? "Value" : horizontalLabel(kind, clause));
  const yAxisLabel = display.yLabel ?? (kind === "scatter" ? "Y value"
    : kind === "histogram" ? "Count" : kind === "bar-horizontal" ? clause.groupBy.join(" / ") : display.valueLabel ?? "Value");
  return (
    <MetricTooltip id={tooltipId}>
      <div
        className={`qt-metric-chart-layout qt-metric-legend-${position}`}
        style={
          kind === "bar-horizontal" || kind === "box"
            ? {
                minHeight:
                  Math.min(8, buckets.length) * (compactBox ? 30 : kind === "box" ? 22 : 20) + (compactBox ? 20 : 54),
              }
            : undefined
        }
      >
        <div ref={ref} className={`qt-metric-plot ${classNames?.plot ?? ""}`}>
          {problem ? (
            <p className="qt-metric-message" role="status">
              {problem}
            </p>
          ) : (
            <svg
              viewBox={`0 0 ${W} ${H}`}
              aria-label={clause.label ?? "Metric chart"}
              role="group"
            >
              <title>{clause.label ?? "Metric chart"}</title>
              <defs>
                <clipPath id={clipId}>
                  <rect x={left} y={top} width={plotW} height={plotH} />
                </clipPath>
              </defs>
              {axes}
              {marks}
              {!compact && !["pie", "donut"].includes(kind) && (
                <>
                  {text(
                    (left + right) / 2,
                    H - 5,
                    display.xLabel ??
                      (kind === "scatter"
                        ? "X value"
                        : kind === "box" || kind === "histogram"
                          ? (display.valueLabel ?? "Value")
                          : horizontalLabel(kind, clause)),
                  )}
                  {display.yLabel && (
                    <text
                      transform={`translate(12 ${(top + bottom) / 2}) rotate(-90)`}
                      textAnchor="middle"
                      className="qt-metric-axis"
                    >
                      {display.yLabel}
                    </text>
                  )}
                </>
              )}
            </svg>
          )}
        </div>
        {position !== "none" && legend.length > 0 && (
          <ul
            className={`qt-metric-legend ${classNames?.legend ?? ""}`}
            aria-label="Legend"
          >
            {legend.map((e) => (
              <li key={e.key} title={[e.label, e.value, e.share].filter(Boolean).join(" · ")}>
                <span
                  className="qt-metric-swatch"
                  style={{ background: e.color }}
                />
                <span className="qt-metric-legend-label">{e.label}</span>
                {e.value !== undefined && <span className="qt-metric-legend-value">{e.value}</span>}
                {e.share !== undefined && <span className="qt-metric-legend-share">{e.share}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {compact && !compactBox && !["pie", "donut"].includes(kind) && (
        <div className="qt-metric-axis-labels">
          <span title={yAxisLabel}>
            <span aria-hidden="true">↑ </span>{yAxisLabel}
          </span>
          <span title={xAxisLabel}>
            <span aria-hidden="true">→ </span>{xAxisLabel}
          </span>
        </div>
      )}
      {compactBox && <p className="qt-metric-compact-guide">Shared {display.xScale?.mode === "log" ? "log " : ""}axis · Box: middle 50% · line: median · dots: outliers and extremes</p>}
      {!problem && scaleNotes.length > 0 && (
        <p className="qt-metric-note" role="status">
          {[...new Set(scaleNotes)].join(" ")}
        </p>
      )}
      {!problem && disclosure && (
        <p className="qt-metric-note" role="status">
          {disclosure.trim()}
        </p>
      )}
      <p className="qt-metric-note qt-sr-only">{note}</p>
    </MetricTooltip>
  );
}
function horizontalLabel(kind: string, clause: RenderingClause): string {
  return kind === "bar-horizontal"
    ? (clause.display?.valueLabel ?? "Value")
    : clause.groupBy.join(" / ");
}
