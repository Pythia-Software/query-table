// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FieldSchema, Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name?: string;
  active?: boolean;
  tags?: string[] | null;
  metadata?: { tags: string[] };
}

const schema: FieldSchema<Row> = {
  name: "filter-values",
  idField: "id",
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
    { name: "active", label: "Active", type: "bool", source: { kind: "backend" } },
    { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" } },
    { name: "nestedTags", label: "Nested tags", type: "textarray", source: { kind: "backend", path: "metadata.tags" } },
    { name: "derivedTags", label: "Derived tags", type: "textarray", source: { kind: "derived", accessor: (row: Row) => row.tags } },
  ],
};

const roots: Root[] = [];

function renderQueryTable(clientRows: Row[], transport?: Transport<Row>) {
  const result = { current: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    result.current = useQueryTable({ schema, clientRows, ...(transport ? { transport } : {}) });
    return null;
  }
  act(() => {
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    root.render(createElement(Probe));
  });
  return result;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

describe("useQueryTable filter values", () => {
  it("suggests distinct sorted array elements without a transport", async () => {
    const result = renderQueryTable([
      { id: 1, tags: ["beta", "alpha", "beta"] },
      { id: 2, tags: ["gamma", "alpha"] },
    ]);

    await expect(result.current.filterValues("tags", "")).resolves.toEqual({
      values: ["alpha", "beta", "gamma"], hasMore: false, hasNull: false,
    });
    await expect(result.current.filterValues("tags", "  ALP  ")).resolves.toEqual({
      values: ["alpha"], hasMore: false, hasNull: false,
    });
    await expect(result.current.filterValues("tags", "missing")).resolves.toEqual({
      values: [], hasMore: false, hasNull: false,
    });
  });

  it("preserves null-as-empty metadata while skipping empty arrays and nulls", async () => {
    const result = renderQueryTable([
      { id: 1, tags: [] },
      { id: 2, tags: null },
      { id: 3 },
      { id: 4, tags: ["alpha"] },
    ]);

    await expect(result.current.filterValues("tags", "")).resolves.toEqual({
      values: ["alpha"], hasMore: false, hasNull: true,
    });
  });

  it("reads array elements through backend paths and derived accessors", async () => {
    const result = renderQueryTable([
      { id: 1, tags: ["derived"], metadata: { tags: ["nested"] } },
    ]);

    await expect(result.current.filterValues("nestedTags", "")).resolves.toEqual({
      values: ["nested"], hasMore: false, hasNull: false,
    });
    await expect(result.current.filterValues("derivedTags", "")).resolves.toEqual({
      values: ["derived"], hasMore: false, hasNull: false,
    });
  });

  it("caps distinct elements, not rows, and reports only additional matches", async () => {
    const tags = Array.from({ length: 50 }, (_, index) => `tag-${String(index).padStart(2, "0")}`);
    const exact = renderQueryTable([{ id: 1, tags: [...tags, ...tags] }]);
    await expect(exact.current.filterValues("tags", "")).resolves.toEqual({
      values: tags, hasMore: false, hasNull: false,
    });

    const overflow = renderQueryTable([{ id: 1, tags: [...tags, "extra"] }]);
    await expect(overflow.current.filterValues("tags", "")).resolves.toEqual({
      values: tags, hasMore: true, hasNull: false,
    });
    await expect(overflow.current.filterValues("tags", "tag-")).resolves.toEqual({
      values: tags, hasMore: false, hasNull: false,
    });
  });

  it("preserves scalar suggestions", async () => {
    const result = renderQueryTable([
      { id: 1, name: "beta", active: false },
      { id: 2, name: "alpha", active: true },
      { id: 3, name: "alpha", active: false },
    ]);
    await expect(result.current.filterValues("name", "")).resolves.toEqual({
      values: ["alpha", "beta"], hasMore: false, hasNull: false,
    });
    await expect(result.current.filterValues("id", "")).resolves.toEqual({
      values: ["1", "2", "3"], hasMore: false, hasNull: false,
    });
    await expect(result.current.filterValues("active", "")).resolves.toEqual({
      values: ["false", "true"], hasMore: false, hasNull: false,
    });
  });

  it("uses local arrays when the transport has no distinct-value lookup", async () => {
    const result = renderQueryTable([{ id: 1, tags: ["local"] }], {
      fetchRows: async () => ({ rows: [], total: 0 }),
    });
    await expect(result.current.filterValues("tags", "")).resolves.toEqual({
      values: ["local"], hasMore: false, hasNull: false,
    });
  });

  it("still delegates suggestions to an available transport", async () => {
    const response = { values: ["remote"], hasMore: true, hasNull: true };
    const fetchDistinctValues = vi.fn(async () => response);
    const result = renderQueryTable([{ id: 1, tags: ["local"] }], {
      fetchRows: async () => ({ rows: [], total: 0 }),
      fetchDistinctValues,
    });
    await expect(result.current.filterValues("tags", "rem")).resolves.toEqual(response);
    expect(fetchDistinctValues).toHaveBeenCalledWith({ field: "tags", search: "rem" });
  });
});
