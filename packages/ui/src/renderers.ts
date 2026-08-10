// renderers.ts — the cell render registry.
//
// This is how the table stays "gold standard but customizable" (the core ask).
// The package ships ONLY truly-generic renderers. Domain-specific cells are
// registered by the consuming app — they must NOT live in a generic package.
// A FieldDef.render is either a key resolved
// against `{ ...defaultRenderers, ...consumerRenderers }` or an inline function.

import type { ReactNode } from "react";
import { createElement } from "react";
import type { FieldDef, QueryState } from "@pythia-software/query-table-core";

export interface CellContext<Row = any, V = unknown> {
  value: V;
  row: Row;
  field: FieldDef<Row, V>;
  /** Current query — lets renderers reflect active state (e.g. highlight matches). */
  query: QueryState;
}

export type CellRenderer<Row = any, V = unknown> = (ctx: CellContext<Row, V>) => ReactNode;

export type RenderRegistry<Row = any> = Record<string, CellRenderer<Row>>;

/** The em-dash shown for empty / null values, so every renderer agrees. */
const EMPTY = "—";

const muted = (text: string): ReactNode => createElement("span", { className: "qt-muted" }, text);

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Resolve a user-controlled link against a harmless HTTPS base and allow only
 * navigation protocols. This catches obfuscated forms such as `java\nscript:`
 * that simple prefix checks miss while preserving relative and fragment URLs. */
export function safeLinkHref(value: unknown): string | null {
  if (isEmpty(value)) return null;
  const href = String(value).trim();
  if (!href) return null;
  try {
    const parsed = new URL(href, "https://query-table.invalid/");
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

/** Generic, domain-free renderers shipped with the package. Keys are stable and
 *  referenced from FieldDef.render. Consumers spread these and add their own. */
export const defaultRenderers: RenderRegistry = {
  // String(value), em-dash for null/empty
  text({ value }) {
    if (isEmpty(value)) return muted(EMPTY);
    return String(value);
  },

  // single-line ellipsis (CSS does the truncation; title carries the full text)
  truncate({ value }) {
    if (isEmpty(value)) return muted(EMPTY);
    const s = String(value);
    return createElement("span", { className: "qt-truncate", title: s }, s);
  },

  // locale-grouped number
  number({ value }) {
    if (value == null || value === "") return muted(EMPTY);
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return muted(EMPTY);
    return n.toLocaleString();
  },

  // ✓ / —
  bool_check({ value }) {
    if (value == null) return muted(EMPTY);
    return value ? "✓" : muted(EMPTY);
  },

  // ISO clamped to seconds
  datetime({ value }) {
    if (isEmpty(value)) return muted(EMPTY);
    const s = String(value);
    // pgtype zero-time and other epoch placeholders read as empty.
    if (s.startsWith("0001-")) return muted(EMPTY);
    return s.slice(0, 19).replace("T", " ");
  },

  // relative ("5m ago", "yesterday", "Mar 4")
  datetime_rel({ value }) {
    if (isEmpty(value)) return muted(EMPTY);
    const s = String(value);
    if (s.startsWith("0001-")) return muted(EMPTY);
    return createElement("span", { title: s.slice(0, 19).replace("T", " ") }, formatRelative(s));
  },

  // human duration from a millisecond number
  duration_ms({ value }) {
    if (typeof value !== "number" || !Number.isFinite(value)) return muted(EMPTY);
    return formatDuration(value);
  },

  // humanized bytes (B/KB/MB/GB)
  byte_size({ value }) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return muted(EMPTY);
    return formatBytes(value);
  },

  // string[] as pills
  tags_pills({ value }) {
    if (!Array.isArray(value) || value.length === 0) return muted(EMPTY);
    return createElement(
      "span",
      { className: "qt-pills" },
      value.map((t, i) => createElement("span", { key: `${String(t)}-${i}`, className: "qt-pill" }, String(t))),
    );
  },

  // value as an <a href={value}> when its URL scheme is safe
  link({ value }) {
    if (isEmpty(value)) return muted(EMPTY);
    const label = String(value);
    const href = safeLinkHref(value);
    if (!href) return createElement("span", { className: "qt-muted", title: "Unsafe link blocked" }, label);
    return createElement(
      "a",
      { className: "qt-link", href, target: "_blank", rel: "noopener noreferrer", title: href },
      label,
    );
  },
};

/** Resolve a FieldDef's renderer: inline fn wins, else registry lookup, else
 *  the `text` fallback. */
export function resolveRenderer<Row>(
  field: FieldDef<Row>,
  registry: RenderRegistry<Row>,
): CellRenderer<Row> {
  const r = field.render;
  if (typeof r === "function") {
    // core's CellRenderer returns `unknown`; ours narrows that to ReactNode.
    return r as CellRenderer<Row>;
  }
  if (typeof r === "string") {
    const found = registry[r];
    if (found) return found;
  }
  // text fallback always exists (consumers spread defaultRenderers in).
  return (registry["text"] ?? defaultRenderers["text"]) as CellRenderer<Row>;
}

// ---- formatting helpers ---------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 0) return String(ms);
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 19);
  const now = Date.now();
  const diffSec = Math.round((now - ts) / 1000);
  if (Math.abs(diffSec) < 30) return "just now";
  const past = diffSec >= 0;
  const abs = Math.abs(diffSec);
  if (abs < 60) return past ? `${abs}s ago` : `in ${abs}s`;
  if (abs < 3600) return past ? `${Math.round(abs / 60)}m ago` : `in ${Math.round(abs / 60)}m`;
  if (abs < 86400) return past ? `${Math.round(abs / 3600)}h ago` : `in ${Math.round(abs / 3600)}h`;
  const days = Math.round(abs / 86400);
  if (past && days === 1) return "yesterday";
  if (days < 7) return past ? `${days}d ago` : `in ${days}d`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "2-digit" };
  return d.toLocaleDateString(undefined, opts);
}
