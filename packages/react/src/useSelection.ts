// useSelection — row selection for paged and re-sortable datasets.
//
//   - Editable Shift-click ranges with a fixed row-ID anchor and a snapshot of
//     the selection before the range, so earlier selections survive resizing.
//   - Display-order changes commit the selection and reset the active range.
//   - Indeterminate header checkbox + select-all-on-page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RowId } from "@pythia-software/query-table-core";

export interface SelectionApi {
  selected: Set<RowId>;
  isSelected: (id: RowId) => boolean;
  /** Toggle one row and start an editable range. With `shiftKey`, resize that
   *  range in the current page's order, checking or unchecking according to the
   *  anchor's toggle. `additive` + Shift adds a span to the current selection.
   *  Missing anchors or changed display order fall back to a plain toggle. */
  toggle: (id: RowId, shiftKey?: boolean, additive?: boolean) => void;
  /** Select / clear every row currently on the page. */
  setPage: (ids: RowId[], selected: boolean) => void;
  /** Atomically replace the complete selection with arbitrary stable row ids. */
  replace: (ids: Iterable<RowId>) => void;
  /** Atomically retain only selected ids that are also present in `ids`. */
  retain: (ids: Iterable<RowId>) => void;
  /** Header checkbox tri-state for the current page. */
  pageState: (pageIds: RowId[]) => "none" | "some" | "all";
  clear: () => void;
  count: number;
}

interface SelectionRange {
  anchor: RowId;
  baseline: Set<RowId>;
  selecting: boolean;
  displayedIds: RowId[];
}

interface SelectionState {
  selected: Set<RowId>;
  range: SelectionRange | null;
}

function sameOrder(left: RowId[], right: RowId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** `displayedIds` is the page's id list in display order; the hook uses it to
 *  resolve shift-ranges and header tri-state against what the user sees. */
export function useSelection(displayedIds: RowId[]): SelectionApi {
  const [{ selected }, setState] = useState<SelectionState>(() => ({
    selected: new Set(),
    range: null,
  }));

  useEffect(() => {
    setState((prev) => prev.range && !sameOrder(prev.range.displayedIds, displayedIds)
      ? { selected: prev.selected, range: null }
      : prev);
  }, [displayedIds]);

  const toggle = useCallback(
    (id: RowId, shiftKey = false, additive = false) => {
      setState((prev) => {
        const range = prev.range;
        if (shiftKey && range && sameOrder(range.displayedIds, displayedIds)) {
          const i = displayedIds.indexOf(range.anchor);
          const j = displayedIds.indexOf(id);
          if (i !== -1 && j !== -1) {
            const [lo, hi] = i <= j ? [i, j] : [j, i];
            // Additive gestures commit the current range before adding another
            // span. Ordinary Shift gestures always rebuild from its baseline.
            const activeRange = additive
              ? { ...range, baseline: prev.selected, selecting: true }
              : range;
            const next = new Set(activeRange.baseline);
            for (const rowId of displayedIds.slice(lo, hi + 1)) {
              if (activeRange.selecting) next.add(rowId);
              else next.delete(rowId);
            }
            return { selected: next, range: activeRange };
          }
        }
        const next = new Set(prev.selected);
        const selecting = !next.has(id);
        if (selecting) next.add(id);
        else next.delete(id);
        return {
          selected: next,
          range: { anchor: id, baseline: prev.selected, selecting, displayedIds: [...displayedIds] },
        };
      });
    },
    [displayedIds],
  );

  const setPage = useCallback((ids: RowId[], select: boolean) => {
    setState((prev) => {
      const next = new Set(prev.selected);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return { selected: next, range: null };
    });
  }, []);

  const replace = useCallback((ids: Iterable<RowId>) => {
    const next = new Set(ids);
    setState({ selected: next, range: null });
  }, []);

  const retain = useCallback((ids: Iterable<RowId>) => {
    const allowed = new Set(ids);
    setState((prev) => {
      const next = new Set<RowId>();
      for (const id of prev.selected) if (allowed.has(id)) next.add(id);
      return { selected: next, range: null };
    });
  }, []);

  const pageState = useCallback(
    (pageIds: RowId[]): "none" | "some" | "all" => {
      if (pageIds.length === 0) return "none";
      let n = 0;
      for (const id of pageIds) if (selected.has(id)) n++;
      return n === 0 ? "none" : n === pageIds.length ? "all" : "some";
    },
    [selected],
  );

  const clear = useCallback(() => {
    setState({ selected: new Set(), range: null });
  }, []);

  return useMemo<SelectionApi>(
    () => ({
      selected,
      isSelected: (id) => selected.has(id),
      toggle,
      setPage,
      replace,
      retain,
      pageState,
      clear,
      count: selected.size,
    }),
    [selected, toggle, setPage, replace, retain, pageState, clear],
  );
}
