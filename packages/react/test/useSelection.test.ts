// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { RowId } from "@pythia-software/query-table-core";
import { useSelection, type SelectionApi } from "../src/useSelection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderSelection(initialDisplayedIds: RowId[]) {
  const result = { current: undefined as unknown as SelectionApi };
  let setDisplayedIds!: (ids: RowId[]) => void;

  function Probe() {
    const [displayedIds, updateDisplayedIds] = useState(initialDisplayedIds);
    setDisplayedIds = updateDisplayedIds;
    result.current = useSelection(displayedIds);
    return null;
  }

  const container = document.createElement("div");
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    setDisplayedIds,
    unmount: () => act(() => root.unmount()),
  };
}

function selected(selection: SelectionApi): RowId[] {
  return [...selection.selected];
}

describe("useSelection arbitrary-id mutations", () => {
  it("replaces the selection with on-page and off-page ids and collapses duplicates", () => {
    const { result, unmount } = renderSelection([1, 2, 3]);
    act(() => result.current.setPage([1, 2], true));
    act(() => result.current.replace([2, 9, 9]));

    expect(selected(result.current)).toEqual([2, 9]);
    expect(result.current.count).toBe(2);
    unmount();
  });

  it("resets the range anchor after replacement", () => {
    const { result, unmount } = renderSelection([1, 2, 3, 4]);
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(3, true));
    expect(selected(result.current)).toEqual([1, 2, 3]);

    act(() => result.current.replace([99]));
    act(() => result.current.toggle(4, true));
    expect(selected(result.current)).toEqual([99, 4]);
    unmount();
  });

  it("retains only the intersection and resets the range anchor", () => {
    const { result, unmount } = renderSelection([1, 2, 3, 4]);
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(3, true));
    act(() => result.current.retain([2, 4, 8]));
    expect(selected(result.current)).toEqual([2]);

    act(() => result.current.toggle(4, true));
    expect(selected(result.current)).toEqual([2, 4]);
    unmount();
  });

  it("treats an empty replacement like clear", () => {
    const { result, unmount } = renderSelection([1, 2]);
    act(() => result.current.setPage([1, 2], true));
    act(() => result.current.replace([]));

    expect(selected(result.current)).toEqual([]);
    expect(result.current.count).toBe(0);
    unmount();
  });

  it("keeps replacement stable when displayed ids change in the same interaction", () => {
    const { result, setDisplayedIds, unmount } = renderSelection([1, 2, 3]);
    act(() => result.current.setPage([1, 2, 3], true));

    act(() => {
      setDisplayedIds([2]);
      result.current.replace([2, 9]);
    });

    expect(selected(result.current)).toEqual([2, 9]);
    unmount();
  });
});
