import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { jsonInspectionScopeKey, type JsonCellDisplay, type JsonInspectionState, type JsonInspectionScope, type AttentionRegistry, type AttentionProvider } from "@pythia-software/query-table-core";
import { ModalSurface } from "./AdaptiveOverlay";
import { boundedJsonOption, inspectJsonValue, searchJsonEntries, JSON_MAX_CHARACTERS, JSON_MAX_ENTRIES, type JsonEntry, type JsonInspection } from "./jsonValue";
import { Icon } from "./Icon";
import { jsonBucketId, jsonLines, jsonSearchMatches, JSON_ARRAY_BUCKET_SIZE, type JsonSearchMatch } from "./jsonTree";

export interface JsonInspectionResolution {
  status: "ready" | "unavailable";
  missingPaths: string[];
  selectedMatchUnavailable: boolean;
}
export interface JsonCellProps {
  value: unknown;
  label?: string;
  display?: JsonCellDisplay | undefined;
  /** Controlled portable state. Omit to keep local state. */
  inspectionState?: JsonInspectionState | undefined;
  onInspectionStateChange?: ((state: JsonInspectionState) => void) | undefined;
  inspectionScope?: JsonInspectionScope | undefined;
  attention?: AttentionRegistry | undefined;
  onInspectionResolution?: ((result: JsonInspectionResolution) => void) | undefined;
}

/** Compact cell plus a shared searchable inspector. Mountable outside DataTable. */
export function JsonCell(props: JsonCellProps): ReactNode {
  const { value, label = "JSON", display } = props;
  const inspection = useMemo(() => inspectJsonValue(value, display, false), [value, display]);
  const [state, change] = useInspectionState(props, inspection);
  const preserveFocus = useRef(false);
  const latest = useRef({ state, change, controlled: props.inspectionState !== undefined });
  latest.current = { state, change, controlled: props.inspectionState !== undefined };
  const initialized = useRef<string | null>(null);
  const sessionKey = props.inspectionScope ? jsonInspectionScopeKey(props.inspectionScope) : inspection.raw + JSON.stringify(display);
  const openInspector = (preserve: boolean, full = inspectJsonValue(value, display)) => {
    const current = latest.current;
    const next = current.controlled || initialized.current === sessionKey ? current.state : createJsonInspectionState(full, display);
    initialized.current = sessionKey;
    preserveFocus.current = preserve;
    current.change({ ...next, open: true });
  };
  const scopeKey = props.inspectionScope ? jsonInspectionScopeKey(props.inspectionScope) : "";
  useEffect(() => {
    if (!props.attention || !props.inspectionScope || state.open || value == null || value === "") return;
    const registry = props.attention;
    const target = props.inspectionScope;
    const provider: AttentionProvider = { reveal: async (destination, signal) => {
      if (signal.aborted) return false;
      const full = inspectJsonValue(value, display);
      if (destination.path && !full.entries.some(entry => entry.path === destination.path)) return false;
      openInspector(true, full);
      const mounted = await registry.whenRegistered(target, signal, provider);
      return signal.aborted ? false : mounted.reveal(destination, signal);
    } };
    return registry.register(target, provider);
  }, [props.attention, scopeKey, state.open, inspection]);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  return <div className="qt-json-cell">
    <button type="button" className={`qt-json-preview${inspection.error ? " qt-json-preview--invalid" : ""}`}
      title={inspection.error ?? "Open in JSON Viewer"} aria-label={`Inspect ${label}`} aria-haspopup="dialog" aria-expanded={state.open}
      onClick={(event) => { event.stopPropagation(); openInspector(false); }} onDoubleClick={(event) => event.stopPropagation()}>
      <span className="qt-json-badge">{inspection.error ? "JSON?" : "JSON"}</span>
    </button>
    <code className="qt-json-preview-text" title={inspection.error ?? inspection.preview}>{inspection.preview}</code>
    {state.open && <JsonViewerModal {...props} preserveFocus={preserveFocus.current} inspectionState={state} onInspectionStateChange={change} onClose={() => change({ ...state, open: false })} />}
  </div>;
}

