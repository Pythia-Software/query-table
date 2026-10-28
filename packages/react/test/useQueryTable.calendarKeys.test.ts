// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FieldSchema, type GroupedRow } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schema: FieldSchema<GroupedRow> = {
  name: "calendar-keys",
  idField: "id",
  fields: [
    { name: "team", label: "Team", type: "text", source: { kind: "backend" } },
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
  ],
};
const rows = [
  { id: 1, team: "a", at: "2026-03-08T06:30:00.000Z" },
  { id: 2, team: "a", at: "2026-03-08T07:30:00.000Z" },
  { id: 3, team: "b", at: "2026-03-09T05:59:00.000Z" },
];
let root: Root | undefined;
function mount() {
  const current = { api: undefined as unknown as QueryTableApi<GroupedRow> };
  function Probe() {
    current.api = useQueryTable({ schema, clientRows: rows, debounceMs: 0 });
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

describe("calendar grouping keys", () => {
  it("groups by a local day, exposes the key in the view and hides it by field", async () => {
    const current = mount();
    await settle();
    const day = { field: "at", interval: "day" as const, timeZone: "America/Denver" };
    act(() => current.api.grouping!.changeKeys([day, "team"]));
    await settle();
    expect(current.api.error).toBeNull();
    expect(current.api.grouping!.view.keys).toEqual(["at", "team"]);
    expect(current.api.grouping!.view.groupKeys).toEqual([day, "team"]);
    expect(current.api.rows.map((row) => [row.at, row.team]).sort()).toEqual([
      ["2026-03-07T07:00:00.000Z", "a"],
      ["2026-03-08T07:00:00.000Z", "a"],
      ["2026-03-08T07:00:00.000Z", "b"],
    ]);
    expect(current.api.schema!.fields.find((field) => field.name === "at")?.label).toBe("At (day)");
    act(() => current.api.select.hide("at"));
    await settle();
    expect(current.api.query.grouping!.keys).toEqual(["team"]);
    expect(current.api.total).toBe(2);
  });
});
