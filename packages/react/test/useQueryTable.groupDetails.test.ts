// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEM_DETAILS_COLUMN, normalizeQueryState, type FieldSchema, type GroupedRow, type QueryState } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schema: FieldSchema<GroupedRow> = {
  name: "human-messages",
  idField: "id",
  fields: [
    { name: "conversation", label: "Conversation", type: "text", source: { kind: "backend" } },
    { name: "words", label: "Words", type: "number", source: { kind: "backend" } },
  ],
};
const rows: GroupedRow[] = [
  { id: 1, conversation: "alpha", words: 10 },
  { id: 2, conversation: "alpha", words: 30 },
  { id: 3, conversation: "beta", words: 5 },
  { id: 4, conversation: null, words: 7 },
];
const grouped = (overrides: Partial<QueryState> = {}) => normalizeQueryState({
  grouping: {
    source: normalizeQueryState({ select: [{ field: "conversation" }, { field: "words" }], itemDetails: { modes: ["modal"] } }),
    keys: ["conversation"],
    summaries: [
      { id: "messages", op: "count" },
      { id: "word_total", op: "sum", field: "words" },
      { id: "records", op: "link", label: "Records", link: { label: "Matching records", to: { kind: "query", target: "messages" } } },
    ],
    representative: null,
  },
  select: [{ field: "conversation" }, { field: "messages" }, { field: "word_total" }, { field: "records" }, { field: ITEM_DETAILS_COLUMN }],
  orderBy: [{ field: "conversation", dir: "asc" }],
  limit: 2,
  ...overrides,
});

let root: Root | undefined;
function mount(options: Partial<UseQueryTableOptions<GroupedRow>>) {
  const current = { api: undefined as unknown as QueryTableApi<GroupedRow>, options };
  function Probe() {
    current.api = useQueryTable({ schema, clientRows: rows, debounceMs: 0, itemDetails: { modes: ["modal", "expand", "page"], defaultModes: ["modal", "expand"] }, ...current.options });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return Object.assign(current, {
    rerender(next: Partial<UseQueryTableOptions<GroupedRow>>) {
      current.options = { ...current.options, ...next };
      act(() => root!.render(createElement(Probe)));
    },
  });
}
async function settle() {
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}
const idOf = (api: QueryTableApi<GroupedRow>, key: string | null) =>
  api.rowId(api.rows.find((row) => row.conversation === key)!)!;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe("group details", () => {
  it("shows a group's keys, summaries and links from its grouped row", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    const details = current.api.itemDetails!;
    expect(details.subject).toBe("group");
    // Page templates address source items; groups keep the in-place modes.
    expect(details.availableModes).toEqual(["modal", "expand"]);
    // Detail can follow the link summaries in the grouped select.
    expect(current.api.query.select.map((column) => column.field).slice(-2)).toEqual(["records", ITEM_DETAILS_COLUMN]);
    const alpha = idOf(current.api, "alpha");
    act(() => details.open(alpha, "modal"));
    await settle();
    const record = current.api.itemDetails!.record!;
    expect(record.row).toMatchObject({ conversation: "alpha", messages: 2, word_total: 40 });
    expect(current.api.itemDetails!.schema.defaultSelect!.map((column) => column.field))
      .toEqual(["conversation", "messages", "word_total", "records"]);
    // The group's state lives in the grouped query; source item details are untouched.
    expect(current.api.query.itemDetails!.active).toEqual({ id: alpha, mode: "modal" });
    expect(current.api.query.grouping!.source.itemDetails!.active).toBeUndefined();
  });

  it("keeps an open group across pages and reads null keys", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    const alpha = idOf(current.api, "alpha");
    act(() => current.api.itemDetails!.open(alpha, "expand"));
    await settle();
    act(() => current.api.nextPage());
    await settle();
    expect(current.api.rows.some((row) => current.api.rowId(row) === alpha)).toBe(false);
    expect(current.api.itemDetails!.record!.row).toMatchObject({ conversation: "alpha", word_total: 40 });
    const empty = idOf(current.api, null);
    act(() => current.api.itemDetails!.open(empty, "modal"));
    await settle();
    expect(current.api.itemDetails!.record!.row).toMatchObject({ conversation: null, messages: 1 });
  });

  it("reports a group missing from a changed population as unavailable", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    const beta = idOf(current.api, "beta");
    act(() => current.api.itemDetails!.open(beta, "modal"));
    await settle();
    expect(current.api.itemDetails!.record).not.toBeNull();
    act(() => current.api.grouping!.source.addFilter({ field: "conversation", op: "=", value: "alpha" }));
    await settle();
    expect(current.api.itemDetails!.active).toEqual({ id: beta, mode: "modal" });
    expect(current.api.itemDetails!.loading).toBe(false);
    expect(current.api.itemDetails!.record).toBeNull();
  });

  it("restores an open group from its query, as after a URL reload", async () => {
    const first = mount({ initialQuery: grouped() });
    await settle();
    const alpha = idOf(first.api, "alpha");
    act(() => first.api.itemDetails!.open(alpha, "modal"));
    await settle();
    const saved = first.api.query;
    act(() => root!.unmount());
    root = undefined;
    const reopened = mount({ initialQuery: saved });
    expect(reopened.api.itemDetails!.loading).toBe(true);
    await settle();
    expect(reopened.api.itemDetails!.record!.row).toMatchObject({ conversation: "alpha" });
  });

  it("returns to ordinary item details when grouping ends", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    act(() => current.api.itemDetails!.open(idOf(current.api, "alpha"), "modal"));
    await settle();
    act(() => current.api.grouping!.changeKeys([]));
    await settle();
    expect(current.api.query.grouping).toBeUndefined();
    expect(current.api.itemDetails!.subject).toBeUndefined();
    expect(current.api.itemDetails!.active).toBeNull();
    act(() => current.api.itemDetails!.open(1, "modal"));
    await settle();
    expect(current.api.itemDetails!.record!.row).toMatchObject({ id: 1, conversation: "alpha" });
  });

  it("keeps source filter metadata callbacks stable across renders", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    const { filterValues, fieldStats } = current.api.grouping!.source;
    act(() => current.api.nextPage());
    await settle();
    act(() => current.api.itemDetails!.open(idOf(current.api, null), "modal"));
    await settle();
    expect(current.api.grouping!.source.filterValues).toBe(filterValues);
    expect(current.api.grouping!.source.fieldStats).toBe(fieldStats);
  });

  it("drops groups seen before the data source changed", async () => {
    const current = mount({ initialQuery: grouped() });
    await settle();
    const beta = idOf(current.api, "beta");
    act(() => current.api.itemDetails!.open(beta, "modal"));
    await settle();
    expect(current.api.itemDetails!.record!.row).toMatchObject({ conversation: "beta", messages: 1 });
    // New rows without beta: the open group is unavailable, not its old summary.
    current.rerender({ clientRows: rows.filter((row) => row.conversation !== "beta") });
    await settle();
    expect(current.api.itemDetails!.active).toEqual({ id: beta, mode: "modal" });
    expect(current.api.itemDetails!.loading).toBe(false);
    expect(current.api.itemDetails!.record).toBeNull();
  });
});