/** Shared modal; controlled state also survives closing and reopening it. */
export function JsonViewerModal({ onClose, returnFocus, preserveFocus, ...props }: JsonCellProps & {
  onClose: () => void;
  returnFocus?: HTMLElement | null | undefined;
  preserveFocus?: boolean | undefined;
}): ReactNode {
  const { value, label = "JSON", display } = props;
  const inspection = useMemo(() => inspectJsonValue(value, display), [value, display]);
  const [state, change] = useInspectionState(props, inspection);
  return <span onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
    <ModalSurface title={`${label} · JSON`} onClose={onClose} returnFocus={returnFocus} preserveFocus={preserveFocus} chrome={false} className="qt-modal qt-json-inspector">
      <JsonValueContent {...props} inspection={inspection} state={state} change={change} label={label} onClose={onClose} />
    </ModalSurface>
  </span>;
}

export function createJsonInspectionState(inspection: JsonInspection, display?: JsonCellDisplay, compact = false): JsonInspectionState {
  return { version: 1, open: false, search: "", raw: Boolean(inspection.error), visibleEntryLimit: 200,
    collapsedPaths: inspection.entries.filter(entry => entry.children > 0 && (compact || (entry.depth > 0 && (display?.expandDepth === undefined
      ? entry.children >= 4 : entry.depth >= boundedJsonOption(display.expandDepth, 1, 0, 8))))).map(entry => entry.path),
    expandedBuckets: [], searchMode: "filter", searchOverrides: [] };
}
function useInspectionState(props: JsonCellProps, inspection: JsonInspection, compact = false): [JsonInspectionState, (state: JsonInspectionState) => void] {
  // Semantic scope, not object reference/raw bytes, owns an inspection session.
  const key = props.inspectionScope ? jsonInspectionScopeKey(props.inspectionScope) : inspection.raw + JSON.stringify(props.display);
  const [local, setLocal] = useState(() => ({ key, state: createJsonInspectionState(inspection, props.display, compact) }));
  const state = props.inspectionState ?? (local.key === key ? local.state : createJsonInspectionState(inspection, props.display, compact));
  const change = (next: JsonInspectionState) => {
    if (props.inspectionState === undefined) setLocal({ key, state: next });
    props.onInspectionStateChange?.(next);
  };
  return [state, change];
}

