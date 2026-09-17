import type { PreviewGroup } from "@pythia-software/query-table-core";

export type PreviewSortKey =
  | { kind: "input"; index: number }
  | { kind: "result" }
  | { kind: "count" }
  | { kind: "percentage" };

export interface PreviewSort {
  key: PreviewSortKey;
  direction: "asc" | "desc";
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const valueLabel = (value: unknown) =>
  value === null
    ? "NULL"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

function mixedRank(group: PreviewGroup) {
  // A stable hash gives each distinct combination a pseudo-random position.
  // Unlike source, alphabetic, or frequency order, the first page therefore
  // contains a representative mix without changing between renders.
  const value = JSON.stringify([
    group.inputs,
    group.result.value,
    group.result.error ?? null,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function compareValue(a: unknown, b: unknown) {
  return collator.compare(valueLabel(a), valueLabel(b));
}

function sortValue(group: PreviewGroup, key: PreviewSortKey) {
  switch (key.kind) {
    case "input":
      return group.inputs[key.index] ?? null;
    case "result":
      return group.result.error ?? group.result.value;
    case "count":
    case "percentage":
      return group.count;
  }
}

/**
 * Preview groups start in a stable mixed order. A user-selected header replaces
 * that order with the requested alphabetical or numeric order.
 */
export function orderPreviewGroups(
  groups: PreviewGroup[],
  sort: PreviewSort | null,
) {
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      if (!sort) {
        const rank = mixedRank(a.group) - mixedRank(b.group);
        return rank || a.index - b.index;
      }
      const comparison = compareValue(
        sortValue(a.group, sort.key),
        sortValue(b.group, sort.key),
      );
      return (sort.direction === "asc" ? comparison : -comparison) ||
        a.index - b.index;
    })
    .map(({ group }) => group);
}
