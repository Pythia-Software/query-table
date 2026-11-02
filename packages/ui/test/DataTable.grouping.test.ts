// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeQueryState, type FieldSchema, type GroupedRow, type QueryState } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { DataTable } from "../src/DataTable";
import { defaultRenderers } from "../src/renderers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "header-grouping", idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    { name: "region", label: "Region", type: "text", source: { kind: "backend" } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
  ],
};
const rows = [
  { id: 1, team: "a", region: "east", amount: 10 },
  { id: 2, team: "a", region: "west", amount: 20 },
  { id: 3, team: "b", region: "east", amount: 30 },
];
let root: Root;
let container: HTMLDivElement;
let api: QueryTableApi<GroupedRow>;
function Fixture({ initialQuery, withGrouping }: { initialQuery: QueryState; withGrouping: boolean }) {
  api = useQueryTable({ schema, initialQuery, clientRows: rows, debounceMs: 0 });
  return createElement(DataTable<GroupedRow>, {
    fields: api.visibleFields, rows: api.rows, query: api.query, onQueryChange: api.setQuery,
    renderers: defaultRenderers, rowId: api.rowId, grouping: withGrouping ? api.grouping : undefined,
  });
}
async function mount(initialQuery: QueryState = normalizeQueryState({}), withGrouping = true) {
  await act(async () => root.render(createElement(Fixture, { initialQuery, withGrouping })));
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
}
async function openHeader(field: string) {
  const th = document.querySelector<HTMLElement>(`th[data-qt-field="${field}"]`);
  expect(th, field).not.toBeNull();
  await act(async () => th!.click());
}
function menuItem(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.trim() === text);
}
async function select(text: string) {
  const item = menuItem(text);
  expect(item, text).toBeDefined();
  await act(async () => item!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
}
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

it("groups by a header, adds nothing for non-groupable fields, and ungroups back to the source query", async () => {
  const source = normalizeQueryState({ select: [{ field: "team" }, { field: "region" }, { field: "amount" }], where: [{ field: "amount", op: "gt", value: 5 }] });
  await mount(source);
  await openHeader("amount");
  expect(menuItem("Group By Amount")?.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLElement>('th[data-qt-field="amount"]')!.click());

  await openHeader("team");
  await select("Group By Team");
  expect(api.query.grouping?.keys).toEqual(["team"]);
  expect(api.rows).toHaveLength(2);

  // A single key is removed by Ungroup, not by a redundant key removal.
  await openHeader("team");
  expect(menuItem("Remove from Group By")).toBeUndefined();
  await select("Ungroup");
  expect(api.query.grouping).toBeUndefined();
  expect(api.query.where).toEqual(source.where);
  expect(api.query.select).toEqual(source.select);
});

it("removes one key of several from a key column header", async () => {
  await mount(normalizeQueryState({
    select: [{ field: "team" }, { field: "region" }],
    grouping: { keys: ["team", "region"], summaries: [], representative: null, source: normalizeQueryState({}) },
  }));
  expect(api.rows).toHaveLength(3);
  await openHeader("region");
  await select("Remove from Group By");
  expect(api.query.grouping?.keys).toEqual(["team"]);
  expect(api.rows).toHaveLength(2);
});

it("offers no grouping actions without the grouping controller", async () => {
  await mount(normalizeQueryState({ select: [{ field: "team" }, { field: "amount" }] }), false);
  await openHeader("team");
  expect(menuItem("Group By Team")).toBeUndefined();
  expect(menuItem("Ungroup")).toBeUndefined();
});
