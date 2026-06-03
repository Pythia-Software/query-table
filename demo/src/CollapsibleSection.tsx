import { useId, type ReactNode } from "react";

export interface CollapsibleSectionProps {
  title: string;
  collapsed: boolean;
  onToggle: (nextCollapsed: boolean) => void;
  collapsedSummary?: ReactNode;
  children: ReactNode;
  className?: string;
}

const cx = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(" ");

export function CollapsibleSection({
  title,
  collapsed,
  onToggle,
  collapsedSummary,
  children,
  className,
}: CollapsibleSectionProps): ReactNode {
  const bodyId = useId();
  const hasSummary = collapsedSummary != null;

  return (
    <section className={cx("qt-qt-section", collapsed ? "qt-qt-section--collapsed" : "qt-qt-section--expanded", className)}>
      <button
        type="button"
        className="qt-btn qt-qt-section-toggle"
        onClick={() => onToggle(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
      >
        <span
          className={collapsed ? "qt-qt-section-toggle-caret qt-qt-section-toggle-caret--collapsed" : "qt-qt-section-toggle-caret"}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className="qt-sr-only">{collapsed ? `Expand ${title}` : `Collapse ${title}`}</span>
      </button>
      {collapsed ? (
        <div className="qt-qt-section-head">
          <span className="qt-qt-section-title">{title}</span>
          {hasSummary ? <span className="qt-qt-section-summary">{collapsedSummary}</span> : null}
        </div>
      ) : null}
      {!collapsed ? <div id={bodyId}>{children}</div> : null}
    </section>
  );
}
