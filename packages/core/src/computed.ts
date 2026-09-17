import type { FormulaResult, FormulaValue } from "./formula";

/** Reserved field token namespace. Query state stores IDs, never formula source. */
export const COMPUTED_PREFIX = "@computed/";
export const computedFieldName = (id: string): string => COMPUTED_PREFIX + id;
export const isComputedField = (name: string): boolean =>
  name.trim().toLowerCase().startsWith(COMPUTED_PREFIX);
export interface ComputedColumn {
  id: string;
  label: string;
  expression: { language: "qt-expr"; version: 1; source: string };
  /** Optimistic concurrency token issued by the store. */
  revision: string;
}
export type ComputedColumnDraft = Omit<ComputedColumn, "revision">;
export interface ComputedColumnStore {
  /** Return the complete authorized catalogue for this dataset. */
  list(dataset: string, signal?: AbortSignal): Promise<ComputedColumn[]>;
  /** null creates a new ID; updates must match the current revision. */
  save(
    dataset: string,
    column: ComputedColumnDraft,
    expectedRevision: string | null,
  ): Promise<ComputedColumn>;
  /** Optional push invalidation, including changes from other sessions. */
  subscribe?(dataset: string, listener: () => void): () => void;
}
export function validateComputedColumn(input: unknown): ComputedColumn {
  const c = input as ComputedColumn;
  if (
    !c ||
    typeof c.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(c.id) ||
    typeof c.label !== "string" ||
    !c.label.trim() ||
    c.label.length > 200 ||
    typeof c.revision !== "string" ||
    !c.revision ||
    c.revision.length > 256 ||
    c.expression?.language !== "qt-expr" ||
    c.expression.version !== 1 ||
    typeof c.expression.source !== "string" ||
    !c.expression.source.trim() ||
    c.expression.source.length > 10000
  ) {
    throw new Error(
      "Invalid computed column definition or unsupported formula version.",
    );
  }
  return {
    id: c.id,
    label: c.label,
    revision: c.revision,
    expression: { ...c.expression },
  };
}
export function memoryComputedColumnStore(
  seed: Record<string, ComputedColumn[]> = {},
): ComputedColumnStore {
  const data = new Map(
    Object.entries(seed).map(([k, v]) => [
      k,
      new Map(v.map((c) => [c.id, validateComputedColumn(c)])),
    ]),
  );
  // Revisions are opaque: never derive a new token by parsing an existing one.
  // Reserve all seed tokens so even a seed from this namespace cannot recur.
  const seedRevisions = new Set(
    [...data.values()].flatMap((entries) =>
      [...entries.values()].map((c) => c.revision),
    ),
  );
  let revisionSequence = 0n;
  function freshRevision(): string {
    let revision: string;
    do {
      revision = `memory:${++revisionSequence}`;
    } while (seedRevisions.has(revision));
    return revision;
  }
  const listeners = new Map<string, Set<() => void>>();
  return {
    async list(dataset) {
      return [...(data.get(dataset)?.values() ?? [])].map(
        validateComputedColumn,
      );
    },
    async save(dataset, column, expectedRevision) {
      const entries = data.get(dataset) ?? new Map<string, ComputedColumn>();
      const current = entries.get(column.id);
      if ((current?.revision ?? null) !== expectedRevision)
        throw new Error(
          "This definition changed. Reload it before saving again.",
        );
      const next = validateComputedColumn({
        ...column,
        revision: freshRevision(),
      });
      entries.set(next.id, next);
      data.set(dataset, entries);
      listeners.get(dataset)?.forEach((fn) => fn());
      return validateComputedColumn(next);
    },
    subscribe(dataset, listener) {
      const set = listeners.get(dataset) ?? new Set();
      set.add(listener);
      listeners.set(dataset, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** REST adapter. The implementing server owns authorization and DB persistence.
 * GET base?dataset=… → ComputedColumn[]
 * PUT base?dataset=… → {column, expectedRevision} → ComputedColumn
 * Return HTTP 409 for a stale revision. No formula evaluation happens there. */
export function httpComputedColumnStore(
  base: string,
  fetcher: typeof fetch = fetch,
): ComputedColumnStore {
  const listeners = new Map<string, Set<() => void>>();
  const url = (dataset: string) =>
    `${base}${base.includes("?") ? "&" : "?"}dataset=${encodeURIComponent(dataset)}`;
  async function read(response: Response): Promise<unknown> {
    if (response.status === 409)
      throw new Error(
        "This definition changed. Reload it before saving again.",
      );
    if (!response.ok)
      throw new Error(
        `Computed column store request failed (${response.status}).`,
      );
    return response.json();
  }
  return {
    async list(dataset, signal) {
      const raw = await read(
        await fetcher(url(dataset), { ...(signal ? { signal } : {}) }),
      );
      if (!Array.isArray(raw))
        throw new Error("Invalid computed column catalogue.");
      return raw.map(validateComputedColumn);
    },
    async save(dataset, column, expectedRevision) {
      const result = validateComputedColumn(
        await read(
          await fetcher(url(dataset), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ column, expectedRevision }),
          }),
        ),
      );
      listeners.get(dataset)?.forEach((fn) => fn());
      return result;
    },
    subscribe(dataset, listener) {
      const set = listeners.get(dataset) ?? new Set();
      set.add(listener);
      listeners.set(dataset, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}
export interface ComputedCellError {
  computedError: string;
}
export function isComputedCellError(
  value: unknown,
): value is ComputedCellError {
  return (
    value !== null &&
    typeof value === "object" &&
    "computedError" in value &&
    typeof (value as ComputedCellError).computedError === "string"
  );
}
export interface PreviewGroup {
  inputs: FormulaValue[];
  result: FormulaResult;
  count: number;
}
export interface ColumnPreview {
  dependencies: string[];
  groups: PreviewGroup[];
  processed: number;
  total: number;
  nulls: number;
  errors: number;
}
export function groupPreview(
  dependencies: string[],
  inputs: Record<string, FormulaValue>[],
  results: FormulaResult[],
  total: number,
): ColumnPreview {
  const groups = new Map<string, PreviewGroup>();
  let nulls = 0,
    errors = 0;
  inputs.forEach((row, i) => {
    const values = dependencies.map((name) => row[name] ?? null),
      result = results[i] ?? { value: null, error: "No result." };
    const key = JSON.stringify([values, result.value, result.error ?? null]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { inputs: values, result, count: 1 });
    if (result.error) errors++;
    else if (result.value === null) nulls++;
  });
  return {
    dependencies,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    processed: inputs.length,
    total,
    nulls,
    errors,
  };
}
