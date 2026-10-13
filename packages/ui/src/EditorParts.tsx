import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Shared chrome for query-local metric and column workbenches. */
export function EditorContext({
  shown,
  total,
  filters,
  noun = "rows",
  locale,
  children,
}: {
  shown: number;
  total: number | null;
  filters: number;
  noun?: string;
  locale?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="qt-metrics-editor-context">
      <span>
        Shown:{" "}
        <b>
          {shown.toLocaleString(locale)} {noun}
        </b>
      </span>
      <span>
        Matching:{" "}
        <b>
          {total === null ? "unknown" : total.toLocaleString(locale)} {noun}
        </b>
      </span>
      <span>{filters ? `${filters} filter terms` : "No filters"}</span>
      {children}
    </div>
  );
}

export function EditorPaneTitle({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="qt-editor-pane-title">
      <h3>{children}</h3>
      {actions}
    </div>
  );
}

export function EditorChoice({
  selected,
  title,
  detail,
  code,
  onClick,
}: {
  selected: boolean;
  title: string;
  detail?: string;
  code?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="qt-editor-choice"
      aria-pressed={selected}
      onClick={onClick}
    >
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {code && <code>{code}</code>}
      {selected && <Icon name="check" />}
    </button>
  );
}
