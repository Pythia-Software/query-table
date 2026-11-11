// Entry point of the metric authoring workbench. The component shell lives here;
// state/actions are in metricsEditor/useMetricsEditorState and each pane or
// settings group is a render function in its own metricsEditor/* file.
import { type ReactNode } from "react";
import { MAX_AGGREGATIONS } from "@pythia-software/query-table-core";
import { EditorContext } from "./EditorParts";
import { EditorModal } from "./EditorModal";
import { ModalSurface } from "./AdaptiveOverlay";
import { Icon } from "./Icon";
import { panes, titleOf } from "./metricsEditor/shared";
import { useMetricsEditorState } from "./metricsEditor/useMetricsEditorState";
import { renderDashboardLayout } from "./metricsEditor/dashboardLayout";
import { renderLibraryPane } from "./metricsEditor/libraryPane";
import { renderMetricDefinition } from "./metricsEditor/definitionPane";
import { renderReferencePane } from "./metricsEditor/referencePane";
import { renderPreviewPane } from "./metricsEditor/previewPane";
import type { MetricsEditorProps } from "./metricsEditor/types";

export type { MetricsEditorProps } from "./metricsEditor/types";

/** Transactional query-local authoring; previews never mutate the table query. */
export function MetricsEditor<Row>(
  props: MetricsEditorProps<Row>,
): ReactNode {
  const state = useMetricsEditorState(props);
  const {
    api, fields, onClose, locale, separator, titleId, drafts, setDrafts,
    active, setActive, view, setView, discard, setDiscard, error, announcement,
    setAnnouncement, preview, previewLoading, removed, setRemoved,
    geometryDrag, focusDestination, setNavigation, workbench, selected, dirty,
    contextChanged, diagnostics, navigate, seeInDashboard, createMetric,
    paneProps, panelToggle, paneHeading, close, apply, issues, orderItems,
    selectedPosition,
  } = state;

  return (
    <EditorModal
      title="Edit metrics"
      titleId={titleId}
      closeLabel="Close metric editor"
      onClose={close}
      workbench={workbench}
      headerActions={
        <label>
          <span className="qt-sr-only">Workbench view</span>
          <select
            aria-label="Workbench view"
            value={view}
            onChange={(e) => {
              geometryDrag.stop();
              setView(e.target.value as typeof view);
            }}
          >
            <option value="editor">Metric editor</option>
            <option value="dashboard">Dashboard layout</option>
          </select>
        </label>
      }
      panelControls={
        view === "editor" && (
          <div
            className="qt-metric-panel-tools"
            role="group"
            aria-label="Visible editor panels"
          >
            <span>Panels</span>
            {panes.map((pane, i) => (
              <span key={pane.label}>{panelToggle(i)}</span>
            ))}
          </div>
        )
      }
    >
      <EditorContext
        shown={api.rows.length}
        total={api.total}
        filters={api.query.where.length}
        locale={locale}
      />
      {view === "editor" && (
        <div className="qt-metric-workbench-tools">
          <div className="qt-metric-selection-tools">
            <select
              aria-label="Editing metric"
              value={active}
              onChange={(e) => setActive(e.target.value)}
              disabled={!drafts.length}
            >
              {!drafts.length && <option value="">No metrics yet</option>}
              {orderItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="qt-btn qt-metric-icon-button"
              aria-label="Previous metric"
              title="Previous metric"
              disabled={selectedPosition <= 0}
              onClick={() => setActive(drafts[selectedPosition - 1]!.id)}
            >
              <Icon name="arrowUp" />
            </button>
            <button
              type="button"
              className="qt-btn qt-metric-icon-button"
              aria-label="Next metric"
              title="Next metric"
              disabled={
                selectedPosition < 0 || selectedPosition >= drafts.length - 1
              }
              onClick={() => setActive(drafts[selectedPosition + 1]!.id)}
            >
              <Icon name="arrowDown" />
            </button>
          </div>
          <button
            type="button"
            className="qt-btn qt-metric-context-link"
            disabled={!selected}
            onClick={seeInDashboard}
          >
            <Icon name="dashboard" />
            See in dashboard
            <Icon name="arrowRight" size={14} />
          </button>
        </div>
      )}
      {view === "dashboard" ? (
        renderDashboardLayout(state)
      ) : (
        <div
          ref={workbench.root}
          className="qt-metric-workspace"
          style={{
            gridTemplateColumns: workbench.visibleIndices
              .map((i) => `${workbench.widths[i]}px`)
              .join(" 6px "),
          }}
        >
          {renderLibraryPane(state)}
          {separator(0)}
          <section className="qt-metric-definition" {...paneProps(1)}>
            {paneHeading(1, "Metric definition")}
            {selected ? (
              renderMetricDefinition(state, selected)
            ) : (
              <div className="qt-metric-authoring-empty">
                <Icon name="panelDefinition" size={28} />
                <strong>No metric selected</strong>
                <p>Create a metric to define what you want to measure.</p>
                <button type="button" className="qt-btn" onClick={createMetric}>
                  <Icon name="add" />
                  Create metric
                </button>
              </div>
            )}
          </section>
          {separator(1)}
          {renderReferencePane(state)}
          {separator(2)}
          {renderPreviewPane(state)}
        </div>
      )}
      {error && (
        <p className="qt-metric-editor-error" role="alert">
          {error}
        </p>
      )}
      {contextChanged && (
        <p className="qt-metric-editor-error" role="status">
          The metric configuration changed outside this draft.
        </p>
      )}
      <footer className="qt-metrics-editor-footer">
        <span className="qt-muted">
          {dirty
            ? "Unsaved changes"
            : "Changes stay in this draft until applied."}
        </span>
        {removed && (
          <button
            type="button"
            className="qt-btn qt-metric-undo-remove"
            title={`Restore ${titleOf(removed.clause, fields)}`}
            disabled={drafts.length >= MAX_AGGREGATIONS}
            onClick={() => {
              setDrafts((previous) => {
                const next = [...previous];
                next.splice(
                  Math.min(removed.position, next.length),
                  0,
                  removed.clause,
                );
                return next;
              });
              focusDestination.current = true;
              setNavigation((previous) => previous + 1);
              setActive(removed.clause.id);
              setAnnouncement(`${titleOf(removed.clause, fields)} restored.`);
              setRemoved(null);
            }}
          >
            <Icon name="undo" size={14} />
            Undo remove
          </button>
        )}
        {issues.size > 0 && (
          <button
            type="button"
            className="qt-btn qt-metric-review-issues"
            onClick={() => {
              workbench.showPane(3);
              navigate("editor", issues.keys().next().value);
            }}
          >
            <Icon name="alert" size={14} />
            Review {issues.size} {issues.size === 1 ? "issue" : "issues"}
          </button>
        )}
        <button type="button" className="qt-btn" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="qt-btn qt-btn-primary"
          disabled={
            diagnostics.size > 0 ||
            contextChanged ||
            !!error ||
            previewLoading ||
            !!preview?.metrics.some((m) => m.error)
          }
          onClick={apply}
        >
          Apply metrics
        </button>
      </footer>
      <div className="qt-sr-only" role="status" aria-live="polite">
        {announcement}
        {selectedPosition >= 0
          ? `Selected metric ${selectedPosition + 1} of ${drafts.length}`
          : ""}
      </div>
      {discard && (
        <ModalSurface
          title="Discard metric changes?"
          className="qt-modal qt-metric-discard"
          onClose={() => setDiscard(false)}
        >
          <div className="qt-overlay-body">
            <p>Your metric draft has not been applied.</p>
            <div className="qt-metric-discard-actions">
              <button
                type="button"
                className="qt-btn"
                onClick={() => setDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="qt-btn" onClick={onClose}>
                Discard changes
              </button>
            </div>
          </div>
        </ModalSurface>
      )}
    </EditorModal>
  );
}
