import { useEffect, useId, useRef, useState } from "react";
import {
  FUNCTION_CATEGORIES,
  FUNCTION_RESULT_TYPES,
  findFormulaFunctions,
  functionCategory,
  functionResultLabel,
  type FunctionCategory,
} from "./formulaFunctionCatalogue";
import type { FormulaFunction } from "@pythia-software/query-table-core";

export function FormulaFunctionBrowser({
  onInsert,
}: {
  onInsert: (name: string) => void;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<FunctionCategory | "all">("all");
  const [result, setResult] = useState<FormulaFunction["result"] | "all">(
    "all",
  );
  const [active, setActive] = useState(0);
  const matches = findFormulaFunctions(search, category, result);
  const concept = FUNCTION_CATEGORIES.find((item) => item.id === category);

  useEffect(() => {
    // Scroll the list itself without moving the workbench while searching.
    const option = list.current?.children[active] as HTMLElement | undefined;
    const viewport = list.current;
    if (!option || !viewport) return;
    // The positioned list is the option’s offset parent.
    const top = option.offsetTop;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (
      top + option.offsetHeight >
      viewport.scrollTop + viewport.clientHeight
    )
      viewport.scrollTop = top + option.offsetHeight - viewport.clientHeight;
  }, [active, search, category, result]);

  return (
    <aside className="qt-function-library" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Function library</h4>
      <p className="qt-muted">Find a function by name or what it does.</p>
      <label className="qt-function-search">
        Search functions
        <input
          className="qt-input"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          aria-controls={`${id}-results`}
          aria-activedescendant={
            matches[active] ? `${id}-${matches[active]!.name}` : undefined
          }
          placeholder="e.g. trim, minimum, date…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              !matches.length
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : matches.length - 1)) %
                  matches.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              const fn = matches[active];
              if (fn) onInsert(fn.name);
            }
          }}
        />
      </label>
      <div className="qt-function-filters">
        <label>
          Browse by concept
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value as FunctionCategory | "all");
              setActive(0);
            }}
          >
            <option value="all">All functions</option>
            {FUNCTION_CATEGORIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Return type
          <select
            value={result}
            onChange={(event) => {
              setResult(
                event.target.value as FormulaFunction["result"] | "all",
              );
              setActive(0);
            }}
          >
            <option value="all">Any type</option>
            {FUNCTION_RESULT_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {concept && <p className="qt-function-concept">{concept.description}</p>}
      <p className="qt-function-count" aria-live="polite">
        {matches.length} {matches.length === 1 ? "function" : "functions"}
      </p>
      <div
        ref={list}
        className="qt-function-list"
        id={`${id}-results`}
        role="listbox"
        aria-label="Function library results"
      >
        {matches.map((fn, index) => (
          <button
            type="button"
            role="option"
            id={`${id}-${fn.name}`}
            key={fn.name}
            aria-selected={index === active}
            aria-label={`Insert ${fn.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onFocus={() => setActive(index)}
            onClick={() => onInsert(fn.name)}
          >
            <span className="qt-function-card-title">
              <strong>{fn.name}</strong>
              <span>{functionResultLabel(fn.result)}</span>
            </span>
            <code>{fn.signature}</code>
            <small>{fn.description}</small>
            <span className="qt-function-card-concept">
              {
                FUNCTION_CATEGORIES.find(
                  (item) => item.id === functionCategory(fn),
                )!.label
              }
            </span>
          </button>
        ))}
      </div>
      {!matches.length && (
        <p className="qt-function-empty">
          No functions match. Try a shorter search or a different concept or
          return type.
        </p>
      )}
      <p className="qt-function-insert-hint">
        Click a function or use ↑↓ and Enter in search to insert it at the
        cursor. Select formula text first to wrap it.
      </p>
    </aside>
  );
}
