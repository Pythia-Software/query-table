import type { QueryFilterApi } from "@pythia-software/query-table-react";
import { useGroupingPresentation } from "./grouping/GroupingControls";
import {
  PresentedFilterValue,
  PresentedValueInput,
  useFilterValuePresentation,
} from "./FilterValuePresentation";
// QueryBuilder — the chip toolbar: WHERE filters, SELECT columns, ORDER BY
// (multi-sort, reorderable), and LIMIT/OFFSET paging. Type-aware filter inputs
// (enum/static <select>, value autocomplete via Transport.fetchDistinctValues).
// Hosts the Save / saved-queries entry point.
//
// Combines a chip layout, autocomplete, draggable column chips, a grouped
// picker, per-clause operators, and multi-sort.

import { RequestActivity } from "./RequestActivity";
import { MetricsEditor } from "./MetricsEditor";
import type { MetricTheme } from "./metricColors";
import { SelectColumnEditor } from "./SelectColumnEditor";
import { SortExtractionEditor } from "./SortExtractionEditor";
import { SortPicker } from "./SortPicker";
import { SetFilterEditor } from "./SetFilterEditor";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  FieldDef,
  FilterOp,
  OpChoice,
  OrderByClause,
  WhereClause,
  WhereTerm,
  SetFilterMetadata,
  SavedQuery,
} from "@pythia-software/query-table-core";
import {
  NULLARY_OPS,
  ITEM_DETAILS_COLUMN,
  MAX_WHERE_CLAUSES,
  filterValues as filterValuesFor,
  isOrGroup,
  opPairsForField,
  negateClause,
  predicatesOf,
  queriesEqual,
  isFilterable,
  isSelectable,
  isSortable,
  opsForField,
  createSetFilter,
  readSetFilter,
  setFilterTarget,
  type SetFilterTarget,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { QueryBuilderClassNames } from "./classNames";
import { PickerAnchor } from "./PickerAnchor";
import { FieldPicker } from "./FieldPicker";
import { SavedQueriesModal } from "./SavedQueriesModal";
import { formatRowCount, rowCountTitle } from "./formatRowCount";
import {
  ModalSurface,
  useMobileLayout,
} from "./AdaptiveOverlay";
import { ReorderList } from "./ReorderList";
import { Icon } from "./Icon";
import { MenuButton, MenuGroup, MenuItem } from "./Menu";
import { Popover } from "./Popover";
import { FilterValueAutocomplete } from "./FilterValueAutocomplete";

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

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

const MAX_AUTO_REFRESH_POLLS = 1000;
const DEFAULT_AUTO_REFRESH_FREQUENCY_MS = 20_000;
const DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS = 5 * 60_000;
const SHARE_FEEDBACK_MS = 2_000;

const AUTO_REFRESH_FREQUENCIES = [
  { label: "Every 5s", value: 5_000 },
  { label: "Every 10s", value: 10_000 },
  { label: "Every 20s", value: DEFAULT_AUTO_REFRESH_FREQUENCY_MS },
  { label: "Every 30s", value: 30_000 },
  { label: "Every 1m", value: 60_000 },
  { label: "Every 2m", value: 2 * 60_000 },
  { label: "Every 5m", value: 5 * 60_000 },
  { label: "Every 10m", value: 10 * 60_000 },
] as const;

const AUTO_REFRESH_TURN_OFF_AFTER = [
  { label: "After 5m", value: DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS },
  { label: "After 15m", value: 15 * 60_000 },
  { label: "After 30m", value: 30 * 60_000 },
  { label: "After 1h", value: 60 * 60_000 },
  { label: "After 2h", value: 2 * 60 * 60_000 },
  { label: "After 4h", value: 4 * 60 * 60_000 },
  { label: "After 8h", value: 8 * 60 * 60_000 },
  { label: "After 12h", value: 12 * 60 * 60_000 },
  { label: "After 24h", value: 24 * 60 * 60_000 },
] as const;

function autoRefreshPolls(frequencyMs: number, turnOffAfterMs: number): number {
  if (frequencyMs <= 0 || turnOffAfterMs <= 0) return Infinity;
  return Math.floor(turnOffAfterMs / frequencyMs);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${minutes}m`;
}

function formatStatusTime(ms: number | null): string {
  if (ms == null) return "never";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function useFieldHasNull<Row>(
  api: QueryFilterApi<Row>,
  fieldName: string | undefined,
): boolean | undefined {
  const [hasNull, setHasNull] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!fieldName) return;
    let cancelled = false;

    void api
      .filterValues(fieldName, "")
      .then((r) => {
        if (!cancelled && typeof r.hasNull === "boolean") {
          setHasNull(r.hasNull);
        }
      })
      .catch(() => {
        if (!cancelled) setHasNull(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [api.filterValues, fieldName]);

  return hasNull;
}

/** Operators dropped from the WHERE op dropdowns: their negation is expressed by
 *  the canonical positive op plus the NOT toggle instead (design: "just support
 *  NOT"). Legacy queries carrying these ops still decode/compile fine, and a
 *  clause already on one keeps showing it (see PredicateEditor). */
const CONVERGED_NEGATIVE_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  "!=",
  "is_not_null",
  "not_matches_regex",
]);

/** The op options offered for a field in the WHERE builder — its positive ops,
 *  with the converged negatives removed (NOT toggle covers those). */
function positiveOpsForField<Row>(field: FieldDef<Row>): FilterOp[] {
  return opsForField(field).filter((op) => !CONVERGED_NEGATIVE_OPS.has(op));
}

function predicateAsText<Row>(
  clause: WhereClause,
  byName: Map<string, FieldDef<Row>>,
): string {
  const field = byName.get(clause.field)?.label ?? clause.field;
  if (clause.value === "0" && clause.op === "length_eq") {
    return `${field} is ${clause.negated ? "not " : ""}empty string`;
  }
  if (clause.value === "0" && clause.op === "length_gt" && !clause.negated)
    return `${field} is not empty string`;
  const op = clause.op.replace(/_/g, " ");
  const not = clause.negated ? "not " : "";
  if (NULLARY_OPS.has(clause.op)) return `${field} ${not}${op}`;
  const strategy = byName.get(clause.field)?.filter?.values;
  const option =
    strategy?.source === "static"
      ? strategy.options.find(
          (o) => typeof o !== "string" && o.value === clause.value,
        )
      : undefined;
  const value =
    clause.value === ""
      ? "''"
      : typeof option === "object"
        ? option.label
        : clause.value;
  return `${field} ${not}${op} ${value}`;
}

function whereTermAsText<Row>(
  term: WhereTerm,
  byName: Map<string, FieldDef<Row>>,
): string {
  if (isOrGroup(term))
    return `(${term.any.map((c) => predicateAsText(c, byName)).join(" or ")})`;
  return predicateAsText(term, byName);
}

function orderByAsText<Row>(
  term: OrderByClause,
  byName: Map<string, FieldDef<Row>>,
): string {
  const field = byName.get(term.field)?.label ?? term.field;
  const expression = term.extract
    ? `regex_extract(${field}, /${term.extract.regex}/)`
    : field;
  const nulls = term.nulls ? ` nulls ${term.nulls}` : "";
  return `${expression} ${term.dir}${nulls}`;
}

function chipFieldWidthChars(text: string, fallback = 5, max = 30): number {
  return Math.min(max, Math.max(fallback, (text || "").length + 1));
}

function chipFieldWidthForInput(
  text: string,
  fieldType: string | undefined,
  fallback = 5,
  padding = 0,
): number {
  const cap = fieldType === "number" ? 10 : 30;
  return chipFieldWidthChars(text, fallback, cap) + padding;
}

function chipFieldWidthForSelect(text: string, fallback = 3, max = 30): number {
  return chipFieldWidthChars(text, fallback, max) + 2;
}

function buildCollapsedSummary<Row>(
  where: WhereTerm[],
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  const whereText = whereClauseSummaryText(where, byName);
  const orderText =
    orderBy.length === 0
      ? "(default)"
      : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
  return `WHERE ${whereText} ORDER BY ${orderText}`;
}

function whereClauseSummaryText<Row>(
  where: WhereTerm[],
  byName: Map<string, FieldDef<Row>>,
): string {
  return where.length === 0
    ? "all rows"
    : where.map((t) => whereTermAsText(t, byName)).join(" and ");
}

function orderBySummaryText<Row>(
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  return orderBy.length === 0
    ? "(default)"
    : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
}

export function QueryBuilder<Row>({
  api,
  fields,
  total,
  running,
  classNames,
  collapsed,
  onCollapsedChange,
  defaultCollapsed = false,
  compact,
  metricTheme,
  metricLocale,
  requestActivityDetails,
  clauses,
  whereRow,
  summary,
  selectPresentation,
  matchesSavedQuery,
  savedQueryControls,
  shareUrl,
}: QueryBuilderProps<Row>): ReactNode {
  const groupingUI = useGroupingPresentation(api, clauses === undefined);
  const activeGrouping = api.query.grouping !== undefined && clauses === undefined;
  if (activeGrouping && api.schema) fields = api.schema.fields;
  compact ??= activeGrouping;
  clauses ??= groupingUI.clauses;
  whereRow ??= groupingUI.whereRow;
  summary ??= groupingUI.summary;
  selectPresentation ??= groupingUI.selectPresentation;
  const mobile = useMobileLayout();
  const UNSAVED_QUERY_EDIT_ID = "__qt-unsaved-query__";
  const [showSaved, setShowSaved] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const activityId = useId();
  const [showAutoRefresh, setShowAutoRefresh] = useState(false);
  const [autoRefreshFrequencyMs, setAutoRefreshFrequencyMs] = useState(
    DEFAULT_AUTO_REFRESH_FREQUENCY_MS,
  );
  const [autoRefreshTurnOffAfterMs, setAutoRefreshTurnOffAfterMs] = useState(
    DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS,
  );
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [editingSavedName, setEditingSavedName] = useState("");
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);
  const [collapsedFallback, setCollapsedFallback] = useState(defaultCollapsed);
  const collapsedControlled = typeof collapsed !== "undefined";
  const isCollapsed = collapsedControlled ? collapsed : collapsedFallback;
  const setCollapsed = (next: boolean) => {
    if (collapsedControlled) {
      onCollapsedChange?.(next);
      return;
    }
    setCollapsedFallback(next);
  };
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [lastFailureAt, setLastFailureAt] = useState<number | null>(null);
  const byName = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  const activeSavedQuery = useMemo(
    () => api.saved.items.find((item) =>
      matchesSavedQuery ? matchesSavedQuery(item) : queriesEqual(item.query, api.query),
    ),
    [api.query, api.saved.items, matchesSavedQuery],
  );
  const lastSavedQuery = useMemo(
    () => api.saved.items.find((item) => item.id === lastSavedId) ?? null,
    [api.saved.items, lastSavedId],
  );
  const isSavedQuery = activeSavedQuery != null;
  const isEditingUnsaved = editingSavedId === UNSAVED_QUERY_EDIT_ID;
  const bodyId = useId();
  const isEditingSaved =
    editingSavedId != null && activeSavedQuery?.id === editingSavedId;
  const showUpdateButton = api.saved.canUpdate && Boolean(lastSavedQuery) && !activeSavedQuery;
  const collapsedSummary = useMemo(
    () => buildCollapsedSummary(api.query.where, api.query.orderBy, byName),
    [api.query.where, api.query.orderBy, byName],
  );
  const collapsedWhereText = useMemo(
    () => whereClauseSummaryText(api.query.where, byName),
    [api.query.where, byName],
  );
  const collapsedOrderText = useMemo(
    () => orderBySummaryText(api.query.orderBy, byName),
    [api.query.orderBy, byName],
  );
  const autoRefreshStatus = api.autoRefresh.status;
  const selectedAutoRefreshPolls = autoRefreshPolls(
    autoRefreshFrequencyMs,
    autoRefreshTurnOffAfterMs,
  );
  const canSubmitAutoRefresh =
    selectedAutoRefreshPolls >= 1 &&
    selectedAutoRefreshPolls <= MAX_AUTO_REFRESH_POLLS;
  const autoRefreshButtonText = autoRefreshStatus
    ? `Auto-Update ${formatDuration(autoRefreshStatus.frequencyMs)}`
    : "Auto-Update";
  const rowSummary = `${formatRowCount(api.rows.length)} of ${total == null ? "?" : formatRowCount(total)}`;
  const rowSummaryTitle = [api.rows.length, ...(total == null ? [] : [total])]
    .map((count) => rowCountTitle(count))
    .some((title) => title != null)
    ? `${api.rows.length.toLocaleString()} of ${total == null ? "?" : total.toLocaleString()}`
    : undefined;
  const lastUpdatedText = formatStatusTime(lastUpdatedAt);
  const failureText = api.error
    ? `Error: ${api.error.message}`
    : lastFailureAt
      ? `Last failure at ${formatStatusTime(lastFailureAt)}`
      : null;
  const isBusy = Boolean(running) || api.loading || api.links.busy;
  const lastRowsRef = useRef<Row[] | null>(null);
  const lastTotalRef = useRef<number | null>(null);
  const previousLoadingRef = useRef(api.loading);
  const autoRefreshRef = useRef<HTMLButtonElement>(null);
  const shareFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(
    () => () => {
      if (shareFeedbackTimerRef.current)
        clearTimeout(shareFeedbackTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setShareCopied(false);
    if (shareFeedbackTimerRef.current) {
      clearTimeout(shareFeedbackTimerRef.current);
      shareFeedbackTimerRef.current = null;
    }
  }, [api.query]);

  useEffect(() => {
    if (activeSavedQuery) {
      setLastSavedId(activeSavedQuery.id);
      if (!isEditingSaved) {
        setEditingSavedName(activeSavedQuery.name);
        setEditingSavedId(null);
      }
      return;
    }

    if (!isEditingUnsaved) {
      setEditingSavedId(null);
      setEditingSavedName("");
    }
    // activeSavedQuery can become null if edits/loads shift to unsaved or another query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSavedQuery, isEditingSaved, isEditingUnsaved]);

  useEffect(() => {
    if (!lastSavedId || api.saved.items.some((item) => item.id === lastSavedId))
      return;
    setLastSavedId(null);
  }, [api.saved.items, lastSavedId]);

  useEffect(() => {
    const hasData = api.rows.length > 0 || total != null;
    const rowsChanged = lastRowsRef.current !== api.rows;
    const totalChanged = lastTotalRef.current !== total;
    const loadingDone = !api.loading;

    if (loadingDone && api.error) {
      setLastFailureAt(Date.now());
      lastRowsRef.current = api.rows;
      lastTotalRef.current = total;
      previousLoadingRef.current = api.loading;
      return;
    }

    if (
      loadingDone &&
      (previousLoadingRef.current ||
        rowsChanged ||
        totalChanged ||
        lastUpdatedAt == null) &&
      hasData
    ) {
      setLastUpdatedAt(Date.now());
      setLastFailureAt(null);
      lastRowsRef.current = api.rows;
      lastTotalRef.current = total;
    }
    previousLoadingRef.current = api.loading;
  }, [api.error, api.loading, api.rows, total, lastUpdatedAt]);

  function saveFailed(error: unknown): void {
    const message =
      error instanceof Error ? error.message : "Failed to save query.";
    if (typeof window !== "undefined") window.alert(message);
  }

  function beginEditSavedName() {
    if (activeSavedQuery) {
      setEditingSavedId(activeSavedQuery.id);
      setEditingSavedName(activeSavedQuery.name);
      return;
    }
    if (isEditingUnsaved) return;
    setEditingSavedId(UNSAVED_QUERY_EDIT_ID);
    setEditingSavedName((next) => (next ? next : "Custom Query"));
  }

  function cancelNameEdit() {
    setEditingSavedId(null);
    setEditingSavedName("");
  }

  async function persistSavedQuery(name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const saved = await api.saved.save(trimmed);
      setLastSavedId(saved.id);
      return saved.id;
    } catch (error) {
      saveFailed(error);
      return null;
    }
  }

  async function commitSavedNameEdit() {
    if (!isEditingSaved || !activeSavedQuery) return;
    const trimmed = editingSavedName.trim();
    if (!trimmed || trimmed === activeSavedQuery.name) {
      cancelNameEdit();
      return;
    }
    const savedId = await persistSavedQuery(trimmed);
    if (!savedId) return;
    await api.saved.remove(activeSavedQuery.id);
    cancelNameEdit();
  }

  async function commitUnsavedNameEdit() {
    if (!isEditingUnsaved) return;
    const savedId = await persistSavedQuery(editingSavedName);
    if (!savedId) {
      cancelNameEdit();
      return;
    }
    cancelNameEdit();
  }

  async function updateLastSavedQuery() {
    if (!lastSavedQuery) return;
    try {
      const saved = await api.saved.update(lastSavedQuery.id);
      setLastSavedId(saved.id);
    } catch (error) {
      saveFailed(error);
    }
  }

  function commitNameEditor() {
    if (isEditingSaved) {
      void commitSavedNameEdit();
      return;
    }
    if (isEditingUnsaved) {
      void commitUnsavedNameEdit();
      return;
    }
  }

  useEffect(() => {
    if (isCollapsed) setShowSaved(false);
  }, [isCollapsed]);

  useEffect(() => {
    if (!showAutoRefresh || !autoRefreshStatus) return;
    setAutoRefreshFrequencyMs(autoRefreshStatus.frequencyMs);
    setAutoRefreshTurnOffAfterMs(autoRefreshStatus.turnOffAfterMs);
  }, [showAutoRefresh, autoRefreshStatus]);

  function submitAutoRefresh() {
    if (!canSubmitAutoRefresh) return;
    try {
      api.autoRefresh.start({
        frequencyMs: autoRefreshFrequencyMs,
        turnOffAfterMs: autoRefreshTurnOffAfterMs,
      });
      setShowAutoRefresh(false);
    } catch (error) {
      saveFailed(error);
    }
  }

  async function shareQuery() {
    if (typeof window === "undefined") return;
    let url: URL;
    try { url = new URL(shareUrl ?? (await api.links.create()).url); }
    catch (error) { saveFailed(error); return; }

    if (mobile && navigator.share) {
      try {
        await navigator.share({ title: "Query table", url: url.toString() });
        return;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "AbortError"
        )
          return;
      }
    }

    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      if (shareFeedbackTimerRef.current)
        clearTimeout(shareFeedbackTimerRef.current);
      shareFeedbackTimerRef.current = setTimeout(() => {
        setShareCopied(false);
        shareFeedbackTimerRef.current = null;
      }, SHARE_FEEDBACK_MS);
    } catch {
      window.prompt("Copy this query URL", url.toString());
    }
  }

  return (
    <div className={cx("qt-qb",
          api.grouping && "qt-qb--groupable", compact && "qt-qb--compact", classNames?.root)}>
      <div className="qt-qb-bar qt-qb-state-bar qt-qb-row">
        <span className="qt-qb-state-main">
          <button
            type="button"
            className={cx("qt-btn", "qt-qb-collapse-btn", classNames?.button)}
            onClick={() => setCollapsed(!isCollapsed)}
            aria-expanded={!isCollapsed}
            aria-controls={bodyId}
            aria-label={isCollapsed ? "Expand query builder" : "Collapse query builder"}
            title={isCollapsed ? "Expand query builder" : "Collapse query builder"}
          >
            <Icon
              name="chevronDown"
              size={18}
              className={cx(
                "qt-qb-collapse-caret",
                isCollapsed && "qt-qb-collapse-caret--collapsed",
              )}
            />
            <span>Query</span>
          </button>
          {savedQueryControls !== undefined ? savedQueryControls : <span className="qt-qb-saved">
            <button
              type="button"
              className={cx(
                "qt-qb-saved-star",
                isSavedQuery
                  ? "qt-qb-saved-star--saved"
                  : "qt-qb-saved-star--unsaved",
              )}
              title={isSavedQuery ? "Rename saved query" : "Save query"}
              aria-label={isSavedQuery ? "Rename saved query" : "Save query"}
              disabled={isBusy}
              onClick={beginEditSavedName}
            >
              <Icon name="star" size={16} filled={isSavedQuery} />
            </button>
            {isEditingSaved || isEditingUnsaved ? (
              <span className="qt-qb-saved-input-wrap">
                <input
                  type="text"
                  className="qt-qb-saved-input"
                  value={editingSavedName}
                  disabled={isBusy}
                  autoFocus
                  onChange={(e) => setEditingSavedName(e.target.value)}
                  onBlur={commitNameEditor}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitNameEditor();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelNameEdit();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  type="button"
                  className="qt-qb-saved-cancel"
                  title="Do not save"
                  aria-label="Do not save"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    cancelNameEdit();
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="close" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={cx(
                  "qt-qb-saved-name",
                  !activeSavedQuery && "qt-qb-saved-name--custom",
                )}
                onClick={beginEditSavedName}
              >
                {activeSavedQuery ? activeSavedQuery.name : "Custom Query"}
              </button>
            )}
          </span>}
          {isCollapsed ? (
            <span
              className="qt-qb-summary qt-truncate"
              title={summary ? undefined : collapsedSummary}
            >
              {summary ?? (
                <>
                  <span className="qt-qb-summary-kw">WHERE</span>{" "}
                  <strong>{collapsedWhereText}</strong>{" "}
                  <span className="qt-qb-summary-kw">ORDER BY</span>{" "}
                  <strong>{collapsedOrderText}</strong>
                </>
              )}
            </span>
          ) : null}
        </span>
        {savedQueryControls === undefined && showUpdateButton ? (
          <button
            type="button"
            className={cx("qt-btn", classNames?.button)}
            onClick={() => void updateLastSavedQuery()}
            disabled={isBusy}
          >
            {`Update Query '${lastSavedQuery?.name ?? "query"}'`}
          </button>
        ) : null}
        <button
          type="button"
          className={cx("qt-btn", classNames?.button)}
          onClick={() => void shareQuery()}
          title="Copy a URL for this query"
          aria-live="polite"
          disabled={api.loading || api.links.busy}
        >
          <Icon name={shareCopied ? "check" : "share"} />
          {shareCopied ? "Copied!" : "Share"}
        </button>
        {api.links.kind === "local" && <small role="status">Temporary link · this browser only</small>}
        {api.links.error && <small role="alert">{api.links.error.message}</small>}
        {savedQueryControls === undefined && <button
          type="button"
          className={cx("qt-btn", classNames?.button)}
          onClick={() => setShowSaved(true)}
        >
          <Icon name="bookmark" />
          Saved
          {api.saved.items.length > 0 ? ` (${api.saved.items.length})` : ""}
        </button>}
        <div className="qt-property-history qt-query-history" role="group" aria-label="Query history">
          <button type="button" className={cx("qt-link-btn", "qt-property-icon-button", classNames?.button)}
            aria-label="Undo" title="Undo query change" disabled={!api.canUndo || isBusy} onClick={api.undo}>
            <Icon name="undo" size={14} />
          </button>
          <button type="button" className={cx("qt-link-btn", "qt-property-icon-button", classNames?.button)}
            aria-label="Redo" title="Redo query change" disabled={!api.canRedo || isBusy} onClick={api.redo}>
            <Icon name="redo" size={14} />
          </button>
          <button type="button" className={cx("qt-link-btn", "qt-property-icon-button", classNames?.button)}
            aria-label="Reset" title="Reset query" disabled={isBusy} onClick={api.resetAll}>
            <Icon name="reset" size={14} />
          </button>
        </div>
      </div>

      {!isCollapsed ? (
        <div className="qt-qb-bar qt-qb-editor-bar">
          <div id={bodyId} className="qt-qb-body">
            <SelectRow
              api={api}
              fields={fields}
              classNames={classNames}
              disabled={isBusy}
              presentation={selectPresentation}
            />
            {whereRow ?? (
              <WhereRow
                api={api}
                byName={byName}
                fields={fields}
                classNames={classNames}
                disabled={isBusy}
              />
            )}
            {clauses}
            <OrderRow
              api={api}
              fields={fields}
              classNames={classNames}
              disabled={isBusy}
            />
            <WindowRow
              api={api}
              total={total}
              compact={compact}
              classNames={classNames}
              disabled={isBusy}
            />
            <MetricsRow
              api={api}
              fields={fields}
              theme={metricTheme}
              locale={metricLocale}
            />
          </div>

        </div>
      ) : null}

      <div className="qt-qb-bar qt-qb-run-bar qt-qb-row">
        <span
          className="qt-qb-run-metric qt-qb-run-metric--strong"
          title={api.loading ? undefined : rowSummaryTitle}
        >
          {api.loading ? "loading…" : `${rowSummary} rows`}
        </span>
        <span className="qt-qb-run-metric">Last updated {lastUpdatedText}</span>
        {failureText ? (
          <span className="qt-qb-run-error">{failureText}</span>
        ) : null}
        <span className="qt-qb-run-actions">
          {autoRefreshStatus ? (
            <span className="qt-qb-auto-status">
              {`Every ${formatDuration(autoRefreshStatus.frequencyMs)}; clear after ${formatDuration(
                autoRefreshStatus.turnOffAfterMs,
              )} (${autoRefreshStatus.pollCount} polls run)`}
            </span>
          ) : null}
          <button
            type="button"
            className={cx(
              "qt-btn",
              showActivity && "qt-btn--active",
              classNames?.button,
            )}
            aria-label="Request activity"
            title="Request activity"
            aria-expanded={showActivity}
            aria-controls={activityId}
            onClick={() => setShowActivity((v) => !v)}
          >
            <Icon name="stopwatch" />
          </button>
          <span className="qt-auto-refresh">
            <button
              type="button"
              className={cx(
                "qt-btn",
                Boolean(autoRefreshStatus) && "qt-btn--active",
                classNames?.button,
              )}
              ref={autoRefreshRef}
              aria-haspopup="dialog"
              onClick={() => setShowAutoRefresh((next) => !next)}
              aria-expanded={showAutoRefresh}
              title={
                autoRefreshStatus
                  ? "View or clear auto-update"
                  : "Configure auto-update"
              }
            >
              <Icon name="clock" />
              {autoRefreshButtonText}
            </button>
            {showAutoRefresh && autoRefreshRef.current ? (
              <Popover
                anchor={autoRefreshRef.current}
                width={260}
                className="qt-auto-refresh-popover"
                label="Auto-refresh settings"
                onClose={() => setShowAutoRefresh(false)}
              >
                  <label className="qt-auto-refresh-field">
                    <span>Frequency</span>
                    <select
                      className="qt-auto-refresh-select"
                      value={autoRefreshFrequencyMs}
                      onChange={(e) =>
                        setAutoRefreshFrequencyMs(Number(e.target.value))
                      }
                    >
                      {AUTO_REFRESH_FREQUENCIES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="qt-auto-refresh-field">
                    <span>Turn off after</span>
                    <select
                      className="qt-auto-refresh-select"
                      value={autoRefreshTurnOffAfterMs}
                      onChange={(e) =>
                        setAutoRefreshTurnOffAfterMs(Number(e.target.value))
                      }
                    >
                      {AUTO_REFRESH_TURN_OFF_AFTER.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={
                            autoRefreshPolls(
                              autoRefreshFrequencyMs,
                              option.value,
                            ) < 1 ||
                            autoRefreshPolls(
                              autoRefreshFrequencyMs,
                              option.value,
                            ) > MAX_AUTO_REFRESH_POLLS
                          }
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span
                    className={cx(
                      "qt-auto-refresh-status",
                      !canSubmitAutoRefresh && "qt-auto-refresh-status--error",
                    )}
                  >
                    {canSubmitAutoRefresh
                      ? `${selectedAutoRefreshPolls} polls maximum`
                      : `Choose between 1 and 1000 polls`}
                  </span>
                  {autoRefreshStatus ? (
                    <span className="qt-auto-refresh-status">
                      Active: every{" "}
                      {formatDuration(autoRefreshStatus.frequencyMs)}, clears
                      after {formatDuration(autoRefreshStatus.turnOffAfterMs)}.{" "}
                      {autoRefreshStatus.pollCount} polls run.
                    </span>
                  ) : null}
                  <span className="qt-auto-refresh-actions">
                    <button
                      type="button"
                      className={cx("qt-btn", classNames?.button)}
                      onClick={submitAutoRefresh}
                      disabled={!canSubmitAutoRefresh}
                    >
                      {autoRefreshStatus ? "Update" : "Start"}
                    </button>
                    {autoRefreshStatus ? (
                      <button
                        type="button"
                        className={cx("qt-btn", classNames?.button)}
                        onClick={() => {
                          api.autoRefresh.stop();
                          setShowAutoRefresh(false);
                        }}
                      >
                        Clear
                      </button>
                    ) : null}
                  </span>
              </Popover>
            ) : null}
          </span>
          <button
            type="button"
            className={cx("qt-btn", "qt-btn--primary", classNames?.button)}
            onClick={api.refresh}
            disabled={isBusy}
          >
            <Icon name="refresh" />
            Run Now
          </button>
        </span>
      </div>

      {groupingUI.overlays}
      {showActivity && (
        <RequestActivity id={activityId} activity={api.requestActivity}>
          {requestActivityDetails}
        </RequestActivity>
      )}
      {savedQueryControls === undefined && showSaved ? (
        <SavedQueriesModal
          saved={api.saved}
          onClose={() => setShowSaved(false)}
          onLoad={setLastSavedId}
        />
      ) : null}
    </div>
  );
}

// ---- SELECT ---------------------------------------------------------------

function SelectRow<Row>({
  api,
  fields,
  classNames,
  disabled,
  presentation,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  presentation: SelectPresentation | undefined;
}) {
  const { select, columnDrag } = api;
  function removeColumn(field: string) {
    try {
      select.hide(field);
    } catch (error) {
      if (!api.grouping) throw error;
      api.grouping.setNotice(error instanceof Error ? error.message : String(error));
    }
  }
  const mobile = useMobileLayout();
  const [editingColumns, setEditingColumns] = useState(false);
  const [editingField, setEditingField] = useState<string | undefined>();
  function openColumnEditor(field?: string) {
    setEditingField(field);
    setEditingColumns(true);
  }
  const detailSettingsButton = (field: string) => field === ITEM_DETAILS_COLUMN && api.itemDetails ? (
    <button type="button" className="qt-chip-op-btn" aria-label="Configure Detail column" title="Configure Detail column"
      aria-haspopup="dialog" aria-expanded={editingColumns && editingField === field} disabled={disabled}
      onClick={() => openColumnEditor(field)}><Icon name="chevronRight" size={18} /></button>
  ) : null;
  const [adding, setAdding] = useState(false);
  const addColumnRef = useRef<HTMLButtonElement>(null);
  const fieldLabelByName = useMemo(
    () => new Map(select.fields.map((f) => [f.name, f.label])),
    [select.fields],
  );

  // `overIndex` is a position in the list with the dragged column removed —
  // exactly where the live preview shows it. select.move removes-then-inserts at
  // that index, so the committed order matches the preview.
  function reorderByIndex(from: string, overIndex: number) {
    select.move(from, overIndex);
  }

  const fieldNames = select.visible.map((c) => c.field);
  const dragSource = columnDrag.source;

  // Live reorder, driven by the SHARED column-drag state so dragging a chip also
  // live-previews/dims the matching table column (and vice versa). The dragged
  // chip stays MOUNTED (removing the drag-source node mid-drag aborts the native
  // drag) and slides to the hovered slot, dimmed. Rendered order == drop result.
  const rendered = columnDrag.preview(fieldNames);

  const actions = (
    <>
      <PickerAnchor>
      <span className="qt-split-btn" role="group" aria-label="Column actions">
        <button
          type="button"
          className="qt-add"
          aria-label="Add column"
          ref={addColumnRef}
          aria-expanded={adding}
          aria-haspopup="dialog"
          onClick={() => setAdding(!adding)}
          disabled={
            disabled ||
            (!presentation?.renderPicker && select.hidden.length === 0)
          }
        >
          <Icon name="add" />
          {mobile ? "Add" : "add column"}
        </button>
        <button
          type="button"
          className="qt-add qt-split-btn-caret"
          aria-label="Customize columns"
          title="Customize columns"
          aria-haspopup="dialog"
          aria-expanded={editingColumns}
          disabled={disabled}
          onClick={() => openColumnEditor()}
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </span>
      {adding ? presentation?.renderPicker ? (
        presentation.renderPicker(() => setAdding(false))
      ) : (
          <FieldPicker
            anchor={addColumnRef.current ?? undefined}
            fields={select.hidden.filter(isSelectable)}
            onPick={(f) => {
              select.show(f.name);
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
      ) : null}
      </PickerAnchor>
      <button
        type="button"
        className="qt-link-btn"
        aria-label="Reset columns"
        onClick={select.reset}
        disabled={disabled}
        title="Reset to default columns"
      >
        {mobile ? "Reset" : "reset"}
      </button>
    </>
  );

  return (
    <div className="qt-qb-row qt-qb-row--select">
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label="Columns">
          select
        </span>
        {mobile && actions}
      </div>
      {editingColumns && (presentation?.renderEditor ? presentation.renderEditor(() => setEditingColumns(false)) :
        <SelectColumnEditor
          api={api}
          {...(editingField ? { initialField: editingField } : {})}
          onClose={() => setEditingColumns(false)}
          notice={presentation?.editorNotice}
        />
      )}
      {mobile ? (
        <ReorderList
          className="qt-query-reorder-list qt-query-reorder-list--columns"
          layout="wrap"
          showHint={false}
          items={fieldNames.map((name) => ({
            id: name,
            label: fieldLabelByName.get(name) ?? name,
          }))}
          onMove={select.move}
          disabled={disabled}
          renderItem={(item) => (
            <>
              {presentation?.renderChip?.(item.id, item.label) ?? (
                <span className="qt-chip-field">{item.label}</span>
              )}
              {detailSettingsButton(item.id)}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => removeColumn(item.id)}
                disabled={disabled}
                aria-label={`Remove ${item.label} column`}
              >
                <Icon name="close" />
              </button>
            </>
          )}
        />
      ) : (
        rendered.map((name) => {
          const label = fieldLabelByName.get(name) ?? name;
          return (
            <span
              // Stable key (not index-based) so React MOVES the dragged chip instead
              // of remounting it \u2014 a remount removes the drag source and aborts the drag.
              key={name}
              className={cx(
                "qt-chip",
                "qt-chip--col",
                dragSource === name && "qt-chip--dragging",
                classNames?.columnChip ?? classNames?.chip,
              )}
              draggable={!disabled}
              onDragStart={(e) => {
                columnDrag.start(name, fieldNames.indexOf(name), fieldNames);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", name);
              }}
              onDragOver={(e) => {
                if (!columnDrag.source) return;
                // preventDefault on every chip (incl. the dragged one) so there is no
                // dead drop zone along the row.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (columnDrag.source !== name) {
                  const withoutDragged = fieldNames.filter(
                    (n) => n !== columnDrag.source,
                  );
                  let next = withoutDragged.indexOf(name);
                  if (next >= 0) {
                    // Drop after the hovered chip when past its midpoint, so a column
                    // can be moved into the last slot.
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (e.clientX > rect.left + rect.width / 2) next += 1;
                    columnDrag.over(next, fieldNames);
                  }
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const from =
                  columnDrag.source || e.dataTransfer.getData("text/plain");
                if (
                  from &&
                  columnDrag.overIndex != null &&
                  rendered.includes(from)
                ) {
                  reorderByIndex(from, rendered.indexOf(from));
                  columnDrag.end(true);
                } else columnDrag.end();
              }}
              onDragEnd={() => columnDrag.end()}
              title="drag to reorder"
            >
              <span aria-hidden className="qt-chip-grip">
                <Icon name="grip" />
              </span>
              {presentation?.renderChip?.(name, label) ?? (
                <span className="qt-chip-field">{label}</span>
              )}
              {detailSettingsButton(name)}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => removeColumn(name)}
                disabled={disabled}
                aria-label={`Remove ${label} column`}
              >
                <Icon name="close" />
              </button>
            </span>
          );
        })
      )}
      {!mobile && actions}
      {presentation?.hint}
    </div>
  );
}

// ---- WHERE ----------------------------------------------------------------

/** Reuse the same typed predicates for a host's source or result filter stage. */
export function QueryFilterRow<Row>({
  api,
  fields,
  label = "where",
}: {
  api: QueryFilterApi<Row>;
  fields: FieldDef<Row>[];
  label?: "where" | "having";
}) {
  const byName = useMemo(
    () => new Map(fields.map(field => [field.name, field])),
    [fields],
  );
  return (
    <WhereRow
      api={api}
      fields={fields}
      byName={byName}
      label={label}
      classNames={undefined}
      disabled={api.loading}
    />
  );
}

/** Where a drop lands relative to the hovered term chip: reorder before/after
 *  it, or drop onto its center to OR the two together. */
type DropMode = "before" | "after" | "merge";

interface WhereDrag {
  /** Index of the term being dragged. */
  from: number;
  /** Current hovered term + intent, or null when over dead space. */
  over: { index: number; mode: DropMode } | null;
}

/** Classify a drag position within a chip: outer thirds reorder, the center
 *  merges into an OR group. */
function dropModeFor(e: React.DragEvent): DropMode {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.3) return "before";
  if (x > rect.width * 0.7) return "after";
  return "merge";
}

function WhereRow<Row>({
  api,
  byName,
  fields,
  classNames,
  disabled,
  label = "where",
}: {
  api: QueryFilterApi<Row>;
  byName: Map<string, FieldDef<Row>>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  label?: "where" | "having";
}) {
  const [adding, setAdding] = useState(false);
  const mobile = useMobileLayout();
  const editorId = useId();
  const nextSetId = useRef(0);
  const addFilterButton = useRef<HTMLButtonElement>(null);
  const [editingSet, setEditingSet] = useState<{
    field: FieldDef<Row>;
    returnFocus: HTMLElement;
    index: number;
    count: number;
    metadata: SetFilterMetadata;
    signature: string;
  } | null>(null);
  // Local drag state (WHERE terms are their own list, unlike the columns shared
  // via api.columnDrag). Order is committed only on drop, so the DOM order stays
  // put during the drag and index keys never remount the dragged node.
  const [drag, setDrag] = useState<WhereDrag | null>(null);
  const [editingFilter, setEditingFilter] = useState<number | null>(null);
  const where = api.query.where;
  const whereSignature = JSON.stringify(where);
  const setEditors = new Map<
    number,
    { field: FieldDef<Row>; metadata: SetFilterMetadata; count: number; target: SetFilterTarget }
  >();
  const hiddenSetTerms = new Set<number>();
  for (let index = 0; index < where.length; index++) {
    const set = readSetFilter(where, index);
    const field = set && byName.get(set.field);
    if (!set || !field || setFilterTarget(field) !== set.target)
      continue;
    setEditors.set(index, { field, metadata: set.metadata, count: set.count, target: set.target });
    for (let offset = 1; offset < set.count; offset++)
      hiddenSetTerms.add(index + offset);
    index += set.count - 1;
  }
  useEffect(() => {
    if (editingSet && editingSet.signature !== whereSignature)
      setEditingSet(null);
  }, [editingSet, whereSignature]);
  // Only make the top-level conjunction explicit ("AND" between terms) once an
  // OR group is present — otherwise a plain AND-list reads fine unadorned.
  const hasOr = where.some(isOrGroup);

  function replaceSet(id: string, terms: WhereTerm[]) {
    api.setQuery((query) => {
      const index = query.where.findIndex((term) => term.setFilter?.id === id);
      const current = readSetFilter(query.where, index);
      if (!current) return query;
      return {
        ...query,
        offset: 0,
        where: [
          ...query.where.slice(0, index),
          ...terms,
          ...query.where.slice(index + current.count),
        ],
      };
    });
  }

  function addClause(f: FieldDef<Row>) {
    if (setFilterTarget(f)) {
      const anchor = addFilterButton.current;
      if (!anchor) return;
      setEditingSet({
        field: f,
        returnFocus: anchor,
        index: where.length,
        count: 0,
        metadata: {
          id: `${editorId}-${Date.now()}-${nextSetId.current++}`,
          mode: "any",
          values: [],
        },
        signature: whereSignature,
      });
      setAdding(false);
      return;
    }
    // Desktop uses inline controls; avoid leaving a pending sheet that opens
    // unexpectedly when the viewport later crosses the mobile breakpoint.
    if (mobile) setEditingFilter(where.length);
    const op = positiveOpsForField(f)[0] ?? opsForField(f)[0] ?? "=";
    api.addFilter({ field: f.name, op, value: "" });
    setAdding(false);
  }

  function handleOver(e: React.DragEvent, index: number) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const mode = dropModeFor(e);
    setDrag((d) =>
      d && (d.over?.index !== index || d.over?.mode !== mode)
        ? { from: d.from, over: { index, mode } }
        : d,
    );
  }

  function handleDrop() {
    if (!drag || !drag.over) {
      setDrag(null);
      return;
    }
    const { from } = drag;
    const { index: target, mode } = drag.over;
    if (mode === "merge") {
      if (target !== from) api.mergeFilters(from, target);
    } else {
      // Translate "before/after term `target`" into an index in the list with the
      // dragged term already removed (what reorderFilters expects).
      const tPrime = target < from ? target : target - 1;
      const insertAt = mode === "after" ? tPrime + 1 : tPrime;
      if (insertAt !== from) api.reorderFilters(from, insertAt);
    }
    setDrag(null);
  }

  const actions = (
    <>
      <PickerAnchor>
      <button
        ref={addFilterButton}
        type="button"
        className="qt-add"
        aria-haspopup="dialog"
        aria-label={label === "having" ? "Add HAVING filter" : "Add filter"}
        aria-expanded={adding}
        onClick={() => setAdding(!adding)}
        disabled={disabled}
      >
        <Icon name="add" />
        {label === "having" ? "having" : "add filter"}
      </button>
      {adding && (
        <FieldPicker
          anchor={addFilterButton.current ?? undefined}
          fields={fields.filter(isFilterable)}
          gateOnDistinct
          onPick={addClause}
          onClose={() => setAdding(false)}
        />
      )}
      </PickerAnchor>
      {where.length > 0 && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={api.clearFilters}
          disabled={disabled}
          title="Reset filters"
        >
          reset
        </button>
      )}
    </>
  );

  return (
    <div className={cx("qt-qb-row qt-qb-row--filters", where.length === 0 && "qt-qb-row--unused")} data-clause={label}>
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label={label === "having" ? "Having" : "Filters"}>
          {label}
        </span>
        {mobile && actions}
      </div>
      {where.map((term, index) => {
        if (hiddenSetTerms.has(index)) return null;
        const set = setEditors.get(index);
        return (
          <span className="qt-where-term-wrap" key={index}>
            {index > 0 && hasOr && <span className="qt-where-and">AND</span>}
            {set ? (
              <span className={cx("qt-chip", classNames?.chip)}>
                <button
                  type="button"
                  className="qt-link-btn"
                  disabled={disabled}
                  aria-label={`Edit ${set.field.label} ${set.target === "array" ? "tag" : "value"} filter`}
                  onClick={(event) =>
                    setEditingSet({
                      field: set.field,
                      returnFocus: event.currentTarget,
                      index,
                      count: set.count,
                      metadata: set.metadata,
                      signature: whereSignature,
                    })
                  }
                >
                  {set.field.label} {set.metadata.mode.toUpperCase()}
                </button>
                {set.metadata.values.map((value) => (
                  <span key={value} className="qt-set-tag">
                    <PresentedFilterValue
                      field={set.field.name}
                      value={value}
                      label={setFilterValueLabel(set.field, value)}
                    />
                    <button
                      type="button"
                      className="qt-chip-x"
                      aria-label={`Remove ${set.target === "array" ? "tag" : "value"} ${value}`}
                      disabled={disabled}
                      onClick={() =>
                        replaceSet(
                          set.metadata.id,
                          createSetFilter(
                            set.field.name,
                            set.metadata.mode,
                            set.metadata.values.filter((key) => key !== value),
                            set.metadata.id,
                            set.target,
                          ),
                        )
                      }
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="qt-chip-x"
                  aria-label={`Remove ${set.field.label} ${set.target === "array" ? "tag" : "value"} filter`}
                  disabled={disabled}
                  onClick={() => replaceSet(set.metadata.id, [])}
                >
                  ✕
                </button>
              </span>
            ) : (
              <TermChip
                api={api}
                term={term}
                index={index}
                byName={byName}
                classNames={classNames}
                disabled={disabled}
                isDragSource={drag?.from === index}
                dropHint={drag?.over?.index === index ? drag.over.mode : null}
                onDragStart={() => setDrag({ from: index, over: null })}
                onDragOver={(e) => handleOver(e, index)}
                onDrop={handleDrop}
                onDragEnd={() => setDrag(null)}
                editorOpen={editingFilter === index}
                onEditorChange={(open) => setEditingFilter(open ? index : null)}
              />
            )}
          </span>
        );
      })}
      {editingSet && (
        <SetFilterEditor
          api={api}
          field={editingSet.field}
          returnFocus={editingSet.returnFocus}
          classNames={classNames}
          mode={editingSet.metadata.mode}
          values={editingSet.metadata.values}
          maxPredicates={
            MAX_WHERE_CLAUSES -
            where.reduce(
              (count, term, index) =>
                index >= editingSet.index &&
                index < editingSet.index + editingSet.count
                  ? count
                  : count + predicatesOf(term).length,
              0,
            )
          }
          disabled={disabled}
          onClose={() => setEditingSet(null)}
          onApply={(mode, values) => {
            const terms = createSetFilter(
              editingSet.field.name,
              mode,
              values,
              editingSet.metadata.id,
              setFilterTarget(editingSet.field) ?? "array",
            );
            if (editingSet.count > 0) replaceSet(editingSet.metadata.id, terms);
            else
              api.setQuery((query) => ({
                ...query,
                offset: 0,
                where: [...query.where, ...terms],
              }));
            setEditingSet(null);
          }}
        />
      )}
      {!mobile && actions}
    </div>
  );
}

function setFilterValueLabel(field: FieldDef, value: string): string {
  const strategy = filterValuesFor(field);
  if (strategy.source !== "static") return value;
  const option = strategy.options.find(
    (option) => (typeof option === "string" ? option : option.value) === value,
  );
  return typeof option === "string" ? option : (option?.label ?? value);
}

/** One top-level WHERE term: a single predicate, or a bordered OR group holding
 *  several. Draggable by its grip; a drop onto another chip's center ORs them,
 *  onto its edges reorders. */
function TermChip<Row>({
  api,
  term,
  index,
  byName,
  classNames,
  disabled,
  isDragSource,
  dropHint,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  editorOpen,
  onEditorChange,
}: {
  api: QueryFilterApi<Row>;
  term: WhereTerm;
  index: number;
  byName: Map<string, FieldDef<Row>>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  isDragSource: boolean;
  dropHint: DropMode | null;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  editorOpen: boolean;
  onEditorChange: (open: boolean) => void;
}) {
  const mobile = useMobileLayout();
  const group = isOrGroup(term);
  const predicates = predicatesOf(term);

  if (mobile)
    return (
      <MobileFilter
        api={api}
        term={term}
        index={index}
        byName={byName}
        classNames={classNames}
        disabled={disabled}
        open={editorOpen}
        onOpenChange={onEditorChange}
      />
    );

  const grip = (
    <span
      className="qt-chip-grip"
      aria-hidden
      draggable={!disabled}
      onDragStart={(e) => {
        onDragStart();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      }}
      onDragEnd={onDragEnd}
      title="drag to reorder, or drop onto another filter to make an OR"
    >
      <Icon name="grip" />
    </span>
  );

  return (
    <span
      className={cx(
        "qt-chip",
        "qt-chip--where",
        group && "qt-chip--or",
        isDragSource && "qt-chip--dragging",
        dropHint ? `qt-chip--drop-${dropHint}` : undefined,
        classNames?.chip,
      )}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {grip}
      {group ? (
        <span className="qt-or-group">
          {predicates.map((clause, predIndex) => (
            <span className="qt-or-member" key={predIndex}>
              {predIndex > 0 && (
                <span className="qt-chip-and qt-chip-or">OR</span>
              )}
              <PredicateEditor
                api={api}
                field={byName.get(clause.field)}
                clause={clause}
                classNames={classNames}
                disabled={disabled}
                onChange={(next) => api.updatePredicate(index, predIndex, next)}
                onRemove={() => api.removePredicate(index, predIndex)}
              />
            </span>
          ))}
        </span>
      ) : (
        <PredicateEditor
          api={api}
          field={byName.get(term.field)}
          clause={term}
          classNames={classNames}
          disabled={disabled}
          onChange={(next) => api.updatePredicate(index, 0, next)}
          onRemove={() => api.removeFilter(index)}
        />
      )}
    </span>
  );
}

function MobileFilter<Row>({
  api,
  term,
  index,
  byName,
  classNames,
  disabled,
  open,
  onOpenChange,
}: {
  api: QueryFilterApi<Row>;
  term: WhereTerm;
  index: number;
  byName: Map<string, FieldDef<Row>>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const predicates = predicatesOf(term);
  return (
    <>
      <MobileClauseSummary
        editLabel={`Edit filter: ${whereTermAsText(term, byName)}`}
        disabled={disabled}
        className={classNames?.chip}
        filter
        onEdit={() => onOpenChange(true)}
      >
        <span>
          {predicates.map((clause, position) => {
            const strategy = byName.get(clause.field)?.filter?.values;
            const option =
              strategy?.source === "static"
                ? strategy.options.find(
                    (choice) =>
                      typeof choice !== "string" &&
                      choice.value === clause.value,
                  )
                : undefined;
            const label =
              typeof option === "object"
                ? option.label
                : clause.value === ""
                  ? '""'
                  : clause.value;
            const emptyStringCondition =
              clause.value === "0" &&
              (clause.op === "length_eq" || clause.op === "length_gt");
            return (
              <span key={position} className="qt-mobile-filter-summary">
                {position > 0 && <small>OR</small>}
                <strong>
                  {byName.get(clause.field)?.label ?? clause.field}
                </strong>
                <span>
                  {choiceLabel(
                    clause.op,
                    Boolean(clause.negated),
                    clause.value,
                  )}{" "}
                  {!NULLARY_OPS.has(clause.op) && !emptyStringCondition && (
                    <PresentedFilterValue
                      field={clause.field}
                      value={clause.value}
                      label={label}
                    />
                  )}
                </span>
              </span>
            );
          })}
        </span>
      </MobileClauseSummary>
      {open && (
        <ModalSurface
          title={
            predicates.length > 1
              ? "Edit filter group"
              : `Filter by ${byName.get(predicates[0]!.field)?.label ?? predicates[0]!.field}`
          }
          onClose={() => onOpenChange(false)}
        >
          <div className="qt-overlay-body qt-filter-editor">
            {predicates.map((clause, position) => (
              <Fragment key={position}>
                {position > 0 && <p className="qt-muted">OR</p>}
                <PredicateEditor
                  api={api}
                  clause={clause}
                  field={byName.get(clause.field)}
                  showField={predicates.length > 1}
                  classNames={classNames}
                  disabled={disabled}
                  onChange={(next) =>
                    api.updatePredicate(index, position, next)
                  }
                  onRemove={() => {
                    if (predicates.length === 1) onOpenChange(false);
                    api.removePredicate(index, position);
                  }}
                />
              </Fragment>
            ))}
            {predicates.length > 1 && (
              <button
                type="button"
                className="qt-mobile-form-remove"
                aria-label="Remove filter group"
                disabled={disabled}
                onClick={() => {
                  onOpenChange(false);
                  api.removeFilter(index);
                }}
              >
                Remove filter group
              </button>
            )}
            {api.query.where.length > 1 && (
              <label className="qt-filter-combine">
                Match either filter (OR)
                <select
                  className="qt-input"
                  value=""
                  disabled={disabled}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    onOpenChange(false);
                    api.mergeFilters(index, Number(event.target.value));
                  }}
                >
                  <option value="">Combine with another filter…</option>
                  {api.query.where.map(
                    (candidate, position) =>
                      position !== index && (
                        <option key={position} value={position}>
                          {whereTermAsText(candidate, byName)}
                        </option>
                      ),
                  )}
                </select>
              </label>
            )}
          </div>
        </ModalSurface>
      )}
    </>
  );
}

/** Human-readable operator labels for the WHERE chips + op picker. */
const OP_LABEL: Record<FilterOp, string> = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  matches_regex: "matches",
  not_matches_regex: "not matches",
  length_gt: "length above",
  length_lt: "length below",
  length_eq: "length equals",
  includes: "includes",
  is_null: "is null",
  is_not_null: "is not null",
};

function choiceLabel(op: FilterOp, negated: boolean, value?: string): string {
  if (value === "0" && op === "length_eq")
    return negated ? "is not empty string" : "is empty string";
  if (value === "0" && op === "length_gt")
    return negated ? "is empty string" : "is not empty string";
  return negated ? `not ${OP_LABEL[op]}` : OP_LABEL[op];
}

/** The operator control: a button showing the current condition that opens a
 *  keep/exclude popover — the same two-column layout as the CellMenu, with the
 *  active choice highlighted. Picking sets the predicate's op + negation. */
function OpPicker<Row>({
  field,
  clause,
  disabled,
  classNames,
  onPick,
}: {
  field: FieldDef<Row> | undefined;
  clause: WhereClause;
  disabled: boolean | undefined;
  classNames: QueryBuilderClassNames | undefined;
  onPick: (choice: OpChoice) => void;
}) {
  const pairs = useMemo(() => (field ? opPairsForField(field) : []), [field]);
  const visiblePairs =
    clause.value === "0" && pairs.some((pair) => pair.keep.op === "length_gt")
      ? pairs.filter((pair) => pair.keep.op !== "length_eq")
      : pairs;
  const isActive = (choice: OpChoice) => {
    const resolved = choice.negated
      ? negateClause(
          { field: clause.field, op: choice.op, value: clause.value },
          field ? opsForField(field) : undefined,
        )
      : { op: choice.op, negated: false };
    return (
      resolved.op === clause.op &&
      Boolean(resolved.negated) === Boolean(clause.negated)
    );
  };

  return (
    <span className="qt-op-picker">
      <MenuButton label="Choose condition" width={320}
        buttonProps={{ className: cx("qt-chip-op-btn", "qt-op-trigger", classNames?.select), disabled: disabled || visiblePairs.length === 0,
          "aria-label": choiceLabel(clause.op, Boolean(clause.negated), clause.value) }}
        trigger={<>{choiceLabel(clause.op, Boolean(clause.negated), clause.value)}<Icon name="chevronDown" size={12} className="qt-op-caret" /></>}>
          <MenuGroup label={`Condition for ${field?.label ?? clause.field}`} columns={2} className="qt-op-pop">
            <span className="qt-cm-col-head">keep</span>
            <span className="qt-cm-col-head qt-cm-col-head--neg">exclude</span>
            {visiblePairs.map((pair, i) => (
              <Fragment key={i}>
                <MenuItem className={cx("qt-op-cell", isActive(pair.keep) && "qt-op-cell--on")}
                  checked={isActive(pair.keep)} selectionType="radio" onSelect={() => onPick(pair.keep)}>
                  {choiceLabel(pair.keep.op, pair.keep.negated, clause.value)}
                </MenuItem>
                <MenuItem className={cx("qt-op-cell", "qt-op-cell--neg", isActive(pair.exclude) && "qt-op-cell--on")}
                  checked={isActive(pair.exclude)} selectionType="radio" tone="danger" onSelect={() => onPick(pair.exclude)}>
                  {choiceLabel(pair.exclude.op, pair.exclude.negated, clause.value)}
                </MenuItem>
              </Fragment>
            ))}
          </MenuGroup>
      </MenuButton>
    </span>
  );
}

/** The editor for one predicate: field label, the operator picker (a keep/
 *  exclude popover that also carries negation), a type-aware value input, and
 *  remove. Shared by standalone and grouped terms. */
function PredicateEditor<Row>({
  api,
  field,
  clause,
  classNames,
  disabled,
  onChange,
  onRemove,
  showField = true,
}: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row> | undefined;
  clause: WhereClause;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  onChange: (next: WhereClause) => void;
  onRemove: () => void;
  showField?: boolean;
}) {
  const mobile = useMobileLayout();
  const needsValue = !NULLARY_OPS.has(clause.op);
  const isRegex =
    clause.op === "matches_regex" || clause.op === "not_matches_regex";
  const isLength =
    clause.op === "length_gt" ||
    clause.op === "length_lt" ||
    clause.op === "length_eq";

  function pickOp(choice: OpChoice) {
    const nextIsLength =
      choice.op === "length_gt" ||
      choice.op === "length_lt" ||
      choice.op === "length_eq";
    const value = isLength === nextIsLength ? clause.value : "";
    const next: WhereClause = { field: clause.field, op: choice.op, value };
    onChange(
      choice.negated
        ? negateClause(next, field ? opsForField(field) : undefined)
        : next,
    );
  }

  const conditionControl = (
    <OpPicker
      field={field}
      clause={clause}
      disabled={disabled}
      classNames={classNames}
      onPick={pickOp}
    />
  );
  const valueControl = needsValue ? (
    <ValueInput
      api={api}
      field={field}
      value={clause.value}
      forceFreeform={isRegex || isLength}
      numeric={isLength}
      placeholder={
        isRegex
          ? "regex"
          : isLength
            ? "length"
            : field?.type === "datetime"
              ? "ISO date or signed duration"
              : "value"
      }
      classNames={classNames}
      onChange={(value) => onChange({ ...clause, value })}
    />
  ) : null;
  const removeControl = (
    <button
      type="button"
      className={mobile ? "qt-mobile-form-remove" : "qt-chip-x"}
      onClick={onRemove}
      disabled={disabled}
      aria-label={`Remove ${field?.label ?? clause.field} filter`}
    >
      {mobile ? "Remove filter" : <Icon name="close" />}
    </button>
  );

  if (mobile)
    return (
      <div className="qt-mobile-predicate qt-mobile-form">
        {showField && (
          <strong className="qt-mobile-form-field--wide">
            {field?.label ?? clause.field}
          </strong>
        )}
        <label
          className={cx(
            "qt-mobile-form-field",
            !needsValue && "qt-mobile-form-field--wide",
          )}
        >
          <span>Condition</span>
          {conditionControl}
        </label>
        {valueControl && (
          <label className="qt-mobile-form-field">
            <span>Value</span>
            {valueControl}
          </label>
        )}
        {removeControl}
      </div>
    );

  return (
    <span className="qt-pred">
      <span className="qt-chip-field">{field?.label ?? clause.field}</span>
      {conditionControl}
      {valueControl}
      {removeControl}
    </span>
  );
}

// ---- value input: autocomplete by default --------------------------------

function ValueInput<Row>({
  api,
  field,
  value,
  forceFreeform,
  numeric,
  placeholder = "value",
  classNames,
  onChange,
}: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row> | undefined;
  value: string;
  forceFreeform?: boolean;
  numeric?: boolean;
  placeholder?: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const presentation = useFilterValuePresentation();
  const strategy = field
    ? filterValuesFor(field)
    : { source: "freeform" as const };

  // Static closed domain → a plain <select> of the options.
  if (!forceFreeform && strategy.source === "static") {
    if (
      presentation.render ||
      presentation.label ||
      strategy.options.some((o) => typeof o !== "string")
    ) {
      return (
        <PresentedValueInput
          field={field?.name ?? ""}
          value={value}
          options={strategy.options}
          onChange={onChange}
        />
      );
    }
    return (
      <select
        className={cx("qt-chip-val", classNames?.select)}
        aria-label={`Value for ${field?.label ?? "filter"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {strategy.options.map((o) => {
          const option = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          );
        })}
      </select>
    );
  }

  // Freeform → a plain input, no suggestions.
  if (forceFreeform || strategy.source === "freeform" || !field) {
    const widthChars = chipFieldWidthForInput(
      value || placeholder,
      field?.type,
      5,
      4,
    );
    return (
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder={placeholder}
        aria-label={`${placeholder} for ${field?.label ?? "filter"}`}
        inputMode={numeric ? "numeric" : undefined}
        pattern={numeric ? "[0-9]*" : undefined}
        size={widthChars}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // Autocomplete (the default) → debounced combobox backed by api.filterValues.
  return (
    <FilterValueAutocomplete
      api={api}
      field={field}
      value={value}
      className={cx("qt-chip-val", classNames?.input)}
      widthChars={chipFieldWidthForInput(value || "value", field.type, 5, 4)}
      onChange={onChange}
    />
  );
}

// ---- ORDER BY (multi-sort, reorderable) -----------------------------------

function MobileClauseSummary({
  editLabel,
  disabled,
  className,
  filter,
  onEdit,
  children,
}: {
  editLabel: string;
  disabled: boolean | undefined;
  className?: string | undefined;
  filter?: boolean;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cx("qt-mobile-clause", className)}>
      <button
        type="button"
        className="qt-mobile-filter"
        data-qt-filter={filter || undefined}
        disabled={disabled}
        aria-label={editLabel}
        title={editLabel}
        aria-haspopup="dialog"
        onClick={onEdit}
      >
        {children}
        <span className="qt-mobile-filter-edit">
          <Icon name="pencil" />
        </span>
      </button>
    </div>
  );
}

