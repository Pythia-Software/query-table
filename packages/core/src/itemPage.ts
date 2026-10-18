import { readFieldValue, type FieldSchema } from "./schema";
import type { RowId } from "./query";

// Literal URL templates, shared by item pages and group link columns.
// Substitution never evaluates code or nested paths: each placeholder is a bare
// token or {field:name}, and every substituted value is percent-encoded.

const MAX_TEMPLATE_LENGTH = 8000;
const BASE = "https://query-table.invalid/";
const ITEM_PAGE_TOKENS = ["id", "query"] as const;

function placeholders(tokens: readonly string[]): RegExp {
  return new RegExp(`\\{(${[...tokens, "field:[^{}]+"].join("|")})\\}`, "g");
}

function httpOrRelative(href: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(href, BASE).protocol);
  } catch {
    return false;
  }
}

/** The distinct `{field:name}` references in a template. */
export function templateFields(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(/\{field:([^{}]+)\}/g), match => match[1]!))];
}

/** Why a URL template is invalid, or null. An empty template is valid here;
 * callers that require a URL check for it. `tokens` are the bare placeholders
 * allowed besides `{field:name}`; `hasField` decides which names exist. */
export function urlTemplateProblem(template: string, tokens: readonly string[], hasField: (name: string) => boolean): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) return "Use a URL template of at most 8,000 characters.";
  if (!template.trim()) return null;
  const remainder = template.replace(placeholders(tokens), "value");
  if (/[{}]/.test(remainder)) {
    const names = [...tokens.map(token => `{${token}}`), "{field:field_name}"];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} or ${names.at(-1)}` : names[0];
    return `Use ${list} placeholders.`;
  }
  for (const name of templateFields(template)) {
    if (!hasField(name)) return `Unknown URL field: ${name}.`;
  }
  try {
    if (!["http:", "https:"].includes(new URL(remainder, BASE).protocol))
      return "Use an HTTP, HTTPS, or relative page URL.";
  } catch { return "Enter a valid page URL."; }
  return null;
}

/** Substitute a validated template. `read` returns each token's value (bare
 * tokens by name, fields as `field:name`); only strings, numbers and booleans
 * substitute. Returns null when a value is missing or the result would not be
 * an HTTP(S) or relative URL. */
export function fillUrlTemplate(template: string, tokens: readonly string[], read: (token: string) => unknown): string | null {
  let missing = false;
  const href = template.replace(placeholders(tokens), (_match, token: string) => {
    const value = read(token);
    if (value == null || !["string", "number", "boolean"].includes(typeof value)) { missing = true; return ""; }
    return encodeURIComponent(String(value));
  });
  // Validate again after substitution: a placeholder cannot introduce a scheme.
  return missing || !httpOrRelative(href) ? null : href;
}

export function itemPageFields(template: string): string[] {
  return templateFields(template);
}
export function validateItemPageTemplate<Row>(template: string, schema: FieldSchema<Row>): string | null {
  return urlTemplateProblem(template, ITEM_PAGE_TOKENS, name => schema.fields.some(field => field.name === name));
}
export function renderItemPageTemplate<Row>(template: string, schema: FieldSchema<Row>, row: Row, id: RowId | null, query: string): string | null {
  if (!template.trim() || validateItemPageTemplate(template, schema)) return null;
  return fillUrlTemplate(template, ITEM_PAGE_TOKENS, token => token === "id" ? id : token === "query" ? query
    : readFieldValue(schema.fields.find(field => field.name === token.slice(6))!, row));
}
