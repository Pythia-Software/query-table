import { useEffect, useId, useRef, useState } from "react";
import { filterValues, opsForField, type FieldDef, type SetFilterMode } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { PresentedFilterValue, useFilterValuePresentation } from "./FilterValuePresentation";
import type { QueryBuilderClassNames } from "./classNames";

export function SetFilterEditor<Row>({ api, field, anchor, returnFocus, classNames, mode: initialMode, values: initialValues, disabled, maxPredicates, onApply, onClose }: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row>;
  anchor: HTMLElement;
  returnFocus: HTMLElement;
  classNames: QueryBuilderClassNames | undefined;
  mode: SetFilterMode;
  values: string[];
  disabled: boolean | undefined;
  maxPredicates: number;
  onApply: (mode: SetFilterMode, values: string[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [values, setValues] = useState([...initialValues]);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState({ top: 16, left: 16 });
  const dialog = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const presentation = useFilterValuePresentation();
  const strategy = filterValues(field);
  const ops = opsForField(field);
  const allowsMode = (candidate: SetFilterMode) => candidate === "empty" ? ops.includes("is_null") : ops.includes("includes") && (candidate !== "none" || ops.includes("is_null"));
  const predicateCount = mode === "empty" ? 1 : values.length * (mode === "none" ? 2 : 1);
  const exceedsBudget = predicateCount > maxPredicates;
  const options = strategy.source === "static" ? strategy.options.map((option) => typeof option === "string" ? { value: option, label: option } : option) : suggestions.map((value) => ({ value, label: value }));
  const labelFor = (value: string) => presentation.label?.(field.name, value) ?? options.find((option) => option.value === value)?.label ?? value;
  const visible = options.filter((option) => `${option.value} ${option.label} ${labelFor(option.value)}`.toLowerCase().includes(search.toLowerCase()));
  const canCreate = strategy.source !== "static" && search.trim().length > 0;
  const showCreate = canCreate && !values.includes(search) && !options.some((option) => option.value === search);

  useEffect(() => {
    const rect = anchor.getBoundingClientRect();
    setPosition({ top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 480)), left: Math.max(16, Math.min(rect.left, window.innerWidth - 472)) });
    dialog.current?.querySelector<HTMLElement>("select")?.focus();
    return () => { if (returnFocus.isConnected) returnFocus.focus(); };
  }, [anchor, returnFocus]);

  useEffect(() => {
    if (strategy.source !== "autocomplete") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      api.filterValues(field.name, search).then((result) => {
        if (!cancelled) setSuggestions(result.values);
      }).catch(() => {
        if (!cancelled) setError("Could not load values. Try searching again.");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api.filterValues, field.name, strategy.source, search]);

  function toggle(value: string) {
    setValues((previous) => previous.includes(value) ? previous.filter((key) => key !== value) : [...previous, value]);
  }

  function addValue(value: string) {
    setValues((previous) => previous.includes(value) ? previous : [...previous, value]);
    setSearch("");
    searchInput.current?.focus();
  }

  return <div className={["qt-set-backdrop", classNames?.setBackdrop].filter(Boolean).join(" ")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className={["qt-set-editor", classNames?.setEditor].filter(Boolean).join(" ")} style={position} role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>("*")].filter((element) => element.matches("button:not(:disabled), input:not(:disabled), select:not(:disabled)"));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <h3 id={headingId}>Filter {field.label}</h3>
      <label>Match mode <select className={classNames?.select} aria-label="Match mode" value={mode} disabled={disabled} onChange={(event) => setMode(event.target.value as SetFilterMode)}>
        <option value="any" disabled={!allowsMode("any")}>ANY — at least one selected tag</option>
        <option value="all" disabled={!allowsMode("all")}>ALL — every selected tag</option>
        <option value="none" disabled={!allowsMode("none")}>NONE — exclude selected tags, include empty rows</option>
        <option value="empty" disabled={!allowsMode("empty")}>EMPTY — no tags</option>
      </select></label>
      {mode !== "empty" && <>
        <div className="qt-set-selected" aria-label="Selected tags">
          {values.map((value) => <span className="qt-chip" key={value}>
            <PresentedFilterValue field={field.name} value={value} label={labelFor(value)} />
            {strategy.source === "static" && !options.some((option) => option.value === value) && <small> unavailable: {value}</small>}
            <button type="button" className="qt-chip-x" disabled={disabled} aria-label={`Remove ${labelFor(value)}`} onClick={() => toggle(value)}>✕</button>
          </span>)}
        </div>
        <input ref={searchInput} className={classNames?.input} aria-label={`Search ${field.label} tags`} placeholder="Search names or keys" value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || disabled) return;
          event.preventDefault();
          if (!search.trim()) return;
          const value = visible[0]?.value;
          if (value !== undefined) addValue(value);
          else if (canCreate) addValue(search);
        }} />
        <div className="qt-set-options" role="group" aria-label="Available tags">
          {visible.map((option) => <label key={option.value} className="qt-set-option">
            <input type="checkbox" checked={values.includes(option.value)} disabled={disabled} onChange={() => toggle(option.value)} />
            <PresentedFilterValue field={field.name} value={option.value} label={labelFor(option.value)} />
            {labelFor(option.value) !== option.value && <small>{option.value}</small>}
          </label>)}
          {!visible.length && !loading && <span className="qt-muted">{strategy.source === "freeform" ? "Type a tag and press Enter" : "No matching tags"}</span>}
        </div>
        {showCreate && <button type="button" className={["qt-btn", classNames?.button].filter(Boolean).join(" ")} disabled={disabled} onClick={() => addValue(search)}>Add “{search}”</button>}
        <span role="status">{loading ? "Loading tags…" : error}</span>
      </>}
      {exceedsBudget && <span role="alert">Too many tags for this query. Remove tags or other filters before applying.</span>}
      <div className="qt-set-actions">
        <button type="button" className={["qt-btn", classNames?.button].filter(Boolean).join(" ")} onClick={onClose}>Cancel</button>
        <button type="button" className={["qt-btn", classNames?.button].filter(Boolean).join(" ")} disabled={disabled || exceedsBudget || !allowsMode(mode) || (mode !== "empty" && values.length === 0)} onClick={() => onApply(mode, mode === "empty" ? [] : values)}>Apply filter</button>
      </div>
    </div>
  </div>;
}
