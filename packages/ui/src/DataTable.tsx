// DataTable — the table renderer.
//
// Presentation only: it draws headers (sort affordances), the checkbox column,
// cells (via the render registry), the right-click CellMenu, column resize
// handles, and the loading bar. All state
// lives in the @query-table/react hook; DataTable receives the resolved view
// and emits intents through onQueryChange. It deliberately mirrors the props
// shape of xplo-perf's DataTable so porting is mechanical.

import { useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import type { OrderByClause, QueryState, FieldDef, RowId, SelectColumn, WhereClause } from "@query-table/core";
import { isSortable, readFieldValue } from "@query-table/core";
import type { SelectionApi } from "@query-table/react";
import { resolveRenderer, type RenderRegistry } from "./renderers";
import type { TableClassNames } from "./classNames";
import { CellMenu } from "./CellMenu";

export interface DataTableProps<Row> {
  /** Ordered visible fields (widths already resolved), from `api.visibleFields`. */
  fields: FieldDef<Row>[];
  rows: Row[];
  query: QueryState;
  onQueryChange: (q: SetStateAction<QueryState>) => void;

  /** Resolves FieldDef.render keys. Pass `{ ...defaultRenderers, ...yours }`. */
  renderers: RenderRegistry<Row>;
  /** Row → stable id (defaults to reading the schema's idField). */
  rowId: (row: Row) => RowId | null;

  /** Optional checkbox column + selection behavior (from `api.selection`). */
  selection?: SelectionApi;

  /** Always-visible trailing column (row actions, links). */
  trailing?: (row: Row) => ReactNode;
  trailingLabel?: string;

  loading?: boolean;
  emptyMessage?: string;
  /** Tailwind / bespoke styling slots (Mode B). */
  classNames?: TableClassNames;
}

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

const MIN_WIDTH = 50;
const MAX_WIDTH = 800;
const MENU_WIDTH = 240;
const MENU_ROW_HEIGHT = 32;
type HeaderSortPlacement = "set" | "append" | "prepend";

interface MenuState<Row> {
  kind: "cell" | "header";
  field: FieldDef<Row>;
  value?: unknown;
  x: number;
  y: number;
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactNode {
  const {
    fields,
    rows,
    query,
    onQueryChange,
    renderers,
    rowId,
    selection,
    trailing,
    trailingLabel,
    loading,
    emptyMessage,
    classNames,
  } = props;

  const [menu, setMenu] = useState<MenuState<Row> | null>(null);
  const dragField = useRef<string | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null);

  const pageIds = rows.map(rowId).filter((id): id is RowId => id != null);
  const headerState = selection ? selection.pageState(pageIds) : "none";
  const showSel = selection != null;

  // ---- sort state (used only for indicators + header menu actions) ----
  function sortKeyFor(f: FieldDef<Row>): string {
    return f.sort?.field ?? f.name;
  }
  function applyHeaderSort(f: FieldDef<Row>, dir: "asc" | "desc", placement: HeaderSortPlacement) {
    if (!isSortable(f)) return;
    onQueryChange({
      ...query,
      offset: 0,
      orderBy: nextHeaderOrderBy(query.orderBy, sortKeyFor(f), dir, placement),
    });
    setMenu(null);
  }
  function removeColumn(f: FieldDef<Row>) {
    const explicit = materialize(query.select, fields);
    const nextSelect = explicit.filter((c) => c.field !== f.name);
    const nextOrderBy = query.orderBy.filter((s) => s.field !== sortKeyFor(f));
    if (nextSelect.length === 0) return;
    onQueryChange({ ...query, select: nextSelect, orderBy: nextOrderBy });
    setMenu(null);
  }
  function sortInfo(f: FieldDef<Row>): { dir: "asc" | "desc"; priority: number | null } | null {
    const key = sortKeyFor(f);
    const idx = query.orderBy.findIndex((o) => o.field === key);
    if (idx === -1) return null;
    const term = query.orderBy[idx]!;
    return { dir: term.dir, priority: query.orderBy.length > 1 ? idx + 1 : null };
  }

  // ---- width (resolved from query.select; written back through onQueryChange) ----
  function widthFor(name: string, f: FieldDef<Row>): number | undefined {
    const col = query.select.find((c) => c.field === name);
    return col?.width ?? f.select?.width;
  }
  function setWidth(name: string, width: number) {
    const px = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
    onQueryChange({ ...query, select: writeWidth(query.select, fields, name, px) });
  }
  function startResize(name: string, f: FieldDef<Row>, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthFor(name, f) ?? 120;
    const onMove = (ev: MouseEvent) => setWidth(name, startW + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- reorder (drag headers; writes the new SELECT order) ----
  function reorder(from: string, to: string) {
    if (from === to) return;
    const order = fields.map((f) => f.name);
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(toIdx, 0, order.splice(fromIdx, 1)[0]!);
    onQueryChange({ ...query, select: reorderSelect(query.select, fields, order) });
  }

  function reorderByIndex(from: string, toIndex: number) {
    const order = fields.map((f) => f.name);
    const fromIdx = order.indexOf(from);
    if (fromIdx < 0) return;
    const insertionIndex = Math.max(0, Math.min(toIndex, order.length - 1));
    order.splice(insertionIndex, 0, order.splice(fromIdx, 1)[0]!);
    onQueryChange({ ...query, select: reorderSelect(query.select, fields, order) });
  }

  const fieldByName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const dragSource = dragField.current;
  const slotIndex = dragSlotIndex;
  type HeaderItem = { kind: "slot" } | { kind: "field"; name: string };
  const renderedHeaders = useMemo<HeaderItem[]>(() => {
    if (!dragSource) return fieldNames.map((name) => ({ kind: "field", name }));
    const withoutDragged = fieldNames.filter((name) => name !== dragSource);
    if (slotIndex == null) return withoutDragged.map((name) => ({ kind: "field", name }));
    return [...withoutDragged.slice(0, slotIndex), { kind: "slot" }, ...withoutDragged.slice(slotIndex)];
  }, [dragSource, fieldNames, slotIndex]);

  // ---- selection ----
  function toggleHeader() {
    if (!selection) return;
    selection.setPage(pageIds, headerState !== "all");
  }

  // ---- cell menu ----
  function openMenu(e: React.MouseEvent, f: FieldDef<Row>, row: Row) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
    e.preventDefault();
    setMenu({ kind: "cell", field: f, value: readFieldValue(f, row), x: e.clientX, y: e.clientY });
  }
  function openHeaderMenu(e: React.MouseEvent, f: FieldDef<Row>) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
    e.preventDefault();
    setMenu({ kind: "header", field: f, x: e.clientX, y: e.clientY });
  }

  function onTableWheel(e: React.WheelEvent<HTMLDivElement>) {
    const wrap = tableWrapRef.current;
    if (!wrap) return;

    const canScrollHorizontally = wrap.scrollWidth > wrap.clientWidth;
    if (!canScrollHorizontally) return;

    const dx = e.deltaX;
    const dy = e.deltaY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (dx === 0 && !e.shiftKey) return;

    if (dx === 0 && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      wrap.scrollLeft += dy;
      return;
    }

    if (absDx >= absDy || e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      wrap.scrollLeft += dx;
    }
  }

  const totalCols = fields.length + (showSel ? 1 : 0) + (trailing ? 1 : 0);

  return (
    <>
      <div
        ref={tableWrapRef}
        className={cx("qt-table-wrap", loading && "qt-table-wrap--loading", classNames?.wrap)}
        onWheel={onTableWheel}
      >
        {loading && (
          <div className={cx("qt-loading-bar", classNames?.loadingBar)} role="progressbar" aria-label="loading" />
        )}
        <table className={cx("qt-table", classNames?.table)}>
          <colgroup>
            {showSel && <col style={{ width: 36 }} />}
            {fields.map((f) => {
              const w = widthFor(f.name, f);
              return <col key={f.name} style={w != null ? { width: w } : undefined} />;
            })}
            {trailing && <col style={{ width: 40 }} />}
          </colgroup>
          <thead className={classNames?.thead}>
            <tr className={classNames?.headerRow}>
              {showSel && (
                <th className={cx("qt-th", "qt-checkbox-cell", classNames?.th, classNames?.checkboxCell)}>
                  <input
                    type="checkbox"
                    checked={headerState === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = headerState === "some";
                    }}
                    onChange={toggleHeader}
                    aria-label="select all on page"
                  />
                </th>
              )}
              {renderedHeaders.map((item, idx) => {
                if (item.kind === "slot") {
                  return (
                    <th
                      key={`drag-slot-${idx}`}
                      className="qt-th qt-th-drop-slot"
                      onDragOver={(e) => {
                        if (!dragField.current) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragField.current || e.dataTransfer.getData("text/plain");
                        if (from && slotIndex != null) reorderByIndex(from, slotIndex);
                        dragField.current = null;
                        setDragSlotIndex(null);
                      }}
                    />
                  );
                }

                const f = fieldByName.get(item.name);
                if (!f) return null;
                const info = sortInfo(f);
                const sortable = isSortable(f);
                return (
                  <th
                    key={`${f.name}-${idx}`}
                    className={cx(
                      "qt-th",
                      sortable && "qt-th--sortable",
                      dragField.current === f.name && "qt-th--dragging",
                      classNames?.th,
                    )}
                    style={f.select?.align ? { textAlign: f.select.align } : undefined}
                    draggable
                    onDragStart={(e) => {
                      dragField.current = f.name;
                      const next = fieldNames.indexOf(f.name);
                      setDragSlotIndex(next >= 0 ? next : null);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", f.name);
                    }}
                    onDragOver={(e) => {
                      if (dragField.current && dragField.current !== f.name) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const withoutDragged = fieldNames.filter((name) => name !== dragField.current);
                        const next = withoutDragged.indexOf(f.name);
                        if (next >= 0) setDragSlotIndex(next);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const from = dragField.current || e.dataTransfer.getData("text/plain");
                      if (from && from !== f.name) reorder(from, f.name);
                      dragField.current = null;
                      setDragSlotIndex(null);
                    }}
                    onDragEnd={() => {
                      dragField.current = null;
                      setDragSlotIndex(null);
                    }}
                  >
                    <span
                      className="qt-th-label"
                      onClick={(e) => openHeaderMenu(e, f)}
                      style={{ cursor: "pointer" }}
                      title="Click to open column actions"
                    >
                      {f.label}
                      {info && (
                        <span className="qt-sort-indicator">
                          {info.dir === "asc" ? " ↑" : " ↓"}
                          {info.priority != null && <sup className="qt-sort-priority">{info.priority}</sup>}
                        </span>
                      )}
                    </span>
                    <span
                      className={cx("qt-resize-handle", classNames?.resizeHandle)}
                      onMouseDown={(e) => startResize(f.name, f, e)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </th>
                );
              })}
              {trailing && <th className={cx("qt-th", classNames?.th)}>{trailingLabel ?? ""}</th>}
            </tr>
          </thead>
          <tbody className={classNames?.tbody}>
            {rows.length === 0 && (
              <tr>
                <td colSpan={totalCols} className={cx("qt-cell", "qt-empty", classNames?.empty)}>
                  {emptyMessage ?? "No rows."}
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const id = rowId(row);
              const selected = id != null && selection ? selection.isSelected(id) : false;
              return (
                <tr
                  key={id != null ? String(id) : i}
                  className={cx("qt-row", selected && "qt-row--selected", classNames?.row, selected && classNames?.rowSelected)}
                >
                  {showSel && (
                    <td className={cx("qt-cell", "qt-checkbox-cell", classNames?.cell, classNames?.checkboxCell)}>
                      {id != null && (
                        <input
                          type="checkbox"
                          checked={selected}
                          // Shift-range select is handled inside selection.toggle.
                          onClick={(e) => selection!.toggle(id, e.shiftKey)}
                          onChange={() => {
                            /* state owned by selection; onClick drives it */
                          }}
                          aria-label={`select row ${String(id)}`}
                        />
                      )}
                    </td>
                  )}
                  {fields.map((f) => {
                    const render = resolveRenderer(f, renderers);
                    const value = readFieldValue(f, row);
                    return (
                      <td
                        key={f.name}
                        className={cx("qt-cell", classNames?.cell)}
                        style={f.select?.align ? { textAlign: f.select.align } : undefined}
                        onClick={(e) => openMenu(e, f, row)}
                        onContextMenu={(e) => openMenu(e, f, row)}
                      >
                        {render({ value, row, field: f, query })}
                      </td>
                    );
                  })}
                  {trailing && <td className={cx("qt-cell", "qt-trailing-cell", classNames?.cell)}>{trailing(row)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {menu && (
        menu.kind === "cell" ? (
          <CellMenu
            field={menu.field}
            value={menu.value}
            x={menu.x}
            y={menu.y}
            onAddFilter={(clause: WhereClause) =>
              onQueryChange((prev) => ({ ...prev, offset: 0, where: [...prev.where, clause] }))
            }
            onClose={() => setMenu(null)}
          />
        ) : (
          <HeaderMenu
            field={menu.field}
            x={menu.x}
            y={menu.y}
            sortable={isSortable(menu.field)}
            canRemoveColumn={fields.length > 1}
            onSetSort={(placement, dir) => applyHeaderSort(menu.field, dir, placement)}
            onRemove={() => removeColumn(menu.field)}
            onClose={() => setMenu(null)}
          />
        )
      )}
    </>
  );
}

function HeaderMenu<Row>({
  field,
  x,
  y,
  sortable,
  canRemoveColumn,
  onSetSort,
  onRemove,
  onClose,
}: {
  field: FieldDef<Row>;
  x: number;
  y: number;
  sortable: boolean;
  canRemoveColumn: boolean;
  onSetSort: (placement: HeaderSortPlacement, dir: "asc" | "desc") => void;
  onRemove: () => void;
  onClose: () => void;
}) {
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

  const items: ReactNode[] = [];
  const addSortItem = (placement: HeaderSortPlacement, dir: "asc" | "desc", label: string) =>
    items.push(
      <MenuItem key={`${placement}-${dir}`} disabled={!sortable} onClick={() => onSetSort(placement, dir)}>
        {label}
      </MenuItem>,
    );

  addSortItem("set", "asc", "Set Sort (Asc)");
  addSortItem("set", "desc", "Set Sort (Desc)");
  addSortItem("append", "asc", "Append Sort (Asc)");
  addSortItem("append", "desc", "Append Sort (Desc)");
  addSortItem("prepend", "asc", "Prepend Sort (Asc)");
  addSortItem("prepend", "desc", "Prepend Sort (Desc)");

  items.push(<div key="sep" className="qt-cm-sep" />);
  items.push(
    <MenuItem key="remove" disabled={!canRemoveColumn} onClick={onRemove}>
      Remove Column
    </MenuItem>,
  );

  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.max(8, Math.min(x, vw - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, vh - MENU_ROW_HEIGHT * items.length - 8));

  return (
    <div
      className="qt-cell-menu"
      style={{ left, top, width: MENU_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      <div className="qt-cm-header">
        <span className="qt-cm-field">{field.label}</span>
      </div>
      {items}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="qt-cm-item"
      onClick={onClick}
      role="menuitem"
      disabled={disabled}
    >
      {children}
    </button>
  }
}

/** Header menu sort helper for set / append / prepend actions. */
function nextHeaderOrderBy(
  existing: OrderByClause[],
  field: string,
  dir: "asc" | "desc",
  placement: HeaderSortPlacement,
): OrderByClause[] {
  const next = existing.filter((s) => s.field !== field);
  if (placement === "set") return [{ field, dir }];
  if (placement === "append") return [...next, { field, dir }];
  return [{ field, dir }, ...next];
}

/** Materialize the current visible order into SelectColumn[] so width/order
 *  edits diverge from schema defaults cleanly (mirrors useSelect.writeSelect). */
function materialize<Row>(select: SelectColumn[], fields: FieldDef<Row>[]): SelectColumn[] {
  if (select.length) return select.map((c) => ({ ...c }));
  return fields.map((f) => ({ field: f.name }));
}

function writeWidth<Row>(select: SelectColumn[], fields: FieldDef<Row>[], name: string, width: number): SelectColumn[] {
  const cols = materialize(select, fields);
  let found = false;
  const next = cols.map((c) => {
    if (c.field !== name) return c;
    found = true;
    return { ...c, width };
  });
  if (!found) next.push({ field: name, width });
  return next;
}

function reorderSelect<Row>(select: SelectColumn[], fields: FieldDef<Row>[], order: string[]): SelectColumn[] {
  const cols = materialize(select, fields);
  const byName = new Map(cols.map((c) => [c.field, c]));
  return order.map((name) => byName.get(name) ?? { field: name });
}
