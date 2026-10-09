import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { FormulaError, type FieldDef } from "@pythia-software/query-table-core";
import {
  formulaCompletions,
  formulaContext,
  signatureAt,
  type FormulaCompletions,
  type FormulaSuggestion,
} from "./formulaEditorHelpers";

import { FormulaFunctionBrowser } from "./FormulaFunctionBrowser";

export interface FormulaEditorProps {
  value: string;
  onChange: (value: string) => void;
  fields: FieldDef[];
  compile: (value: string) => unknown;
  /** Metric authoring uses a separate reference pane and no suggestions. */
  suggestions?: boolean;
  showLibrary?: boolean;
  rows?: number;
  ariaLabel?: string;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  onFocus?: () => void;
  onReady?: (input: HTMLTextAreaElement) => void;
}

export default function FormulaEditor({
  value,
  onChange,
  fields,
  compile,
  suggestions = true,
  showLibrary = true,
  ariaLabel = "Computed column formula",
  inputRef,
  onFocus,
  onReady,
  rows = 6,
}: FormulaEditorProps) {
  const id = useId();
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const applyingEdit = useRef(false);
  const composing = useRef(false);
  // Track generated pairs through edits; existing closing characters stay editable.
  const paired = useRef<{
    value: string;
    ranges: { open: number; close: number }[];
  }>({ value, ranges: [] });
  const trackEdit = (next: string) => {
    const previous = paired.current.value;
    if (previous === next) return;
    let from = 0;
    while (
      from < previous.length &&
      from < next.length &&
      previous[from] === next[from]
    )
      from++;
    let oldEnd = previous.length,
      newEnd = next.length;
    while (
      oldEnd > from &&
      newEnd > from &&
      previous[oldEnd - 1] === next[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    const shift = newEnd - oldEnd;
    paired.current.ranges = paired.current.ranges
      .filter(
        ({ open, close }) =>
          !(open >= from && open < oldEnd) &&
          !(close >= from && close < oldEnd),
      )
      .map(({ open, close }) => ({
        open: open >= oldEnd ? open + shift : open,
        close: close >= oldEnd ? close + shift : close,
      }));
    paired.current.value = next;
  };
  const selection = useRef({ start: 0, end: 0 });
  const latestCompile = useRef(compile);
  latestCompile.current = compile;
  const [caret, setCaret] = useState(0);
  const [completions, setCompletions] = useState<FormulaCompletions | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const [diagnostic, setDiagnostic] = useState<{
    message: string;
    from: number;
    to: number;
  } | null>(null);
  const options = suggestions ? (completions?.options.slice(0, 50) ?? []) : [];
  const hint = suggestions ? signatureAt(value.slice(0, caret)) : "";

  useEffect(() => {
    // Native edits already updated the DOM; avoid resetting selection/undo on each keystroke.
    const input = editor.current;
    if (input && input.value !== value) {
      input.value = value;
      paired.current = { value, ranges: [] };
      setCaret(input.selectionStart);
      setCompletions(null);
    }
    setDiagnostic(null);
    const timer = setTimeout(() => {
      try {
        latestCompile.current(value);
        setDiagnostic(null);
      } catch (error) {
        const from = error instanceof FormulaError ? error.from : 0;
        const to = error instanceof FormulaError ? error.to : value.length;
        setDiagnostic({
          message: error instanceof Error ? error.message : String(error),
          from: Math.max(0, Math.min(from, value.length)),
          to: Math.max(0, Math.min(to, value.length)),
        });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    if (editor.current) onReady?.(editor.current);
  }, [onReady]);

  useEffect(() => {
    document
      .getElementById(`${id}-option-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);

  const suggest = (explicit = false) => {
    const input = editor.current;
    if (!suggestions || !input || composing.current) return;
    selection.current = {
      start: input.selectionStart,
      end: input.selectionEnd,
    };
    setCaret(input.selectionStart);
    setActive(0);
    setCompletions(
      formulaCompletions(
        input.value,
        input.selectionStart,
        input.selectionEnd,
        fields,
        explicit,
      ),
    );
  };

  const insert = (
    from: number,
    to: number,
    text: string,
    caretOffset = text.length,
    pair?: { open: number; close: number },
  ) => {
    const input = editor.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(from, to);
    applyingEdit.current = true;
    try {
      // insertText preserves native textarea undo in Chromium/WebKit. Browsers
      // without this editing command still have a plain-text insertion fallback.
      const before = input.value;
      try {
        document.execCommand?.("insertText", false, text);
      } catch {
        /* use fallback */
      }
      if (input.value === before) input.setRangeText(text, from, to, "end");
    } finally {
      applyingEdit.current = false;
    }
    trackEdit(input.value);
    if (pair)
      paired.current.ranges.push({
        open: from + pair.open,
        close: from + pair.close,
      });
    input.setSelectionRange(from + caretOffset, from + caretOffset);
    setCaret(input.selectionStart);
    setCompletions(null);
    onChange(input.value);
  };

  const accept = (option: FormulaSuggestion) => {
    if (completions)
      insert(
        completions.from,
        completions.to,
        option.insert,
        option.caretOffset,
        option.insert.endsWith("()")
          ? { open: option.insert.length - 2, close: option.insert.length - 1 }
          : undefined,
      );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    if (composing.current || event.nativeEvent.isComposing) return;
    if (suggestions && event.ctrlKey && event.code === "Space") {
      event.preventDefault();
      suggest(true);
      return;
    }
    if (options.length) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCompletions(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) %
            options.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const option = options[active];
        if (option) accept(option);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const start = input.selectionStart,
      end = input.selectionEnd;
    const context = formulaContext(input.value, start);
    const close = event.key === "(" ? ")" : event.key === '"' ? '"' : undefined;
    if (
      close &&
      !context.quoted &&
      context.fieldStart < 0 &&
      (start !== end ||
        end === input.value.length ||
        /[\s)\]}]/.test(input.value[end]!))
    ) {
      event.preventDefault();
      const selection = input.value.slice(start, end);
      insert(start, end, event.key + selection + close, selection.length + 1, {
        open: 0,
        close: selection.length + 1,
      });
    } else if (
      start === end &&
      input.value[start] === event.key &&
      paired.current.ranges.some((pair) => pair.close === start) &&
      ((event.key === ")" && !context.quoted && context.fieldStart < 0) ||
        (event.key === '"' && context.quoted && !context.escaped))
    ) {
      event.preventDefault();
      paired.current.ranges = paired.current.ranges.filter(
        (pair) => pair.close !== start,
      );
      input.setSelectionRange(start + 1, start + 1);
      setCaret(start + 1);
      setCompletions(null);
    } else if (
      event.key === "Backspace" &&
      start === end &&
      start > 0 &&
      ["()", "[]", '""'].includes(input.value.slice(start - 1, start + 1)) &&
      (!context.quoted ||
        (input.value.slice(start - 1, start + 1) === '""' && !context.escaped))
    ) {
      event.preventDefault();
      insert(start - 1, start + 1, "");
    }
  };

  return (
    <div className="qt-formula-layout">
      <div className="qt-formula-editor">
        <textarea
          ref={(input) => {
            editor.current = input;
            if (inputRef) inputRef.current = input;
          }}
          className="qt-formula-input"
          aria-label={ariaLabel}
          aria-describedby={`${id}-hint${diagnostic ? ` ${id}-error` : ""}`}
          aria-invalid={diagnostic ? true : undefined}
          aria-autocomplete={suggestions ? "list" : "none"}
          aria-controls={options.length ? `${id}-suggestions` : undefined}
          aria-activedescendant={
            options.length ? `${id}-option-${active}` : undefined
          }
          defaultValue={value}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            if (applyingEdit.current) return;
            trackEdit(event.currentTarget.value);
            onChange(event.currentTarget.value);
            if (!composing.current) suggest();
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
            const input = event.currentTarget;
            if (
              !applyingEdit.current &&
              (input.selectionStart !== selection.current.start ||
                input.selectionEnd !== selection.current.end)
            )
              setCompletions(null);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
            setCompletions(null);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            suggest();
          }}
          onBlur={() => setCompletions(null)}
          onFocus={onFocus}
        />
        <div className="qt-formula-tools">
          {suggestions && (
            <button
              type="button"
              className="qt-link-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.current?.focus();
                suggest(true);
              }}
            >
              Suggestions
            </button>
          )}
          <span>
            Line {value.slice(0, caret).split("\n").length}, column{" "}
            {caret - value.slice(0, caret).lastIndexOf("\n")}
          </span>
        </div>
        {options.length > 0 && (
          <div
            className="qt-formula-completions"
            data-qt-formula-suggestions=""
          >
            <ul
              id={`${id}-suggestions`}
              role="listbox"
              aria-label="Formula suggestions"
              onMouseDown={(event) => event.preventDefault()}
            >
              {options.map((option, index) => (
                <li
                  key={option.label}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  title={option.description}
                  onClick={() => accept(option)}
                >
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </li>
              ))}
            </ul>
            <p>
              {options[active]?.description} · ↑↓ choose, Enter inserts, Esc
              closes
            </p>
            {completions && completions.options.length > options.length && (
              <p>Type to narrow the first {options.length} suggestions.</p>
            )}
          </div>
        )}
        <p id={`${id}-hint`} className="qt-formula-hint" aria-live="polite">
          {hint}
        </p>
        {diagnostic && (
          <div id={`${id}-error`} className="qt-formula-error" role="status">
            {diagnostic.message}{" "}
            <button
              type="button"
              className="qt-link-btn"
              onClick={() => {
                editor.current?.focus();
                editor.current?.setSelectionRange(
                  diagnostic.from,
                  diagnostic.to,
                );
                setCaret(diagnostic.from);
              }}
            >
              Select error location
            </button>
          </div>
        )}
      </div>
      {showLibrary && (
        <FormulaFunctionBrowser
          onInsert={(name) => {
            const input = editor.current;
            if (!input) return;
            const from = input.selectionStart;
            const to = input.selectionEnd;
            const selected = input.value.slice(from, to);
            insert(
              from,
              to,
              `${name}(${selected})`,
              name.length + selected.length + 1,
              { open: name.length, close: name.length + selected.length + 1 },
            );
          }}
        />
      )}
    </div>
  );
}
