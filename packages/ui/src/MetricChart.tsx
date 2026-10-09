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
  metricPieSlices,
} from "./metricChartHelpers";
import type {
  MetricBucket,
  MetricRenderResult,
  MetricValue,
  MetricValueFormat,
  RenderingClause,
} from "./metricTypes";

interface ChartProps {
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
        setSize({
          width: Math.max(160, rect.width),
          height: Math.max(100, rect.height),
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}
export function MetricChart({
  clause,
  buckets,
  result,
  theme,
  locale,
  classNames,
  onInspect,
}: ChartProps): ReactNode {
  const { ref, width: W, height: H } = usePlotSize(),
    tooltipId = useId(),
    clipId = useId(),
    [tooltip, setTooltip] = useState<string | null>(null);
  const display = clause.display ?? { kind: "auto" },
    kind = display.kind,
    colors = createMetricColorResolver(theme);
  const fmt = (v: MetricValue | undefined, f: MetricValueFormat | undefined) =>
    formatMetricOutput(v, f, locale).text;
  const tickFmt = (v: number, format: MetricValueFormat | undefined) =>
    format
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
  const detail = (b: MetricBucket) =>
    `${metricGroupLabel(b)}\n${b.error ?? fmt(b.value, kind === "scatter" ? display.xFormat : display.format)}${kind === "scatter" ? ` / ${b.yError ?? fmt(b.y, display.yFormat)}` : ""}\n${b.count.toLocaleString(locale)} rows`;
  const interaction = (
    b: MetricBucket,
    label = detail(b),
    inspectable = true,
  ): SVGProps<SVGGElement> => ({
    clipPath: ["pie", "donut"].includes(kind) ? undefined : `url(#${clipId})`,
    tabIndex: 0,
    role: onInspect && inspectable ? "button" : "img",
    "aria-label": label,
    "aria-describedby": tooltip === label ? tooltipId : undefined,
    className: `qt-metric-mark ${classNames?.mark ?? ""}`,
    onMouseEnter: () => setTooltip(label),
    onMouseLeave: () => setTooltip(null),
    onFocus: () => setTooltip(label),
    onBlur: () => setTooltip(null),
    onClick: () => {
      if (inspectable) onInspect?.(b);
    },
    onKeyDown: (e) => {
      if (e.key === "Escape" && tooltip) {
        e.preventDefault();
        e.stopPropagation();
        setTooltip(null);
      }
      if (onInspect && inspectable && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onInspect(b);
      }
    },
  });
  const left = Math.min(78, W * 0.24),
    right = W - 32,
    top = 12,
    bottom = H - 42,
    plotW = right - left,
    plotH = bottom - top;
  const text = (
    x: number,
    y: number,
    label: string,
    anchor: "start" | "middle" | "end" = "middle",
  ) => (
    <text
      x={x}
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
  ) => {
    const axis = metricScale(values, options, zero);
    if (axis.error) problem = axis.error;
    if (axis.omitted)
      scaleNotes.push(
        `${axis.omitted} nonpositive values omitted from logarithmic axis.`,
      );
    return axis;
  };
  let legend: Array<{ key: string; label: string; color: string }> = Array.from(
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
        label = `${s.other ? "Other (combined remainder)" : metricGroupLabel(s.bucket)}: ${fmt(s.value, display.format)} (${percent(s.value / pie.total)} of ${fmt(pie.total, display.format)})`;
      return (
        <g key={i} {...interaction(s.bucket, label, !s.other)}>
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
      label: `${s.other ? "Other (remainder)" : metricGroupLabel(s.bucket)} · ${fmt(s.value, display.format)} · ${percent(s.value / pie.total)}`,
      color: s.other ? colors.token("other") : shade(s.bucket),
    }));
    note = `Exact additive denominator: ${fmt(pie.total, display.format)}. Other combines remaining groups; Hover a slice for its value.`;
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
        {text(x(v), bottom + 18, tickFmt(v, display.format))}
      </g>
    ));
    marks = visible.map((b, i) => {
      const s = b.distribution?.kind === "box" ? b.distribution.summary : null,
        y = top + step * (i + 0.5),
        color = shade(b);
      const label = s
        ? `${metricGroupLabel(b)}\nMin ${fmt(s.min, display.format)} · Q1 ${fmt(s.q1, display.format)} · Median ${fmt(s.median, display.format)} · Q3 ${fmt(s.q3, display.format)} · Max ${fmt(s.max, display.format)} · Mean ${fmt(s.mean, display.format)}\nWhiskers ${fmt(s.low, display.format)} – ${fmt(s.high, display.format)}\n${s.n} samples · ${b.nullCount ?? 0} NULL · ${s.outlierCount} outliers (${s.outliers.length} markers returned)`
        : detail(b);
      return (
        <g key={i}>
          {text(left - 8, y + 4, metricGroupLabel(b), "end")}
          {!s || b.error || !axis.accepts(s.min) ? (
            text(
              (left + right) / 2,
              y + 4,
              b.error ? "Error" : s ? "Nonpositive samples" : "No samples",
            )
          ) : (
            <g {...interaction(b, label)}>
              <line
                x1={x(s.low)}
                x2={x(s.high)}
                y1={y}
                y2={y}
                stroke={color}
                strokeWidth={2}
              />
              {[s.low, s.high].map((v, j) => (
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
              {s.outliers.map((v, j) => (
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
      (n, s) => n + s.outlierCount - s.outliers.length,
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
      series = valid.slice(0, 6),
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
      xa = scale(edges, display.xScale);
    const y = (v: number) => bottom - ya.fraction(v) * plotH;
    axes = (
      <>
        {ya.ticks.map((v, i) => (
          <g key={i}>
            {grid(left, y(v), right, y(v))}
            {text(left - 7, y(v) + 4, v.toLocaleString(locale), "end")}
          </g>
        ))}
        {xa.ticks.map((v, i) => (
          <g key={i}>
            {text(
              left + xa.fraction(v) * plotW,
              bottom + 18,
              tickFmt(v, display.xFormat),
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
            const label = `${metricGroupLabel(b)}\n${fmt(edges[i], display.xFormat)} ≤ value ${i === bins - 1 ? "≤" : "<"} ${fmt(edges[i + 1], display.xFormat)}\n${n} rows · ${b.distribution?.kind === "histogram" ? b.distribution.n : 0} numeric samples · ${b.nullCount ?? 0} NULL`;
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
      label: metricGroupLabel(b),
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
      ),
      ya = scale(
        points.map((b) => b.y as number),
        display.yScale,
      ),
      x = (v: number) => left + xa.fraction(v) * plotW,
      y = (v: number) => bottom - ya.fraction(v) * plotH;
    axes = (
      <>
        {xa.ticks.map((v, i) => (
          <g key={`x${i}`}>
            {grid(x(v), top, x(v), bottom)}
            {text(x(v), bottom + 18, tickFmt(v, display.xFormat))}
          </g>
        ))}
        {ya.ticks.map((v, i) => (
          <g key={`y${i}`}>
            {grid(left, y(v), right, y(v))}
            {text(left - 7, y(v) + 4, tickFmt(v, display.yFormat), "end")}
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
      );
    const x = (v: number) => left + axis.fraction(v) * plotW,
      y = (v: number) => bottom - axis.fraction(v) * plotH;
    if (kind === "line") {
      try {
        const ordered = chronologicalBuckets(buckets),
          timeAxis = scale(
            ordered.map((p) => p.time),
            display.xScale,
          ),
          tx = (v: number) => left + timeAxis.fraction(v) * plotW;
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
                <g key={i} {...interaction(b)}>
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
                  i % Math.max(1, Math.ceil(ordered.length / 4)) === 0 ||
                  i === ordered.length - 1,
              )
              .filter(({ time }) => timeAxis.accepts(time))
              .map(({ bucket: b, time }, i) => (
                <g key={i}>{text(tx(time), bottom + 18, String(b.keys[0]))}</g>
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
      marks = visible.map((b, i) => {
        const center = (horizontal ? top : left) + step * (i + 0.5),
          valid =
            !b.error && finiteMetricNumber(b.value) && axis.accepts(b.value),
          value = valid ? (b.value as number) : 0;
        return (
          <g key={i}>
            {(horizontal || step > 42 || i % Math.ceil(42 / step) === 0) &&
              text(
                horizontal ? left - 7 : center,
                horizontal ? center + 4 : bottom + 18,
                metricGroupLabel(b),
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
          ? text(x(v), bottom + 18, fmt(v, display.format))
          : text(left - 7, y(v) + 4, tickFmt(v, display.format), "end")}
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
  return (
    <>
      <div
        className={`qt-metric-chart-layout qt-metric-legend-${position}`}
        style={
          kind === "bar-horizontal" || kind === "box"
            ? {
                minHeight:
                  Math.min(8, buckets.length) * (kind === "box" ? 22 : 20) + 54,
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
              {!["pie", "donut"].includes(kind) && (
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
              <li key={e.key}>
                <span
                  className="qt-metric-swatch"
                  style={{ background: e.color }}
                />
                <span>{e.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {tooltip && (
        <div id={tooltipId} role="tooltip" className="qt-metric-tooltip">
          {tooltip}
        </div>
      )}
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
    </>
  );
}
function horizontalLabel(kind: string, clause: RenderingClause): string {
  return kind === "bar-horizontal"
    ? (clause.display?.valueLabel ?? "Value")
    : clause.groupBy.join(" / ");
}
