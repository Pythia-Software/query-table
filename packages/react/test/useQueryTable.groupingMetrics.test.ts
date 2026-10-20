// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAggregations, decodeQuery, encodeQuery, memoryStorageAdapter,
  memoryComputedColumnStore, normalizeQueryState, type AggregationClause, type FieldSchema, type GroupedRow,
  type QueryState,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "metric-transitions", idField: "id",
  fields: [
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "created", label: "Created", type: "datetime", source: { kind: "backend" } },
  ],
};
const rows: GroupedRow[] = [["z", 20], ["z", 40], ["a", 90], ["m", null], ["b", 10], ["b", 30]].map(([team, amount], i) => ({
  id: i + 1, team, amount, created: "2026-10-13T12:00:00Z",
}));
const metric = (id: string, expression: string, extra: Partial<AggregationClause> = {}): AggregationClause => ({ id, op: "count", groupBy: [], expression, ...extra });
function query(extra: Partial<QueryState> = {}): QueryState {
  return normalizeQueryState({
    grouping: {
      source: normalizeQueryState({ limit: 1, offset: 99, aggregations: [metric("source", "SUM([amount])")] }),
      keys: ["team"], summaries: [
        { id: "n", op: "count" }, { id: "sum_amount", op: "sum", field: "amount" },
        { id: "mean_amount", op: "avg", field: "amount" },
      ], representative: null,
    },
    select: [{ field: "team" }], orderBy: [{ field: "n", dir: "desc" }, { field: "team", dir: "asc" }], limit: 1,
    aggregations: [metric("all", "COUNT()"), metric("sum", "SUM([sum_amount])"),
      metric("page", "COUNT()", { scope: "shownRows" }), metric("page-sum", "SUM([sum_amount])", { scope: "shownRows" })],
    ...extra,
  });
}
let root: Root | undefined;
function mount(overrides: Partial<UseQueryTableOptions<GroupedRow>> = {}) {
  let options: UseQueryTableOptions<GroupedRow> = { schema, clientRows: rows, debounceMs: 0, initialQuery: query(), ...overrides };
  const current = { api: undefined as unknown as QueryTableApi<GroupedRow>, rerender(next: Partial<UseQueryTableOptions<GroupedRow>>) {
    options = { ...options, ...next };
    act(() => root!.render(createElement(Probe)));
  } };
  function Probe() { current.api = useQueryTable(options); return null; }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return current;
}
async function settle(ms = 50) {
  // Flush both the page commit and the shown-page metric effect it schedules.
  for (let i = 0; i < 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function values(api: QueryTableApi<GroupedRow>) {
  expect(api.error).toBeNull();
  expect(api.aggregations.error).toBeNull();
  expect(api.aggregations.loading).toBe(false);
  expect(api.aggregations.results?.metrics.every(m => !m.error && m.buckets.every(b => !b.error))).toBe(true);
  return api.aggregations.results!.metrics.map(m => m.buckets[0]?.value);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; vi.useRealTimers(); });

describe("grouped metric lifecycle", () => {
  it("keeps both scopes correct through paging, sort reversal, HAVING and source WHERE", async () => {
    const current = mount(); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    for (const [offset, sum] of [[1, 60], [2, 90], [3, null], [4, null]] as const) {
      act(() => current.api.setOffset(offset)); await settle();
      expect(values(current.api)).toEqual([4, 190, offset < 4 ? 1 : 0, sum]);
    }
    act(() => current.api.setSort([{ field: "sum_amount", dir: "desc" }])); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 90]);
    act(() => current.api.addFilter({ field: "n", op: ">=", value: "2" })); await settle();
    expect(values(current.api)).toEqual([2, 100, 1, 60]);
    act(() => current.api.setLimit(2)); await settle();
    expect(values(current.api)).toEqual([2, 100, 2, 100]);
    act(() => current.api.grouping!.source.addFilter({ field: "amount", op: ">", value: "20" })); await settle();
    expect(values(current.api)).toEqual([0, null, 0, null]);
    act(() => current.api.clearFilters()); await settle();
    expect(values(current.api)).toEqual([3, 160, 2, 130]);
  });

  it("waits for the committed grouped page before previewing shown-row metrics", async () => {
    const current = mount({ debounceMs: 100 }); await settle(300);
    act(() => current.api.setOffset(1));
    const before = current.api.query;
    await expect(current.api.aggregations.preview!(current.api.aggregations.clauses)).rejects.toThrow("current table page");
    await settle(300);
    const preview = await current.api.aggregations.preview!(current.api.aggregations.clauses);
    expect(preview.metrics.map(m => m.buckets[0]?.value)).toEqual([4, 190, 1, 60]);
    expect(current.api.query).toBe(before);
    act(() => current.api.grouping!.source.addFilter({ field: "amount", op: ">", value: "20" }));
    await expect(current.api.aggregations.preview!(current.api.aggregations.clauses)).rejects.toThrow("current table page");
    await settle(300);
    const changed = await current.api.aggregations.preview!(current.api.aggregations.clauses);
    expect(changed.metrics.map(m => m.buckets[0]?.value)).toEqual([3, 160, 1, 90]);
    await settle(300);
    expect(values(current.api)).toEqual([3, 160, 1, 90]);
  });

  it("keeps core, preview and hook results identical for empty/null group keys and plain metrics", async () => {
    const input = [{ id: 1, team: "", amount: 10 }, { id: 2, team: null, amount: 20 }, { id: 3, team: "x", amount: null }];
    const q = query({ aggregations: [
      { id: "plain", op: "sum", field: "sum_amount", groupBy: ["team"] },
      metric("formula", "SUM([sum_amount])", { groupBy: ["team"] }),
    ] });
    const current = mount({ clientRows: input, initialQuery: q }); await settle();
    const expected = applyAggregations(input, q, schema);
    expect(expected.metrics[0]!.buckets).toHaveLength(3);
    expect(current.api.aggregations.results).toEqual(expected);
    expect(await current.api.aggregations.preview!(q.aggregations!)).toEqual(expected);
  });

  it("updates both scopes when the host replaces its source rows, including failure and recovery", async () => {
    const current = mount(); await settle();
    current.rerender({ clientRows: [...rows, { id: 7, team: "b", amount: 100 }] }); await settle();
    expect(values(current.api)).toEqual([4, 290, 1, 140]);
    current.rerender({ clientRows: [{ id: 7, team: {}, amount: 100 }] }); await settle();
    expect(current.api.error).toBeTruthy();
    expect(current.api.rows).toEqual([]);
    expect(current.api.aggregations.results).toBeNull();
    expect(current.api.aggregations.error).toBeTruthy();
    current.rerender({ clientRows: [] }); await settle();
    expect(values(current.api)).toEqual([0, null, 0, null]);
    current.rerender({ clientRows: rows }); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
  });

  it("round-trips metrics, scopes, HAVING and paging through saved views, reset, URL, undo and redo", async () => {
    const storage = memoryStorageAdapter();
    const current = mount({ storage }); await settle();
    act(() => current.api.addFilter({ field: "n", op: ">", value: "1" }));
    act(() => current.api.setOffset(1)); await settle();
    const savedQuery = current.api.query;
    let id = "";
    await act(async () => { id = (await current.api.saved.save("Grouped dashboard")).id; });
    expect(decodeQuery(encodeQuery(savedQuery))).toEqual(savedQuery);
    expect(values(current.api)).toEqual([2, 100, 1, 60]);
    act(() => current.api.grouping!.changeKeys([])); await settle();
    expect(values(current.api)).toEqual([190]);
    act(() => current.api.saved.load(id)); await settle();
    expect(values(current.api)).toEqual([2, 100, 1, 60]);
    act(() => current.api.clearFilters()); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    act(() => current.api.undo()); await settle();
    expect(values(current.api)).toEqual([2, 100, 1, 60]);
    act(() => current.api.redo()); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    act(() => current.api.resetAll()); await settle();
    expect(current.api.query).toEqual(savedQuery);
    expect(values(current.api)).toEqual([2, 100, 1, 60]);
  });

  it("refreshes relative source WHERE and HAVING using the same evaluation clock", async () => {
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const q = query();
    q.grouping!.source.where = [{ field: "created", op: ">=", value: "-1h" }];
    q.grouping!.summaries.push({ id: "last_created", op: "max", field: "created" });
    q.where = [{ field: "last_created", op: ">=", value: "-1h" }];
    const current = mount({ initialQuery: q, debounceMs: 100,
      clientRows: [{ id: 1, team: "a", amount: 10, created: "2026-10-13T11:00:00.050Z" }] });
    await settle(300);
    expect(current.api.total).toBe(1);
    expect(values(current.api)).toEqual([1, 10, 1, 10]);
    act(() => current.api.refresh()); await settle(300);
    expect(values(current.api)).toEqual([0, null, 0, null]);
  });

  it("retains metrics when columns are hidden or added, and clears them when aggregate meaning changes", async () => {
    const current = mount(); await settle();
    act(() => current.api.select.show("sum_amount")); await settle();
    act(() => current.api.select.hide("sum_amount")); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    act(() => current.api.grouping!.addSummary("max", "amount")); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    act(() => current.api.grouping!.changeSummary("sum_amount", "min")); await settle();
    expect(current.api.aggregations.clauses).toEqual([]);
    expect(current.api.aggregations.results).toBeNull();
    act(() => current.api.undo()); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
    act(() => current.api.grouping!.changeKeys(["team", "amount"])); await settle();
    expect(current.api.aggregations.clauses).toEqual([]);
    act(() => current.api.undo()); await settle();
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
  });

  it("invalidates all kinds of representative-dependent metrics and retains independent formulas", async () => {
    const q = query({ aggregations: [] });
    q.grouping!.representative = { orderBy: [{ field: "amount", dir: "desc", nulls: "last" }] };
    q.grouping!.summaries.push({ id: "chosen_amount", op: "row", field: "amount" });
    const current = mount({ initialQuery: q, computedColumnStore: memoryComputedColumnStore() }); await settle();
    await act(async () => { await current.api.computed.save({ id: "twice", label: "Twice chosen", expression: { language: "qt-expr", version: 1, source: "[chosen_amount] * 2" } }, null); });
    await settle();
    const clauses = [
      metric("independent", "SUM([sum_amount])"),
      metric("row", "SUM([chosen_amount])"),
      metric("scatter", "COUNT()", { expressionY: "SUM([chosen_amount])", display: { kind: "scatter" } }),
      metric("box", "COUNT()", { distribution: { kind: "box", input: "[chosen_amount]" }, display: { kind: "box" } }),
      metric("row-groups", "COUNT()", { groupBy: ["chosen_amount"] }),
      metric("computed", "SUM([@computed/twice])"),
    ];
    act(() => current.api.aggregations.replace!(clauses)); await settle();
    expect(values(current.api).slice(0, 2)).toEqual([190, 160]);
    act(() => current.api.grouping!.changeRepresentative({ orderBy: [{ field: "amount", dir: "asc", nulls: "last" }] })); await settle();
    expect(current.api.aggregations.clauses.map(c => c.id)).toEqual(["independent"]);
    expect(values(current.api)).toEqual([190]);
    act(() => current.api.undo()); await settle();
    expect(current.api.aggregations.clauses).toEqual(clauses);
    expect(values(current.api).slice(0, 2)).toEqual([190, 160]);
  });

  it("passes draft grouped metrics to the host validator before previewing", async () => {
    const validateQuery = vi.fn((q: QueryState) => {
      if (q.grouping && q.aggregations?.some(m => m.id === "blocked")) throw Error("Host rejects this metric");
    });
    const current = mount({ validateQuery }); await settle();
    await expect(current.api.aggregations.preview!([metric("blocked", "COUNT()")])).rejects.toThrow("Host rejects this metric");
    expect(values(current.api)).toEqual([4, 190, 1, 40]);
  });
});
