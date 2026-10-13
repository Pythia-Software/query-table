// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ITEM_DETAILS_COLUMN, MAX_GROUP_BY_FIELDS, memoryStorageAdapter, normalizeQueryState,
  type FieldSchema, type GroupedRow, type QueryState,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "grouping-review", idField: "id", defaultLimit: 25, defaultSelect: [{ field: "team" }],
  fields: [
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    { name: "region", label: "Region", type: "text", source: { kind: "backend" } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
  ],
};
const rows: GroupedRow[] = [
  { id: 1, team: "a", region: "east", amount: 10 },
  { id: 2, team: "a", region: "west", amount: 30 },
  { id: 3, team: "b", region: "west", amount: 50 },
];
function grouped(keys = ["team"], diagnostics?: string[]): QueryState {
  return normalizeQueryState({
    grouping: { keys, summaries: [{ id: "n", op: "count" }], representative: null,
      source: normalizeQueryState({ select: schema.defaultSelect }), ...(diagnostics ? { diagnostics } : {}) },
    select: [...keys.map(field => ({ field })), { field: "n" }],
    aggregations: [
      { id: "all", op: "count", groupBy: [] },
      { id: "page", op: "sum", field: "n", groupBy: [], scope: "shownRows" },
    ],
  });
}
let root: Root | undefined;
function mount(overrides: Partial<UseQueryTableOptions<GroupedRow>> = {}) {
  let options: UseQueryTableOptions<GroupedRow> = { schema, clientRows: rows, debounceMs: 200, initialQuery: grouped(), ...overrides };
  const current = {
    api: undefined as unknown as QueryTableApi<GroupedRow>,
    renders: [] as Array<{ rows: GroupedRow[]; loading: boolean }>,
    rerender(next: Partial<UseQueryTableOptions<GroupedRow>>) {
      options = { ...options, ...next };
      act(() => root!.render(createElement(Probe)));
    },
  };
  function Probe() {
    current.api = useQueryTable(options);
    current.renders.push({ rows: current.api.rows, loading: current.api.loading });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return current;
}
async function advance(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function settle() { await advance(); await advance(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; vi.useRealTimers(); });

describe("group key validation stays outside React updates", () => {
  it.each([
    { name: "adding with a stale key", initial: grouped(["team", "missing"]), keys: ["team", "missing", "region"] },
    { name: "removing with a stale key", initial: grouped(["team", "missing"]), keys: ["missing"] },
    { name: "removing with stored diagnostics", initial: grouped(["team", "region"], ["Invalid grouping definition."]), keys: ["team"] },
  ])("rejects $name synchronously without changing state", async ({ initial, keys }) => {
    const current = mount({ initialQuery: initial }); await settle();
    const before = current.api.query;
    act(() => { expect(() => current.api.grouping!.changeKeys(keys)).toThrow(); });
    await settle();
    expect(current.api.query).toBe(before);
    // Invalid state remains recoverable by leaving grouping.
    act(() => current.api.grouping!.changeKeys([])); await settle();
    expect(current.api.error).toBeNull();
    expect(current.api.rows).toEqual(rows);
  });

  it("rejects the 21st key synchronously and keeps the current result", async () => {
    const keys = Array.from({ length: MAX_GROUP_BY_FIELDS + 1 }, (_, i) => `key${i}`);
    const wideSchema: FieldSchema<GroupedRow> = { ...schema, fields: keys.map(name => ({ name, label: name, type: "text", source: { kind: "backend" } })) };
    const current = mount({ schema: wideSchema, initialQuery: grouped(keys.slice(0, -1)) }); await settle();
    const before = current.api.query;
    act(() => { expect(() => current.api.grouping!.changeKeys(keys)).toThrow(); });
    await settle();
    expect(current.api.query).toBe(before);
    expect(current.api.error).toBeNull();
    expect(current.api.rows).toHaveLength(1);
  });

  it("can remove a missing key and resume execution", async () => {
    const current = mount({ initialQuery: grouped(["team", "missing"]) }); await settle();
    act(() => current.api.grouping!.changeKeys(["team"])); await settle();
    expect(current.api.error).toBeNull();
    expect(current.api.rows.map(row => row.team)).toEqual(["a", "b"]);
  });
});

describe("grouped column presentation", () => {
  it.each(["resize", "reorder"] as const)("keeps rows and both metric scopes stable on column %s", async kind => {
    const initial = grouped();
    initial.where = [{ field: "n", op: ">", value: "0" }];
    initial.orderBy = [{ field: "n", dir: "desc" }];
    initial.limit = 1;
    const validateQuery = vi.fn();
    const current = mount({ initialQuery: initial, validateQuery }); await settle();
    const beforeRows = current.api.rows;
    const beforeMetrics = current.api.aggregations.results;
    expect(beforeMetrics?.metrics.map(metric => metric.buckets[0]?.value)).toEqual([2, 2]);
    validateQuery.mockClear();

    act(() => {
      if (kind === "resize") current.api.select.setWidth("n", 240);
      else current.api.select.move("n", 0);
    });
    await settle();
    if (kind === "resize") expect(current.api.select.visible.find(column => column.field === "n")?.width).toBe(240);
    else expect(current.api.select.visible.map(column => column.field)).toEqual(["n", "team"]);
    expect(current.api.rows).toBe(beforeRows);
    expect(current.api.aggregations.results).toBe(beforeMetrics);
    expect(validateQuery).not.toHaveBeenCalled();

    // A real source change still recomputes and validates the updated stage.
    const filter = { field: "team", op: "=" as const, value: "a" };
    act(() => current.api.grouping!.source.addFilter(filter)); await settle();
    expect(current.api.rows).not.toBe(beforeRows);
    expect(current.api.aggregations.results?.metrics.map(metric => metric.buckets[0]?.value)).toEqual([1, 2]);
    expect(validateQuery).toHaveBeenCalledWith(expect.objectContaining({
      grouping: expect.objectContaining({ source: expect.objectContaining({ where: [filter] }) }),
    }));
  });

  it("preserves default key columns when adding a key to an empty SELECT", async () => {
    const initial = { ...grouped(), select: [] };
    const current = mount({ initialQuery: initial }); await settle();
    expect(current.api.select.visible).toEqual([{ field: "team" }]);
    act(() => current.api.grouping!.changeKeys(["team", "region"])); await settle();
    expect(current.api.select.visible).toEqual([{ field: "region" }, { field: "team" }]);
    expect(current.api.query.grouping!.keys).toEqual(["team", "region"]);
    expect(current.api.rows).toHaveLength(3);
    act(() => current.api.undo()); await settle();
    expect(current.api.query.select).toEqual([]);
    expect(current.api.select.visible).toEqual([{ field: "team" }]);
  });

  it("retains explicit column order, widths and hidden keys when adding a group key", async () => {
    const initial = { ...grouped(), select: [{ field: "n", width: 240 }] };
    const current = mount({ initialQuery: initial }); await settle();
    act(() => current.api.grouping!.changeKeys(["team", "region"])); await settle();
    expect(current.api.select.visible).toEqual([{ field: "region" }, { field: "n", width: 240 }]);
  });
});

describe("grouped refresh continuity", () => {
  it.each(["refresh", "auto refresh", "source WHERE", "clientRows"] as const)("retains rows throughout %s debounce", async kind => {
    const current = mount(); await settle();
    let before = current.api.rows;
    current.renders.length = 0;
    if (kind === "clientRows") current.rerender({ clientRows: rows.slice(0, 2) });
    else if (kind === "auto refresh") {
      act(() => current.api.autoRefresh.start({ frequencyMs: 1000, turnOffAfterMs: 5000 }));
      expect(current.api.rows).toBe(before);
      // Starting also refreshes immediately. Commit that run, then inspect
      // the next scheduled tick before its debounce can complete.
      await advance(250);
      before = current.api.rows;
      await advance(750);
    } else act(() => {
      if (kind === "refresh") current.api.refresh();
      else current.api.grouping!.source.addFilter({ field: "team", op: "=", value: "a" });
    });
    expect(current.api.rows).toBe(before);
    await advance(199);
    expect(current.api.rows).toBe(before);
    expect(current.renders.every(render => render.rows.length > 0)).toBe(true);
    await settle();
    const changed = kind === "source WHERE" || kind === "clientRows";
    expect(current.api.rows).toHaveLength(changed ? 1 : 2);
    expect(current.api.aggregations.error).toBeNull();
    expect(current.api.aggregations.results?.metrics.map(m => m.buckets[0]?.value)).toEqual(changed ? [1, 2] : [2, 3]);
  });

  it.each(["keys", "summary", "row mode", "source schema"] as const)("hides incompatible rows on a %s change", async kind => {
    const current = mount(); await settle();
    if (kind === "source schema") current.rerender({ schema: { ...schema, name: "another-table" } });
    else act(() => {
      if (kind === "keys") current.api.grouping!.changeKeys(["region"]);
      else if (kind === "row mode") current.api.grouping!.changeKeys([]);
      else current.api.grouping!.applyColumns([{ id: "n", op: "sum", field: "amount" }], current.api.query.select);
    });
    expect(current.api.rows).toEqual([]);
    await settle();
    expect(current.api.rows.length).toBeGreaterThan(0);
    expect(current.api.error).toBeNull();
  });
});

describe("reset baselines and custom storage", () => {
  it("uses current schema defaults when no saved view was loaded", async () => {
    const current = mount({ initialQuery: normalizeQueryState({ limit: 1 }) }); await settle();
    current.rerender({ schema: { ...schema, defaultSelect: [{ field: "region" }], defaultLimit: 75 } });
    act(() => current.api.resetAll()); await settle();
    expect(current.api.query).toEqual(current.api.defaults);
    expect(current.api.query.select).toEqual([{ field: "region" }]);
    expect(current.api.query.limit).toBe(75);
  });

  it.each([true, false])("uses current itemDetails defaults when toggled to %s", async enabled => {
    const current = mount({ initialQuery: normalizeQueryState({}), itemDetails: !enabled }); await settle();
    current.rerender({ itemDetails: enabled });
    act(() => current.api.resetAll()); await settle();
    expect(current.api.query).toEqual(current.api.defaults);
    expect(current.api.query.select.some(c => c.field === ITEM_DETAILS_COLUMN)).toBe(enabled);
  });

  it("retains an explicit saved baseline when defaults change within the same source", async () => {
    const current = mount(); await settle();
    const baseline = current.api.query;
    await act(async () => { await current.api.saved.save("Grouped totals"); });
    current.rerender({ schema: { ...schema, defaultSelect: [{ field: "region" }], defaultLimit: 75 }, itemDetails: true });
    act(() => current.api.grouping!.changeKeys([])); await settle();
    act(() => current.api.resetAll()); await settle();
    expect(current.api.query).toEqual(baseline);
  });

  it.each(["select", "where", "orderBy", "all"] as const)("normalizes custom saved views missing %s before taking a reset snapshot", async missing => {
    const raw: Partial<QueryState> = { select: [{ field: "region" }], where: [{ field: "team", op: "=", value: "a" }], orderBy: [{ field: "region", dir: "desc" }], limit: 1 };
    for (const key of ["select", "where", "orderBy"] as const) if (missing === "all" || key === missing) delete raw[key];
    const storage = { ...memoryStorageAdapter(), listSaved: async () => [{ id: "old", name: "Old view", savedAt: 1, query: raw as QueryState }] };
    const current = mount({ storage, initialQuery: normalizeQueryState({}) }); await settle();
    const expected = normalizeQueryState(raw, current.api.defaults);
    act(() => current.api.saved.load("old")); await settle();
    expect(current.api.query).toEqual(expected);
    act(() => current.api.setLimit(99));
    act(() => current.api.resetAll()); await settle();
    expect(current.api.query).toEqual(expected);
    expect(raw).not.toHaveProperty("offset");
  });
});
