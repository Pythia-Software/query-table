import { useMemo, useState, type ReactNode } from "react";
import type { JsonCellDisplay } from "@pythia-software/query-table-core";
import { ModalSurface } from "./AdaptiveOverlay";
import { boundedJsonOption, inspectJsonValue, searchJsonEntries, JSON_MAX_CHARACTERS, type JsonInspection } from "./jsonValue";
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
    {open && <ModalSurface title={`${label} · JSON`} onClose={() => setOpen(false)} className="qt-modal qt-json-inspector">
      <JsonValueContent inspection={inspection} label={label} display={display} />
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

function JsonValueContent({ inspection, label, display }: {
  inspection: JsonInspection; label: string; display?: JsonCellDisplay | undefined;
}): ReactNode {
  const [search, setSearch] = useState("");
  const [raw, setRaw] = useState(Boolean(inspection.error));
  const [copyStatus, setCopyStatus] = useState("");
  const [pageSize, setPageSize] = useState(200);
  const [collapsed, setCollapsed] = useState(() => new Set(inspection.entries
    .filter((entry) => entry.children > 0 && entry.depth >= boundedJsonOption(display?.expandDepth, 1, 0, 8))
    .map((entry) => entry.path)));
  const searching = Boolean(search.trim());
  const matches = useMemo(() => searchJsonEntries(inspection.entries, search), [inspection, search]);
  const byPath = useMemo(() => new Map(inspection.entries.map((entry) => [entry.path, entry])), [inspection]);
  const visible = searching ? matches : inspection.entries.filter((entry) => {
    let parent = entry.parent;
    while (parent !== null) {
      if (collapsed.has(parent)) return false;
      parent = byPath.get(parent)?.parent ?? null;
    }
    return true;
  });
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); setCopyStatus(message); }
    catch { setCopyStatus("Copy failed. Select and copy the text manually."); }
  };
  return <section className="qt-json-value-view" aria-label={`${label} JSON value`}>
    <div className="qt-json-toolbar">
      <label className="qt-json-search">Search keys, paths and values
        <input type="search" className="qt-input" value={search} aria-label={`Search ${label} JSON`} disabled={raw || Boolean(inspection.error)}
          placeholder="e.g. customer, status, 42" onChange={(event) => { setSearch(event.target.value); setCopyStatus(""); setPageSize(200); }} />
      </label>
      <div className="qt-json-actions">
        <button type="button" className="qt-btn" aria-pressed={raw} disabled={Boolean(inspection.error)} onClick={() => setRaw(!raw)}>{raw ? "Tree" : "Original"}</button>
        <button type="button" className="qt-btn" onClick={() => copy(inspection.raw, "Original value copied")}><Icon name="copy" />Copy original</button>
        <button type="button" className="qt-btn" disabled={Boolean(inspection.error)} onClick={() => copy(inspection.formatted, "Formatted JSON copied")}>Copy JSON</button>
      </div>
      <span role="status" className="qt-muted">{copyStatus || (searching && !raw ? `${matches.length} matching paths` : "Expand a key to explore its values")}</span>
    </div>
    {inspection.error && <p className="qt-json-notice" role="alert">{inspection.error}</p>}
    {inspection.raw.length > JSON_MAX_CHARACTERS && <p className="qt-json-notice">Original text is truncated in this view. Copy original retains the full source.</p>}
    {inspection.limited && <p className="qt-json-notice">Inspection is limited to 5,000 entries and 64 levels. Search covers the inspected entries only; Copy JSON includes the full value.</p>}
    <div className="qt-json-content">
      {raw || inspection.error ? <pre className="qt-json-original">{inspection.raw.slice(0, JSON_MAX_CHARACTERS)}</pre> : <>
        {visible.slice(0, pageSize).map((entry) => <div key={entry.path} className="qt-json-entry" style={{ paddingLeft: searching ? undefined : `${Math.min(entry.depth, 12) * 16 + 8}px` }}>
          {entry.children > 0 && !searching ? <button type="button" className="qt-json-toggle" aria-label={`${collapsed.has(entry.path) ? "Expand" : "Collapse"} ${entry.path}`} aria-expanded={!collapsed.has(entry.path)} onClick={() => setCollapsed((current) => {
            const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next;
          })}><Icon name={collapsed.has(entry.path) ? "chevronRight" : "chevronDown"} /></button> : <span className="qt-json-toggle" />}
          <div className="qt-json-entry-data"><code className="qt-json-key">{searching ? entry.path : entry.key}</code>
            <code className={`qt-json-value qt-json-value--${entry.type}`}>{entry.text}</code>
            <small className="qt-muted">{entry.type}{!searching && entry.depth > 0 ? ` · ${entry.path}` : ""}</small>
          </div>
          <button type="button" className="qt-btn qt-json-copy" aria-label={`Copy value at ${entry.path}`} title="Copy this JSON value" onClick={() => copy(JSON.stringify(entry.value, null, 2), `Copied ${entry.path}`)}><Icon name="copy" /></button>
        </div>)}
        {visible.length === 0 && <p className="qt-json-notice">No matching keys or values.</p>}
        {visible.length > pageSize && <button type="button" className="qt-btn qt-json-more" onClick={() => setPageSize(pageSize + 200)}>Show more ({visible.length - pageSize} remaining)</button>}
      </>}
    </div>
  </section>;
}
