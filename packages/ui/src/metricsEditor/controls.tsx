// Small form primitives of the MetricsEditor: the commit-on-blur number input
// and the collapsible Settings disclosure.
import { useState, type ReactNode, type InputHTMLAttributes } from "react";

/** Preserve incomplete typing; bounds apply only on blur or Enter. */
export function MetricNumberInput({
  value,
  onCommit,
  allowEmpty,
  min,
  max,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur" | "onKeyDown" | "min" | "max"
> & {
  min: number;
  max: number;
} & ({
  allowEmpty?: false;
  value: number;
  onCommit: (value: number) => void;
} | {
  allowEmpty: true;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
})) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft ?? value ?? ""}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft !== null && !draft.trim() && allowEmpty) onCommit(undefined);
        if (draft !== null && draft.trim() && Number.isFinite(Number(draft)))
          onCommit(Math.max(min, Math.min(max, Math.round(Number(draft)))));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape" && draft !== null) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
export function Settings({
  title,
  summary,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  summary: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details
      className="qt-metric-settings"
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
    >
      <summary>
        <strong>{title}</strong>
        <span>{summary}</span>
      </summary>
      <div>{children}</div>
    </details>
  );
}
