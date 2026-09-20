import { PresentedFilterValue } from "./FilterValuePresentation";
// CellMenu — right-click (or left-click) a cell → quick-filter popover + copy.
// Filters are laid out in two columns: each row is a candidate predicate on the
// left and its logical negation directly opposite (`= 5 | ≠ 5`, `≥ 5 | < 5`,
// `is null | is not null`, `contains | not contains`). Value ops are prefilled
// with the clicked cell's value; array cells get a per-element `includes` row.
// Anchors just off the click point and clamps to the viewport.

import { useEffect, useState, type ReactNode } from "react";
import type { FieldDef, FilterOp, WhereClause } from "@pythia-software/query-table-core";
import { NULLARY_OPS, negateClause, opsForField, opPairsForField, isFilterable } from "@pythia-software/query-table-core";
import type { MenuClassNames } from "./classNames";

export interface CellMenuProps<Row> {
  field: FieldDef<Row>;
  value: unknown;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
  onAddFilter: (clause: WhereClause) => void;
  onClose: () => void;
  classNames?: MenuClassNames;
}

const cx = (...parts: Array<string | undefined | false>): string => parts.filter(Boolean).join(" ");

/** Approximate sizing so the popover can clamp itself into the viewport. */
const MENU_WIDTH = 320;
const ROW_HEIGHT = 32;
const POINTER_OFFSET = 4;

interface FilterRow {
  positive?: WhereClause;
  negative?: WhereClause;
}

