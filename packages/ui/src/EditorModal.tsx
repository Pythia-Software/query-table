import type { ReactNode } from "react";
import { ModalSurface } from "./AdaptiveOverlay";
import { Icon, type IconName } from "./Icon";
import type { useEditorWorkbench } from "./useEditorWorkbench";

export type EditorWorkbench = ReturnType<typeof useEditorWorkbench>;

/** Shared shell for transactional editors. Panel geometry never changes query state. */
export function EditorModal({
  title,
  titleId,
  closeLabel,
  onClose,
  workbench,
  headerActions,
  panelControls,
  children,
  className = "",
}: {
  title: string;
  titleId?: string;
  closeLabel?: string;
  onClose: () => void;
  workbench: EditorWorkbench;
  headerActions?: ReactNode;
  panelControls?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ModalSurface
      title={title}
      onClose={onClose}
      chrome={false}
      className={`qt-modal qt-metrics-editor qt-editor-modal ${className}`}
    >
      <header ref={workbench.header} className="qt-metrics-editor-header">
        <h2 id={titleId}>{title}</h2>
        {headerActions}
        {panelControls}
        <button
          type="button"
          className="qt-btn qt-metric-reset-layout"
          title="Restore dialog size and default panels"
          onClick={workbench.reset}
        >
          Reset layout
        </button>
        <button
          type="button"
          className="qt-btn qt-metric-close"
          aria-label={closeLabel ?? `Close ${title.toLowerCase()}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </ModalSurface>
  );
}

export function EditorPanelToggle({
  workbench,
  index,
  label,
  icon,
  paneId,
  collapse = false,
}: {
  workbench: EditorWorkbench;
  index: number;
  label: string;
  icon: IconName;
  paneId: string;
  collapse?: boolean;
}) {
  const shown = workbench.visiblePanes[index];
  return (
    <button
      type="button"
      className={`qt-btn qt-metric-icon-button${collapse ? " qt-metric-pane-collapse" : ""}`}
      aria-label={
        collapse ? `Hide ${label.toLowerCase()} panel` : `${label} panel`
      }
      aria-controls={paneId}
      aria-pressed={collapse ? undefined : shown}
      disabled={shown && workbench.visibleIndices.length === 1}
      title={`${shown ? "Hide" : "Show"} ${label.toLowerCase()} panel`}
      onClick={() => workbench.togglePane(index)}
    >
      <Icon name={collapse ? "close" : icon} />
    </button>
  );
}

export function EditorPanelSeparator({
  workbench,
  index,
  label,
  controls,
}: {
  workbench: EditorWorkbench;
  index: number;
  label: string;
  controls: string;
}) {
  const next = workbench.nextPane(index);
  if (!workbench.visiblePanes[index] || next === undefined) return null;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      title="Drag to resize. Arrow keys adjust width; Home or double-click resets."
      aria-valuemin={workbench.minWidths[index]}
      aria-valuenow={Math.round(workbench.widths[index] ?? 0)}
      aria-valuemax={
        (workbench.widths[index] ?? 0) +
        (workbench.widths[next] ?? 0) -
        (workbench.minWidths[next] ?? 0)
      }
      aria-valuetext={`${Math.round(workbench.widths[index] ?? 0)} pixels`}
      className="qt-metric-pane-separator"
      onDoubleClick={workbench.resetPanes}
      onPointerDown={(e) => workbench.startResize(e, index)}
      onKeyDown={(e) => {
        if (e.key === "Home") {
          e.preventDefault();
          workbench.resetPanes();
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          workbench.stepResize(
            index,
            (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 50 : 10),
          );
        }
      }}
    />
  );
}
