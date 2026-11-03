// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FieldSchema, StorageAdapter, Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
import { memoryV3Transport, metricRequests, rowRequests } from "./v3Transport";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name: string;
  status: string;
}

const schema: FieldSchema<Row> = {
  name: "row-pipeline",
  idField: "id",
  defaultLimit: 100,
  defaultSelect: [{ field: "name" }],
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
    { name: "status", label: "Status", type: "text", source: { kind: "backend" } },
  ],
};

const clientRows: Row[] = [
  { id: 1, name: "alpha", status: "ready" },
  { id: 2, name: "bravo", status: "done" },
];

const storage: StorageAdapter = {
  loadLast: async () => null,
  saveLast: async () => {},
  listSaved: async () => [],
  saveNamed: async (key, name, query, savedAt) => ({ id: key, name, savedAt, query }),
  deleteSaved: async () => {},
};

function renderQueryTable(options: { clientRows?: Row[]; transport?: Transport<Row> }) {
  const result = { current: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    result.current = useQueryTable<Row>({ schema, storage, debounceMs: 20, ...options });
    return null;
  }

  const container = document.createElement("div");
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });
  return { result, unmount: () => act(() => root.unmount()) };
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useQueryTable row pipeline", () => {
  it("computes client field cardinality and delegates server stats", async () => {
    const local = renderQueryTable({
      clientRows: [
        { id: 1, name: "alpha", status: "ready" },
        { id: 2, name: "bravo", status: "ready" },
      ],
    });
    await expect(local.result.current.fieldStats(["status", "name"])).resolves.toEqual({
      status: { distinct: 1 },
      name: { distinct: 2 },
    });
    local.unmount();

    const transport = memoryV3Transport<Row>(
      Array.from({ length: 7 }, (_, i) => ({ id: i, name: "n", status: `s${i}` })), schema);
    const remote = renderQueryTable({ transport });
    await expect(
      remote.result.current.fieldStats(["status", "missing"]),
    ).resolves.toEqual({ status: { distinct: 7, min: "s0", max: "s6" } });
    expect(metricRequests(transport).map((request) => request.metrics)).toEqual([[
      { id: "status:distinct", op: "count_distinct", field: "status", groupBy: [] },
      { id: "status:min", op: "min", field: "status", groupBy: [] },
      { id: "status:max", op: "max", field: "status", groupBy: [] },
    ]]);
    remote.unmount();
  });

  it("does not recompute client rows for a width-only query change", async () => {
    const { result, unmount } = renderQueryTable({ clientRows });
    await act(async () => {});
    advance(20);
    const rowsBeforeResize = result.current.rows;

    act(() => {
      result.current.setQuery((query) => ({
        ...query,
        select: query.select.map((column) =>
          column.field === "name" ? { ...column, width: 240 } : column,
        ),
      }));
    });
    advance(100);

    expect(result.current.query.select[0]?.width).toBe(240);
    expect(result.current.rows).toBe(rowsBeforeResize);
    unmount();
  });

  it("does not refetch transport rows for widths, but does for a changed projection", async () => {
    const transport = memoryV3Transport(clientRows, schema);
    const { result, unmount } = renderQueryTable({ transport });
    await act(async () => {});
    advance(20);
    await act(async () => {});
    expect(rowRequests(transport)).toHaveLength(1);

    act(() => {
      result.current.setQuery((query) => ({
        ...query,
        select: query.select.map((column) => ({ ...column, width: 240 })),
      }));
    });
    advance(100);
    expect(rowRequests(transport)).toHaveLength(1);

    act(() => {
      result.current.setQuery((query) => ({
        ...query,
        select: [...query.select, { field: "status" }],
      }));
    });
    advance(20);
    expect(rowRequests(transport)).toHaveLength(2);
    unmount();
  });

  it("keeps replacement stable when a filter changes in the same interaction", () => {
    const { result, unmount } = renderQueryTable({ clientRows });
    advance(20);
    act(() => result.current.selection.setPage([1, 2], true));

    act(() => {
      result.current.addFilter({ field: "status", op: "=", value: "ready" });
      result.current.selection.replace([1]);
    });
    advance(20);

    expect(result.current.rows.map((row) => row.id)).toEqual([1]);
    expect([...result.current.selection.selected]).toEqual([1]);
    unmount();
  });
});