export function CellMenu<Row>({ field, value, x, y, onAddFilter, onClose, classNames }: CellMenuProps<Row>): ReactNode {
  // Dismiss on Escape or an outside click. The opening click is deferred a tick
  // so it doesn't immediately re-close the freshly-opened menu.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onDocClick() {
      onClose();
    }
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => window.addEventListener("click", onDocClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onDocClick);
      clearTimeout(t);
    };
  }, [onClose]);

  // A non-filterable field (e.g. a computed column that opted out) offers no
  // filter rows; only the header + copy remain. `pairs` is the shared keep/
  // exclude op source the WHERE op picker uses too, so the two read identically.
  const ops = isFilterable(field) ? opsForField(field) : [];
  const pairs = isFilterable(field) ? opPairsForField(field) : [];
  const hasNullity = pairs.some((p) => p.keep.op === "is_null");
  const isArray = Array.isArray(value);
  const isNullish = value == null || value === "" || (isArray && (value as unknown[]).length === 0);
  const cellText = valueToString(value);

  function applyClause(clause: WhereClause) {
    onAddFilter(clause);
    onClose();
  }

  // Build one row = a positive predicate and its negation opposite.
  const rows: FilterRow[] = [];
  const pairRow = (op: FilterOp, raw: string) => {
    const positive: WhereClause = { field: field.name, op, value: NULLARY_OPS.has(op) ? "" : raw };
    rows.push({ positive, negative: negateClause(positive, ops) });
  };

  if (isArray && !isNullish) {
    // A tag column: filter by the clicked tag (and its negation), then nullity.
    const arrayOp: FilterOp = pairs.find((p) => p.keep.op === "includes")?.keep.op ?? pairs[0]?.keep.op ?? "=";
    (value as unknown[]).forEach((el) => pairRow(arrayOp, String(el)));
    if (hasNullity) pairRow("is_null", cellText);
  } else if (!isNullish) {
    // Every keep op (value ops + nullity) prefilled with the cell value.
    for (const pair of pairs) pairRow(pair.keep.op, cellText);
  } else if (hasNullity) {
    // Empty cell → only the nullity row makes sense.
    pairRow("is_null", cellText);
  }

  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  // header + copy + separator + one line per filter row.
  const approxRows = 3 + rows.length;
  const left = Math.max(8, Math.min(x + POINTER_OFFSET, vw - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y + POINTER_OFFSET, vh - ROW_HEIGHT * approxRows - 8));

  return (
    <div
      className={cx("qt-cell-menu", classNames?.popover)}
      style={{ left, top, width: MENU_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      <div className="qt-cm-header">
        <span className="qt-cm-field">{field.label}</span>
        <span className="qt-cm-value">{Array.isArray(value) ? value.map(v => <PresentedFilterValue key={String(v)} field={field.name} value={String(v)}/>) : <PresentedFilterValue field={field.name} value={String(value ?? "")}/>}</span>
      </div>
      <MenuItem
        classNames={classNames}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(cellText);
          } catch {
            /* clipboard denial is non-fatal */
          }
          onClose();
        }}
      >
        copy value
      </MenuItem>
      <div className={cx("qt-cm-sep", classNames?.separator)} />
      {rows.length > 0 && (
        <div className="qt-cm-filter-grid" role="group" aria-label="Filter by this cell">
          <span className="qt-cm-col-head">keep</span>
          <span className="qt-cm-col-head qt-cm-col-head--neg">exclude</span>
          {rows.map((row, i) => (
            <FilterPairRow key={i} row={row} value={value} classNames={classNames} onApply={applyClause} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPairRow<Row>({
  row,
  value,
  classNames,
  onApply,
}: {
  row: FilterRow;
  value: unknown;
  classNames: MenuClassNames | undefined;
  onApply: (clause: WhereClause) => void;
}): ReactNode {
  return (
    <>
      <FilterButton clause={row.positive} value={value} classNames={classNames} onApply={onApply} />
      <FilterButton clause={row.negative} value={value} negative classNames={classNames} onApply={onApply} />
    </>
  );
}

function FilterButton({
  clause,
  value,
  negative,
  classNames,
  onApply,
}: {
  clause: WhereClause | undefined;
  value: unknown;
  negative?: boolean;
  classNames: MenuClassNames | undefined;
  onApply: (clause: WhereClause) => void;
}): ReactNode {
  if (!clause) return <span className="qt-cm-filter-empty" aria-hidden />;
  const nullary = NULLARY_OPS.has(clause.op);
  return (
    <button
      type="button"
      className={cx("qt-cm-item", "qt-cm-filter", negative && "qt-cm-filter--neg", classNames?.item)}
      onClick={() => onApply(clause)}
      role="menuitem"
    >
      <span className="qt-cm-op">{predicateSymbol(clause)}</span>
      {!nullary ? (
        <>
          {" "}
          <code><PresentedFilterValue field={clause.field} value={clause.value}/></code>
        </>
      ) : null}
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  classNames,
}: {
  children: ReactNode;
  onClick: () => void;
  classNames: MenuClassNames | undefined;
}) {
  return (
    <button type="button" className={cx("qt-cm-item", classNames?.item)} onClick={onClick} role="menuitem">
      {children}
    </button>
  );
}

/** Human-readable label for a predicate, honoring the `negated` flag. */
function predicateSymbol(clause: WhereClause): string {
  const base = opSymbol(clause.op);
  return clause.negated ? `not ${base}` : base;
}

function opSymbol(op: FilterOp): string {
  switch (op) {
    case "!=":
      return "≠";
    case ">=":
      return "≥";
    case "<=":
      return "≤";
    case "starts_with":
      return "starts with";
    case "ends_with":
      return "ends with";
    case "matches_regex":
      return "matches";
    case "not_matches_regex":
      return "not matches";
    case "is_null":
      return "is null";
    case "is_not_null":
      return "is not null";
    default:
      return op;
  }
}

function valueToString(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function previewValue(v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (Array.isArray(v)) {
    return v.length === 0 ? "(empty)" : `[${v.length}] ${v.slice(0, 2).join(", ")}${v.length > 2 ? "…" : ""}`;
  }
  const s = String(v);
  return s.length > 50 ? s.slice(0, 50) + "…" : s;
}
