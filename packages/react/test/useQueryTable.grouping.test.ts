// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  memoryStorageAdapter,
  normalizeQueryState,
  type FieldSchema,
  type GroupedRow,
} from "@pythia-software/query-table-core";
import {
  useQueryTable,
  type QueryTableApi,
  type UseQueryTableOptions,
} from "../src/useQueryTable";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "grouping-hooks",
  idField: "id",
  defaultSelect: [{ field: "team" }, { field: "amount" }],
  fields: [
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    {
      name: "amount",
      label: "Amount",
      type: "number",
      source: { kind: "backend" },
    },
  ],
};
const rows = [
  { id: 1, team: "a", amount: 10 },
  { id: 2, team: "a", amount: 30 },
  { id: 3, team: "b", amount: 50 },
];
let root: Root | undefined;
function mount(options: Partial<UseQueryTableOptions<GroupedRow>> = {}) {
  const current = { api: undefined as unknown as QueryTableApi<GroupedRow> };
  function Probe() {
    current.api = useQueryTable({
      schema,
      clientRows: rows,
      debounceMs: 0,
      ...options,
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return current;
}
async function settle() {
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe("standard query table grouping", () => {
  it("switches modes atomically and restores source columns, metrics, paging and item details", async () => {
    const original = normalizeQueryState({
      select: [{ field: "amount", width: 180 }],
      limit: 1,
      offset: 1,
      aggregations: [{ id: "source-count", op: "count", groupBy: [] }],
      itemDetails: { modes: ["modal"] },
    });
    const current = mount({ initialQuery: original, itemDetails: true });
    await settle();
    expect(current.api.itemDetails).toBeDefined();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    expect(current.api.error).toBeNull();
    expect(current.api.query.grouping!.source).toEqual(original);
    expect(current.api.itemDetails).toBeUndefined();
    expect(current.api.grouping!.source.itemDetails).toBeDefined();
    expect(current.api.aggregations.clauses).toEqual([]);
    expect(current.api.total).toBe(2);
    expect(current.api.rowId(current.api.rows[0]!)).toBeTypeOf("string");
    act(() => current.api.grouping!.addSummary("avg", "amount"));
    await settle();
    const grouped = current.api.query;
    expect(current.api.rows[0]![grouped.grouping!.summaries[0]!.id]).toBe(20);
    act(() => current.api.select.hide("team"));
    await settle();
    expect(current.api.query).toEqual(original);
    expect(current.api.itemDetails).toBeDefined();
    act(() => current.api.undo());
    await settle();
    expect(current.api.query).toEqual(grouped);
    act(() => current.api.redo());
    await settle();
    expect(current.api.query).toEqual(original);
  });

  it("keeps source WHERE and group HAVING separate, and metrics target the result", async () => {
    const current = mount();
    await settle();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    act(() => current.api.grouping!.addSummary("count"));
    await settle();
    const count = current.api.query.grouping!.summaries[0]!.id;
    act(() => current.api.addFilter({ field: count, op: ">", value: "1" }));
    await settle();
    expect(current.api.rows.map((row) => row.team)).toEqual(["a"]);
    act(() => current.api.aggregations.add({ op: "count", groupBy: [] }));
    await settle();
    expect(
      current.api.aggregations.results?.metrics[0]?.buckets[0]?.value,
    ).toBe(1);
    act(() =>
      current.api.grouping!.source.addFilter({
        field: "amount",
        op: ">",
        value: "20",
      }),
    );
    await settle();
    expect(current.api.total).toBe(0);
    expect(current.api.query.where).toHaveLength(1);
    expect(current.api.query.grouping!.source.where).toHaveLength(1);
    expect(
      current.api.aggregations.results?.metrics[0]?.buckets[0]?.value,
    ).toBe(0);
  });

  it("persists grouping and resets to the loaded saved view", async () => {
    const storage = memoryStorageAdapter();
    const current = mount({ storage });
    await settle();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    act(() => current.api.grouping!.addSummary("sum", "amount"));
    await settle();
    const snapshot = current.api.query;
    let id = "";
    await act(async () => {
      id = (await current.api.saved.save("Totals")).id;
    });
    act(() => current.api.grouping!.changeKeys([]));
    await settle();
    act(() => current.api.saved.load(id));
    await settle();
    expect(current.api.query).toEqual(snapshot);
    act(() => current.api.setLimit(1));
    await settle();
    act(() => current.api.resetAll());
    await settle();
    expect(current.api.query).toEqual(snapshot);
    expect((await storage.listSaved(schema.name))[0]!.query).toEqual(snapshot);
  });

  it("does not restore another saved view's remembered group layout", async () => {
    const storage = memoryStorageAdapter();
    const saved = await storage.saveNamed(
      schema.name,
      "Rows",
      normalizeQueryState({ select: schema.defaultSelect }),
      1,
    );
    const current = mount({ storage });
    await settle();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    act(() => current.api.grouping!.addSummary("count"));
    await settle();
    act(() => current.api.grouping!.changeKeys([]));
    await settle();
    act(() => current.api.saved.load(saved.id));
    await settle();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    expect(current.api.query.grouping!.summaries).toEqual([]);
  });

  it("invalidates row-value consumers while retaining independent aggregate metrics", async () => {
    const current = mount();
    await settle();
    act(() => current.api.grouping!.changeKeys(["team"]));
    await settle();
    act(() =>
      current.api.grouping!.changeRepresentative({
        orderBy: [{ field: "amount", dir: "desc", nulls: "last" }],
      }),
    );
    await settle();
    act(() => current.api.grouping!.addSummary("row", "amount"));
    await settle();
    const rowColumn = current.api.query.grouping!.summaries[0]!.id;
    act(() => current.api.addFilter({ field: rowColumn, op: ">", value: "1" }));
    act(() =>
      current.api.aggregations.add({
        op: "sum",
        field: rowColumn,
        groupBy: [],
      }),
    );
    act(() => current.api.aggregations.add({ op: "count", groupBy: [] }));
    await settle();
    act(() => current.api.grouping!.changeRepresentative(null));
    await settle();
    expect(current.api.query.where).toEqual([]);
    expect(current.api.query.select.some((c) => c.field === rowColumn)).toBe(
      false,
    );
    expect(current.api.aggregations.clauses.map((c) => c.op)).toEqual([
      "count",
    ]);
  });

  it("rejects a saved grouped query before contacting an unsupported transport", async () => {
    const fetchRows = vi.fn(async () => ({ rows, total: 3 }));
    const current = mount({
      transport: { fetchRows },
      initialQuery: normalizeQueryState({
        grouping: {
          keys: ["team"],
          summaries: [],
          representative: null,
          source: normalizeQueryState({}),
        },
      }),
    });
    await settle();
    expect(current.api.error?.message).toMatch(/server with grouped-query support/);
    expect(current.api.rows).toEqual([]);
    expect(fetchRows).not.toHaveBeenCalled();
    act(() => current.api.grouping!.changeKeys([]));
    await settle();
    expect(fetchRows).toHaveBeenCalled();
    expect(current.api.error).toBeNull();
  });

  it("lets hosts explicitly disable grouping", async () => {
    const current = mount({ grouping: false });
    await settle();
    expect(current.api.grouping).toBeUndefined();
    expect(current.api.rows).toHaveLength(3);
  });
});
