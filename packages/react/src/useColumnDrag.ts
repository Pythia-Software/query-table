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
  /** Changes only for confirmed drops, so surfaces can persist auxiliary positions. */
  dropRevision?: number;
  /** Begin dragging `field` at `index`. Supply the surface order for cross-surface mapping. */
  start: (field: string, index: number, order?: string[]) => void;
  /** Update the insertion slot and optional surface order (no-op if unchanged). */
  over: (index: number, order?: string[]) => void;
  /** End the drag (on drop or cancel). */
  end: (committed?: boolean) => void;
  /** The live order to render while dragging: `source` moved to `overIndex`.
   *  Returns `order` unchanged when idle, or when `source` isn't in `order`. */
  preview: (order: string[]) => string[];
}

interface DragState {
  source: string;
  overIndex: number;
  order: string[] | undefined;
  moved: boolean;
}

export function useColumnDrag(): ColumnDragApi {
  const [state, setState] = useState<DragState | null>(null);
  const [dropRevision, setDropRevision] = useState(0);

  const start = useCallback(
    (field: string, index: number, order?: string[]) =>
      setState({
        source: field,
        overIndex: index,
        order: order?.slice(),
        moved: false,
      }),
    [],
  );
  const over = useCallback(
    (index: number, order?: string[]) =>
      // Keep the SAME object reference when unchanged so React can bail out of the
      // re-render — onDragOver fires continuously while the cursor moves.
      setState((s) => {
        if (!s) return s;
        if (
          s.moved &&
          s.overIndex === index &&
          ((!order && !s.order) ||
            (order &&
              s.order &&
              order.length === s.order.length &&
              order.every((name, i) => name === s.order![i])))
        )
          return s;
        return {
          source: s.source,
          overIndex: index,
          order: order?.slice(),
          moved: true,
        };
      }),
    [],
  );
  const end = useCallback((committed = false) => {
    if (committed) setDropRevision((revision) => revision + 1);
    setState(null);
  }, []);

  const preview = useCallback(
    (order: string[]): string[] => {
      if (!state || (state.order && !state.moved)) return order;
      const without = order.filter((n) => n !== state.source);
      if (without.length === order.length) return order; // source not part of this list
      let at = Math.max(0, Math.min(state.overIndex, without.length));
      if (state.order) {
        // Surfaces can contain different auxiliary columns (e.g. selection).
        // Resolve the slot against shared neighboring fields, not raw indices.
        const reference = state.order.filter((name) => name !== state.source);
        const slot = Math.max(0, Math.min(state.overIndex, reference.length));
        const following = reference
          .slice(slot)
          .find((name) => without.includes(name));
        const preceding = reference
          .slice(0, slot)
          .reverse()
          .find((name) => without.includes(name));
        if (following != null) at = without.indexOf(following);
        else if (preceding != null) at = without.indexOf(preceding) + 1;
      }
      return [...without.slice(0, at), state.source, ...without.slice(at)];
    },
    [state],
  );

  return useMemo(
    () => ({
      source: state?.source ?? null,
      overIndex: state?.overIndex ?? null,
      active: state != null,
      dropRevision,
      start,
      over,
      end,
      preview,
    }),
    [state, dropRevision, start, over, end, preview],
  );
}
