// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FieldSchema, StorageAdapter, Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";

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
  it("does not recompute client rows for a width-only query change", () => {
    const { result, unmount } = renderQueryTable({ clientRows });
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

  it("does not refetch transport rows for widths, but does for a changed projection", () => {
    const fetchRows = vi.fn(async () => ({ rows: clientRows, total: clientRows.length }));
    const { result, unmount } = renderQueryTable({ transport: { fetchRows } });
    advance(20);
    expect(fetchRows).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setQuery((query) => ({
        ...query,
        select: query.select.map((column) => ({ ...column, width: 240 })),
      }));
    });
    advance(100);
    expect(fetchRows).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setQuery((query) => ({
        ...query,
        select: [...query.select, { field: "status" }],
      }));
    });
    advance(20);
    expect(fetchRows).toHaveBeenCalledTimes(2);
    unmount();
  });
});
