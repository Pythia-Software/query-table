// SelectionToolbar — the bulk-action FRAME, not the actions.
//
// Deliberately generic: it shows the selected count, a clear-all, and an
// `actions` slot. The actual verbs (xlsx-collect's keep/delete/restore state
// machine, xplo-perf export) are domain logic the consumer renders into the
// slot. The reusable part is the selection plumbing + affordance; the verbs are
// not. This keeps domain coupling out of the package while still shipping the
// pattern.

import type { ReactNode } from "react";
import type { RowId } from "@query-table/core";
import type { SelectionApi } from "@query-table/react";

export interface SelectionToolbarProps {
  selection: SelectionApi;
  /** Consumer-rendered action buttons. Receives the selected ids so the consumer
   *  can gate/enable actions (e.g. mixed-state rules). */
  actions: (selectedIds: RowId[]) => ReactNode;
  /** Hidden when nothing is selected unless `alwaysShow`. */
  alwaysShow?: boolean;
  className?: string;
}

const cx = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(" ");

export function SelectionToolbar({ selection, actions, alwaysShow, className }: SelectionToolbarProps): ReactNode {
  if (selection.count === 0 && !alwaysShow) return null;

  const selectedIds = [...selection.selected];

  return (
    <div className={cx("qt-selection-toolbar", className)} role="toolbar">
      <span className="qt-selection-count">
        {selection.count} selected
      </span>
      <button
        type="button"
        className="qt-btn"
        onClick={selection.clear}
        disabled={selection.count === 0}
      >
        clear
      </button>
      <span className="qt-selection-actions">{actions(selectedIds)}</span>
    </div>
  );
}
