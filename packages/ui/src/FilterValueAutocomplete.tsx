import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DistinctValuesResult, FieldDef } from "@pythia-software/query-table-core";
import type { QueryFilterApi } from "@pythia-software/query-table-react";
import { OverlayPortal, useFloatingOverlay } from "./FloatingOverlay";

/** Freeform values with optional distinct suggestions; focus stays in the input. */
export function FilterValueAutocomplete<Row>({ api, field, value, contextKey, className, widthChars, onChange }: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row>;
  value: string;
  contextKey: string;
  className: string;
  widthChars: number;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // Reuse known values across searches, but never across fields/query contexts.
  const scopeKey = JSON.stringify([field.name, contextKey]);
  const requestKey = JSON.stringify([scopeKey, value]);
  const fetchValues = api.filterValues;
  const [known, setKnown] = useState<{
    scopeKey: string; fetchValues: typeof fetchValues; result: DistinctValuesResult;
  } | null>(null);
  const [response, setResponse] = useState<{
    key: string; fetchValues: typeof fetchValues; result?: DistinctValuesResult; failed?: boolean;
  } | null>(null);
  const current = response?.key === requestKey && response.fetchValues === fetchValues ? response : null;
  const search = value.trim().toLowerCase();
  const previousValues = known?.scopeKey === scopeKey && known.fetchValues === fetchValues
    ? known.result.values.filter(choice => choice.toLowerCase().includes(search)) : [];
  const values = [...new Set(current?.result?.values ?? previousValues)];
  const activeIndex = active === null ? -1 : values.indexOf(active);
  const activeId = open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  useEffect(() => { setActive(null); }, [requestKey]);
  // Suggestions are read only for an open editor, once per search; closed
  // controls issue no metadata reads.
  const loaded = Boolean(current);
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => fetchValues(field.name, value)).then(
        result => {
          if (cancelled) return;
          setResponse({ key: requestKey, fetchValues, result });
          setKnown({ scopeKey, fetchValues, result });
        },
        () => { if (!cancelled) setResponse({ key: requestKey, fetchValues, failed: true }); },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, loaded, fetchValues, requestKey, scopeKey, field.name, value]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const close = () => { setOpen(false); setActive(null); };
  const choose = (choice: string) => {
    onChange(choice);
    close();
    input.current?.focus({ preventScroll: true });
  };
  const status = !current ? (values.length ? "" : "Loading suggestions…") : current.failed
    ? "Suggestions unavailable. Keep typing a value."
    : values.length === 0 ? "No matching values. Keep typing a value."
    : current.result?.hasMore ? "keep typing to refine…" : "";

  return <span className="qt-autocomplete">
    <input ref={input} className={className} value={value} placeholder="value"
      aria-label={`Value for ${field.label}`} role="combobox" aria-autocomplete="list"
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={activeId} aria-describedby={open && status ? `${listId}-status` : undefined}
      autoComplete="off" size={widthChars} style={{ width: `${widthChars}ch` }}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
      onChange={event => { setActive(null); setOpen(true); onChange(event.target.value); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
          if (values.length) {
            const next = !open || activeIndex < 0 ? (event.key === "ArrowDown" ? 0 : values.length - 1)
              : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + values.length) % values.length;
            setActive(values[next]!);
          }
        } else if (open && activeIndex >= 0 && (event.key === "Home" || event.key === "End")) {
          event.preventDefault();
          setActive(values[event.key === "Home" ? 0 : values.length - 1]!);
        } else if (open && event.key === "Enter" && activeIndex >= 0) {
          event.preventDefault();
          choose(values[activeIndex]!);
        } else if (open && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); close();
        } else if (event.key === "Tab") close();
      }}
    />
    {open && input.current && <Suggestions anchor={input.current} onClose={close}>
      <div id={listId} role="listbox" aria-label={`Suggestions for ${field.label}`} aria-busy={!current}>
        {values.map((choice, index) => <div key={choice} id={`${listId}-${index}`} role="option"
          aria-selected={choice === active} className="qt-autocomplete-option"
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(choice)}>{choice}</div>)}
      </div>
      {status && <p id={`${listId}-status`} role="status" className="qt-autocomplete-status">{status}</p>}
    </Suggestions>}
  </span>;
}

function Suggestions({ anchor, onClose, children }: {
  anchor: HTMLElement; onClose: () => void; children: ReactNode;
}) {
  const overlay = useFloatingOverlay({ anchor, onClose, width: "max-content", maxHeight: 440,
    modalOnMobile: false, retainAnchorFocus: true });
  return <OverlayPortal overlay={overlay} label="Value suggestions">
    <div ref={overlay.setSurface} style={overlay.style} className="qt-menu-surface qt-autocomplete-menu"
      onClick={event => event.stopPropagation()}>{children}</div>
  </OverlayPortal>;
}
