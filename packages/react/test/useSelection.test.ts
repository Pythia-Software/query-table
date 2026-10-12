// @vitest-environment jsdom

import { act, createElement, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { RowId } from "@pythia-software/query-table-core";
import { useSelection, type SelectionApi } from "../src/useSelection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderSelection(initialDisplayedIds: RowId[], strict = false) {
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
    root.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe));
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

describe("useSelection editable ranges", () => {
  const page = Array.from({ length: 12 }, (_, index) => index + 1);

  it("grows and shrinks from a fixed anchor, including repeated endpoints", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(6, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 5, 6]));
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4]));
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4]));
    act(() => result.current.toggle(2, true));
    expect(result.current.selected).toEqual(new Set([2]));
    unmount();
  });

  it("resizes across both sides of the anchor", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(5));
    act(() => result.current.toggle(8, true));
    act(() => result.current.toggle(2, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 5]));
    act(() => result.current.toggle(6, true));
    expect(result.current.selected).toEqual(new Set([5, 6]));
    unmount();
  });

  it("preserves earlier ranges while resizing a new range", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(4, true));
    act(() => result.current.toggle(8));
    act(() => result.current.toggle(12, true));
    act(() => result.current.toggle(10, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 8, 9, 10]));
    act(() => result.current.toggle(7, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 7, 8]));
    unmount();
  });

  it("preserves preexisting checks when overlapping ranges shrink", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(3));
    act(() => result.current.toggle(6, true));
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(8, true));
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 5, 6]));
    unmount();
  });

  it("unchecks mixed spans and restores baseline checks when shrinking", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.replace([2, 3, 5, 6, 99]));
    act(() => result.current.toggle(3));
    act(() => result.current.toggle(5, true));
    expect(result.current.selected).toEqual(new Set([2, 6, 99]));
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([2, 5, 6, 99]));
    act(() => result.current.toggle(3, true));
    expect(result.current.selected).toEqual(new Set([2, 5, 6, 99]));
    unmount();
  });

  it("adds spans without shrinking or flipping existing checks", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(6, true));
    act(() => result.current.toggle(4, true, true));
    act(() => result.current.toggle(4, true, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 5, 6]));
    act(() => result.current.toggle(1, true));
    expect(result.current.selected).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    unmount();
  });

  it("forces an additive span after an uncheck gesture", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.replace([2, 3, 4, 5, 6]));
    act(() => result.current.toggle(3));
    act(() => result.current.toggle(5, true));
    act(() => result.current.toggle(4, true, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 6]));
    act(() => result.current.toggle(3, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 6]));
    unmount();
  });

  it("keeps modifier-only clicks as individual toggles", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(6, false, true));
    expect(result.current.selected).toEqual(new Set([2, 6]));
    act(() => result.current.toggle(8, true));
    expect(result.current.selected).toEqual(new Set([2, 6, 7, 8]));
    unmount();
  });

  it("starts a plain toggle when Shift has no anchor", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(4, true));
    act(() => result.current.toggle(6, true));
    expect(result.current.selected).toEqual(new Set([4, 5, 6]));
    unmount();
  });

  it.each([
    ["sort", [4, 3, 2, 1]],
    ["filter", [1, 2, 4]],
    ["page", [5, 6, 7, 8]],
  ] as const)("commits selections and resets the range after a %s change", (_name, ids) => {
    const { result, setDisplayedIds, unmount } = renderSelection([1, 2, 3, 4]);
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(3, true));
    act(() => setDisplayedIds([...ids]));
    // Returning to the original page must not revive its old anchor.
    act(() => setDisplayedIds([1, 2, 3, 4]));
    expect(result.current.selected).toEqual(new Set([1, 2, 3]));
    act(() => result.current.toggle(2, true));
    expect(result.current.selected).toEqual(new Set([1, 3]));
    unmount();
  });

  it("retains the range when refreshed row IDs have the same order", () => {
    const { result, setDisplayedIds, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(6, true));
    act(() => setDisplayedIds([...page]));
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([2, 3, 4]));
    unmount();
  });

  it("falls back to a toggle for an off-page anchor or endpoint", () => {
    const { result, unmount } = renderSelection([1, 2, 3, 4]);
    act(() => result.current.toggle(99));
    act(() => result.current.toggle(2, true));
    expect(result.current.selected).toEqual(new Set([99, 2]));
    act(() => result.current.toggle(3, true));
    expect(result.current.selected).toEqual(new Set([99, 2, 3]));
    act(() => result.current.toggle(98, true));
    expect(result.current.selected).toEqual(new Set([99, 2, 3, 98]));
    unmount();
  });

  it.each([true, false])("resets the active range after setting page checks to %s", (select) => {
    const { result, unmount } = renderSelection([1, 2, 3, 4]);
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(3, true));
    act(() => result.current.setPage([1, 2, 3, 4], select));
    expect(result.current.pageState([1, 2, 3, 4])).toBe(select ? "all" : "none");
    act(() => result.current.toggle(2, true));
    expect(result.current.selected).toEqual(new Set(select ? [1, 3, 4] : [2]));
    expect(result.current.pageState([1, 2, 3, 4])).toBe("some");
    unmount();
  });

  it("does not restore old checks after clear", () => {
    const { result, unmount } = renderSelection(page);
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(6, true));
    act(() => result.current.clear());
    act(() => result.current.toggle(4, true));
    expect(result.current.selected).toEqual(new Set([4]));
    unmount();
  });

  it("applies batched gestures once under React StrictMode", () => {
    const { result, unmount } = renderSelection(page, true);
    act(() => {
      result.current.toggle(2);
      result.current.toggle(6, true);
      result.current.toggle(4, true);
    });
    expect(result.current.selected).toEqual(new Set([2, 3, 4]));
    act(() => {
      result.current.toggle(8);
      result.current.toggle(10, true);
    });
    expect(result.current.selected).toEqual(new Set([2, 3, 4, 8, 9, 10]));
    unmount();
  });
});
