// QueryBuilder — the chip toolbar: WHERE filters, SELECT columns, ORDER BY
// (multi-sort, reorderable), and LIMIT/OFFSET paging. Type-aware filter inputs
// (enum/static <select>, value autocomplete via Transport.fetchDistinctValues).
// Hosts the Save / saved-queries entry point.
//
// A union of both projects' builders: xplo-perf's chip layout + datalist
// autocomplete and xlsx-collect's draggable column chips, grouped picker, and
// per-clause operator dropdowns. Multi-sort (orderBy is an array) is new to both.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AggOp,
  AggregationClause,
  DistinctValuesResult,
  FieldDef,
  FilterOp,
  OrderByClause,
  WhereClause,
} from "@query-table/core";
import {
  NULLARY_OPS,
  aggOpNeedsField,
  aggOpsForField,
  filterValues as filterValuesFor,
  isGroupable,
  isMeasurable,
  queriesEqual,
  isFilterable,
  isSelectable,
  isSortable,
  opsForField,
} from "@query-table/core";
import type { QueryTableApi } from "@query-table/react";
import type { QueryBuilderClassNames } from "./classNames";
import { FieldPicker } from "./FieldPicker";
import { SavedQueriesModal } from "./SavedQueriesModal";

export interface QueryBuilderProps<Row> {
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
}

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

const MAX_AUTO_REFRESH_POLLS = 1000;
const DEFAULT_AUTO_REFRESH_FREQUENCY_MS = 20_000;
const DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS = 5 * 60_000;

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
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function useFieldHasNull<Row>(api: QueryTableApi<Row>, fieldName: string | undefined): boolean | undefined {
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
  }, [api, fieldName]);

  return hasNull;
}

function whereClauseAsText<Row>(clause: WhereClause, byName: Map<string, FieldDef<Row>>): string {
  const field = byName.get(clause.field)?.label ?? clause.field;
  const op = clause.op.replace(/_/g, " ");
  if (NULLARY_OPS.has(clause.op)) return `${field} ${op}`;
  const value = clause.value === "" ? "''" : clause.value;
  return `${field} ${op} ${value}`;
}

function orderByAsText<Row>(term: OrderByClause, byName: Map<string, FieldDef<Row>>): string {
  const field = byName.get(term.field)?.label ?? term.field;
  const nulls = term.nulls ? ` nulls ${term.nulls}` : "";
  return `${field} ${term.dir}${nulls}`;
}

function chipFieldWidthChars(text: string, fallback = 5, max = 30): number {
  return Math.min(max, Math.max(fallback, (text || "").length + 1));
}

function chipFieldWidthForInput(text: string, fieldType: string | undefined, fallback = 5, padding = 0): number {
  const cap = fieldType === "number" ? 10 : 30;
  return chipFieldWidthChars(text, fallback, cap) + padding;
}

function chipFieldWidthForSelect(text: string, fallback = 3, max = 30): number {
  return chipFieldWidthChars(text, fallback, max) + 2;
}

function buildCollapsedSummary<Row>(
  where: WhereClause[],
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  const whereText = where.length === 0 ? "all rows" : where.map((c) => whereClauseAsText(c, byName)).join(" and ");
  const orderText = orderBy.length === 0 ? "(default)" : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
  return `WHERE ${whereText} ORDER BY ${orderText}`;
}

function whereClauseSummaryText<Row>(where: WhereClause[], byName: Map<string, FieldDef<Row>>): string {
  return where.length === 0 ? "all rows" : where.map((c) => whereClauseAsText(c, byName)).join(" and ");
}

