// Mobile-layout clause chrome shared by rows: MobileClauseSummary and the
// MobileChipEditor sheet.

import { type ReactNode } from "react";
import {
  ModalSurface,
  useMobileLayout,
} from "../AdaptiveOverlay";
import { Icon } from "../Icon";
import { cx } from "./helpers";

export function MobileClauseSummary({
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

export function MobileChipEditor({
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
