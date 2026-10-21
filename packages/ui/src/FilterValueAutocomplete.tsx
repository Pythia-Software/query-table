import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DistinctValuesResult, FieldDef } from "@pythia-software/query-table-core";
import type { QueryFilterApi } from "@pythia-software/query-table-react";
import { OverlayPortal, useFloatingOverlay } from "./FloatingOverlay";

/** Freeform values with optional distinct suggestions; focus stays in the input. */
export function FilterValueAutocomplete<Row>({ api, field, value, className, widthChars, onChange }: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row>;
  value: string;
  className: string;
  widthChars: number;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // Include the query stage/context even when the host keeps a stable callback.
  const requestKey = JSON.stringify([field.name, value, api.query]);
  const fetchValues = api.filterValues;
  const [response, setResponse] = useState<{
    key: string; fetchValues: typeof fetchValues; result?: DistinctValuesResult; failed?: boolean;
  } | null>(null);
  const current = response?.key === requestKey && response.fetchValues === fetchValues ? response : null;
  const values = current?.result ? [...new Set(current.result.values)] : [];
  const activeIndex = active === null ? -1 : values.indexOf(active);
  const activeId = open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  useEffect(() => {
    let cancelled = false;
    setActive(null);
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => fetchValues(field.name, value)).then(
        result => { if (!cancelled) setResponse({ key: requestKey, fetchValues, result }); },
        () => { if (!cancelled) setResponse({ key: requestKey, fetchValues, failed: true }); },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fetchValues, requestKey, field.name, value]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const close = () => { setOpen(false); setActive(null); };
  const choose = (choice: string) => {
    onChange(choice);
    close();
    input.current?.focus({ preventScroll: true });
  };
  const status = !current ? "Loading suggestions…" : current.failed
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
