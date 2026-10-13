import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JsonCellDisplay } from "@pythia-software/query-table-core";
import { ModalSurface } from "./AdaptiveOverlay";
import { boundedJsonOption, inspectJsonValue, searchJsonEntries, JSON_MAX_CHARACTERS, JSON_MAX_ENTRIES, type JsonEntry, type JsonInspection } from "./jsonValue";
import { Icon } from "./Icon";
import { jsonBucketId, jsonLines, jsonSearchMatches, JSON_ARRAY_BUCKET_SIZE, type JsonSearchMatch } from "./jsonTree";

export interface JsonCellProps {
  value: unknown;
  label?: string;
  display?: JsonCellDisplay | undefined;
}

/** Compact cell plus a shared searchable inspector. Mountable outside DataTable. */
export function JsonCell({ value, label = "JSON", display }: JsonCellProps): ReactNode {
  const [open, setOpen] = useState(false);
  const inspection = useMemo(() => inspectJsonValue(value, display, false), [value, display]);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  return <div className="qt-json-cell">
    <button type="button" className={`qt-json-preview${inspection.error ? " qt-json-preview--invalid" : ""}`}
      title={inspection.error ?? "Open in JSON Viewer"} aria-label={`Inspect ${label}`} aria-haspopup="dialog"
      onClick={(event) => { event.stopPropagation(); setOpen(true); }} onDoubleClick={(event) => event.stopPropagation()}>
      <span className="qt-json-badge">{inspection.error ? "JSON?" : "JSON"}</span>
    </button>
    <code className="qt-json-preview-text" title={inspection.error ?? inspection.preview}>{inspection.preview}</code>
    {open && <JsonViewerModal value={value} label={label} display={display} onClose={() => setOpen(false)} />}
  </div>;
}

/** Shared modal for a cell's JSON button and its context-menu action. */
export function JsonViewerModal({ value, label = "JSON", display, onClose, returnFocus }: JsonCellProps & {
  onClose: () => void;
  returnFocus?: HTMLElement | null | undefined;
}): ReactNode {
  const inspection = useMemo(() => inspectJsonValue(value, display), [value, display]);
  // Portals still bubble through the cell's React ancestors. Viewer gestures
  // must stay inside the viewer rather than invoking the table's cell actions.
  return <span onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
    <ModalSurface title={`${label} · JSON`} onClose={onClose} returnFocus={returnFocus} chrome={false} className="qt-modal qt-json-inspector">
      <JsonValueContent inspection={inspection} label={label} display={display} onClose={onClose} />
    </ModalSurface>
  </span>;
}

/** The same searchable JSON value embedded in item details, pages or host cards. */
export function JsonValueView({ value, label = "JSON", display, compact = false }: JsonCellProps & { compact?: boolean }): ReactNode {
  const inspection = useMemo(() => inspectJsonValue(value, display), [value, display]);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  // Reset local search/expansion when an item or its decoding settings change.
  return <div className={`qt-json-inline${compact ? " qt-json-inline--compact" : ""}`} data-qt-json-inline>
    <JsonValueContent key={`${inspection.raw}\n${JSON.stringify(display)}\n${compact}`} inspection={inspection} label={label} display={display} compact={compact} />
  </div>;
}