/** The same searchable JSON value embedded in item details, pages or host cards. */
export function JsonValueView(props: JsonCellProps & { compact?: boolean }): ReactNode {
  const { value, label = "JSON", display, compact = false } = props;
  const inspection = useMemo(() => inspectJsonValue(value, display), [value, display]);
  const [state, change] = useInspectionState(props, inspection, compact);
  if (value == null || value === "") return <span className="qt-muted">—</span>;
  return <div className={`qt-json-inline${compact ? " qt-json-inline--compact" : ""}`} data-qt-json-inline>
    <JsonValueContent {...props} inspection={inspection} state={state} change={change} label={label} compact={compact} />
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

function JsonValueContent({ inspection, label, onClose, compact = false, state, change, inspectionScope, attention, onInspectionResolution }: {
  inspection: JsonInspection; label: string; onClose?: () => void; compact?: boolean;
  state: JsonInspectionState; change: (state: JsonInspectionState) => void;
  inspectionScope?: JsonInspectionScope | undefined; attention?: AttentionRegistry | undefined;
  onInspectionResolution?: ((result: JsonInspectionResolution) => void) | undefined;
}): ReactNode {
  const { search, raw, searchMode, visibleEntryLimit: pageSize } = state;
  const collapsed = useMemo(() => new Set(state.collapsedPaths), [state.collapsedPaths]);
  const expandedBuckets = useMemo(() => new Set(state.expandedBuckets), [state.expandedBuckets]);
  const searchOverrides = useMemo(() => new Map(state.searchOverrides.map(entry => [entry.path, entry.expanded])), [state.searchOverrides]);
  const [copyStatus, setCopyStatus] = useState("");
  const [navigationRequest, setNavigationRequest] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const searching = Boolean(search.trim());
  const matches = useMemo(() => searchJsonEntries(inspection.entries, search), [inspection, search]);
  const occurrences = useMemo(() => jsonSearchMatches(inspection.entries, search), [inspection, search]);
  const selectedIndex = state.selectedMatch ? occurrences.findIndex(match => match.path === state.selectedMatch!.path && match.part === state.selectedMatch!.part && match.start === state.selectedMatch!.start) : 0;
  const matchIndex = Math.max(0, selectedIndex);
  const activeMatch = selectedIndex < 0 ? undefined : occurrences[matchIndex];
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
  const missingPaths = [...state.collapsedPaths, ...state.expandedBuckets, ...state.searchOverrides.map(entry => entry.path)].filter(path => {
    if (byPath.has(path)) return false;
    const split = path.lastIndexOf(":bucket:");
    const parent = byPath.get(path.slice(0, split));
    return !(split > 0 && parent?.type === "array" && parent.children > Number(path.slice(split + 8)));
  });
  const resolutionKey = JSON.stringify([missingPaths, selectedIndex < 0]);
  const resolutionCallback = useRef(onInspectionResolution); resolutionCallback.current = onInspectionResolution;
  useEffect(() => { resolutionCallback.current?.({ status: missingPaths.length || selectedIndex < 0 ? "unavailable" : "ready", missingPaths, selectedMatchUnavailable: selectedIndex < 0 }); }, [resolutionKey]);
  const [attentionPath, setAttentionPath] = useState<string | null>(null);
  const pendingReveal = useRef<{ path: string; signal: AbortSignal; finish: (found: boolean) => void } | null>(null);
  const latest = useRef({ state, change, byPath }); latest.current = { state, change, byPath };
  const scopeKey = inspectionScope ? jsonInspectionScopeKey(inspectionScope) : "";
  useEffect(() => {
    if (!attention || !inspectionScope) return;
    return attention.register(inspectionScope, { reveal: (target, signal) => {
      const path = target.path ?? "$";
      const current = latest.current;
      let entry = current.byPath.get(path);
      if (!entry || signal.aborted) return false;
      const folded = new Set(current.state.collapsedPaths), buckets = new Set(current.state.expandedBuckets);
      while (entry) {
        folded.delete(entry.path);
        const parent: JsonEntry | undefined = entry.parent ? current.byPath.get(entry.parent) : undefined;
        if (parent?.type === "array" && Number(entry.key) >= JSON_ARRAY_BUCKET_SIZE) buckets.add(jsonBucketId(parent.path, Number(entry.key)));
        entry = parent;
      }
      return new Promise<boolean>(resolve => {
        const abort = () => { if (pendingReveal.current?.signal === signal) pendingReveal.current = null; resolve(false); };
        const finish = (found: boolean) => { signal.removeEventListener("abort", abort); resolve(found); };
        signal.addEventListener("abort", abort, { once: true });
        pendingReveal.current?.finish(false);
        pendingReveal.current = { path, signal, finish };
        const { selectedMatch: _match, ...next } = current.state;
        current.change({ ...next, raw: false, search: "", searchOverrides: [], collapsedPaths: [...folded], expandedBuckets: [...buckets], visibleEntryLimit: 10000 });
        setAttentionPath(path);
        setNavigationRequest(request => request + 1);
      });
    } });
  }, [attention, scopeKey]);
  useLayoutEffect(() => {
    const request = pendingReveal.current;
    if (!request || request.signal.aborted) return;
    const element = [...(contentRef.current?.querySelectorAll<HTMLElement>(".qt-json-entry") ?? [])].find(node => node.dataset.jsonPath === request.path);
    if (!element) return; // Wait for the controlled state's commit.
    pendingReveal.current = null;
    element.scrollIntoView?.({ block: "nearest", behavior: "instant" as ScrollBehavior });
    request.finish(true);
  });
  useEffect(() => () => { pendingReveal.current?.finish(false); pendingReveal.current = null; }, []);
  useEffect(() => {
    if (!searching || raw) return;
    const content = contentRef.current;
    const selected = content?.querySelector<HTMLElement>(".qt-json-current-mark") ?? content?.querySelector<HTMLElement>(".qt-json-match--active");
    if (!content || !selected) return;
    const bounds = content.getBoundingClientRect();
    const target = selected.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) content.scrollTop += target.top - bounds.top - (bounds.height - target.height) / 2;
    // Expansion changes the rendered lines but should preserve manual scrolling.
  }, [searching, raw, activeMatch?.path, activeMatch?.part, activeMatch?.start, searchMode, navigationRequest]);
  const navigate = (direction: number) => {
    if (!occurrences.length) return;
    change({ ...state, selectedMatch: occurrences[selectedIndex < 0 ? (direction > 0 ? 0 : occurrences.length - 1) : (matchIndex + direction + occurrences.length) % occurrences.length]!, searchOverrides: [] });
    setNavigationRequest(current => current + 1);
  };
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); setCopyStatus(message); }
    catch { setCopyStatus("Copy failed. Select and copy the text manually."); }
  };
  const toggle = (path: string, bucket = false) => {
    const expanded = bucket ? presentation.expandedBuckets.has(path) : !presentation.collapsed.has(path);
    if (searching) change({ ...state, searchOverrides: [...searchOverrides].filter(([key]) => key !== path).map(([path, expanded]) => ({ path, expanded })).concat({ path, expanded: !expanded }) });
    else {
      const next = new Set(bucket ? expandedBuckets : collapsed);
      if (next.has(path)) next.delete(path); else next.add(path);
      change({ ...state, ...(bucket ? { expandedBuckets: [...next] } : { collapsedPaths: [...next] }) });
    }
  };

  return <section className="qt-json-value-view" aria-label={`${label} JSON value`}>
    {!compact && <div className="qt-json-toolbar">
      {onClose && <strong className="qt-json-title">{label}</strong>}
      <div className="qt-json-actions">
        <button type="button" className="qt-link-btn qt-json-action" aria-label={raw ? "Show JSON" : "Show original"} title={raw ? "Show pretty-printed JSON" : "Show original source"} aria-pressed={raw} disabled={Boolean(inspection.error)} onClick={() => change({ ...state, raw: !raw })}><Icon name="panelDefinition" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy original" title="Copy original source" onClick={() => copy(inspection.raw, "Original value copied")}><Icon name="panelReference" size={14} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Copy JSON" title="Copy JSON object or value" disabled={Boolean(inspection.error)} onClick={() => copy(inspection.formatted, "Formatted JSON copied")}><Icon name="copy" size={14} /></button>
      </div>
      <div className="qt-json-search-controls">
        <select className="qt-json-search-mode" aria-label="JSON search mode" title="Filter matches or highlight in context" value={searchMode} disabled={raw || Boolean(inspection.error)}
          onChange={(event) => { change({ ...state, searchMode: event.target.value as "filter" | "find", searchOverrides: [] }); }}>
          <option value="filter">Filter</option><option value="find">Find</option>
        </select>
        <input type="search" className="qt-input qt-json-search" value={search} aria-label={`Search ${label} JSON`} title="Search keys, paths and values" disabled={raw || Boolean(inspection.error)}
          placeholder="Search JSON" maxLength={10000} onChange={(event) => { const { selectedMatch: _selected, ...next } = state; change({ ...next, search: event.target.value, searchOverrides: [], visibleEntryLimit: 200 }); setCopyStatus(""); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); } }} />
        {searching && <span className="qt-json-search-count" aria-live="polite">{activeMatch ? matchIndex + 1 : 0}/{occurrences.length}</span>}
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Previous JSON match" title="Previous match (Shift+Enter)" disabled={raw || !occurrences.length} onClick={() => navigate(-1)}><Icon name="arrowUp" size={12} /></button>
        <button type="button" className="qt-link-btn qt-json-action" aria-label="Next JSON match" title="Next match (Enter)" disabled={raw || !occurrences.length} onClick={() => navigate(1)}><Icon name="arrowDown" size={12} /></button>
      </div>
      {onClose && <><span className="qt-property-close-divider" aria-hidden="true" /><button type="button" className="qt-link-btn qt-json-action" aria-label={`Close ${label} · JSON`} title="Close" onClick={onClose}><Icon name="close" size={14} /></button></>}
    </div>}
    <div className="qt-json-content" ref={contentRef}>
      {state.selectedMatch && !activeMatch && <p className="qt-json-notice" role="status">Selected JSON match is unavailable.</p>}
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
          return <div key={`${entry.path}:${kind}`} className={`qt-json-line${kind === "value" && attentionPath === entry.path ? " qt-attention-target" : ""}${kind === "value" ? " qt-json-entry" : ""}${searching && kind === "value" && matchedPaths.has(entry.path) ? " qt-json-match" : ""}${searching && kind === "value" && activeMatch?.path === entry.path ? " qt-json-match--active" : ""}`}
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
        {remaining > 0 && <button type="button" className="qt-btn qt-json-more" onClick={() => change({ ...state, visibleEntryLimit: Math.min(10000, pageSize + 200) })}>Show more</button>}
      </div>}
    </div>
    {!compact && <footer className="qt-json-footer"><span role="status">{copyStatus || (searching && !raw ? `${matches.length} matching paths` : "JSON")}</span><span>Read only</span></footer>}
  </section>;
}
