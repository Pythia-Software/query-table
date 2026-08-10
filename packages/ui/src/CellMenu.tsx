// CellMenu — right-click (or left-click) a cell → quick-filter popover + copy.
// Offers only the operators valid for that field's type (opsForField), prefilled
// with the clicked cell's value, plus "copy value". Anchors just off the click
// point and clamps to the viewport. Present in both source projects; unified here.

import { useEffect, useState, type ReactNode } from "react";
import type { FieldDef, FilterOp, WhereClause } from "@pythia-software/query-table-core";
import { NULLARY_OPS, opsForField } from "@pythia-software/query-table-core";
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

const cx = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(" ");

/** Approximate sizing so the popover can clamp itself into the viewport. */
const MENU_WIDTH = 240;
const ROW_HEIGHT = 32;
const POINTER_OFFSET = 4;

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

  const ops = opsForField(field);
  const isArray = Array.isArray(value);
  const isNullish = value == null || value === "" || (isArray && (value as unknown[]).length === 0);

  function apply(op: FilterOp, raw?: string) {
    const v = raw != null ? raw : valueToString(value);
    onAddFilter({ field: field.name, op, value: NULLARY_OPS.has(op) ? "" : v });
    onClose();
  }

  // Build the actionable filter items. For arrays we offer a per-element
  // shortcut (so a tag column filters by the clicked tag); otherwise we offer
  // every operator the field type allows, prefilled with the cell value.
  const filterItems: ReactNode[] = [];
  if (isArray && !isNullish) {
    (value as unknown[]).forEach((el, i) => {
      const s = String(el);
      const arrayOp: FilterOp = ops.includes("includes") ? "includes" : ops[0] ?? "=";
      filterItems.push(
        <MenuItem key={`el-${i}`} classNames={classNames} onClick={() => apply(arrayOp, s)}>
          filter: {opSymbol(arrayOp)} <code>{s}</code>
        </MenuItem>,
      );
    });
  }
  for (const op of ops) {
    const nullary = NULLARY_OPS.has(op);
    // When the cell is empty, only the nullary ops make sense; when it has a
    // value, offer both (so a user can still ask "is null" off a present cell).
    if (isNullish && !nullary) continue;
    // Array element shortcuts above already covered the value ops.
    if (isArray && !nullary && !isNullish) continue;
    filterItems.push(
      <MenuItem key={op} classNames={classNames} onClick={() => apply(op)}>
        filter: {opSymbol(op)}
        {!nullary && !isNullish ? <> <code>{previewValue(value)}</code></> : null}
      </MenuItem>,
    );
  }

  const copyItem = (
    <MenuItem
      key="copy"
      classNames={classNames}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(valueToString(value));
        } catch {
          /* clipboard denial is non-fatal */
        }
        onClose();
      }}
    >
      copy value
    </MenuItem>
  );

  const items: ReactNode[] = [
    <div key="header" className="qt-cm-header">
      <span className="qt-cm-field">{field.label}</span>
      <span className="qt-cm-value">{previewValue(value)}</span>
    </div>,
    copyItem,
    <div key="sep" className={cx("qt-cm-sep", classNames?.separator)} />,
    ...filterItems,
  ];

  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.max(8, Math.min(x + POINTER_OFFSET, vw - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y + POINTER_OFFSET, vh - ROW_HEIGHT * items.length - 8));

  return (
    <div
      className={cx("qt-cell-menu", classNames?.popover)}
      style={{ left, top, width: MENU_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {items}
    </div>
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

function opSymbol(op: FilterOp): string {
  switch (op) {
    case "!=":
      return "≠";
    case ">=":
      return "≥";
    case "<=":
      return "≤";
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
