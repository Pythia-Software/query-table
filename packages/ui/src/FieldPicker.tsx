// FieldPicker — grouped, searchable field chooser (xlsx-collect's richer one).
// Searches label + name + aliases, groups by FieldDef.group, and surfaces
// per-field stats (distinct count, min/max) when the Transport provides them.
// Used to add columns and to add filters.

import { useMemo, useState, type ReactNode } from "react";
import type { FieldDef, FieldStats } from "@query-table/core";

export interface FieldPickerProps<Row> {
  fields: FieldDef<Row>[];
  /** Already-shown field names, so the picker can mark/hide them. */
  excluded?: string[];
  /** Stats keyed by field name (optional). */
  stats?: Record<string, FieldStats>;
  /** When true, dim/disable fields with ≤1 distinct value ("gate on distinct"). */
  gateOnDistinct?: boolean;
  onPick: (field: FieldDef<Row>) => void;
  onClose?: () => void;
}

const UNGROUPED = "other";

export function FieldPicker<Row>({
  fields,
  excluded,
  stats,
  gateOnDistinct,
  onPick,
  onClose,
}: FieldPickerProps<Row>): ReactNode {
  const [search, setSearch] = useState("");
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
          (f.aliases?.some((a) => a.toLowerCase().includes(needle)) ?? false)
        );
      }),
    [fields, excludedSet, needle],
  );

  const grouped = useMemo(() => groupByGroup(matched), [matched]);

  const firstEnabled = matched.find((f) => isEnabled(f, stats, gateOnDistinct));

  return (
    <div className="qt-picker">
      <input
        autoFocus
        type="text"
        className="qt-picker-input"
        placeholder="search fields…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose?.();
          if (e.key === "Enter" && firstEnabled) {
            onPick(firstEnabled);
            setSearch("");
          }
        }}
        // Defer so a mousedown on a list item lands before blur closes it.
        onBlur={() => setTimeout(() => onClose?.(), 150)}
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
                    className={enabled ? "qt-picker-item" : "qt-picker-item qt-picker-item--disabled"}
                    title={enabled ? f.name : "not useful as a filter (≤1 distinct value)"}
                    // mousedown (not click) fires before the input's blur.
                    onMouseDown={(e) => {
                      if (!enabled) return;
                      e.preventDefault();
                      onPick(f);
                      setSearch("");
                    }}
                  >
                    <span className="qt-picker-row">
                      <span className="qt-picker-label">{f.label}</span>
                      <span className="qt-picker-name">{f.name}</span>
                    </span>
                    {aliasHit && <span className="qt-picker-alias">matches: {aliasHit}</span>}
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
    </div>
  );
}

function isEnabled(f: FieldDef, stats: FieldPickerProps<any>["stats"], gate: boolean | undefined): boolean {
  if (!gate) return true;
  const s = stats?.[f.name];
  if (!s || s.distinct == null) return true; // no data → don't gate
  return s.distinct > 1;
}

function aliasMatch(f: FieldDef, needle: string): string | undefined {
  if (!needle || !f.aliases) return undefined;
  if (f.label.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle)) return undefined;
  return f.aliases.find((a) => a.toLowerCase().includes(needle));
}

function groupByGroup<Row>(fs: FieldDef<Row>[]): Array<[string, FieldDef<Row>[]]> {
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