function highlight(text: string, search: string, entry: JsonEntry, part: "key" | "value", active: JsonSearchMatch | undefined): ReactNode {
  const needle = search.trim().toLowerCase();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let start = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, start)) {
    parts.push(text.slice(start, index), <mark key={index} className={active?.path === entry.path && active.part === part && active.start === index ? "qt-json-current-mark" : undefined}>{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
  }
  parts.push(text.slice(start));
  return parts;
}

function JsonValueContent({ inspection, label, display, onClose, compact = false }: {
  inspection: JsonInspection; label: string; display?: JsonCellDisplay | undefined; onClose?: () => void; compact?: boolean;
}): ReactNode {
  const [search, setSearch] = useState("");
  const [raw, setRaw] = useState(Boolean(inspection.error));
  const [copyStatus, setCopyStatus] = useState("");
  const [pageSize, setPageSize] = useState(200);
  const [collapsed, setCollapsed] = useState(() => new Set(inspection.entries
    .filter((entry) => entry.children > 0 && (compact || (entry.depth > 0 && (display?.expandDepth === undefined
      ? entry.children >= 4
      : entry.depth >= boundedJsonOption(display.expandDepth, 1, 0, 8)))))
    .map((entry) => entry.path)));
  const [expandedBuckets, setExpandedBuckets] = useState(new Set<string>());
  const [searchMode, setSearchMode] = useState<"filter" | "highlight">("filter");
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchOverrides, setSearchOverrides] = useState(new Map<string, boolean>());
  const contentRef = useRef<HTMLDivElement>(null);
  const searching = Boolean(search.trim());
  const matches = useMemo(() => searchJsonEntries(inspection.entries, search), [inspection, search]);
  const occurrences = useMemo(() => jsonSearchMatches(inspection.entries, search), [inspection, search]);
  const activeMatch = occurrences[matchIndex];
  const matchedPaths = useMemo(() => new Set(matches.map(entry => entry.path)), [matches]);
  const byPath = useMemo(() => new Map(inspection.entries.map(entry => [entry.path, entry])), [inspection]);
  const presentation = useMemo(() => {
    if (!searching) return { collapsed, expandedBuckets };
    const folded = new Set(searchMode === "filter" ? [] : collapsed);
    const buckets = new Set(searchMode === "filter" ? [] : expandedBuckets);
    // Highlight mode opens only the selected match's ancestors and array ranges.
    let entry = activeMatch ? byPath.get(activeMatch.path) : undefined;
    while (entry) {
      folded.delete(entry.path);
      const parent = entry.parent ? byPath.get(entry.parent) : undefined;
      if (parent?.type === "array" && Number(entry.key) >= JSON_ARRAY_BUCKET_SIZE) buckets.add(jsonBucketId(parent.path, Number(entry.key)));
      entry = parent;
    }
    for (const [path, expanded] of searchOverrides) {
      if (byPath.has(path)) { if (expanded) folded.delete(path); else folded.add(path); }
      else { if (expanded) buckets.add(path); else buckets.delete(path); }
    }
    return { collapsed: folded, expandedBuckets: buckets };
  }, [searching, searchMode, collapsed, expandedBuckets, activeMatch, byPath, searchOverrides]);
  const { lines, remaining } = useMemo(() => jsonLines(inspection.entries, searching && searchMode === "filter" ? matches : null,
    presentation.collapsed, presentation.expandedBuckets, searching ? JSON_MAX_ENTRIES * 2 : pageSize), [inspection, searching, searchMode, matches, presentation, pageSize]);
  useEffect(() => {
    if (!searching || raw) return;
    const content = contentRef.current;
    const selected = content?.querySelector<HTMLElement>(".qt-json-current-mark") ?? content?.querySelector<HTMLElement>(".qt-json-match--active");
    if (!content || !selected) return;
    const bounds = content.getBoundingClientRect();
    const target = selected.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) content.scrollTop += target.top - bounds.top - (bounds.height - target.height) / 2;
  }, [searching, raw, activeMatch, lines]);
  const navigate = (direction: number) => {
    if (!occurrences.length) return;
    setMatchIndex((current) => (current + direction + occurrences.length) % occurrences.length);
    setSearchOverrides(new Map());
  };
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); setCopyStatus(message); }
    catch { setCopyStatus("Copy failed. Select and copy the text manually."); }
  };
  const toggle = (path: string, bucket = false) => {
    const expanded = bucket ? presentation.expandedBuckets.has(path) : !presentation.collapsed.has(path);
    if (searching) setSearchOverrides(current => new Map(current).set(path, !expanded));
    else (bucket ? setExpandedBuckets : setCollapsed)(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  return <section className="qt-json-value-view" aria-label={`${label} JSON value`}>
    {!compact && <div className="qt-json-toolbar">
      {onClose && <strong className="qt-json-title">{label}</strong>}
      <div className="qt-json-actions">
        <button type="button" className="qt-link-btn qt-json-action" aria-label={raw ? "Show JSON" : "Show original"} title={raw ? "Show pretty-printed JSON" : "Show original source"} aria-pressed={raw} disabled={Boolean(inspection.error)} onClick={() => setRaw(!raw)}><Icon name="panelDefinition" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy original" title="Copy original source" onClick={() => copy(inspection.raw, "Original value copied")}><Icon name="panelReference" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy JSON" title="Copy JSON object or value" disabled={Boolean(inspection.error)} onClick={() => copy(inspection.formatted, "Formatted JSON copied")}><Icon name="copy" size={14} /></button>
      </div>
      <div className="qt-json-search-controls">
        <select className="qt-json-search-mode" aria-label="JSON search mode" title="Filter matches or highlight in context" value={searchMode} disabled={raw || Boolean(inspection.error)}
          onChange={(event) => { setSearchMode(event.target.value as "filter" | "highlight"); setSearchOverrides(new Map()); }}>
          <option value="filter">Filter</option><option value="highlight">Highlight</option>
        </select>
        <input type="search" className="qt-input qt-json-search" value={search} aria-label={`Search ${label} JSON`} title="Search keys, paths and values" disabled={raw || Boolean(inspection.error)}
          placeholder="Search JSON" onChange={(event) => { setSearch(event.target.value); setMatchIndex(0); setSearchOverrides(new Map()); setCopyStatus(""); setPageSize(200); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); } }} />
        {searching && <span className="qt-json-search-count" aria-live="polite">{occurrences.length ? matchIndex + 1 : 0}/{occurrences.length}</span>}
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Previous JSON match" title="Previous match (Shift+Enter)" disabled={raw || !occurrences.length} onClick={() => navigate(-1)}><Icon name="arrowUp" size={12} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Next JSON match" title="Next match (Enter)" disabled={raw || !occurrences.length} onClick={() => navigate(1)}><Icon name="arrowDown" size={12} /></button>
      </div>
      {onClose && <><span className="qt-property-close-divider" aria-hidden="true" /><button type="button" className="qt-link-btn qt-json-action" aria-label={`Close ${label} · JSON`} title="Close" onClick={onClose}><Icon name="close" size={14} /></button></>}
    </div>}
    <div className="qt-json-content" ref={contentRef}>
      {inspection.error && <p className="qt-json-notice" role="alert">{inspection.error}</p>}
      {inspection.raw.length > JSON_MAX_CHARACTERS && <p className="qt-json-notice">Original text is truncated in this view. Copy original retains the full source.</p>}
      {inspection.limited && <p className="qt-json-notice">Inspection is limited to 5,000 entries and 64 levels. Search covers the inspected entries only; Copy JSON includes the full value.</p>}
      {raw || inspection.error ? compact ? <code className="qt-json-preview-text">{inspection.preview}</code> : <pre className="qt-json-original">{inspection.raw.slice(0, JSON_MAX_CHARACTERS)}</pre> : <div className="qt-json-code">
        {lines.map(({ entry, kind, comma, collapsed: folded, bucket }) => {
          if (bucket) return <div key={bucket.id} className="qt-json-line qt-json-bucket" style={{ paddingInlineStart: `${Math.min(entry.depth + 1, 32) * 16}px` }}>
            <button type="button" className="qt-json-bucket-toggle" aria-label={`${folded ? "Expand" : "Collapse"} ${entry.path} items ${bucket.start}–${bucket.end}`} aria-expanded={!folded} onClick={() => toggle(bucket.id, true)}>
              <Icon name={folded ? "chevronRight" : "chevronDown"} size={12} /><code>[{bucket.start} … {bucket.end}]</code><span className="qt-muted">{bucket.end - bucket.start + 1} items</span>
            </button>
          </div>;
          const array = entry.type === "array";
          const opening = array ? "[" : "{";
          const closing = array ? "]" : "}";
          const container = entry.type === "object" || array;
          const parent = entry.parent === null ? null : byPath.get(entry.parent);
          return <div key={`${entry.path}:${kind}`} className={`qt-json-line${kind === "value" ? " qt-json-entry" : ""}${searching && kind === "value" && matchedPaths.has(entry.path) ? " qt-json-match" : ""}${searching && kind === "value" && activeMatch?.path === entry.path ? " qt-json-match--active" : ""}`}
            data-json-path={entry.path} title={entry.path} style={{ paddingInlineStart: `${Math.min(entry.depth + (kind === "omitted" ? 1 : 0), 32) * 16}px` }}>
            {kind === "value" && entry.children > 0 ? <button type="button" className="qt-json-toggle" aria-label={`${folded ? "Expand" : "Collapse"} ${entry.path}`} aria-expanded={!folded} onClick={() => toggle(entry.path)}><Icon name={folded ? "chevronRight" : "chevronDown"} size={12} /></button> : <span className="qt-json-toggle-space" />}
            <code className="qt-json-line-code">
              {kind === "close" ? <span className="qt-json-punctuation">{closing}{comma ? "," : ""}</span> : kind === "omitted" ? <span className="qt-muted">…</span> : <>
                {parent?.type === "object" && <><span className="qt-json-key">{highlight(JSON.stringify(entry.key), search, entry, "key", activeMatch)}</span><span className="qt-json-punctuation">: </span></>}
                {container ? <span className="qt-json-punctuation">{opening}{folded ? <span className="qt-muted"> … </span> : null}{!entry.children || folded ? closing : ""}</span>
                  : <span className={`qt-json-value qt-json-value--${entry.type}`}>{highlight(entry.text, search, entry, "value", activeMatch)}</span>}
                {comma && (!entry.children || folded) ? <span className="qt-json-punctuation">,</span> : null}
                {folded && <span className="qt-json-hidden-count"> {entry.children} {array ? `value${entry.children === 1 ? "" : "s"}` : `key${entry.children === 1 ? "" : "s"}`} hidden</span>}
              </>}
            </code>
            {!compact && kind === "value" && <button type="button" className="qt-link-btn qt-json-copy" aria-label={`Copy value at ${entry.path}`} title={`Copy value at ${entry.path}`} onClick={() => copy(JSON.stringify(entry.value, null, 2), `Copied ${entry.path}`)}><Icon name="copy" size={12} /></button>}
          </div>;
        })}
        {lines.length === 0 && <p className="qt-json-notice">No matching keys or values.</p>}
        {remaining > 0 && <button type="button" className="qt-btn qt-json-more" onClick={() => setPageSize(pageSize + 200)}>Show more</button>}
      </div>}
    </div>
    {!compact && <footer className="qt-json-footer"><span role="status">{copyStatus || (searching && !raw ? `${matches.length} matching paths` : "JSON")}</span><span>Read only</span></footer>}
  </section>;
}
