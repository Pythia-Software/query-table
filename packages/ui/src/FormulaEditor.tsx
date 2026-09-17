import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  hoverTooltip,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import {
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import {
  FORMULA_FUNCTIONS,
  FormulaError,
  type FieldDef,
  type FormulaPlan,
} from "@pythia-software/query-table-core";

export interface FormulaEditorProps {
  value: string;
  onChange: (value: string) => void;
  fields: FieldDef[];
  compile: (value: string) => FormulaPlan;
}
const language = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\[(?:[^\]]|\]\])*\]/)) return "variableName";
    if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)/)) return "number";
    if (stream.match(/^(?:AND|OR|NOT|IN|BETWEEN|NULL|TRUE|FALSE)\b/i))
      return "keyword";
    if (stream.match(/^[a-zA-Z_][a-zA-Z_0-9]*/))
      return "function(variableName)";
    stream.next();
    return "operator";
  },
});
function signatureAt(text: string): string {
  const stack: { name: string; argument: number }[] = [];
  let quoted = false,
    field = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (field) {
      if (c === "]") {
        if (text[i + 1] === "]") i++;
        else field = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === "[") {
      field = true;
      continue;
    }
    if (c === "(")
      stack.push({
        name:
          text
            .slice(0, i)
            .match(/([A-Za-z_]+)\s*$/)?.[1]
            ?.toUpperCase() ?? "",
        argument: 1,
      });
    else if (c === ")") stack.pop();
    else if (c === "," && stack.length) stack[stack.length - 1]!.argument++;
  }
  const call = stack[stack.length - 1],
    spec = FORMULA_FUNCTIONS.find((f) => f.name === call?.name);
  return spec && call
    ? `${spec.signature} · Argument ${call.argument} — ${spec.description}`
    : "Use [field] references. Ctrl+Space opens suggestions.";
}
export default function FormulaEditor({
  value,
  onChange,
  fields,
  compile,
}: FormulaEditorProps) {
  const [hint, setHint] = useState(
    "Use [field] references. Ctrl+Space opens suggestions.",
  );
  const parent = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView>();
  const latest = useRef({ onChange, fields, compile });
  latest.current = { onChange, fields, compile };
  useEffect(() => {
    if (!parent.current) return;
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          language,
          syntaxHighlighting(defaultHighlightStyle),
          bracketMatching(),
          closeBrackets(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Computed column formula",
            spellcheck: "false",
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          autocompletion({
            override: [
              (context) => {
                const word = context.matchBefore(
                  /\[[^\]]*|[a-zA-Z_][a-zA-Z_0-9]*/,
                );
                if (!word && !context.explicit) return null;
                return {
                  from: word?.from ?? context.pos,
                  options: [
                    ...latest.current.fields.map((f) => ({
                      label: `[${f.name.replace(/\]/g, "]]")}]`,
                      displayLabel: f.label,
                      detail: f.type,
                      type: "variable",
                      info: f.name,
                    })),
                    ...FORMULA_FUNCTIONS.map((f) => ({
                      label: f.name,
                      type: "function",
                      detail: f.signature,
                      info: f.description,
                      apply: `${f.name}(`,
                    })),
                    ...[
                      "TRUE",
                      "FALSE",
                      "NULL",
                      "AND",
                      "OR",
                      "NOT",
                      "IN",
                      "BETWEEN",
                    ].map((label) => ({ label, type: "keyword" })),
                  ],
                };
              },
            ],
          }),
          linter(
            (view) => {
              try {
                latest.current.compile(view.state.doc.toString());
                return [];
              } catch (e) {
                return [
                  {
                    from: Math.min(
                      e instanceof FormulaError ? e.from : 0,
                      view.state.doc.length,
                    ),
                    to: Math.min(
                      e instanceof FormulaError ? e.to : view.state.doc.length,
                      view.state.doc.length,
                    ),
                    severity: "error" as const,
                    message: e instanceof Error ? e.message : String(e),
                  },
                ];
              }
            },
            { delay: 250 },
          ),
          hoverTooltip((view, pos) => {
            const line = view.state.doc.lineAt(pos);
            const left =
              line.text
                .slice(0, pos - line.from)
                .match(/[A-Za-z_0-9]*$/)?.[0] ?? "";
            const right =
              line.text.slice(pos - line.from).match(/^[A-Za-z_0-9]*/)?.[0] ??
              "";
            const spec = FORMULA_FUNCTIONS.find(
              (f) => f.name === (left + right).toUpperCase(),
            );
            if (!spec) return null;
            return {
              pos: pos - left.length,
              end: pos + right.length,
              create() {
                const dom = document.createElement("div");
                dom.className = "qt-function-help";
                dom.textContent = `${spec.signature} — ${spec.description}`;
                return { dom };
              },
            };
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet)
              setHint(
                signatureAt(
                  update.state.doc.sliceString(
                    0,
                    update.state.selection.main.head,
                  ),
                ),
              );
          }),
          EditorView.theme({
            "&": {
              fontSize: "13px",
              border: "1px solid var(--qt-border, #cbd5e1)",
              borderRadius: "6px",
            },
            ".cm-scroller": {
              minHeight: "130px",
              maxHeight: "260px",
              fontFamily: "ui-monospace, monospace",
            },
            ".cm-content": { padding: "12px 0" },
            ".cm-gutters": {
              background: "var(--qt-bg-muted, #f8fafc)",
              color: "var(--qt-muted, #64748b)",
            },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = undefined;
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  return (
    <>
      <div ref={parent} />
      <p className="qt-formula-hint" aria-live="polite">
        {hint}
      </p>
    </>
  );
}
