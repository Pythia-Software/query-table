import { useMemo, useState, type ReactNode } from "react";
import type { JsonCellDisplay } from "@pythia-software/query-table-core";
import { ModalSurface } from "./AdaptiveOverlay";
import { boundedJsonOption, inspectJsonValue, searchJsonEntries, JSON_MAX_CHARACTERS, type JsonEntry, type JsonInspection } from "./jsonValue";
import { Icon } from "./Icon";

export interface JsonCellProps {
  value: unknown;
  label?: string;
  display?: JsonCellDisplay | undefined;
}

/** Compact cell plus a shared searchable inspector. Mountable outside DataTable. */
export function JsonCell({ value, label = "JSON", display }: JsonCellProps): ReactNode {
  const [open, setOpen] = useState(false);
  const inspection = useMemo(() => inspectJsonValue(value, display, open), [value, display, open]);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  return <div className="qt-json-cell" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" className={`qt-json-preview${inspection.error ? " qt-json-preview--invalid" : ""}`}
      title={inspection.error ?? "Search keys, paths and values"} aria-label={`Inspect ${label}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span className="qt-json-badge">{inspection.error ? "JSON?" : "JSON"}</span>
      <code>{inspection.preview}</code>
    </button>
    {open && <ModalSurface title={`${label} · JSON`} onClose={() => setOpen(false)} chrome={false} className="qt-modal qt-json-inspector">
      <JsonValueContent inspection={inspection} label={label} display={display} onClose={() => setOpen(false)} />
    </ModalSurface>}
  </div>;
}

/** The same searchable JSON value embedded in item details, pages or host cards. */
export function JsonValueView({ value, label = "JSON", display }: JsonCellProps): ReactNode {
  const inspection = useMemo(() => inspectJsonValue(value, display), [value, display]);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  // Reset local search/expansion when an item or its decoding settings change.
  return <div className="qt-json-inline" data-qt-json-inline>
    <JsonValueContent key={`${inspection.raw}\n${JSON.stringify(display)}`} inspection={inspection} label={label} display={display} />
  </div>;
}

interface JsonLine {
  entry: JsonEntry;
  kind: "value" | "close" | "omitted";
  comma?: boolean;
  collapsed?: boolean;
}

/** Keep ancestor braces and balanced closing lines when searching or paging. */
function jsonLines(entries: JsonEntry[], matches: JsonEntry[] | null, collapsed: Set<string>, pageSize: number): { lines: JsonLine[]; remaining: number } {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const included = matches ? new Set<string>() : null;
  for (const match of matches ?? []) {
    let entry: JsonEntry | undefined = match;
    while (entry && !included!.has(entry.path)) {
      included!.add(entry.path);
      entry = entry.parent ? byPath.get(entry.parent) : undefined;
    }
  }
  const children = new Map<string, JsonEntry[]>();
  for (const entry of entries) {
    if (entry.parent === null || (included && !included.has(entry.path))) continue;
    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry);
    children.set(entry.parent, siblings);
  }
  const lines: JsonLine[] = [];
  let remaining = 0;
  let count = 0;
  const visit = (entry: JsonEntry, comma: boolean) => {
    count++;
    const folded = entry.children > 0 && collapsed.has(entry.path);
    lines.push({ entry, kind: "value", comma, collapsed: folded });
    if (!entry.children || folded) return;
    const nested = children.get(entry.path) ?? [];
    let omitted = false;
    for (let index = 0; index < nested.length; index++) {
      if (count >= pageSize) {
        lines.push({ entry, kind: "omitted" });
        omitted = true;
        remaining += nested.length - index;
        break;
      }
      visit(nested[index]!, index < nested.length - 1);
    }
    // Traversal limits must not make a nonempty container look empty.
    if (!omitted && (!nested.length || (!matches && nested.length < entry.children))) lines.push({ entry, kind: "omitted" });
    lines.push({ entry, kind: "close", comma });
  };
  const root = entries[0];
  if (root && (!included || included.has(root.path))) visit(root, false);
  return { lines, remaining };
}

function highlight(text: string, search: string): ReactNode {
  const needle = search.trim().toLowerCase();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let start = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, start)) {
    parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
  }
  parts.push(text.slice(start));
  return parts;
}

function JsonValueContent({ inspection, label, display, onClose }: {
  inspection: JsonInspection; label: string; display?: JsonCellDisplay | undefined; onClose?: () => void;
}): ReactNode {
  const [search, setSearch] = useState("");
  const [raw, setRaw] = useState(Boolean(inspection.error));
  const [copyStatus, setCopyStatus] = useState("");
  const [pageSize, setPageSize] = useState(200);
  const [collapsed, setCollapsed] = useState(() => new Set(inspection.entries
    .filter((entry) => entry.children > 0 && entry.depth >= boundedJsonOption(display?.expandDepth, 1, 0, 8))
    .map((entry) => entry.path)));
  const [searchCollapsed, setSearchCollapsed] = useState(new Set<string>());
  const searching = Boolean(search.trim());
  const matches = useMemo(() => searchJsonEntries(inspection.entries, search), [inspection, search]);
  const matchedPaths = useMemo(() => new Set(matches.map(entry => entry.path)), [matches]);
  const byPath = useMemo(() => new Map(inspection.entries.map(entry => [entry.path, entry])), [inspection]);
  const { lines, remaining } = useMemo(() => jsonLines(inspection.entries, searching ? matches : null, searching ? searchCollapsed : collapsed, pageSize), [inspection, searching, matches, searchCollapsed, collapsed, pageSize]);
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); setCopyStatus(message); }
    catch { setCopyStatus("Copy failed. Select and copy the text manually."); }
  };
  const toggle = (path: string) => (searching ? setSearchCollapsed : setCollapsed)(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  return <section className="qt-json-value-view" aria-label={`${label} JSON value`}>
    <div className="qt-json-toolbar">
      {onClose && <strong className="qt-json-title">{label}</strong>}
      <div className="qt-json-actions">
        <button type="button" className="qt-link-btn qt-json-action" aria-label={raw ? "Show JSON" : "Show original"} title={raw ? "Show pretty-printed JSON" : "Show original source"} aria-pressed={raw} disabled={Boolean(inspection.error)} onClick={() => setRaw(!raw)}><Icon name="panelDefinition" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy original" title="Copy original source" onClick={() => copy(inspection.raw, "Original value copied")}><Icon name="panelReference" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy JSON" title="Copy JSON object or value" disabled={Boolean(inspection.error)} onClick={() => copy(inspection.formatted, "Formatted JSON copied")}><Icon name="copy" size={14} /></button>
      </div>
      <input type="search" className="qt-input qt-json-search" value={search} aria-label={`Search ${label} JSON`} title="Search keys, paths and values" disabled={raw || Boolean(inspection.error)}
        placeholder="Search JSON" onChange={(event) => { setSearch(event.target.value); setSearchCollapsed(new Set()); setCopyStatus(""); setPageSize(200); }} />
      {onClose && <><span className="qt-property-close-divider" aria-hidden="true" /><button type="button" className="qt-link-btn qt-json-action" aria-label={`Close ${label} · JSON`} title="Close" onClick={onClose}><Icon name="close" size={14} /></button></>}
    </div>
    <div className="qt-json-content">
      {inspection.error && <p className="qt-json-notice" role="alert">{inspection.error}</p>}
      {inspection.raw.length > JSON_MAX_CHARACTERS && <p className="qt-json-notice">Original text is truncated in this view. Copy original retains the full source.</p>}
      {inspection.limited && <p className="qt-json-notice">Inspection is limited to 5,000 entries and 64 levels. Search covers the inspected entries only; Copy JSON includes the full value.</p>}
      {raw || inspection.error ? <pre className="qt-json-original">{inspection.raw.slice(0, JSON_MAX_CHARACTERS)}</pre> : <div className="qt-json-code">
        {lines.map(({ entry, kind, comma, collapsed: folded }) => {
          const array = entry.type === "array";
          const opening = array ? "[" : "{";
          const closing = array ? "]" : "}";
          const container = entry.type === "object" || array;
          const parent = entry.parent === null ? null : byPath.get(entry.parent);
          return <div key={`${entry.path}:${kind}`} className={`qt-json-line${kind === "value" ? " qt-json-entry" : ""}${searching && kind === "value" && matchedPaths.has(entry.path) ? " qt-json-match" : ""}`}
            data-json-path={entry.path} title={entry.path} style={{ paddingInlineStart: `${Math.min(entry.depth + (kind === "omitted" ? 1 : 0), 32) * 16}px` }}>
            {kind === "value" && entry.children > 0 ? <button type="button" className="qt-json-toggle" aria-label={`${folded ? "Expand" : "Collapse"} ${entry.path}`} aria-expanded={!folded} onClick={() => toggle(entry.path)}><Icon name={folded ? "chevronRight" : "chevronDown"} size={12} /></button> : <span className="qt-json-toggle-space" />}
            <code className="qt-json-line-code">
              {kind === "close" ? <span className="qt-json-punctuation">{closing}{comma ? "," : ""}</span> : kind === "omitted" ? <span className="qt-muted">…</span> : <>
                {parent?.type === "object" && <><span className="qt-json-key">{highlight(JSON.stringify(entry.key), search)}</span><span className="qt-json-punctuation">: </span></>}
                {container ? <span className="qt-json-punctuation">{opening}{folded ? <span className="qt-muted"> … </span> : null}{!entry.children || folded ? closing : ""}</span>
                  : <span className={`qt-json-value qt-json-value--${entry.type}`}>{highlight(entry.text, search)}</span>}
                {comma && (!entry.children || folded) ? <span className="qt-json-punctuation">,</span> : null}
              </>}
            </code>
            {kind === "value" && <button type="button" className="qt-link-btn qt-json-copy" aria-label={`Copy value at ${entry.path}`} title={`Copy value at ${entry.path}`} onClick={() => copy(JSON.stringify(entry.value, null, 2), `Copied ${entry.path}`)}><Icon name="copy" size={12} /></button>}
          </div>;
        })}
        {lines.length === 0 && <p className="qt-json-notice">No matching keys or values.</p>}
        {remaining > 0 && <button type="button" className="qt-btn qt-json-more" onClick={() => setPageSize(pageSize + 200)}>Show more</button>}
      </div>}
    </div>
    <footer className="qt-json-footer"><span role="status">{copyStatus || (searching && !raw ? `${matches.length} matching paths` : "JSON")}</span><span>Read only</span></footer>
  </section>;
}
