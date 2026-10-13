import { useEffect, useId, useRef, useState } from "react";
import { queriesEqual, type QueryState } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { Icon, MenuButton, MenuItem, ModalSurface } from "@pythia-software/query-table-ui";
import "./savedQueriesPrototype.css";

const SELECTION_KEY = "query-table:saved-queries-prototype:selection";
function initialSelection(): string | null | undefined {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" || value === null ? value : undefined;
  } catch { return undefined; }
}

/** Exploration UI over the real controller; stable selection survives edits. */
export function SavedQueryControlsPrototype<Row>({ api }: { api: QueryTableApi<Row> }) {
  const [selectedId, setSelectedId] = useState(initialSelection);
  const [dialog, setDialog] = useState<"save" | "switch" | null>(null);
  const [pendingId, setPendingId] = useState<string | null | undefined>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSavedConfirmation, setShowSavedConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const currentQuery = useRef(api.query);
  currentQuery.current = api.query;
  const picker = useRef<HTMLSelectElement>(null);
  const selectId = useId();
  const nameId = useId();
  const selected = api.saved.items.find(item => item.id === selectedId);
  const dirty = selected ? !queriesEqual(selected.query, api.query) : !queriesEqual(api.defaults, api.query);
  const ready = !api.saved.loading && selectedId !== undefined;
  const saved = !!selected && !dirty;
  const status = busy ? "saving" : !ready ? "loading" : saved ? "saved" : "unsaved";
  const showActions = status === "unsaved";

  useEffect(() => {
    setShowSavedConfirmation(status === "saved");
    if (status !== "saved") return;
    const timeout = window.setTimeout(() => setShowSavedConfirmation(false), 3000);
    return () => window.clearTimeout(timeout);
  }, [status, selectedId]);

  useEffect(() => {
    if (api.saved.loading || api.loading) return;
    if (selectedId === undefined) {
      setSelectedId(api.saved.items.find(item => queriesEqual(item.query, api.query))?.id ?? null);
    } else if (selectedId && !selected) setSelectedId(null);
  }, [api.saved.loading, api.loading, api.saved.items, api.query, selectedId, selected]);

  useEffect(() => {
    if (selectedId === undefined) return;
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(selectedId)); } catch { /* Optional context memory. */ }
  }, [selectedId]);

  function closeDialog() {
    if (saving.current) return;
    setDialog(null); setPendingId(undefined); setError(null);
  }
  function load(id: string | null) {
    if (id) api.saved.load(id); else api.resetAll();
    setSelectedId(id); setDialog(null); setPendingId(undefined); setError(null);
  }
  function requestLoad(id: string | null) {
    if (id === selectedId && id !== null) return;
    if (dirty) { setPendingId(id); setDialog("switch"); setError(null); }
    else load(id);
  }
  function beginSave() {
    setName(""); setError(null); setDialog("save");
  }
  async function save(create: boolean) {
    if (saving.current) return;
    const trimmed = name.trim();
    if (create && !trimmed) { setError("Enter a name for this query."); return; }
    if (create && api.saved.items.some(item => item.name.toLowerCase() === trimmed.toLowerCase())) {
      setError("A query with that name already exists. Choose another name."); return;
    }
    const snapshot: QueryState = api.query;
    saving.current = true; setBusy(true); setError(null);
    try {
      const result = create ? await api.saved.save(trimmed) : await api.saved.update(selected!.id);
      setSelectedId(result.id);
      // Filters and columns remain editable while saving; retain any later edits.
      if (pendingId !== undefined && queriesEqual(currentQuery.current, snapshot)) load(pendingId);
      else { setDialog(null); setPendingId(undefined); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn’t save. Your edits are still here.");
    } finally { saving.current = false; setBusy(false); }
  }

  return <span className="qt-save-prototype">
    <span className="qt-save-prototype-controls" role="group" aria-label="Saved query controls">
      <label className="qt-qb-kw" htmlFor={selectId}>Query</label>
      <span className="qt-save-prototype-picker">
        <select id={selectId} ref={picker} aria-label="Query" value={selected?.id ?? "__unsaved__"}
          disabled={!ready || busy} onChange={event => requestLoad(event.target.value === "__new__" ? null : event.target.value)}>
          {!selected && <option value="__unsaved__" disabled>{ready ? "Unsaved query" : "Loading queries…"}</option>}
          <optgroup label="Saved queries">
            {api.saved.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </optgroup>
          <option value="__new__">New query…</option>
        </select>
        <Icon name="chevronDown" size={12} />
      </span>
      {showActions && <span className="qt-save-prototype-actions">
        <button type="button" className="qt-btn qt-save-prototype-save qt-btn--primary"
          onClick={() => { setPendingId(undefined); if (selected) void save(false); else beginSave(); }}>
          {selected ? "Save changes" : "Save query"}
        </button>
        <MenuButton label="Query actions" trigger={<Icon name="chevronDown" size={12} />}
          buttonProps={{ className: "qt-btn qt-save-prototype-more qt-btn--primary", title: "More query actions" }}>
          <MenuItem icon={<Icon name="copy" size={14} />} onSelect={() => { setPendingId(undefined); beginSave(); }}>Save as new query…</MenuItem>
          <MenuItem icon={<Icon name="undo" size={14} />} disabled={!selected || !dirty} onSelect={() => load(selected!.id)}>Revert to saved query</MenuItem>
        </MenuButton>
      </span>}
      <span role="status" aria-atomic="true" className={status === "saved" && !showSavedConfirmation ? "qt-sr-only" : `qt-save-prototype-status qt-save-prototype-status--${status}`}>
        {(status === "loading" || status === "saving") && <span className="qt-save-prototype-spinner" aria-hidden="true" />}
        {status === "saved" ? showSavedConfirmation && <span key={selectedId} className="qt-save-prototype-confirmation"><Icon name="check" size={14} />Saved</span>
          : status === "saving" ? "Saving…" : status === "loading" ? "Loading queries…" : selected ? "Unsaved changes" : "Not saved"}
      </span>
    </span>
    {error && !dialog && <span className="qt-save-prototype-error" role="alert">{error}</span>}

    {dialog === "save" && <ModalSurface title="Save query" className="qt-modal qt-save-prototype-dialog" initialFocus="input" onClose={closeDialog} returnFocus={picker.current}>
      <form className="qt-overlay-body qt-save-prototype-form" onSubmit={event => { event.preventDefault(); void save(true); }}>
        <div className="qt-save-prototype-field">
          <label htmlFor={nameId}>Query name</label>
          <input id={nameId} className="qt-input" maxLength={200} value={name} disabled={busy}
            placeholder="e.g. Failed Linux runs" onChange={event => setName(event.target.value)} />
        </div>
        <p className="qt-muted">Save your filters, columns, sorting, and metrics as a named query.</p>
        {error && <p role="alert" className="qt-save-prototype-error">{error}</p>}
        <div className="qt-save-prototype-dialog-actions">
          <button type="button" className="qt-btn" onClick={closeDialog} disabled={busy}>Cancel</button>
          <button type="submit" className="qt-btn qt-btn--primary" disabled={busy}>{busy ? "Saving…" : "Save query"}</button>
        </div>
      </form>
    </ModalSurface>}
    {dialog === "switch" && <ModalSurface title="Unsaved changes" className="qt-modal qt-save-prototype-dialog" onClose={closeDialog} returnFocus={picker.current}>
      <div className="qt-overlay-body qt-save-prototype-form">
        <p>{selected ? `Save your changes to “${selected.name}” before switching?` : "Save this query before switching?"}</p>
        {error && <p role="alert" className="qt-save-prototype-error">{error}</p>}
        <div className="qt-save-prototype-dialog-actions">
          <button type="button" className="qt-btn qt-save-prototype-keep" disabled={busy} onClick={closeDialog}>Keep editing</button>
          <button type="button" className="qt-btn" disabled={busy} onClick={() => load(pendingId ?? null)}>Discard and switch</button>
          <button type="button" className="qt-btn qt-btn--primary" disabled={busy} onClick={() => selected ? void save(false) : beginSave()}>{busy ? "Saving…" : "Save and switch"}</button>
        </div>
      </div>
    </ModalSurface>}
  </span>;
}
