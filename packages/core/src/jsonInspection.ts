import type { RowId } from "./query";

/** Portable presentation only. Arrays are ordered sets; their order is retained. */
export interface JsonInspectionState {
  version: 1;
  open: boolean;
  search: string;
  searchMode: "filter" | "find";
  raw: boolean;
  collapsedPaths: string[];
  expandedBuckets: string[];
  visibleEntryLimit: number;
  selectedMatch?: JsonMatchIdentity;
  /** Explicit expansion choices made while searching, in interaction order. */
  searchOverrides: { path: string; expanded: boolean }[];
}
export interface JsonMatchIdentity {
  path: string;
  part: "key" | "value" | "path";
  start: number;
}
export interface JsonInspectionScope { dataset: string; rowId: RowId; field: string }
export interface ScopedJsonInspectionState extends JsonInspectionScope { state: JsonInspectionState }
export const MAX_JSON_INSPECTIONS = 200;
export const MAX_JSON_PATHS = 5000;

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
/** Bracket JSONPath, as emitted by the inspector. No dot splitting or evaluation. */
export function isJsonPath(path: unknown): path is string {
  return text(path, 10000) && /^\$(?:\[(?:0|[1-9]\d*|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")\])*$/.test(path);
}
export function isJsonBucketId(path: unknown): path is string {
  if (!text(path, 10032)) return false;
  const index = path.lastIndexOf(":bucket:");
  return index > 0 && isJsonPath(path.slice(0, index)) && /^(?:0|[1-9]\d*)$/.test(path.slice(index + 8))
    && Number.isSafeInteger(Number(path.slice(index + 8))) && Number(path.slice(index + 8)) >= 20 && Number(path.slice(index + 8)) % 20 === 0;
}
export function jsonInspectionScopeKey(scope: JsonInspectionScope): string {
  return JSON.stringify([scope.dataset, scope.rowId, scope.field]);
}
export function parseJsonInspectionState(input: unknown): JsonInspectionState {
  if (!record(input) || input.version !== 1 || typeof input.open !== "boolean" || typeof input.raw !== "boolean"
    || typeof input.search !== "string" || input.search.length > 10000 || (input.searchMode !== "filter" && input.searchMode !== "find")
    || typeof input.visibleEntryLimit !== "number" || !Number.isInteger(input.visibleEntryLimit) || input.visibleEntryLimit < 1 || input.visibleEntryLimit > 10000)
    throw Error("Invalid or unsupported JSON inspection state.");
  const paths = (value: unknown, valid: (path: unknown) => boolean): string[] => {
    if (!Array.isArray(value) || value.length > MAX_JSON_PATHS || !value.every(valid) || new Set(value).size !== value.length)
      throw Error("Invalid JSON inspection paths.");
    return value.slice() as string[];
  };
  const state: JsonInspectionState = { version: 1, open: input.open, search: input.search,
    searchMode: input.searchMode as JsonInspectionState["searchMode"], raw: input.raw,
    collapsedPaths: paths(input.collapsedPaths, isJsonPath), expandedBuckets: paths(input.expandedBuckets, isJsonBucketId),
    visibleEntryLimit: input.visibleEntryLimit, searchOverrides: [] };
  if (input.selectedMatch !== undefined) {
    const match = input.selectedMatch;
    if (!record(match) || !isJsonPath(match.path) || (match.part !== "key" && match.part !== "value" && match.part !== "path")
      || typeof match.start !== "number" || !Number.isSafeInteger(match.start) || match.start < 0 || match.start > 1048576)
      throw Error("Invalid JSON match identity.");
    state.selectedMatch = { path: match.path, part: match.part as JsonMatchIdentity["part"], start: match.start };
  }
  if (!Array.isArray(input.searchOverrides) || input.searchOverrides.length > MAX_JSON_PATHS) throw Error("Invalid JSON search expansion overrides.");
  const seen = new Set<string>();
  for (const entry of input.searchOverrides) {
    if (!record(entry) || !(isJsonPath(entry.path) || isJsonBucketId(entry.path)) || typeof entry.expanded !== "boolean" || seen.has(entry.path))
      throw Error("Invalid JSON search expansion override.");
    seen.add(entry.path);
    state.searchOverrides.push({ path: entry.path, expanded: entry.expanded });
  }
  return state;
}
/** Reject the entire envelope on an invalid/duplicate scope, never restore a different record. */
export function parseJsonInspections(input: unknown): ScopedJsonInspectionState[] {
  if (!Array.isArray(input) || input.length > MAX_JSON_INSPECTIONS) throw Error("Invalid JSON inspection scopes.");
  const seen = new Set<string>();
  return input.map(entry => {
    if (!record(entry) || !text(entry.dataset, 256) || !text(entry.field, 256)
      || !(text(entry.rowId, 1000) || (typeof entry.rowId === "number" && Number.isFinite(entry.rowId))))
      throw Error("Invalid JSON inspection scope.");
    const scope: JsonInspectionScope = { dataset: entry.dataset, rowId: entry.rowId as RowId, field: entry.field };
    const key = jsonInspectionScopeKey(scope);
    if (seen.has(key)) throw Error("Duplicate JSON inspection scope.");
    seen.add(key);
    return { ...scope, state: parseJsonInspectionState(entry.state) };
  });
}
