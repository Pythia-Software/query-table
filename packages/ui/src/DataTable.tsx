// DataTable — the table renderer.
//
// Presentation only: it draws headers (sort affordances incl. shift-click
// multi-sort), the checkbox column, cells (via the render registry), the
// right-click CellMenu, column resize handles, and the loading bar. All state
// lives in the @query-table/react hook; DataTable receives the resolved view
// and emits intents through onQueryChange. It deliberately mirrors the props
// shape of xplo-perf's DataTable so porting is mechanical.

import { useRef, useState, type ReactNode, type SetStateAction } from "react";
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

interface MenuState<Row> {
  field: FieldDef<Row>;
  value: unknown;
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

  const pageIds = rows.map(rowId).filter((id): id is RowId => id != null);
  const headerState = selection ? selection.pageState(pageIds) : "none";
  const showSel = selection != null;

  // ---- sort (multi-sort; mirrors react's nextOrderBy) ----
  function sortKeyFor(f: FieldDef<Row>): string {
    return f.sort?.field ?? f.name;
  }
  function sortBy(f: FieldDef<Row>, additive: boolean) {
    if (!isSortable(f)) return;
    onQueryChange({ ...query, offset: 0, orderBy: nextOrderBy(query.orderBy, sortKeyFor(f), additive) });
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
    setMenu({ field: f, value: readFieldValue(f, row), x: e.clientX, y: e.clientY });
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
              {fields.map((f) => {
                const info = sortInfo(f);
                const sortable = isSortable(f);
                return (
                  <th
                    key={f.name}
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
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", f.name);
                    }}
                    onDragOver={(e) => {
                      if (dragField.current && dragField.current !== f.name) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragField.current || e.dataTransfer.getData("text/plain");
                      if (from && from !== f.name) reorder(from, f.name);
                      dragField.current = null;
                    }}
                    onDragEnd={() => {
                      dragField.current = null;
                    }}
                  >
                    <span
                      className="qt-th-label"
                      onClick={(e) => sortable && sortBy(f, e.shiftKey)}
                      style={sortable ? { cursor: "pointer" } : undefined}
                      title={sortable ? "Click to sort, shift-click to add a secondary sort" : undefined}
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
        <CellMenu
          field={menu.field}
          value={menu.value}
          x={menu.x}
          y={menu.y}
          onAddFilter={(clause: WhereClause) => onQueryChange((prev) => ({ ...prev, offset: 0, where: [...prev.where, clause] }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Multi-sort header click logic — kept in lockstep with react's nextOrderBy. */
function nextOrderBy(existing: OrderByClause[], field: string, additive: boolean): OrderByClause[] {
  const i = existing.findIndex((s) => s.field === field);
  if (!additive) {
    if (i === 0 && existing.length === 1) {
      const flipped: "asc" | "desc" = existing[0]!.dir === "desc" ? "asc" : "desc";
      return [{ field, dir: flipped }];
    }
    return [{ field, dir: "desc" }];
  }
  if (i === -1) return [...existing, { field, dir: "desc" }];
  const cur = existing[i]!;
  if (cur.dir === "desc") {
    const next = [...existing];
    next[i] = { field, dir: "asc" };
    return next;
  }
  return existing.filter((_, k) => k !== i); // asc → remove
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
