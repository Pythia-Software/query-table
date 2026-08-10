// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  encodeQuery,
  EMPTY_QUERY,
  MAX_QUERY_LIMIT,
  MAX_QUERY_OFFSET,
  type FieldSchema,
  type QueryState,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "../src/useQueryTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name: string;
}

const schema: FieldSchema<Row> = {
  name: "things",
  idField: "id",
  defaultLimit: 100,
  defaultSelect: [{ field: "name" }],
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};

function renderHook<R>(useHook: () => R) {
  const container = document.createElement("div");
  let root!: Root;
  const result = { current: undefined as unknown as R };

  function Probe() {
    result.current = useHook();
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    unmount() {
      act(() => root.unmount());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useQueryTable security defaults", () => {
  it("does not read, rewrite, or durably store URL query state by default", () => {
    const sensitive: QueryState = {
      ...EMPTY_QUERY,
      where: [{ field: "name", op: "contains", value: "customer-secret" }],
    };
    const token = encodeQuery(sensitive);
    window.history.replaceState(null, "", `/?q=${token}`);

    const { result, unmount } = renderHook(() => useQueryTable<Row>({ schema, clientRows: [] }));

    expect(result.current.query.where).toEqual([]);
    expect(window.location.search).toBe(`?q=${token}`);
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.length).toBe(0);
    expect(window.location.search).toBe(`?q=${token}`);

    unmount();
  });

  it("normalizes imperative query updates before they can trigger a fetch", () => {
    const { result, unmount } = renderHook(() => useQueryTable<Row>({ schema, clientRows: [] }));

    act(() => {
      result.current.setQuery({
        ...EMPTY_QUERY,
        limit: Number.MAX_SAFE_INTEGER,
        offset: Number.MAX_SAFE_INTEGER,
      });
    });

    expect(result.current.query.limit).toBe(MAX_QUERY_LIMIT);
    expect(result.current.query.offset).toBe(MAX_QUERY_OFFSET);
    unmount();
  });
});
