import type { ReactNode } from "react";
import type { CellDisplay } from "@pythia-software/query-table-core";
import type { CellContext } from "./renderers";
import { formatMetricOutput } from "./metricFormat";
import { JsonCell, JsonValueView } from "./JsonCell";
import { cellValueText } from "./jsonValue";
import { ClippedText, distinctTitle, numberTitle } from "./hoverTitle";

/** Declarative formats share the metric formatter's strict units and UTC default. */
export function renderCellDisplay({ value, field, presentation }: CellContext, display: CellDisplay): ReactNode {
  if (display.kind === "json") return presentation === "property"
    ? <JsonValueView value={value} label={field.label} display={display} />
    : <JsonCell value={value} label={field.label} display={display} />;
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return <span className="qt-muted">—</span>;
  if (display.kind === "text") {
    const text = cellValueText(value);
    // Clamped text wraps inside the cell; the virtualized table measures each
    // rendered row, so taller rows keep correct scroll offsets. The full text
    // is hover help only while the cell actually clips it.
    if (display.lines) return <ClippedText className="qt-line-clamp" style={{ WebkitLineClamp: display.lines }} text={text} />;
    return display.truncate ? <ClippedText className="qt-truncate" text={text} /> : text;
  }
  if (display.kind === "chip") {
    const values = Array.isArray(value) ? value : [value];
    return <span className="qt-pills">{values.map((item, index) => {
      const key = cellValueText(item);
      const own = (map: Record<string, string> | undefined) => map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
      const tone = own(display.tones), label = own(display.labels) ?? key;
      const classes = { success: "qt-pill--pass", warning: "qt-pill--warn", danger: "qt-pill--fail", neutral: "" };
      // A renamed chip offers its raw key; a plain one shows it already.
      return <span key={index} className={`qt-pill ${classes[tone as keyof typeof classes] ?? ""}`} title={distinctTitle(key, label)}>{label}</span>;
    })}</span>;
  }
  const raw = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
  if (typeof raw !== "string" && typeof raw !== "number") return <span className="qt-cell-format-error" title="Expected a string or number for this display">{cellValueText(value)}</span>;
  // Numeric strings are common in database results. Coerce strictly; never turn
  // whitespace, booleans or arbitrary text into a displayed zero.
  let numeric = raw;
  if (display.kind === "number" || display.kind === "percent") {
    numeric = typeof raw === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : raw;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) return <span className="qt-cell-format-error" title="Expected a finite number">{String(raw)}</span>;
  }
  const format = display.kind === "number" && display.decimals === undefined && display.notation !== "compact" ? undefined
    : display.kind === "percent" ? { ...display, decimals: display.decimals ?? 2 } : display;
  const locale = "locale" in display ? display.locale ?? "en-US" : "en-US";
  const result = formatMetricOutput(numeric, format, locale);
  if (result.error) return <span className="qt-cell-format-error" title={result.error}>{cellValueText(value)}</span>;
  // The raw value is hover help only when formatting hides it (rounding, units).
  return <span title={numberTitle(cellValueText(value), result.text, locale)}>{result.text}</span>;
}
