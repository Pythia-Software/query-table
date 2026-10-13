// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  memoryQuerySnapshotCache,
  memoryStorageAdapter,
  normalizeQueryState,
  type FieldSchema,
  type GroupedRow,
  type QuerySnapshot,
  type QuerySnapshotStore,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "grouping-links", idField: "id",
  fields: [
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
  ],
};
const rows = [{ id: 1, team: "a", amount: 10 }, { id: 2, team: "a", amount: 30 }, { id: 3, team: "b", amount: 50 }];
const grouped = normalizeQueryState({
  select: [{ field: "team" }, { field: "total" }],
  where: [{ field: "total", op: ">", value: "35" }],
  orderBy: [{ field: "total", dir: "desc" }], limit: 1,
  aggregations: [{ id: "shown", op: "count", groupBy: [], scope: "shownRows" }],
  grouping: {
    keys: ["team"], summaries: [{ id: "total", op: "sum", field: "amount" }], representative: null,
    source: normalizeQueryState({ select: [{ field: "amount" }], limit: 1, offset: 1 }),
  },
});
let root: Root | undefined;
function mount(options: Partial<UseQueryTableOptions<GroupedRow>>) {
  let current!: QueryTableApi<GroupedRow>;
  const links = { cache: memoryQuerySnapshotCache() };
  function Probe() {
    current = useQueryTable({ schema, clientRows: rows, debounceMs: 0, syncUrl: true,
      links, ...options });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return () => current;
}
async function settle() {
  // URL restoration, the debounced page, and shown-row metrics commit in turn.
  for (let step = 0; step < 3; step++)
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/grouping?section=recent#table");
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

it.each(["inline", "durable"] as const)("restores %s grouped links, metrics and reset baselines in the source namespace", async kind => {
  const saved = new Map<string, QuerySnapshot>();
  const snapshots: QuerySnapshotStore = {
    save: vi.fn(async (_key, snapshot) => { saved.set(snapshot.code, snapshot); return snapshot; }),
    resolve: vi.fn(async (_key, code) => saved.get(code) ?? null),
  };
  const storage = { ...memoryStorageAdapter(), ...(kind === "durable" ? { snapshots } : {}) };
  const loadDefault = vi.spyOn(storage, "loadDefaultSaved");
  const saveLast = vi.spyOn(storage, "saveLast");
  const api = mount({ storage, initialQuery: grouped });
  await settle();
  expect(api().error).toBeNull();
  const initialLoads = loadDefault.mock.calls.length;
  expect(snapshots.save).not.toHaveBeenCalled();
  let url = "";
  await act(async () => { url = (await api().links.create()).url; });
  expect(new URL(url).searchParams.get("section")).toBe("recent");
  expect(new URL(url).hash).toBe("#table");
  if (kind === "durable") expect(snapshots.save).toHaveBeenCalledWith(schema.name, expect.any(Object));
  act(() => api().grouping!.changeKeys([]));
  await settle();
  expect(loadDefault).toHaveBeenCalledTimes(initialLoads);
  expect(api().query).toEqual(grouped.grouping!.source);
  act(() => root!.unmount());
  root = undefined;

  // A new cache ensures durable restoration consults the host snapshot store.
  window.history.replaceState(null, "", url);
  const restored = mount({ storage });
  await settle();
  expect(restored().error).toBeNull();
  expect(restored().query).toEqual(grouped);
  expect(restored().rows.map(row => [row.team, row.total])).toEqual([["b", 50]]);
  expect(restored().aggregations.results?.metrics[0]?.buckets[0]?.value).toBe(1);
  expect(loadDefault.mock.calls.every(([key]) => key === schema.name)).toBe(true);
  expect(saveLast.mock.calls.every(([key]) => key === schema.name)).toBe(true);
  if (kind === "durable") expect(snapshots.resolve).toHaveBeenCalledWith(schema.name, expect.any(String), expect.any(AbortSignal));
  act(() => restored().setLimit(5));
  await settle();
  act(() => restored().resetAll());
  await settle();
  expect(restored().query).toEqual(grouped);
  expect(snapshots.save).toHaveBeenCalledTimes(kind === "durable" ? 1 : 0);
});
