import {
  FORMULA_FUNCTIONS,
  type FieldDef,
} from "@pythia-software/query-table-core";

export const FORMULA_EDITOR_HELP =
  "Use [field] references. Ctrl+Space opens suggestions.";

export interface FormulaSuggestion {
  label: string;
  detail: string;
  description: string;
  insert: string;
  // Place the caret inside the function call after inserting paired parentheses.
  caretOffset?: number;
}

export interface FormulaCompletions {
  from: number;
  to: number;
  options: FormulaSuggestion[];
}

/** Scan strings and escaped field names before interpreting punctuation. */
export function formulaContext(text: string, end = text.length) {
  let quoted = false;
  let fieldStart = -1;
  let escaped = false;
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") {
        escaped = i + 1 >= end;
        i++;
      } else if (c === '"') quoted = false;
    } else if (fieldStart >= 0) {
      if (c === "]") {
        if (text[i + 1] === "]") i++;
        else fieldStart = -1;
      }
    } else if (c === '"') quoted = true;
    else if (c === "[") fieldStart = i;
  }
  return { quoted, fieldStart, escaped };
}

export function formulaCompletions(
  text: string,
  start: number,
  end: number,
  fields: FieldDef[],
  explicit = false,
): FormulaCompletions | null {
  const before = text.slice(0, start);
  const { quoted, fieldStart } = formulaContext(text, start);
  if (quoted || (!explicit && start !== end)) return null;
  const word = before.match(/\b[A-Za-z_][A-Za-z_0-9]*$/)?.[0] ?? "";
  if (!explicit && fieldStart < 0 && !word) return null;
  const from =
    start !== end ? start : fieldStart >= 0 ? fieldStart : start - word.length;
  let to = end;
  if (start === end && fieldStart >= 0) {
    // Replace the rest of a field reference too, including escaped ]] characters.
    for (let i = fieldStart + 1; i < text.length; i++) {
      if (text[i] === "]") {
        if (text[i + 1] === "]") {
          i++;
          continue;
        }
        to = i + 1;
        break;
      }
      if (text[i] === "\n" || text[i] === "[") break;
    }
  } else if (start === end) {
    to += text.slice(end).match(/^[A-Za-z_0-9]*/)?.[0].length ?? 0;
  }
  const prefix = start !== end ? "" : before.slice(from).toLowerCase();
  const options: FormulaSuggestion[] = fields.map((f) => ({
    label: `[${f.name.replace(/\]/g, "]]")}]`,
    detail: `${f.label} · ${f.type}`,
    description: f.name,
    insert: `[${f.name.replace(/\]/g, "]]")}]`,
  }));
  if (fieldStart < 0) {
    options.push(
      ...FORMULA_FUNCTIONS.map((f) => ({
        label: f.name,
        detail: f.signature,
        description: f.description,
        insert: text[to] === "(" ? f.name : `${f.name}()`,
        caretOffset: f.name.length + 1,
      })),
      ...["TRUE", "FALSE", "NULL", "AND", "OR", "NOT", "IN", "BETWEEN"].map(
        (label) => ({
          label,
          detail: "Keyword",
          description: "",
          insert: label,
        }),
      ),
    );
  }
  return {
    from,
    to,
    options: options.filter(
      (option) =>
        option.label.toLowerCase().startsWith(prefix) ||
        (fieldStart >= 0 &&
          option.detail.toLowerCase().includes(prefix.slice(1))),
    ),
  };
}

export function signatureAt(text: string): string {
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
    : FORMULA_EDITOR_HELP;
}
