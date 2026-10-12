import type { JsonCellDisplay } from "@pythia-software/query-table-core";

/** Limits apply to both parsing and inspection; never silently report a partial search. */
export const JSON_MAX_CHARACTERS = 1_048_576;
export const JSON_MAX_ENTRIES = 5_000;
const JSON_MAX_DEPTH = 64;

export interface JsonEntry {
  /** Unambiguous JSONPath; bracket notation preserves dots/quotes in keys. */
  path: string;
  parent: string | null;
  key: string;
  depth: number;
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  text: string;
  children: number;
  value: unknown;
}
export interface JsonInspection {
  value: unknown;
  raw: string;
  formatted: string;
  preview: string;
  entries: JsonEntry[];
  error?: string;
  limited?: boolean;
}

export function boundedJsonOption(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(min, Math.min(max, Math.floor(value)));
}

/** Raw strings are copied exactly; native JSON values use JSON text. */
export function cellValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try { return JSON.stringify(value) ?? String(value); }
    catch { return "[Unserializable value]"; }
  }
  return String(value);
}

export function inspectJsonValue(input: unknown, display: JsonCellDisplay = { kind: "json" }, includeEntries = true): JsonInspection {
  let raw = typeof input === "string" ? input : "";
  try {
    if (raw.length > JSON_MAX_CHARACTERS) throw Error("JSON exceeds the 1,048,576 character inspection limit. Inspect it outside the table.");
    let value = input;
    const encoding = display.encoding ?? "auto";
    const passes = encoding === "json" ? 1 : boundedJsonOption(display.maxDecodeDepth, 4, 1, 8);
    if (typeof value === "string" && encoding !== "value") {
      let decoded = false;
      for (let pass = 0; pass < passes && typeof value === "string"; pass++) {
        const text = value;
        try {
          value = JSON.parse(text);
          decoded = true;
        } catch {
          // Strict JSON unescaping handles blobs such as {\"key\":\"value\"}
          // without replacing slashes, quotes or newlines heuristically.
          if (encoding !== "json" && /\\["\\]/.test(text)) {
            try {
              const unescaped: unknown = JSON.parse(`"${text}"`);
              if (typeof unescaped !== "string" || unescaped === text) throw Error();
              value = JSON.parse(unescaped);
              decoded = true;
              continue;
            } catch { /* show a decoded JSON string literally, or raw invalid text */ }
          }
          if (!decoded) throw Error("Invalid JSON. The original value is available below.");
          break;
        }
      }
      if (encoding !== "json" && typeof value === "string" && /^\s*[\[{]/.test(value)) {
        // A valid JSON string is allowed; disclose when the bounded decoder stops.
        let stillEncoded = false;
        try { JSON.parse(value); stillEncoded = true; } catch { /* literal JSON string */ }
        if (stillEncoded) throw Error("JSON string decoding limit reached. Increase maxDecodeDepth or use encoding: value.");
      }
    }
    const formatted = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" ||
          (typeof item === "number" && !Number.isFinite(item))) throw Error("Value contains data that cannot be represented as JSON.");
      if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item)) {
        throw Error("JSON contains a number outside safe integer precision. Use the original text to preserve its value.");
      }
      return item;
    }, 2);
    if (formatted === undefined) throw Error("Value cannot be represented as JSON.");
    if (formatted.length > JSON_MAX_CHARACTERS) throw Error("JSON exceeds the 1,048,576 character inspection limit. Inspect it outside the table.");
    // Snapshot native values (including toJSON conversions) so paths and copy
    // actions describe exactly the document represented by the formatted text.
    value = JSON.parse(formatted);
    if (typeof input !== "string") raw = JSON.stringify(value);
    const entries: JsonEntry[] = [];
    const stack = [{ value, path: "$", parent: null as string | null, key: "$", depth: 0 }];
    let limited = false;
    while (includeEntries && stack.length && entries.length < JSON_MAX_ENTRIES) {
      const item = stack.pop()!;
      const type = item.value === null ? "null" : Array.isArray(item.value) ? "array" : typeof item.value;
      if (!["null", "array", "object", "string", "number", "boolean"].includes(type)) throw Error("Value is not JSON.");
      const keys = type === "array" || type === "object" ? Object.keys(item.value as object) : [];
      const text = type === "array" ? `[${keys.length} items]` : type === "object" ? `{${keys.length} keys}` : JSON.stringify(item.value);
      entries.push({ ...item, type: type as JsonEntry["type"], text, children: keys.length });
      if (item.depth >= JSON_MAX_DEPTH) { limited ||= keys.length > 0; continue; }
      // Bound pending work as well as the displayed entries for very wide objects.
      const available = Math.max(0, JSON_MAX_ENTRIES - entries.length - stack.length);
      limited ||= keys.length > available;
      const selected = keys.slice(0, available);
      for (let i = selected.length - 1; i >= 0; i--) {
        const key = selected[i]!;
        stack.push({
          value: (item.value as Record<string, unknown>)[key],
          path: type === "array" ? `${item.path}[${key}]` : `${item.path}[${JSON.stringify(key)}]`,
          parent: item.path, key, depth: item.depth + 1,
        });
      }
    }
    limited ||= includeEntries && stack.length > 0;
    const length = boundedJsonOption(display.previewLength, 80, 20, 500);
    const compact = JSON.stringify(value);
    return { value, raw, formatted, entries, limited, preview: compact.length > length ? compact.slice(0, length) + "…" : compact };
  } catch (error) {
    raw ||= cellValueText(input);
    return { value: input, raw, formatted: raw, entries: [], preview: raw.slice(0, 80) || "Invalid JSON", error: error instanceof Error ? error.message : "Unable to inspect JSON." };
  }
}

/** Search keys, full paths and typed values; case insensitive, literal matching. */
export function searchJsonEntries(entries: JsonEntry[], search: string): JsonEntry[] {
  const needle = search.trim().toLowerCase();
  return needle ? entries.filter((entry) => `${entry.key}\n${entry.path}\n${entry.text}`.toLowerCase().includes(needle)) : entries;
}
