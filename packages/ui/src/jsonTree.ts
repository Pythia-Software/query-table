import { searchJsonEntries, type JsonEntry } from "./jsonValue";

export const JSON_ARRAY_BUCKET_SIZE = 20;

export interface JsonLine {
  entry: JsonEntry;
  kind: "value" | "close" | "omitted" | "bucket";
  comma?: boolean;
  collapsed?: boolean;
  bucket?: { id: string; start: number; end: number };
}

export function jsonBucketId(path: string, index: number): string {
  return `${path}:bucket:${Math.floor(index / JSON_ARRAY_BUCKET_SIZE) * JSON_ARRAY_BUCKET_SIZE}`;
}

/** Balanced JSON lines, with optional filtering and lazy array ranges. */
export function jsonLines(entries: JsonEntry[], matches: JsonEntry[] | null, collapsed: Set<string>, expandedBuckets: Set<string>, pageSize: number): { lines: JsonLine[]; remaining: number } {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const included = matches ? new Set<string>() : null;
  for (const match of matches ?? []) {
    let entry: JsonEntry | undefined = match;
    while (entry && !included!.has(entry.path)) {
      included!.add(entry.path);
      entry = entry.parent ? byPath.get(entry.parent) : undefined;
    }
  }
  const children = new Map<string, JsonEntry[]>();
  for (const entry of entries) {
    if (entry.parent === null || (included && !included.has(entry.path))) continue;
    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry);
    children.set(entry.parent, siblings);
  }
  const lines: JsonLine[] = [];
  let remaining = 0;
  let count = 0;
  const visit = (entry: JsonEntry, comma: boolean) => {
    count++;
    const folded = entry.children > 0 && collapsed.has(entry.path);
    lines.push({ entry, kind: "value", comma, collapsed: folded });
    if (!entry.children || folded) return;
    const nested = children.get(entry.path) ?? [];
    let omitted = false;
    for (let index = 0; index < nested.length; index++) {
      if (count >= pageSize) {
        lines.push({ entry, kind: "omitted" });
        omitted = true;
        remaining += nested.length - index;
        break;
      }
      if (!matches && entry.type === "array" && index >= JSON_ARRAY_BUCKET_SIZE) {
        const end = Math.min(index + JSON_ARRAY_BUCKET_SIZE, nested.length);
        const bucket = { id: jsonBucketId(entry.path, Number(nested[index]!.key)), start: Number(nested[index]!.key), end: Number(nested[end - 1]!.key) };
        const foldedBucket = !expandedBuckets.has(bucket.id);
        count++;
        lines.push({ entry, kind: "bucket", bucket, collapsed: foldedBucket });
        if (!foldedBucket) for (let child = index; child < end; child++) {
          // A bucket is bounded to 20 entries; finish its range before paging.
          visit(nested[child]!, child < nested.length - 1);
        }
        index = end - 1;
      } else visit(nested[index]!, index < nested.length - 1);
    }
    // Traversal limits must not make a nonempty container look empty.
    if (!omitted && (!nested.length || (!matches && nested.length < entry.children))) lines.push({ entry, kind: "omitted" });
    lines.push({ entry, kind: "close", comma });
  };
  const root = entries[0];
  if (root && (!included || included.has(root.path))) visit(root, false);
  return { lines, remaining };
}

export interface JsonSearchMatch {
  path: string;
  part: "key" | "value" | "path";
  start: number;
}

/** Navigate each visible text occurrence, with a row fallback for path matches. */
export function jsonSearchMatches(entries: JsonEntry[], search: string): JsonSearchMatch[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [];
  const matches: JsonSearchMatch[] = [];
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of searchJsonEntries(entries, search)) {
    const before = matches.length;
    const parts: ["key" | "value", string][] = [];
    if (entry.parent !== null && byPath.get(entry.parent)?.type === "object") parts.push(["key", JSON.stringify(entry.key)]);
    // Array indices are navigated as paths, since JSON does not print them as keys.
    if (entry.type !== "object" && entry.type !== "array") parts.push(["value", entry.text]);
    for (const [part, text] of parts) {
      const lower = text.toLowerCase();
      for (let start = lower.indexOf(needle); start !== -1; start = lower.indexOf(needle, start + needle.length)) {
        matches.push({ path: entry.path, part, start });
      }
    }
    if (matches.length === before) matches.push({ path: entry.path, part: "path", start: 0 });
  }
  return matches;
}