function orderBySummaryText<Row>(orderBy: OrderByClause[], byName: Map<string, FieldDef<Row>>): string {
  return orderBy.length === 0 ? "(default)" : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
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
}: QueryBuilderProps<Row>): ReactNode {
  const UNSAVED_QUERY_EDIT_ID = "__qt-unsaved-query__";
  const [showSaved, setShowSaved] = useState(false);
  const [showAutoRefresh, setShowAutoRefresh] = useState(false);
  const [autoRefreshFrequencyMs, setAutoRefreshFrequencyMs] = useState(DEFAULT_AUTO_REFRESH_FREQUENCY_MS);
  const [autoRefreshTurnOffAfterMs, setAutoRefreshTurnOffAfterMs] = useState(DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS);
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
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const activeSavedQuery = useMemo(
    () => api.saved.items.find((item) => queriesEqual(item.query, api.query)),
    [api.query, api.saved.items],
  );
  const lastSavedQuery = useMemo(
    () => api.saved.items.find((item) => item.id === lastSavedId) ?? null,
    [api.saved.items, lastSavedId],
  );
  const isSavedQuery = activeSavedQuery != null;
  const isEditingUnsaved = editingSavedId === UNSAVED_QUERY_EDIT_ID;
  const bodyId = useId();
  const isEditingSaved = editingSavedId != null && activeSavedQuery?.id === editingSavedId;
  const showUpdateButton = Boolean(lastSavedQuery) && !activeSavedQuery;
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
  const selectedAutoRefreshPolls = autoRefreshPolls(autoRefreshFrequencyMs, autoRefreshTurnOffAfterMs);
  const canSubmitAutoRefresh = selectedAutoRefreshPolls >= 1 && selectedAutoRefreshPolls <= MAX_AUTO_REFRESH_POLLS;
  const autoRefreshButtonText = autoRefreshStatus
    ? `⟳ Auto-Update ${formatDuration(autoRefreshStatus.frequencyMs)}`
    : "⟳ Auto-Update";
  const rowSummary = `${api.rows.length} of ${total ?? "?"}`;
  const lastUpdatedText = formatStatusTime(lastUpdatedAt);
  const failureText = api.error
    ? `Error: ${api.error.message}`
    : lastFailureAt
      ? `Last failure at ${formatStatusTime(lastFailureAt)}`
      : null;
  const isBusy = Boolean(running) || api.loading;
  const lastRowsRef = useRef<Row[] | null>(null);
  const lastTotalRef = useRef<number | null>(null);
  const previousLoadingRef = useRef(api.loading);
  const autoRefreshRef = useRef<HTMLSpanElement>(null);
  const autoRefreshPopoverRef = useRef<HTMLSpanElement>(null);
  const [autoRefreshPopoverAlignRight, setAutoRefreshPopoverAlignRight] = useState(false);

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
    if (!lastSavedId || api.saved.items.some((item) => item.id === lastSavedId)) return;
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
      (previousLoadingRef.current || rowsChanged || totalChanged || lastUpdatedAt == null) &&
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
    const message = error instanceof Error ? error.message : "Failed to save query.";
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
    const wasDefault = api.saved.defaultId === lastSavedQuery.id;
    const trimmedName = lastSavedQuery.name.trim();
    if (!trimmedName) return;

    try {
      await api.saved.remove(lastSavedQuery.id);
      const saved = await api.saved.save(trimmedName);
      if (wasDefault) await api.saved.setDefault(saved.id);
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

  useEffect(() => {
    if (!showAutoRefresh) return;

    function onDocumentClick(event: MouseEvent) {
      const wrapper = autoRefreshRef.current;
      const target = event.target as Node | null;
      if (!wrapper || !target) return;
      if (!wrapper.contains(target)) setShowAutoRefresh(false);
    }

    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setShowAutoRefresh(false);
    }

    function calculateAutoRefreshPosition() {
      const popover = autoRefreshPopoverRef.current;
      const wrapper = autoRefreshRef.current;
      if (!popover || !wrapper) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const popWidth = popover.offsetWidth;
      const viewportRightInset = 8;
      setAutoRefreshPopoverAlignRight(wrapperRect.right + popWidth > window.innerWidth - viewportRightInset);
    }

    calculateAutoRefreshPosition();
    const t = setTimeout(() => window.addEventListener("click", onDocumentClick), 0);
    window.addEventListener("keydown", onDocumentKeyDown);
    window.addEventListener("resize", calculateAutoRefreshPosition);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", onDocumentClick);
      window.removeEventListener("keydown", onDocumentKeyDown);
      window.removeEventListener("resize", calculateAutoRefreshPosition);
    };
  }, [showAutoRefresh]);

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

  return (
    <div className={cx("qt-qb", classNames?.root)}>
      <div className="qt-qb-bar qt-qb-state-bar qt-qb-row">
        <span className="qt-qb-state-main">
          <span className="qt-qb-saved">
            <button
              type="button"
              className={cx("qt-qb-saved-star", isSavedQuery ? "qt-qb-saved-star--saved" : "qt-qb-saved-star--unsaved")}
              title={isSavedQuery ? "Rename saved query" : "Save query"}
              disabled={isBusy}
              onClick={beginEditSavedName}
            >
              {isSavedQuery ? "★" : "☆"}
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
                  onMouseDown={(e) => {
                    e.preventDefault();
                    cancelNameEdit();
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={cx("qt-qb-saved-name", !activeSavedQuery && "qt-qb-saved-name--custom")}
                onClick={beginEditSavedName}
              >
                {activeSavedQuery ? activeSavedQuery.name : "Custom Query"}
              </button>
            )}
          </span>
          {isCollapsed ? (
            <span className="qt-qb-summary qt-truncate" title={collapsedSummary}>
              <span className="qt-qb-summary-kw">WHERE</span>{" "}
              <strong>{collapsedWhereText}</strong>{" "}
              <span className="qt-qb-summary-kw">ORDER BY</span>{" "}
              <strong>{collapsedOrderText}</strong>
            </span>
          ) : null}
        </span>
        {showUpdateButton ? (
          <button
            type="button"
            className={cx("qt-btn", classNames?.button)}
            onClick={() => void updateLastSavedQuery()}
            disabled={isBusy}
          >
            {`Update Query '${lastSavedQuery?.name ?? "query"}'`}
          </button>
        ) : null}
        <button type="button" className={cx("qt-btn", classNames?.button)} onClick={() => setShowSaved(true)}>
          Saved{api.saved.items.length > 0 ? ` (${api.saved.items.length})` : ""}
        </button>
        <button
          type="button"
          className={cx("qt-btn", "qt-qb-collapse-btn", classNames?.button)}
          onClick={() => setCollapsed(!isCollapsed)}
          aria-expanded={!isCollapsed}
          aria-controls={bodyId}
          title={isCollapsed ? "Expand query builder" : "Collapse query builder"}
        >
          <span
            className={cx("qt-qb-collapse-caret", isCollapsed && "qt-qb-collapse-caret--collapsed")}
            aria-hidden="true"
          >
            ▾
          </span>
          <span className="qt-sr-only">{isCollapsed ? "Expand query builder" : "Collapse query builder"}</span>
        </button>
      </div>

      {!isCollapsed ? (
        <div className="qt-qb-bar qt-qb-editor-bar">
          <div id={bodyId} className="qt-qb-body">
            <SelectRow api={api} fields={fields} classNames={classNames} disabled={isBusy} />
            <WhereRow api={api} byName={byName} fields={fields} classNames={classNames} disabled={isBusy} />
            <OrderRow api={api} fields={fields} classNames={classNames} disabled={isBusy} />
            <WindowRow api={api} classNames={classNames} disabled={isBusy} />
            <MetricsRow api={api} fields={fields} classNames={classNames} disabled={isBusy} />
          </div>
          <div className="qt-qb-editor-stack">
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.undo} disabled={!api.canUndo || isBusy}>
              ↶ Undo
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.redo} disabled={!api.canRedo || isBusy}>
              ↷ Redo
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.resetAll} disabled={isBusy}>
              Reset All
            </button>
          </div>
        </div>
      ) : null}

      <div className="qt-qb-bar qt-qb-run-bar qt-qb-row">
        <span className="qt-qb-run-metric qt-qb-run-metric--strong">{api.loading ? "loading…" : `${rowSummary} rows`}</span>
        <span className="qt-qb-run-metric">Last updated {lastUpdatedText}</span>
        {failureText ? <span className="qt-qb-run-error">{failureText}</span> : null}
        <span className="qt-qb-run-actions">
          {autoRefreshStatus ? (
            <span className="qt-qb-auto-status">
              {`Every ${formatDuration(autoRefreshStatus.frequencyMs)}; clear after ${formatDuration(
                autoRefreshStatus.turnOffAfterMs,
              )} (${autoRefreshStatus.pollCount} polls run)`}
            </span>
          ) : null}
            <span className="qt-auto-refresh" ref={autoRefreshRef}>
            <button
              type="button"
              className={cx("qt-btn", Boolean(autoRefreshStatus) && "qt-btn--active", classNames?.button)}
              onClick={() => setShowAutoRefresh((next) => !next)}
              aria-expanded={showAutoRefresh}
              title={autoRefreshStatus ? "View or clear auto-update" : "Configure auto-update"}
            >
              {autoRefreshButtonText}
            </button>
            {showAutoRefresh ? (
              <span
                ref={autoRefreshPopoverRef}
                className={cx("qt-auto-refresh-popover", autoRefreshPopoverAlignRight && "qt-auto-refresh-popover--align-right")}
                role="dialog"
                aria-label="Auto-refresh settings"
              >
                <label className="qt-auto-refresh-field">
                  <span>Frequency</span>
                  <select
                    className="qt-auto-refresh-select"
                    value={autoRefreshFrequencyMs}
                    onChange={(e) => setAutoRefreshFrequencyMs(Number(e.target.value))}
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
                    onChange={(e) => setAutoRefreshTurnOffAfterMs(Number(e.target.value))}
                  >
                    {AUTO_REFRESH_TURN_OFF_AFTER.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={
                          autoRefreshPolls(autoRefreshFrequencyMs, option.value) < 1 ||
                          autoRefreshPolls(autoRefreshFrequencyMs, option.value) > MAX_AUTO_REFRESH_POLLS
                        }
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className={cx("qt-auto-refresh-status", !canSubmitAutoRefresh && "qt-auto-refresh-status--error")}>
                  {canSubmitAutoRefresh
                    ? `${selectedAutoRefreshPolls} polls maximum`
                    : `Choose between 1 and 1000 polls`}
                </span>
                {autoRefreshStatus ? (
                  <span className="qt-auto-refresh-status">
                    Active: every {formatDuration(autoRefreshStatus.frequencyMs)}, clears after{" "}
                    {formatDuration(autoRefreshStatus.turnOffAfterMs)}. {autoRefreshStatus.pollCount} polls run.
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
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className={cx("qt-btn", "qt-btn--primary", classNames?.button)}
            onClick={api.refresh}
            disabled={isBusy}
          >
            Run Now
          </button>
        </span>
      </div>

      {!isCollapsed && showSaved ? (
        <SavedQueriesModal saved={api.saved} onClose={() => setShowSaved(false)} onLoad={setLastSavedId} />
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
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { select, columnDrag } = api;
  const [adding, setAdding] = useState(false);
  const fieldLabelByName = useMemo(() => new Map(select.fields.map((f) => [f.name, f.label])), [select.fields]);

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

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">select</span>
      {rendered.map((name) => {
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
            columnDrag.start(name, fieldNames.indexOf(name));
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
              const withoutDragged = fieldNames.filter((n) => n !== columnDrag.source);
              let next = withoutDragged.indexOf(name);
              if (next >= 0) {
                // Drop after the hovered chip when past its midpoint, so a column
                // can be moved into the last slot.
                const rect = e.currentTarget.getBoundingClientRect();
                if (e.clientX > rect.left + rect.width / 2) next += 1;
                columnDrag.over(next);
              }
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const from = columnDrag.source || e.dataTransfer.getData("text/plain");
            if (from && columnDrag.overIndex != null) reorderByIndex(from, columnDrag.overIndex);
            columnDrag.end();
          }}
          onDragEnd={() => columnDrag.end()}
          title="drag to reorder"
        >
          <span aria-hidden className="qt-chip-grip">
            ⋮⋮
          </span>
          <span className="qt-chip-field">{label}</span>
          <button type="button" className="qt-chip-x" onClick={() => select.hide(name)} disabled={disabled}>
            ✕
          </button>
        </span>
        );
      })}
      {adding ? (
        <FieldPicker
          fields={select.hidden.filter(isSelectable)}
          onPick={(f) => {
            select.show(f.name);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className="qt-add"
          onClick={() => setAdding(true)}
          disabled={disabled || select.hidden.length === 0}
        >
          + add column
        </button>
      )}
      {api.query.select.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={select.reset} disabled={disabled} title="Reset to default columns">
          reset
        </button>
      )}
    </div>
  );
}

// ---- WHERE ----------------------------------------------------------------

function WhereRow<Row>({
  api,
  byName,
  fields,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  byName: Map<string, FieldDef<Row>>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const [adding, setAdding] = useState(false);

  function addClause(f: FieldDef<Row>) {
    const op = opsForField(f)[0] ?? "=";
    api.addFilter({ field: f.name, op, value: "" });
    setAdding(false);
  }

  const groupedWhere = useMemo(() => {
    const groups = new Map<string, { field: string; clauses: { clause: WhereClause; index: number }[] }>();
    const order: string[] = [];

    api.query.where.forEach((c, i) => {
      if (!groups.has(c.field)) order.push(c.field);
      const group = groups.get(c.field) ?? { field: c.field, clauses: [] };
      group.clauses.push({ clause: c, index: i });
      groups.set(c.field, group);
    });

    return order.map((fieldName) => groups.get(fieldName)!);
  }, [api.query.where]);

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">where</span>
      {api.query.where.length === 0 && !adding && <span className="qt-qb-hint">all rows</span>}
      {groupedWhere.map((g) => (
        <ClauseChip
          key={g.field}
          api={api}
          field={byName.get(g.field)}
          clauses={g.clauses}
          classNames={classNames}
          disabled={disabled}
          onChange={(index, next) => api.updateFilter(index, next)}
          onRemove={(index) => api.removeFilter(index)}
        />
      ))}
      {adding ? (
        <FieldPicker
          fields={fields.filter(isFilterable)}
          gateOnDistinct
          onPick={addClause}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="qt-add" onClick={() => setAdding(true)} disabled={disabled}>
          + add filter
        </button>
      )}
      {api.query.where.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={api.clearFilters} disabled={disabled} title="Reset filters">
          reset
        </button>
      )}
    </div>
  );
}

function ClauseChip<Row>({
  api,
  field,
  clauses,
  classNames,
  disabled,
  onChange,
  onRemove,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  clauses: Array<{ clause: WhereClause; index: number }>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  onChange: (index: number, c: WhereClause) => void;
  onRemove: (index: number) => void;
}) {
  const labelField = field?.label;
  const fieldName = clauses[0]?.clause.field;
  const fieldHasNull = useFieldHasNull(api, field?.name);

  return (
    <span className={cx("qt-chip", "qt-chip--where", classNames?.chip)}>
      <span className="qt-chip-field">{labelField ?? fieldName}</span>
      <span className="qt-chip-where-list">
        {clauses.map((entry, idx) => {
          const clause = entry.clause;
          const baseOps: FilterOp[] = field ? opsForField(field) : [clause.op];
          const filteredBaseOps = fieldHasNull === false ? baseOps.filter((op) => !NULLARY_OPS.has(op)) : baseOps;
          const clauseOps: FilterOp[] = filteredBaseOps.includes(clause.op)
            ? filteredBaseOps
            : [...filteredBaseOps, clause.op];
          const needsValue = !NULLARY_OPS.has(clause.op);
          return (
            <span className="qt-chip-where-clause" key={entry.index}>
              {idx > 0 && <span className="qt-chip-and">and</span>}
              <select
                className={cx("qt-chip-op", classNames?.select)}
                value={clause.op}
                disabled={disabled}
                style={{ width: `${chipFieldWidthForSelect(clause.op, 3)}ch` }}
                onChange={(e) => onChange(entry.index, { ...clause, op: e.target.value as FilterOp })}
              >
                {clauseOps.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {needsValue && (
                <ValueInput
                  api={api}
                  field={field}
                  value={clause.value}
                  classNames={classNames}
                  onChange={(v) => onChange(entry.index, { ...clause, value: v })}
                />
              )}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => onRemove(entry.index)}
                disabled={disabled}
              >
                ✕
              </button>
            </span>
          );
        })}
      </span>
    </span>
  );
}

// ---- value input: autocomplete by default --------------------------------

function ValueInput<Row>({
  api,
  field,
  value,
  classNames,
  onChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  value: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const strategy = field ? filterValuesFor(field) : { source: "freeform" as const };

  // Static closed domain → a plain <select> of the options.
  if (strategy.source === "static") {
    const selectedText = value || "—";
    const widthChars = chipFieldWidthForSelect(selectedText, 4);
    return (
      <select
        className={cx("qt-chip-val", classNames?.select)}
        value={value}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {strategy.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  // Freeform → a plain input, no suggestions.
  if (strategy.source === "freeform" || !field) {
    const widthChars = chipFieldWidthForInput(value || "value", field?.type, 5, 4);
    return (
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder="value"
        size={widthChars}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // Autocomplete (the default) → debounced combobox backed by api.filterValues.
  return <AutocompleteInput api={api} field={field} value={value} classNames={classNames} onChange={onChange} />;
}

function AutocompleteInput<Row>({
  api,
  field,
  value,
  classNames,
  onChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row>;
  value: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const [result, setResult] = useState<DistinctValuesResult>({ values: [], hasMore: false });
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .filterValues(field.name, value)
        .then((r) => {
          if (!cancelled) setResult(r);
        })
        .catch(() => {
          if (!cancelled) setResult({ values: [], hasMore: false });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, field.name, value]);

  return (
    <span className="qt-autocomplete">
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder="value"
        list={listId}
        size={chipFieldWidthForInput(value || "value", field.type, 5, 4)}
        style={{ width: `${chipFieldWidthForInput(value || "value", field.type, 5, 4)}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {result.values.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      {result.hasMore && <span className="qt-autocomplete-hint">keep typing to refine…</span>}
    </span>
  );
}

// ---- ORDER BY (multi-sort, reorderable) -----------------------------------

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
  removeTerm,
  classNames,
  label,
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
  removeTerm: (i: number) => void;
  classNames: QueryBuilderClassNames | undefined;
  label: string;
}) {
  const fieldHasNull = useFieldHasNull(api, field?.name);

  return (
    <span
      className={cx("qt-chip", "qt-chip--col", "qt-chip--sort", isDragSource && "qt-chip--dragging", classNames?.chip)}
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
        ⋮⋮
      </span>
      {showPriority && <span className="qt-chip-priority">{priority}</span>}
      <span className="qt-chip-field">{label}</span>
      <button
        type="button"
        className="qt-chip-op-btn"
        disabled={disabled}
        onClick={() => updateTerm(dataIndex, { dir: term.dir === "asc" ? "desc" : "asc" })}
      >
        {term.dir === "asc" ? "↑ asc" : "↓ desc"}
      </button>
      {fieldHasNull !== false && (
        <button
          type="button"
          className="qt-chip-op-btn"
          disabled={disabled}
          title="where NULL values sort"
          onClick={() => updateTerm(dataIndex, { nulls: (term.nulls ?? "last") === "last" ? "first" : "last" })}
        >
          nulls {term.nulls ?? "last"}
        </button>
      )}
      <button type="button" className="qt-chip-x" onClick={() => removeTerm(dataIndex)} disabled={disabled}>
        ✕
      </button>
    </span>
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
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  // Local live-reorder drag state (sort terms are their own list, distinct from
  // the columns shared via api.columnDrag) — same dimmed-source + slide preview.
  const [drag, setDrag] = useState<{ source: string; overIndex: number } | null>(null);
  const [adding, setAdding] = useState(false);

  function setOrderBy(next: OrderByClause[]) {
    api.setSort(next);
  }
  function updateTerm(i: number, patch: Partial<OrderByClause>) {
    setOrderBy(orderBy.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function removeTerm(i: number) {
    setOrderBy(orderBy.filter((_, k) => k !== i));
  }
  function addTerm(f: FieldDef<Row>) {
    const field = f.sort?.field ?? f.name;
    const nextOrderBy: OrderByClause[] = [...orderBy, { field, dir: "desc" }];

    if (orderBy.some((o) => o.field === field)) {
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
      select: q.select.length ? [...q.select, { field }] : [...api.select.visible, { field }],
    }));
    setAdding(false);
  }

  // Order-by terms are identified by their (unique) field; the drag math mirrors
  // the column chips so the live preview equals the committed order.
  const termFields = orderBy.map((o) => o.field);
  const termByField = useMemo(() => new Map(orderBy.map((o) => [o.field, o])), [orderBy]);
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
        setDrag((d) => (d && d.overIndex !== next ? { source: d.source, overIndex: next } : d));
      }
    }
  }
  function commitSortDrop() {
    if (drag) setOrderBy(previewFields().map((f) => termByField.get(f)!));
    setDrag(null);
  }

  const rendered = previewFields();
  const sortable = fields.filter(isSortable);
  const isDefaultOrderBy =
    orderBy.length === api.defaults.orderBy.length &&
    orderBy.every((term, i) => {
      const next = api.defaults.orderBy[i];
      return (
        term.field === next?.field &&
        term.dir === next?.dir &&
        (term.nulls ?? "last") === (next?.nulls ?? "last")
      );
    });

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">order by</span>
      {orderBy.length === 0 && !adding && <span className="qt-qb-hint">(default)</span>}
      {rendered.map((f, pos) => {
        const term = termByField.get(f)!;
        return (
          <OrderTermChip
            // Stable key (term field) so React MOVES the dragged chip, not remounts it.
            key={f}
            api={api}
            field={byName.get(f)}
            term={term}
            dataIndex={orderBy.findIndex((o) => o.field === f)}
            priority={pos + 1}
            showPriority={orderBy.length > 1}
            isDragSource={drag?.source === f}
            onDragStart={() => setDrag({ source: f, overIndex: termFields.indexOf(f) })}
            onDragOver={(e) => handleSortOver(e, f)}
            onDrop={commitSortDrop}
            onDragEnd={() => setDrag(null)}
            disabled={disabled}
            updateTerm={updateTerm}
            removeTerm={removeTerm}
            classNames={classNames}
            label={byName.get(f)?.label ?? f}
          />
        );
      })}
      {adding ? (
        <FieldPicker fields={sortable} onPick={addTerm} onClose={() => setAdding(false)} />
      ) : (
        <button type="button" className="qt-add" onClick={() => setAdding(true)} disabled={disabled}>
          + add sort
        </button>
      )}
      {!isDefaultOrderBy && (
        <button type="button" className="qt-link-btn" onClick={() => api.setSort(api.defaults.orderBy)} disabled={disabled}>
          reset
        </button>
      )}
    </div>
  );
}

// ---- LIMIT / OFFSET -------------------------------------------------------

function WindowRow<Row>({
  api,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { query } = api;
  const [limitDraft, setLimitDraft] = useState(String(query.limit));
  const [offsetDraft, setOffsetDraft] = useState(String(query.offset));
  useEffect(() => setLimitDraft(String(query.limit)), [query.limit]);
  useEffect(() => setOffsetDraft(String(query.offset)), [query.offset]);
  const hasLimitDefault = query.limit === api.defaults.limit;
  const hasOffsetDefault = query.offset === api.defaults.offset;
  const hasWindowDefault = hasLimitDefault && hasOffsetDefault;

  function commitLimit() {
    api.setLimit(Math.max(1, Number(limitDraft) || query.limit));
  }
  function commitOffset() {
    api.setOffset(Math.max(0, Number(offsetDraft) || 0));
  }

  return (
    <div className="qt-qb-row qt-qb-pagination">
      <span className="qt-qb-kw">limit</span>
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
      <span className="qt-qb-kw">offset</span>
      <input
        className={cx("qt-qb-num", classNames?.input)}
        type="number"
        min={0}
        value={offsetDraft}
        disabled={disabled}
        onChange={(e) => setOffsetDraft(e.target.value)}
        onBlur={commitOffset}
        onKeyDown={(e) => e.key === "Enter" && commitOffset()}
      />
      {!hasWindowDefault && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => {
            api.setLimit(api.defaults.limit);
            api.setOffset(api.defaults.offset);
          }}
          disabled={disabled}
          title="Reset limit and offset"
        >
          reset
        </button>
      )}
    </div>
  );
}

// ---- METRICS (aggregations: op · measure · group-by, reorderable) ---------

const AGG_OPS: AggOp[] = ["count", "count_distinct", "sum", "avg", "min", "max"];
const AGG_OP_LABELS: Record<AggOp, string> = {
  count: "count",
  count_distinct: "count distinct",
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
};

function MetricsRow<Row>({
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
  const { aggregations } = api;
  const clauses = aggregations.clauses;
  const measurable = useMemo(() => fields.filter(isMeasurable), [fields]);
  const groupable = useMemo(() => fields.filter(isGroupable), [fields]);

  // Local live-reorder drag state (metrics are their own list, like the order-by
  // terms). Chips are identified by their stable clause id so React MOVES the
  // dragged chip instead of remounting it (a remount aborts the native drag).
  const [drag, setDrag] = useState<{ source: string; overIndex: number } | null>(null);

  const ids = clauses.map((c) => c.id);
  const byId = useMemo(() => new Map(clauses.map((c) => [c.id, c])), [clauses]);

  function previewIds(): string[] {
    if (!drag) return ids;
    const without = ids.filter((i) => i !== drag.source);
    if (without.length === ids.length) return ids;
    const at = Math.max(0, Math.min(drag.overIndex, without.length));
    return [...without.slice(0, at), drag.source, ...without.slice(at)];
  }
  function handleOver(e: React.DragEvent, id: string) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drag.source === id) return;
    const without = ids.filter((i) => i !== drag.source);
    let next = without.indexOf(id);
    if (next >= 0) {
      // Drop after the hovered chip when past its midpoint, so a metric can be
      // moved into the last slot (no clientX ⇒ insert before, like the spec).
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX > rect.left + rect.width / 2) next += 1;
      setDrag((d) => (d && d.overIndex !== next ? { source: d.source, overIndex: next } : d));
    }
  }
  function commitDrop() {
    if (drag) aggregations.move(drag.source, drag.overIndex);
    setDrag(null);
  }

  const rendered = previewIds();

  return (
    <div className="qt-qb-row qt-qb-row--metrics">
      <span className="qt-qb-kw">metrics</span>
      {clauses.length === 0 && <span className="qt-qb-hint">none</span>}
      {rendered.map((id) => {
        const clause = byId.get(id)!;
        return (
          <MetricChip
            // Stable key (clause id) so React MOVES the dragged chip, not remounts it.
            key={id}
            clause={clause}
            measurable={measurable}
            groupable={groupable}
            classNames={classNames}
            disabled={disabled}
            isDragSource={drag?.source === id}
            onDragStart={() => setDrag({ source: id, overIndex: ids.indexOf(id) })}
            onDragOver={(e) => handleOver(e, id)}
            onDrop={commitDrop}
            onDragEnd={() => setDrag(null)}
            onChangeOp={(op) => changeMetricOp(aggregations, clause, measurable, op)}
            onChangeField={(field) => aggregations.update(id, { field })}
            onAddGroup={(field) => aggregations.update(id, { groupBy: [...clause.groupBy, field] })}
            onRemoveGroup={(field) =>
              aggregations.update(id, { groupBy: clause.groupBy.filter((g) => g !== field) })
            }
            onRemove={() => aggregations.remove(id)}
          />
        );
      })}
      <button type="button" className="qt-add" onClick={() => aggregations.add()} disabled={disabled}>
        + add metric
      </button>
      {clauses.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={aggregations.clear} disabled={disabled} title="Remove all metrics">
          reset
        </button>
      )}
    </div>
  );
}

/** Change a metric's op, dropping the measure if it's no longer valid for the
 *  new op (e.g. switching avg→count on a text field, or to an op the field type
 *  can't aggregate). `count` keeps any chosen measure. */
function changeMetricOp<Row>(
  aggregations: QueryTableApi<Row>["aggregations"],
  clause: AggregationClause,
  measurable: FieldDef<Row>[],
  op: AggOp,
): void {
  const field = clause.field;
  const stillValid =
    field != null && measurable.some((f) => f.name === field && aggOpsForField(f).includes(op));
  if (field != null && !stillValid) aggregations.update(clause.id, { op, field: undefined });
  else aggregations.update(clause.id, { op });
}

function MetricChip<Row>({
  clause,
  measurable,
  groupable,
  classNames,
  disabled,
  isDragSource,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onChangeOp,
  onChangeField,
  onAddGroup,
  onRemoveGroup,
  onRemove,
}: {
  clause: AggregationClause;
  measurable: FieldDef<Row>[];
  groupable: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  isDragSource: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onChangeOp: (op: AggOp) => void;
  onChangeField: (field: string | undefined) => void;
  onAddGroup: (field: string) => void;
  onRemoveGroup: (field: string) => void;
  onRemove: () => void;
}) {
  const [addingGroup, setAddingGroup] = useState(false);
  const byName = useMemo(() => new Map(groupable.map((f) => [f.name, f])), [groupable]);

  // Measures valid for the current op (a measurable field whose effective ops
  // include this op). `count` may stand alone, so it gets an "(all rows)" choice.
  const needsField = aggOpNeedsField(clause.op);
  const measureOptions = measurable.filter((f) => aggOpsForField(f).includes(clause.op));

  return (
    <span
      className={cx("qt-chip", "qt-chip--agg", isDragSource && "qt-chip--dragging", classNames?.chip)}
      draggable={!disabled}
      onDragStart={(e) => {
        onDragStart();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", clause.id);
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      title="drag to reorder metrics"
    >
      <span aria-hidden className="qt-chip-grip">
        ⋮⋮
      </span>
      <select
        className={cx("qt-chip-op", classNames?.select)}
        value={clause.op}
        disabled={disabled}
        onChange={(e) => onChangeOp(e.target.value as AggOp)}
      >
        {AGG_OPS.map((op) => (
          <option key={op} value={op}>
            {AGG_OP_LABELS[op]}
          </option>
        ))}
      </select>
      <select
        className={cx("qt-chip-val", classNames?.select)}
        value={clause.field ?? ""}
        disabled={disabled}
        onChange={(e) => onChangeField(e.target.value || undefined)}
      >
        {!needsField && <option value="">(all rows)</option>}
        {needsField && clause.field == null && <option value="">measure…</option>}
        {measureOptions.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <span className="qt-chip-agg-by">
        {clause.groupBy.map((g) => (
          <span className="qt-chip-agg-group" key={g}>
            <span className="qt-chip-agg-group-label">{byName.get(g)?.label ?? g}</span>
            <button type="button" className="qt-chip-x" onClick={() => onRemoveGroup(g)} disabled={disabled}>
              ✕
            </button>
          </span>
        ))}
        {addingGroup ? (
          <FieldPicker
            fields={groupable}
            excluded={clause.groupBy}
            onPick={(f) => {
              onAddGroup(f.name);
              setAddingGroup(false);
            }}
            onClose={() => setAddingGroup(false)}
          />
        ) : (
          <button
            type="button"
            className="qt-add qt-chip-agg-add"
            onClick={() => setAddingGroup(true)}
            disabled={disabled}
            title="Group by a field"
          >
            {clause.groupBy.length === 0 ? "+ by" : "+"}
          </button>
        )}
      </span>
      <button type="button" className="qt-chip-x" onClick={onRemove} disabled={disabled} title="Remove metric">
        ✕
      </button>
    </span>
  );
}
