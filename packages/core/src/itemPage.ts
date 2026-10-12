import { readFieldValue, type FieldSchema } from "./schema";
import type { RowId } from "./query";

/** Literal templates only: substitution never evaluates code or nested paths. */
export function itemPageFields(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(/\{field:([^{}]+)\}/g), match => match[1]!))];
}
export function validateItemPageTemplate<Row>(template: string, schema: FieldSchema<Row>): string | null {
  if (template.length > 8000) return "Use a URL template of at most 8,000 characters.";
  if (!template.trim()) return null;
  const remainder = template.replace(/\{(id|query|field:[^{}]+)\}/g, "value");
  if (/[{}]/.test(remainder)) return "Use {id}, {query}, or {field:field_name} placeholders.";
  for (const name of itemPageFields(template)) {
    if (!schema.fields.some(field => field.name === name)) return `Unknown URL field: ${name}.`;
  }
  try {
    if (!["http:", "https:"].includes(new URL(remainder, "https://query-table.invalid/").protocol))
      return "Use an HTTP, HTTPS, or relative page URL.";
  } catch { return "Enter a valid page URL."; }
  return null;
}
export function renderItemPageTemplate<Row>(template: string, schema: FieldSchema<Row>, row: Row, id: RowId | null, query: string): string | null {
  if (!template.trim() || validateItemPageTemplate(template, schema)) return null;
  let missing = false;
  const href = template.replace(/\{(id|query|field:[^{}]+)\}/g, (_match, token: string) => {
    const value = token === "id" ? id : token === "query" ? query
      : readFieldValue(schema.fields.find(field => field.name === token.slice(6))!, row);
    if (value == null || !["string", "number", "boolean"].includes(typeof value)) { missing = true; return ""; }
    return encodeURIComponent(String(value));
  });
  // Validate again after substitution: a placeholder cannot introduce a scheme.
  try {
    if (missing || !["http:", "https:"].includes(new URL(href, "https://query-table.invalid/").protocol)) return null;
  } catch { return null; }
  return href;
}
