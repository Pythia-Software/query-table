// useColumnDrag — transient, SHARED state for a column-reorder drag. One instance
// is owned by useQueryTable and read by BOTH the table headers and the
// QueryBuilder select chips, so a drag started in either surface live-previews
// (and dims) the same column in the other. It holds no query state; the reorder
// is committed to QueryState.select by whichever surface handles the drop.

import { useCallback, useMemo, useState } from "react";

export interface ColumnDragApi {
  /** Field name currently being dragged, or null when idle. */
  source: string | null;
  /** Insertion index within the order with `source` removed (0..n; n = append). */
  overIndex: number | null;
  /** True while a column drag is in progress. */
  active: boolean;
  /** Begin dragging `field`, initially previewed at `index` (its own slot). */
  start: (field: string, index: number) => void;
  /** Update the previewed insertion index (no-op if unchanged). */
  over: (index: number) => void;
  /** End the drag (on drop or cancel). */
  end: () => void;
  /** The live order to render while dragging: `source` moved to `overIndex`.
   *  Returns `order` unchanged when idle, or when `source` isn't in `order`. */
  preview: (order: string[]) => string[];
}

interface DragState {
  source: string;
  overIndex: number;
}

export function useColumnDrag(): ColumnDragApi {
  const [state, setState] = useState<DragState | null>(null);

  const start = useCallback((field: string, index: number) => setState({ source: field, overIndex: index }), []);
  const over = useCallback(
    (index: number) =>
      // Keep the SAME object reference when unchanged so React can bail out of the
      // re-render — onDragOver fires continuously while the cursor moves.
      setState((s) => (s && s.overIndex !== index ? { source: s.source, overIndex: index } : s)),
    [],
  );
  const end = useCallback(() => setState(null), []);

  const preview = useCallback(
    (order: string[]): string[] => {
      if (!state) return order;
      const without = order.filter((n) => n !== state.source);
      if (without.length === order.length) return order; // source not part of this list
      const at = Math.max(0, Math.min(state.overIndex, without.length));
      return [...without.slice(0, at), state.source, ...without.slice(at)];
    },
    [state],
  );

  return useMemo(
    () => ({
      source: state?.source ?? null,
      overIndex: state?.overIndex ?? null,
      active: state != null,
      start,
      over,
      end,
      preview,
    }),
    [state, start, over, end, preview],
  );
}
