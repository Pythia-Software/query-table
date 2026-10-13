// FieldPicker — grouped, searchable field chooser.
// Searches label + name + aliases, groups by FieldDef.group, and surfaces
// per-field stats (distinct count, min/max) when the Transport provides them.
// Used to add columns and to add filters.

import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import type { FieldDef, FieldStats } from "@pythia-software/query-table-core";
import { useMobileLayout } from "./AdaptiveOverlay";
import { PickerSurface } from "./PickerAnchor";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import type { MenuAnchor } from "./Menu";

export interface FieldPickerProps<Row> {
  /** Optional next-step content, sharing the same anchored header and Back/Close controls. */
  children?: ReactNode;
  title?: string;
  onBack?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  description?: string;
  fields: FieldDef<Row>[];
  /** Optional field content; the picker retains search, focus, and selection. */
  renderField?: (field: FieldDef<Row>) => ReactNode;
  /** With onClose, supply a trigger (or wrap in PickerAnchor) for a floating picker; otherwise inline on desktop. */
  anchor?: MenuAnchor | undefined;
  /** Already-shown field names, so the picker can mark/hide them. */
  excluded?: string[];
  /** Stats keyed by field name (optional). */
  stats?: Record<string, FieldStats>;
  /** When true, dim/disable fields with ≤1 distinct value ("gate on distinct"). */
  gateOnDistinct?: boolean;
  onPick: (field: FieldDef<Row>) => void;
  /** Enables a dismissible overlay on mobile. Omit to stay inline at every viewport size. */
  onClose?: () => void;
}

const UNGROUPED = "other";

export function FieldPicker<Row>({
  children,
  fields,
  renderField,
  anchor,
  excluded,
  stats,
  gateOnDistinct,
  onPick,
  onClose,
  title = "Choose a field",
  description,
  onBack,
  searchValue,
  onSearchChange,
}: FieldPickerProps<Row>): ReactNode {
  const mobile = useMobileLayout();
  const [localSearch, setLocalSearch] = useState("");
  const search = searchValue ?? localSearch;
  const setSearch = onSearchChange ?? setLocalSearch;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!mobile) input.current?.focus();
  }, [title, mobile]);
  const needle = search.trim().toLowerCase();
  const excludedSet = useMemo(() => new Set(excluded ?? []), [excluded]);

  const matched = useMemo(
    () =>
      fields.filter((f) => {
        if (excludedSet.has(f.name)) return false;
        if (!needle) return true;
        return (
          f.label.toLowerCase().includes(needle) ||
          f.name.toLowerCase().includes(needle) ||
          fieldAliases(f).some((a) => a.toLowerCase().includes(needle))
        );
      }),
    [fields, excludedSet, needle],
  );

  const grouped = useMemo(() => groupByGroup(matched), [matched]);

  const firstEnabled = grouped.flatMap(([, fields]) => fields).find((f) => isEnabled(f, stats, gateOnDistinct));

  const content = (
    <div
      className="qt-picker"
      onKeyDown={(event) => {
        if (children) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const choices = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".qt-picker-item:not(:disabled)",
          ),
        );
        const current = choices.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "ArrowDown"
            ? Math.min(current + 1, choices.length - 1)
            : current - 1;
        if (next < 0) input.current?.focus();
        else choices[next]?.focus();
      }}
    >
      <div className="qt-picker-heading">
        {onBack && (
          <button
            type="button"
            className="qt-icon-btn"
            aria-label="Back to fields"
            onClick={onBack}
          >
            <Icon name="arrowLeft" />
          </button>
        )}
        <strong>{title}</strong>
        {onClose && (
          <button
            type="button"
            className="qt-icon-btn"
            aria-label="Close field picker"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      {description && <p className="qt-picker-description">{description}</p>}
      {children ?? (
        <>
          <input
            ref={input}
            aria-label="Search fields"
            type="text"
            className="qt-picker-input"
            placeholder="search fields…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && firstEnabled) {
                e.preventDefault();
                onPick(firstEnabled);
              }
            }}
          />
          <div className="qt-picker-list">
            {matched.length === 0 ? (
              <div className="qt-picker-empty">no matches</div>
            ) : (
              grouped.map(([group, fs]) => (
                <div key={group} className="qt-picker-group">
                  <div className="qt-picker-group-label">{group}</div>
                  {fs.map((f) => {
                    const enabled = isEnabled(f, stats, gateOnDistinct);
                    const s = stats?.[f.name];
                    const aliasHit = aliasMatch(f, needle);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        disabled={!enabled}
                        className={
                          enabled
                            ? "qt-picker-item"
                            : "qt-picker-item qt-picker-item--disabled"
                        }
                        title={
                          enabled
                            ? f.name
                            : "not useful as a filter (≤1 distinct value)"
                        }
                        onPointerDown={(event) => {
                          if (!mobile) event.preventDefault();
                        }}
                        onClick={() => {
                          if (!enabled) return;
                          onPick(f);
                        }}
                      >
                        {renderField ? renderField(f) : (
                          <span className="qt-picker-row">
                            <span className="qt-picker-label">{f.label}</span>
                            <span className="qt-picker-name">{f.name}</span>
                          </span>
                        )}
                        {aliasHit && (
                          <span className="qt-picker-alias">
                            matches: {aliasHit}
                          </span>
                        )}
                        {s && (
                          <span className="qt-picker-stats">
                            {s.distinct != null && <>{s.distinct} distinct</>}
                            {s.min != null && s.max != null && (
                              <>
                                {" "}
                                · {fmtStat(s.min)}…{fmtStat(s.max)}
                              </>
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
  if (!onClose) return <div className="qt-picker-inline">{content}</div>;
  return anchor ? (
    <Popover
      label={title}
      anchor={anchor}
      width={340}
      className="qt-picker-popover qt-field-picker-popover"
      onClose={onClose}
      {...(!children ? { initialFocus: ".qt-picker-input" } : {})}
    >
      {content}
    </Popover>
  ) : (
    <PickerSurface title={title} onClose={onClose}>
      {content}
    </PickerSurface>
  );
}

function isEnabled(
  f: FieldDef,
  stats: FieldPickerProps<any>["stats"],
  gate: boolean | undefined,
): boolean {
  if (!gate) return true;
  const s = stats?.[f.name];
  if (!s || s.distinct == null) return true; // no data → don't gate
  return s.distinct > 1;
}

function aliasMatch(f: FieldDef, needle: string): string | undefined {
  if (!needle) return undefined;
  if (
    f.label.toLowerCase().includes(needle) ||
    f.name.toLowerCase().includes(needle)
  )
    return undefined;
  return fieldAliases(f).find((a) => a.toLowerCase().includes(needle));
}

function fieldAliases<Row>(f: FieldDef<Row>): string[] {
  const aliases = new Set<string>();
  if (f.alias) aliases.add(f.alias);
  if (f.aliases) {
    for (const alias of f.aliases) aliases.add(alias);
  }
  return [...aliases];
}

function groupByGroup<Row>(
  fs: FieldDef<Row>[],
): Array<[string, FieldDef<Row>[]]> {
  const groups = new Map<string, FieldDef<Row>[]>();
  for (const f of fs) {
    const key = f.group ?? UNGROUPED;
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.entries()];
}

function fmtStat(v: string | number): string {
  if (typeof v === "number") return v.toLocaleString();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  if (s.length > 18) return s.slice(0, 15) + "…";
  return s;
}
