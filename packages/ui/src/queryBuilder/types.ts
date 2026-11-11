// Public prop types for QueryBuilder: QueryBuilderProps and SelectPresentation.

import type { MetricTheme } from "../metricColors";
import { type ReactNode } from "react";
import type {
  FieldDef,
  SavedQuery,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { QueryBuilderClassNames } from "../classNames";

export interface QueryBuilderProps<Row> {
  /** Collect unused clauses into a compact row of add actions. */
  compact?: boolean;
  /** Additional clauses, inserted after WHERE and before ORDER BY. */
  clauses?: ReactNode;
  /** Replace WHERE when its inputs belong to a different result stage. */
  whereRow?: ReactNode;
  /** Host-owned summary shown when the editor is collapsed. */
  summary?: ReactNode;
  selectPresentation?: SelectPresentation;
  /** Match/share the entire host definition when it contains more than QueryState. */
  matchesSavedQuery?: (saved: SavedQuery) => boolean;
  /** Replace the built-in saved-query controls with host-owned controls. */
  savedQueryControls?: ReactNode;
  shareUrl?: string;
  /** Additional diagnostics shown inside request activity. */
  requestActivityDetails?: ReactNode;
  /** Host content after auto-update status and before Request activity.
   * Remains mounted when the editor is collapsed; the host owns its behavior. */
  runActionsBeforeActivity?: ReactNode;
  /** The controller; QueryBuilder drives it through the intent helpers. */
  api: QueryTableApi<Row>;
  /** All schema fields (for the field picker / sort picker). */
  fields: FieldDef<Row>[];
  /** Total matching rows, for the "N of M" paging hint. */
  total: number | null;
  /** Disable inputs while a fetch is in flight. */
  running?: boolean;
  classNames?: QueryBuilderClassNames;
  /** Use this to control collapse state from a parent UI. */
  collapsed?: boolean;
  /** Controlled collapse callback (use when `collapsed` is provided). */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Initial collapse state for uncontrolled mode. */
  defaultCollapsed?: boolean;
  metricTheme?: MetricTheme;
  metricLocale?: string;
}

export interface SelectPresentation {
  /** Replaces a chip's label; existing drag and remove controls are retained. */
  renderChip?: (field: string, label: string) => ReactNode;
  /** Replaces the add-column picker; call onClose after a selection or dismissal. */
  renderPicker?: (onClose: () => void) => ReactNode;
  renderEditor?: (onClose: () => void) => ReactNode;
  hint?: ReactNode;
  editorNotice?: ReactNode;
}
