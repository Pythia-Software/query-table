// useSelection — row selection with both projects' behaviors merged.
//
//   - xplo-perf: shift-click range select, anchored by ROW ID (not index) so a
//     range survives re-sort / re-filter / paging. Index anchors break the moment
//     the data reorders; id anchors don't.
//   - xlsx-collect: indeterminate header checkbox + select-all-on-page.

import { useCallback, useMemo, useRef, useState } from "react";
import type { RowId } from "@query-table/core";

export interface SelectionApi {
  selected: Set<RowId>;
  isSelected: (id: RowId) => boolean;
  /** Toggle one row. With `shiftKey`, extend from the last-toggled anchor to `id`
   *  across the *currently displayed* order (falls back to a plain toggle if the
   *  anchor row is no longer present). */
  toggle: (id: RowId, shiftKey?: boolean) => void;
  /** Select / clear every row currently on the page. */
  setPage: (ids: RowId[], selected: boolean) => void;
  /** Header checkbox tri-state for the current page. */
  pageState: (pageIds: RowId[]) => "none" | "some" | "all";
  clear: () => void;
  count: number;
}

/** `displayedIds` is the page's id list in display order; the hook uses it to
 *  resolve shift-ranges and header tri-state against what the user sees. */
export function useSelection(displayedIds: RowId[]): SelectionApi {
  const [selected, setSelected] = useState<Set<RowId>>(() => new Set());
  const anchor = useRef<RowId | null>(null);

  const toggle = useCallback(
    (id: RowId, shiftKey = false) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const a = anchor.current;
        if (shiftKey && a != null) {
          const i = displayedIds.indexOf(a);
          const j = displayedIds.indexOf(id);
          if (i !== -1 && j !== -1) {
            const [lo, hi] = i <= j ? [i, j] : [j, i];
            // Extend selection (turn the whole span on) — matches xplo-perf.
            for (let k = lo; k <= hi; k++) next.add(displayedIds[k]!);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchor.current = id;
        return next;
      });
    },
    [displayedIds],
  );

  const setPage = useCallback((ids: RowId[], select: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
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
    anchor.current = null;
    setSelected(new Set());
  }, []);

  return useMemo<SelectionApi>(
    () => ({
      selected,
      isSelected: (id) => selected.has(id),
      toggle,
      setPage,
      pageState,
      clear,
      count: selected.size,
    }),
    [selected, toggle, setPage, pageState, clear],
  );
}
