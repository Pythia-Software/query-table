// QueryBuilder — the chip toolbar: WHERE filters, SELECT columns, ORDER BY
// (multi-sort, reorderable), and LIMIT/OFFSET paging. Type-aware filter inputs
// (enum/static <select>, value autocomplete via api.filterValues).
// Hosts the Save / saved-queries entry point.
//
// Combines a chip layout, autocomplete, draggable column chips, a grouped
// picker, per-clause operators, and multi-sort.

import { useGroupingPresentation } from "./grouping/GroupingControls";
import { RequestActivity } from "./RequestActivity";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { queriesEqual } from "@pythia-software/query-table-core";
import { SavedQueriesModal } from "./SavedQueriesModal";
import { formatRowCount, rowCountTitle } from "./formatRowCount";
import { useMobileLayout } from "./AdaptiveOverlay";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import type { QueryBuilderProps } from "./queryBuilder/types";
import {
  MAX_AUTO_REFRESH_POLLS,
  DEFAULT_AUTO_REFRESH_FREQUENCY_MS,
  DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS,
  SHARE_FEEDBACK_MS,
  AUTO_REFRESH_FREQUENCIES,
  AUTO_REFRESH_TURN_OFF_AFTER,
  autoRefreshPolls,
  formatDuration,
  formatStatusTime,
} from "./queryBuilder/toolbarTiming";
import {
  cx,
  buildCollapsedSummary,
  whereClauseSummaryText,
  orderBySummaryText,
} from "./queryBuilder/helpers";
import { SelectRow } from "./queryBuilder/SelectRow";
import { WhereRow } from "./queryBuilder/WhereRow";
import { OrderRow } from "./queryBuilder/OrderRow";
import { WindowRow } from "./queryBuilder/WindowRow";
import { MetricsRow } from "./queryBuilder/MetricsRow";

export type { QueryBuilderProps, SelectPresentation } from "./queryBuilder/types";
export { QueryFilterRow } from "./queryBuilder/WhereRow";

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
  runActionsBeforeActivity,
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
          {runActionsBeforeActivity}
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