function MobileChipEditor({
  title,
  summaryTitle = title,
  summary,
  disabled,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  summaryTitle?: string;
  summary: string;
  disabled: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const mobile = useMobileLayout();
  if (!mobile) return children;
  return (
    <>
      <MobileClauseSummary
        editLabel={`Edit ${title}: ${summary}`}
        disabled={disabled}
        onEdit={() => onOpenChange(true)}
      >
        <span className="qt-mobile-filter-summary">
          <strong>{summaryTitle}</strong>
          <span>{summary}</span>
        </span>
      </MobileClauseSummary>
      {open && (
        <ModalSurface title={title} onClose={() => onOpenChange(false)}>
          <div className="qt-overlay-body qt-mobile-chip-editor">
            {children}
          </div>
        </ModalSurface>
      )}
    </>
  );
}

function OrderTermChip<Row>({
  api,
  field,
  term,
  dataIndex,
  priority,
  showPriority,
  isDragSource,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  disabled,
  updateTerm,
  clearExtract,
  removeTerm,
  classNames,
  label,
  editorOpen,
  onEditorChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  term: OrderByClause;
  /** Index of this term in the real orderBy array (for update/remove). */
  dataIndex: number;
  /** 1-based sort priority to display (reflects the live drag position). */
  priority: number;
  showPriority: boolean;
  isDragSource: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  disabled: boolean | undefined;
  updateTerm: (i: number, patch: Partial<OrderByClause>) => void;
  clearExtract: (i: number) => void;
  removeTerm: (i: number) => void;
  classNames: QueryBuilderClassNames | undefined;
  label: string;
  editorOpen: boolean;
  onEditorChange: (open: boolean) => void;
}) {
  const fieldHasNull = useFieldHasNull(api, field?.name);
  const mobile = useMobileLayout();
  const [extractOpen, setExtractOpen] = useState(false);
  const title = `Sort by ${label}`;
  const summary = `${term.dir === "asc" ? "Ascending" : "Descending"}${showPriority ? ` · Priority ${priority}` : ""}${term.extract ? " · Regex extraction" : ""}`;
  const extractionEditor = extractOpen && (
    <SortExtractionEditor
      api={api}
      field={term.field}
      label={label}
      initialPattern={term.extract?.regex}
      disabled={disabled}
      onApply={(regex) => {
        updateTerm(dataIndex, { extract: { regex } });
        setExtractOpen(false);
      }}
      onRemove={() => {
        clearExtract(dataIndex);
        setExtractOpen(false);
      }}
      onClose={() => setExtractOpen(false)}
    />
  );

  if (mobile)
    return (
      <>
        <MobileChipEditor
          title={title}
          summaryTitle={label}
          summary={summary}
          disabled={disabled}
          open={editorOpen}
          onOpenChange={onEditorChange}
        >
          <div className="qt-mobile-form">
            <label className="qt-mobile-form-field">
              <span>Direction</span>
              <select
                className={cx("qt-input", classNames?.select)}
                value={term.dir}
                disabled={disabled}
                onChange={(event) =>
                  updateTerm(dataIndex, {
                    dir: event.target.value as OrderByClause["dir"],
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            {(term.extract != null || fieldHasNull !== false) && (
              <label className="qt-mobile-form-field">
                <span>Null values</span>
                <select
                  className={cx("qt-input", classNames?.select)}
                  value={term.nulls ?? "last"}
                  disabled={disabled}
                  onChange={(event) =>
                    updateTerm(dataIndex, {
                      nulls: event.target.value as "first" | "last",
                    })
                  }
                >
                  <option value="last">Last</option>
                  <option value="first">First</option>
                </select>
              </label>
            )}
            <div className="qt-mobile-form-field qt-mobile-form-field--wide">
              <span>Extraction</span>
              <button
                type="button"
                className="qt-btn"
                disabled={disabled}
                onClick={() => setExtractOpen(true)}
                aria-label={`Configure regex extract for ${label}`}
              >
                <Icon name={term.extract ? "pencil" : "add"} />
                {term.extract ? "Edit regex extraction" : "regex extract"}
              </button>
            </div>
            <div className="qt-mobile-form-actions">
              <button
                type="button"
                className="qt-mobile-form-remove"
                disabled={disabled}
                onClick={() => removeTerm(dataIndex)}
                aria-label={`Remove ${label} sort`}
              >
                Remove sort
              </button>
            </div>
          </div>
        </MobileChipEditor>
        {extractionEditor}
      </>
    );

  return (
    <>
      <span
        className={cx(
          "qt-chip",
          "qt-chip--col",
          "qt-chip--sort",
          isDragSource && "qt-chip--dragging",
          classNames?.chip,
        )}
        draggable={!disabled}
        onDragStart={(e) => {
          onDragStart();
          // Firefox refuses to start a native drag unless drag data is set here.
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", term.field);
        }}
        onDragOver={onDragOver}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        onDragEnd={onDragEnd}
        title="drag to reorder sort priority"
      >
        <span aria-hidden className="qt-chip-grip">
          <Icon name="grip" />
        </span>
        {showPriority && <span className="qt-chip-priority">{priority}</span>}
        <span className="qt-chip-field">{label}</span>
        <button
          type="button"
          className="qt-chip-op-btn"
          disabled={disabled}
          onClick={() =>
            updateTerm(dataIndex, { dir: term.dir === "asc" ? "desc" : "asc" })
          }
        >
          <Icon name={term.dir === "asc" ? "arrowUp" : "arrowDown"} />
          {term.dir === "asc" ? "asc" : "desc"}
        </button>
        {term.extract && <button
          type="button"
          className="qt-chip-op-btn"
          title={`Regex: ${term.extract.regex}`}
          aria-label={`Configure regex extract for ${label}`}
          disabled={disabled}
          onClick={() => setExtractOpen(true)}
        >
          <Icon name="pencil" />
          regex extraction
        </button>}
        {(term.extract != null || fieldHasNull !== false) && (
          <button
            type="button"
            className="qt-chip-op-btn"
            disabled={disabled}
            title="where NULL values sort"
            onClick={() =>
              updateTerm(dataIndex, {
                nulls: (term.nulls ?? "last") === "last" ? "first" : "last",
              })
            }
          >
            nulls {term.nulls ?? "last"}
          </button>
        )}
        <button
          type="button"
          className="qt-chip-x"
          onClick={() => removeTerm(dataIndex)}
          disabled={disabled}
          aria-label={`Remove ${label} sort`}
        >
          <Icon name="close" />
        </button>
      </span>
      {extractionEditor}
    </>
  );
}

function OrderRow<Row>({
  api,
  fields,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const orderBy = api.query.orderBy;
  const mobile = useMobileLayout();
  const byName = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  // Local live-reorder drag state (sort terms are their own list, distinct from
  // the columns shared via api.columnDrag) — same dimmed-source + slide preview.
  const [drag, setDrag] = useState<{
    source: string;
    overIndex: number;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  // Field chosen in the "sort with regex extraction" configurator (split-button caret).
  const [regexField, setRegexField] = useState<FieldDef<Row> | null>(null);
  const [regexDirection, setRegexDirection] = useState<OrderByClause["dir"]>("desc");

  const [editingSort, setEditingSort] = useState<string | null>(null);

  function setOrderBy(next: OrderByClause[]) {
    api.setSort(next);
  }
  function updateTerm(i: number, patch: Partial<OrderByClause>) {
    setOrderBy(orderBy.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function clearExtract(i: number) {
    setOrderBy(
      orderBy.map((term, index) => {
        if (index !== i) return term;
        const { extract: _extract, ...plainTerm } = term;
        return plainTerm;
      }),
    );
  }
  function removeTerm(i: number) {
    setEditingSort(null);
    setOrderBy(orderBy.filter((_, k) => k !== i));
  }
  function addTerm(f: FieldDef<Row>, dir: OrderByClause["dir"], extract?: OrderByClause["extract"]) {
    const field = f.sort?.field ?? f.name;
    const nextOrderBy: OrderByClause[] = [
      ...orderBy,
      { field, dir, ...(extract ? { extract } : {}) },
    ];

    const existing = orderBy.findIndex((o) => o.field === field);
    if (existing >= 0) {
      updateTerm(existing, { dir, ...(extract ? { extract } : {}) });
      setAdding(false);
      return;
    }

    const hasSelectColumn = api.select.visible.some((c) => c.field === field);
    if (hasSelectColumn) {
      setOrderBy(nextOrderBy);
      setAdding(false);
      return;
    }

    api.setQuery((q) => ({
      ...q,
      offset: 0,
      orderBy: nextOrderBy,
      select: q.select.length
        ? [...q.select, { field }]
        : [...api.select.visible, { field }],
    }));
    setAdding(false);
  }

  // Order-by terms are identified by their (unique) field; the drag math mirrors
  // the column chips so the live preview equals the committed order.
  const termFields = orderBy.map((o) => o.field);
  const termByField = useMemo(
    () => new Map(orderBy.map((o) => [o.field, o])),
    [orderBy],
  );
  function previewFields(): string[] {
    if (!drag) return termFields;
    const without = termFields.filter((f) => f !== drag.source);
    if (without.length === termFields.length) return termFields;
    const at = Math.max(0, Math.min(drag.overIndex, without.length));
    return [...without.slice(0, at), drag.source, ...without.slice(at)];
  }
  function handleSortOver(e: React.DragEvent, field: string) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drag.source !== field) {
      const without = termFields.filter((f) => f !== drag.source);
      let next = without.indexOf(field);
      if (next >= 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX > rect.left + rect.width / 2) next += 1;
        setDrag((d) =>
          d && d.overIndex !== next ? { source: d.source, overIndex: next } : d,
        );
      }
    }
  }
  function commitSortDrop() {
    if (drag) setOrderBy(previewFields().map((f) => termByField.get(f)!));
    setDrag(null);
  }

  const rendered = previewFields();
  const sortable = fields.filter(isSortable);
  const sortKey = (f: FieldDef<Row>) => f.sort?.field ?? f.name;
  function selectRegexField(field: FieldDef<Row> | null) {
    setRegexField(field);
    setRegexDirection(field ? termByField.get(sortKey(field))?.dir ?? "desc" : "desc");
  }
  function openRegexConfigurator(field?: FieldDef<Row>) {
    const unsorted = sortable.filter((f) => !termFields.includes(sortKey(f)));
    const chosen = field ??
      unsorted.find((f) => f.type === "text") ??
        unsorted[0] ??
        sortable[0] ??
        null;
    selectRegexField(chosen);
    setAdding(false);
  }
  const renderTerm = (name: string, position: number) => {
    const term = termByField.get(name)!;
    return (
      <OrderTermChip
        key={name}
        api={api}
        field={byName.get(name)}
        term={term}
        dataIndex={orderBy.findIndex((candidate) => candidate.field === name)}
        priority={position + 1}
        showPriority={orderBy.length > 1}
        isDragSource={drag?.source === name}
        onDragStart={() =>
          setDrag({ source: name, overIndex: termFields.indexOf(name) })
        }
        onDragOver={(event) => handleSortOver(event, name)}
        onDrop={commitSortDrop}
        onDragEnd={() => setDrag(null)}
        disabled={disabled}
        updateTerm={updateTerm}
        clearExtract={clearExtract}
        removeTerm={removeTerm}
        classNames={classNames}
        label={byName.get(name)?.label ?? name}
        editorOpen={editingSort === name}
        onEditorChange={(open) => setEditingSort(open ? name : null)}
      />
    );
  };
  const isDefaultOrderBy =
    orderBy.length === api.defaults.orderBy.length &&
    orderBy.every((term, i) => {
      const next = api.defaults.orderBy[i];
      return (
        term.field === next?.field &&
        term.dir === next?.dir &&
        (term.nulls ?? "last") === (next?.nulls ?? "last") &&
        (term.extract?.regex ?? null) === (next?.extract?.regex ?? null)
      );
    });

  const actions = (
    <>
      <PickerAnchor>
      <span className="qt-split-btn" role="group" aria-label="Sort actions">
        <button
          type="button"
          className="qt-add"
          aria-label="Add sort"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={() => setAdding(previous => !previous)}
          disabled={disabled || sortable.length === 0}
        >
          <Icon name="add" />
          {mobile ? "Add" : "add sort"}
        </button>
        <button
          type="button"
          className="qt-add qt-split-btn-caret"
          aria-label="Sort with regex extraction"
          title="Sort with regex extraction"
          aria-haspopup="dialog"
          aria-expanded={regexField != null}
          disabled={disabled || sortable.length === 0}
          onClick={() => openRegexConfigurator()}
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </span>
      {adding && (
        <SortPicker
          fields={sortable}
          onPick={addTerm}
          onRegex={openRegexConfigurator}
          onClose={() => setAdding(false)}
        />
      )}
      </PickerAnchor>
      {!isDefaultOrderBy && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => api.setSort(api.defaults.orderBy)}
          disabled={disabled}
        >
          {mobile ? "Reset" : "reset"}
        </button>
      )}
    </>
  );

  return (
    <div className={cx("qt-qb-row qt-qb-row--sort", orderBy.length === 0 && "qt-qb-row--unused")}>
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label="Sort">
          order by
        </span>
        {mobile && actions}
      </div>
      {orderBy.length === 0 && !adding && (
        <span className="qt-qb-hint">(default)</span>
      )}
      {mobile && orderBy.length > 0 ? (
        <ReorderList
          className="qt-query-reorder-list"
          showHint={false}
          items={orderBy.map((term) => ({
            id: term.field,
            label: orderByAsText(term, byName),
          }))}
          disabled={disabled}
          renderItem={(item, position) => renderTerm(item.id, position)}
          onMove={(id, position) => {
            const next = [...orderBy];
            const source = next.findIndex((term) => term.field === id);
            if (source < 0) return;
            const [term] = next.splice(source, 1);
            next.splice(position, 0, term!);
            setOrderBy(next);
          }}
        />
      ) : (
        rendered.map(renderTerm)
      )}
      {!mobile && actions}
      {regexField && (
        <SortExtractionEditor
          api={api}
          field={sortKey(regexField)}
          label={regexField.label}
          initialPattern={termByField.get(sortKey(regexField))?.extract?.regex}
          direction={regexDirection}
          onDirectionChange={setRegexDirection}
          fieldOptions={sortable.map((f) => ({
            name: sortKey(f),
            label: f.label,
          }))}
          onFieldChange={(name) => {
            const next = sortable.find((f) => sortKey(f) === name);
            if (next) selectRegexField(next);
          }}
          title="Sort with regex extraction"
          applyLabel={
            termFields.includes(sortKey(regexField))
              ? "Update sort"
              : "Add sort"
          }
          disabled={disabled}
          onApply={(regex) => {
            addTerm(regexField, regexDirection, { regex });
            setRegexField(null);
          }}
          onRemove={() => {
            clearExtract(orderBy.findIndex((term) => term.field === sortKey(regexField)));
            setRegexField(null);
          }}
          onClose={() => setRegexField(null)}
        />
      )}
    </div>
  );
}

// ---- LIMIT / OFFSET -------------------------------------------------------

function WindowRow<Row>({
  api,
  total,
  classNames,
  disabled,
  compact,
}: {
  api: QueryTableApi<Row>;
  total: number | null;
  compact?: boolean;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { query } = api;
  const offsetId = useId();
  const [addingOffset, setAddingOffset] = useState(false);
  const offsetInput = useRef<HTMLInputElement>(null);
  const [limitDraft, setLimitDraft] = useState(String(query.limit));
  const [offsetDraft, setOffsetDraft] = useState(String(query.offset));
  useEffect(() => setLimitDraft(String(query.limit)), [query.limit]);
  useEffect(() => setOffsetDraft(String(query.offset)), [query.offset]);
  useEffect(() => {
    if (query.offset > 0) setAddingOffset(false);
  }, [query.offset]);
  useEffect(() => {
    if (addingOffset) {
      offsetInput.current?.focus();
      offsetInput.current?.select();
    }
  }, [addingOffset]);

  function commitLimit() {
    api.setLimit(Math.max(1, Number(limitDraft) || query.limit));
  }
  function commitOffset() {
    api.setOffset(Math.max(0, Number(offsetDraft) || 0));
  }

  return (
    <div className="qt-qb-row qt-qb-pagination">
      <label className="qt-qb-window-field">
        <span className="qt-qb-kw" data-mobile-label="Limit">
          limit
        </span>
        <input
          className={cx("qt-qb-num", classNames?.input)}
          type="number"
          min={1}
          value={limitDraft}
          disabled={disabled}
          onChange={(e) => setLimitDraft(e.target.value)}
          onBlur={commitLimit}
          onKeyDown={(e) => e.key === "Enter" && commitLimit()}
        />
      </label>
      {(!compact || query.offset > 0 || addingOffset) ? <div className="qt-qb-window-field">
        <label
          className="qt-qb-kw"
          htmlFor={offsetId}
          data-mobile-label="Offset"
        >
          offset
        </label>
        <span className="qt-qb-num-combo">
          <input
            ref={offsetInput}
            id={offsetId}
            className={cx("qt-qb-num", classNames?.input)}
            type="number"
            min={0}
            value={offsetDraft}
            disabled={disabled}
            onChange={(e) => setOffsetDraft(e.target.value)}
            onBlur={commitOffset}
            onKeyDown={(e) => e.key === "Enter" && commitOffset()}
          />
          {query.offset >= query.limit && (
            <button
              type="button"
              className="qt-qb-num-step"
              onClick={() => api.setOffset(query.offset - query.limit)}
              disabled={disabled}
              title={`Previous ${query.limit} rows`}
              aria-label={`Previous ${query.limit} rows`}
            >
              −{query.limit}
            </button>
          )}
          <button
            type="button"
            className="qt-qb-num-step"
            onClick={() => api.setOffset(query.offset + query.limit)}
            disabled={
              disabled || (total != null && query.offset + query.limit >= total)
            }
            title={`Next ${query.limit} rows`}
            aria-label={`Next ${query.limit} rows`}
          >
            +{query.limit}
          </button>
        </span>
        {compact && <button type="button" className="qt-chip-x" aria-label="Clear offset" disabled={disabled} onClick={() => { setAddingOffset(false); api.setOffset(0); }}><Icon name="close" /></button>}
      </div> : <button type="button" className="qt-add" aria-label="Add offset" disabled={disabled} onClick={() => setAddingOffset(true)}><Icon name="add" />add offset</button>}
    </div>
  );
}

// Metrics authoring lives in a single transactional workbench.
function MetricsRow<Row>({
  api,
  fields,
  theme,
  locale,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  theme: MetricTheme | undefined;
  locale: string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const allFields = useMemo(
    () => [
      ...fields,
      ...api.computed.catalogue.filter(
        (f) => !fields.some((existing) => existing.name === f.name),
      ),
    ],
    [fields, api.computed.catalogue],
  );
  return (
    <>
      {api.aggregations.clauses.length === 0 && (
        <div className="qt-qb-row qt-qb-row--metrics qt-qb-row--unused">
          <div className="qt-qb-section-header">
            <span className="qt-qb-kw" data-mobile-label="Metrics">
              metrics
            </span>
            <button
              type="button"
              className="qt-add qt-metrics-open"
              aria-label="Add metric"
              aria-haspopup="dialog"
              onClick={() => setEditing(true)}
            >
              <Icon name="add" />
              add metric
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
        </div>
      )}
      {editing && (
        <MetricsEditor
          api={api}
          fields={allFields}
          onClose={() => setEditing(false)}
          {...(theme ? { theme } : {})}
          {...(locale ? { locale } : {})}
        />
      )}
    </>
  );
}
