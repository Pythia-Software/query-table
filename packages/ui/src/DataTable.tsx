// DataTable — the table renderer.
//
// Presentation only: it draws headers (sort affordances), the checkbox column,
// cells (via the render registry), the right-click CellMenu, column resize
// handles, and the loading bar. All state
// lives in the @pythia-software/query-table-react hook; DataTable receives the resolved view
// and emits intents through onQueryChange. Its props mirror a conventional
// schema-driven table so adoption is mechanical.

import { useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import type { OrderByClause, QueryState, FieldDef, RowId, SelectColumn, WhereClause } from "@pythia-software/query-table-core";
import { isSortable, readFieldValue } from "@pythia-software/query-table-core";
import { useColumnDrag, type SelectionApi, type ColumnDragApi } from "@pythia-software/query-table-react";
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

  /** Shared column-reorder drag state (`api.columnDrag`). Pass it so dragging a
   *  table header also live-previews/dims the matching QueryBuilder select chip
   *  (and vice versa). Omit for a self-contained, table-only drag. */
  columnDrag?: ColumnDragApi;

  /** Always-visible trailing column (row actions, links). */
  trailing?: (row: Row) => ReactNode;
  trailingLabel?: string;

  /** Total matching rows before pagination, when known. */
  total?: number | null;

  loading?: boolean;
  emptyMessage?: string;
  /** Tailwind / bespoke styling slots (Mode B). */
  classNames?: TableClassNames;
}

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

const MIN_WIDTH = 1;
const MIN_SELECTION_WIDTH = 1;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 120;
const DEFAULT_SELECTION_WIDTH = 36;
const AUTOFIT_EXTRA_PX = 16;
const MENU_WIDTH = 240;
const MENU_ROW_HEIGHT = 32;
const COPY_FEEDBACK_MS = 900;
const SELECTION_COLUMN = "__qt_selection__";
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
    total = null,
    loading,
    emptyMessage,
    classNames,
  } = props;

  const [menu, setMenu] = useState<MenuState<Row> | null>(null);
  const [selectionColumnWidth, setSelectionColumnWidth] = useState(DEFAULT_SELECTION_WIDTH);
  const [tableColumnOrder, setTableColumnOrder] = useState<string[]>([]);
  const [copiedCellKey, setCopiedCellKey] = useState<string | null>(null);
  const [showHorizontalCue, setShowHorizontalCue] = useState(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const resizeGuideRef = useRef<HTMLDivElement>(null);
  // A real <col> width change invalidates layout for every row. During a drag,
  // move only the compositor-friendly guide and apply the column width once on
  // release; refs also keep pointermove out of React's render pipeline.
  const resizeCommitRef = useRef<{ name: string; width: number } | null>(null);
  const resizePreviewRef = useRef<{
    name: string;
    width: number;
    previousWidth: number;
    startTableWidth: number;
    guideX: number;
  } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const cancelResizeRef = useRef<(() => void) | null>(null);
  const resizingFieldRef = useRef<string | null>(null);
  const copiedCellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Shared drag state when the host passes `api.columnDrag`; otherwise a local
  // instance keeps the table self-contained. (The hook is always called to obey
  // the rules of hooks; the local one is unused when a shared one is provided.)
  const localColumnDrag = useColumnDrag();
  const columnDrag = props.columnDrag ?? localColumnDrag;

  useEffect(() => {
    return () => {
      if (copiedCellTimerRef.current) {
        clearTimeout(copiedCellTimerRef.current);
        copiedCellTimerRef.current = null;
      }
      cancelResizeRef.current?.();
    };
  }, []);

  function cellKey(rowIdValue: RowId | null, rowIndex: number, fieldName: string): string {
    return rowIdValue == null ? `row:${rowIndex}:${fieldName}` : `id:${rowIdValue}:${fieldName}`;
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT";
  }

  function showCopyFeedback(cellId: string) {
    if (copiedCellTimerRef.current) {
      clearTimeout(copiedCellTimerRef.current);
      copiedCellTimerRef.current = null;
    }
    setCopiedCellKey(cellId);
    copiedCellTimerRef.current = setTimeout(() => {
      setCopiedCellKey((current) => (current === cellId ? null : current));
      copiedCellTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  async function copyCellToClipboard(e: React.MouseEvent, f: FieldDef<Row>, rowIdValue: RowId | null, rowIndex: number, value: unknown) {
    if (isInteractiveTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(valueToString(value));
      }
    } catch {
      /* clipboard denial is non-fatal */
    }
    showCopyFeedback(cellKey(rowIdValue, rowIndex, f.name));
  }

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
  function resolvedWidthFor(name: string, f: FieldDef<Row>): number | undefined {
    return widthFor(name, f);
  }
  function resolvedColumnWidthFor(name: string, f?: FieldDef<Row>): number | undefined {
    if (name === SELECTION_COLUMN) return selectionColumnWidth;
    return f ? resolvedWidthFor(name, f) : undefined;
  }
  function displayColumnWidthFor(name: string, f?: FieldDef<Row>): number {
    if (name === SELECTION_COLUMN) return resolvedColumnWidthFor(name) ?? DEFAULT_SELECTION_WIDTH;
    return f ? resolvedWidthFor(name, f) ?? DEFAULT_WIDTH : DEFAULT_WIDTH;
  }
  function clampWidth(width: number): number {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
  }
  function clampColumnWidth(name: string, width: number): number {
    const min = name === SELECTION_COLUMN ? MIN_SELECTION_WIDTH : MIN_WIDTH;
    return Math.max(min, Math.min(MAX_WIDTH, Math.round(width)));
  }
  function commitColumnWidth(name: string, width: number) {
    if (name === SELECTION_COLUMN) {
      setSelectionColumnWidth(clampColumnWidth(name, width));
      return;
    }
    setWidth(name, width);
  }
  function setWidth(name: string, width: number) {
    const px = clampWidth(width);
    onQueryChange((prev) => ({ ...prev, select: writeWidth(prev.select, fields, name, px) }));
  }
  function applyResizeGuide() {
    const preview = resizePreviewRef.current;
    const guide = resizeGuideRef.current;
    if (!preview || !guide) return;
    guide.style.transform = `translateX(${preview.guideX}px)`;
  }
  function applyCommittedResize() {
    const preview = resizePreviewRef.current;
    const table = tableRef.current;
    if (!preview || !table) return;
    const selector = `col[data-qt-column="${cssAttributeValue(preview.name)}"]`;
    const col = table.querySelector<HTMLTableColElement>(selector);
    if (col) col.style.width = `${preview.width}px`;
    table.style.minWidth = `${preview.startTableWidth + preview.width - preview.previousWidth}px`;
  }
  function startResize(name: string, startWidth: number | undefined, e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = startWidth ?? e.currentTarget.parentElement?.getBoundingClientRect().width ?? DEFAULT_WIDTH;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const initialWidth = clampColumnWidth(name, startW);
    const wrap = tableWrapRef.current;
    const wrapRect = wrap?.getBoundingClientRect();
    const header = e.currentTarget.parentElement as HTMLTableCellElement | null;
    resizeCommitRef.current = null;
    resizePreviewRef.current = {
      name,
      width: initialWidth,
      previousWidth: displayColumnWidthFor(name, fieldByName.get(name)),
      startTableWidth: tableWidth,
      guideX: startX - (wrapRect?.left ?? 0) + (wrap?.scrollLeft ?? 0),
    };
    resizingFieldRef.current = name;
    tableWrapRef.current?.classList.add("qt-table-wrap--resizing");
    header?.classList.add("qt-th--resizing");
    if (header) header.draggable = false;
    if (resizeGuideRef.current) resizeGuideRef.current.style.display = "block";
    applyResizeGuide();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const cleanup = (commitWidth: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (resizeFrameRef.current != null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
        applyResizeGuide();
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      tableWrapRef.current?.classList.remove("qt-table-wrap--resizing");
      tableRef.current
        ?.querySelector<HTMLElement>(`th[data-qt-field="${cssAttributeValue(name)}"]`)
        ?.classList.remove("qt-th--resizing");
      if (header) header.draggable = true;
      const commit = commitWidth ? resizeCommitRef.current : null;
      if (commit) applyCommittedResize();
      if (resizeGuideRef.current) resizeGuideRef.current.style.display = "none";
      resizeCommitRef.current = null;
      resizePreviewRef.current = null;
      resizingFieldRef.current = null;
      cancelResizeRef.current = null;
      if (commit) commitColumnWidth(commit.name, commit.width);
    };
    const finish = () => cleanup(true);
    const onMove = (ev: PointerEvent) => {
      const next = clampColumnWidth(name, startW + (ev.clientX - startX));
      resizeCommitRef.current = { name, width: next };
      const preview = resizePreviewRef.current;
      if (preview) {
        preview.width = next;
        preview.guideX = startX + (next - startW) - (wrapRect?.left ?? 0) + (wrap?.scrollLeft ?? 0);
      }
      if (resizeFrameRef.current == null) {
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          applyResizeGuide();
        });
      }
    };
    cancelResizeRef.current = () => cleanup(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  function autofitColumn(name: string) {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    const selector = `[data-qt-field="${cssAttributeValue(name)}"]`;
    let width = 0;
    wrap.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      width = Math.max(width, el.scrollWidth);
    });
    if (width > 0) setWidth(name, width + AUTOFIT_EXTRA_PX);
  }
  function resizeWithKeyboard(name: string, startWidth: number | undefined, e: React.KeyboardEvent<HTMLSpanElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") {
      autofitColumn(name);
      return;
    }
    const step = e.shiftKey ? 25 : 10;
    const direction = e.key === "ArrowRight" ? 1 : -1;
    commitColumnWidth(name, (startWidth ?? DEFAULT_WIDTH) + step * direction);
  }

  // ---- reorder (drag headers; writes the new SELECT order) ----
  // `overIndex` is a position in the list with the dragged column removed, which
  // is exactly where the live preview shows the dragged header, so the committed
  // order can never disagree with what the user saw.
  function reorderByIndex(from: string, overIndex: number) {
    const withoutDragged = tableColumnNames.filter((n) => n !== from);
    if (withoutDragged.length === tableColumnNames.length) return; // `from` not visible
    const at = Math.max(0, Math.min(overIndex, withoutDragged.length));
    withoutDragged.splice(at, 0, from);
    setTableColumnOrder(withoutDragged);
    const nextFieldOrder = withoutDragged.filter((name) => name !== SELECTION_COLUMN);
    if (!sameOrder(nextFieldOrder, fieldNames)) {
      onQueryChange({ ...query, select: reorderSelect(query.select, fields, nextFieldOrder) });
    }
  }

  const fieldByName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const tableColumnNames = useMemo(() => {
    if (!showSel) return fieldNames;
    const defaultOrder = [SELECTION_COLUMN, ...fieldNames];
    const valid = new Set(defaultOrder);
    const kept = tableColumnOrder.filter((name) => valid.has(name));
    const missing = defaultOrder.filter((name) => !kept.includes(name));
    return [...kept, ...missing];
  }, [fieldNames, showSel, tableColumnOrder]);
  const dragSource = columnDrag.source;
  // While dragging, render the WHOLE column (header + body cells + width) in the
  // order a drop would commit: the dragged column stays MOUNTED (removing the
  // drag-source node mid-drag aborts the native HTML5 drag) but slides to the
  // hovered slot and is dimmed. Because the rendered order IS the would-be
  // result, the live preview can never disagree with where the drop lands.
  const renderedColumnNames = useMemo(() => columnDrag.preview(tableColumnNames), [columnDrag, tableColumnNames]);

  // ---- selection ----
  function toggleHeader() {
    if (!selection) return;
    selection.setPage(pageIds, headerState !== "all");
  }

  // ---- cell menu ----
  function openMenu(e: React.MouseEvent, f: FieldDef<Row>, row: Row) {
    if (isInteractiveTarget(e.target)) return;
    e.preventDefault();
    setMenu({ kind: "cell", field: f, value: readFieldValue(f, row), x: e.clientX, y: e.clientY });
  }
  function openHeaderMenu(e: React.MouseEvent, f: FieldDef<Row>) {
    if (isInteractiveTarget(e.target)) return;
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
    const prefersHorizontal = absDx > absDy * 1.25;

    if (dx === 0 && !e.shiftKey) return;

    if (dx === 0 && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      wrap.scrollLeft += dy;
      return;
    }

    if (e.shiftKey || prefersHorizontal) {
      e.preventDefault();
      e.stopPropagation();
      wrap.scrollLeft += dx;
    }
  }

  function resizeHandle(name: string, label: string, width: number | undefined): ReactNode {
    return (
      <span
        className={cx("qt-resize-handle", classNames?.resizeHandle)}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        title="Drag to resize. Press Enter to auto-fit."
        tabIndex={0}
        onPointerDown={(e) => startResize(name, width, e)}
        onKeyDown={(e) => resizeWithKeyboard(name, width, e)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  const totalCols = fields.length + (showSel ? 1 : 0) + (trailing ? 1 : 0);
  const tableWidth = renderedColumnNames.reduce((sum, name) => {
    const f = fieldByName.get(name);
    return sum + displayColumnWidthFor(name, f);
  }, trailing ? 40 : 0);
  // A horizontal data grid is more useful than a card stack on small screens,
  // but overflow should be discoverable. Keep a lightweight cue visible only
  // while there is more content to the right.
  useEffect(() => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;

    const updateCue = () => {
      const hasMoreToRight = wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2;
      setShowHorizontalCue(hasMoreToRight);
    };

    updateCue();
    window.addEventListener("resize", updateCue);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateCue);
    observer?.observe(wrap);
    return () => {
      window.removeEventListener("resize", updateCue);
      observer?.disconnect();
    };
  }, [renderedColumnNames, tableWidth]);
  const start = query.offset;
  const end = total != null ? Math.min(start + query.limit, total) : start + rows.length;
  const canPrev = start > 0;
  const canNext = total != null ? end < total : rows.length >= query.limit;
  const prevPage = () => onQueryChange((prev) => ({ ...prev, offset: Math.max(0, prev.offset - prev.limit) }));
  const nextPage = () => onQueryChange((prev) => ({ ...prev, offset: prev.offset + prev.limit }));
  const summaryText =
    total == null || total === 0 ? `${rows.length} rows` : `${start + 1}–${end} of ${total}`;

  return (
    <>
      {showHorizontalCue ? (
        <div className="qt-table-scroll-cue" aria-hidden="true">
          Swipe to see more <span>→</span>
        </div>
      ) : null}
      <div
        ref={tableWrapRef}
        className={cx(
          "qt-table-wrap",
          loading && "qt-table-wrap--loading",
          classNames?.wrap,
        )}
        onWheel={onTableWheel}
        onScroll={() => {
          const wrap = tableWrapRef.current;
          if (!wrap) return;
          setShowHorizontalCue(wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2);
        }}
        role="region"
        aria-label="Scrollable data table"
        tabIndex={0}
      >
        {loading && (
          <div className={cx("qt-loading-bar", classNames?.loadingBar)} role="progressbar" aria-label="loading" />
        )}
        <div
          ref={resizeGuideRef}
          className={cx("qt-resize-guide", classNames?.resizeGuide)}
          aria-hidden="true"
        />
        <table ref={tableRef} className={cx("qt-table", classNames?.table)} style={{ minWidth: tableWidth }}>
          <colgroup>
            {renderedColumnNames.map((name) => {
              const f = fieldByName.get(name);
              const w = displayColumnWidthFor(name, f);
              if (name === SELECTION_COLUMN) return <col key={name} data-qt-column={name} style={{ width: w }} />;
              if (!f) return null;
              return <col key={f.name} data-qt-column={f.name} style={{ width: w }} />;
            })}
            {trailing && <col style={{ width: 40 }} />}
          </colgroup>
          <thead className={classNames?.thead}>
            <tr className={classNames?.headerRow}>
              {renderedColumnNames.map((name) => {
                if (name === SELECTION_COLUMN) {
                  return (
                    <th
                      key={name}
                      data-qt-field={name}
                      className={cx(
                        "qt-th",
                        "qt-checkbox-cell",
                        dragSource === name && "qt-th--dragging",
                        classNames?.th,
                        classNames?.checkboxCell,
                      )}
                      draggable
                      onDragStart={(e) => {
                        if (resizingFieldRef.current) {
                          e.preventDefault();
                          return;
                        }
                        columnDrag.start(name, tableColumnNames.indexOf(name));
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", name);
                      }}
                      onDragOver={(e) => {
                        if (!columnDrag.source) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (columnDrag.source !== name) {
                          const withoutDragged = tableColumnNames.filter((n) => n !== columnDrag.source);
                          let next = withoutDragged.indexOf(name);
                          if (next >= 0) {
                            const rect = e.currentTarget.getBoundingClientRect();
                            if (e.clientX > rect.left + rect.width / 2) next += 1;
                            columnDrag.over(next);
                          }
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const from = columnDrag.source || e.dataTransfer.getData("text/plain");
                        if (from && columnDrag.overIndex != null) reorderByIndex(from, columnDrag.overIndex);
                        columnDrag.end();
                      }}
                      onDragEnd={() => columnDrag.end()}
                    >
                      <input
                        type="checkbox"
                        checked={headerState === "all"}
                        ref={(el) => {
                          if (el) el.indeterminate = headerState === "some";
                        }}
                        onChange={toggleHeader}
                        aria-label="select all on page"
                      />
                      {resizeHandle(name, "selection", resolvedColumnWidthFor(name))}
                    </th>
                  );
                }
                const f = fieldByName.get(name);
                if (!f) return null;
                const info = sortInfo(f);
                const sortable = isSortable(f);
                return (
                  <th
                    // Stable key (not index-based): while dragging, React must
                    // MOVE the dragged <th>, not remount it — a remount removes
                    // the drag source and aborts the native drag.
                    key={f.name}
                    data-qt-field={f.name}
                    className={cx(
                      "qt-th",
                      sortable && "qt-th--sortable",
                      dragSource === f.name && "qt-th--dragging",
                      classNames?.th,
                    )}
                    style={f.select?.align ? { textAlign: f.select.align } : undefined}
                    draggable
                    onDragStart={(e) => {
                      if (resizingFieldRef.current) {
                        e.preventDefault();
                        return;
                      }
                      columnDrag.start(f.name, tableColumnNames.indexOf(f.name));
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", f.name);
                    }}
                    onDragOver={(e) => {
                      if (!columnDrag.source) return;
                      // preventDefault on every header (incl. the dragged one) so
                      // there is no dead drop zone anywhere along the row.
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (columnDrag.source !== f.name) {
                        const withoutDragged = tableColumnNames.filter((n) => n !== columnDrag.source);
                        let next = withoutDragged.indexOf(f.name);
                        if (next >= 0) {
                          // Drop after the hovered header when past its midpoint,
                          // so a column can be moved into the last slot.
                          const rect = e.currentTarget.getBoundingClientRect();
                          if (e.clientX > rect.left + rect.width / 2) next += 1;
                          columnDrag.over(next);
                        }
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const from = columnDrag.source || e.dataTransfer.getData("text/plain");
                      if (from && columnDrag.overIndex != null) reorderByIndex(from, columnDrag.overIndex);
                      columnDrag.end();
                    }}
                    onDragEnd={() => columnDrag.end()}
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
                    {resizeHandle(f.name, f.label, resolvedColumnWidthFor(f.name, f))}
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
                  {renderedColumnNames.map((name) => {
                    if (name === SELECTION_COLUMN) {
                      return (
                        <td
                          key={name}
                          data-qt-field={name}
                          className={cx(
                            "qt-cell",
                            "qt-checkbox-cell",
                            dragSource === name && "qt-cell--dragging",
                            classNames?.cell,
                            classNames?.checkboxCell,
                          )}
                        >
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
                      );
                    }
                    const f = fieldByName.get(name);
                    if (!f) return null;
                    const render = resolveRenderer(f, renderers);
                    const value = readFieldValue(f, row);
                    const key = cellKey(id, i, f.name);
                    return (
                      <td
                        key={f.name}
                        data-qt-field={f.name}
                        className={cx("qt-cell", dragSource === f.name && "qt-cell--dragging", classNames?.cell)}
                        style={f.select?.align ? { textAlign: f.select.align } : undefined}
                        onClick={(e) => openMenu(e, f, row)}
                        onContextMenu={(e) => openMenu(e, f, row)}
                        onDoubleClick={(e) => copyCellToClipboard(e, f, id, i, value)}
                      >
                        {copiedCellKey === key ? <span className="qt-cell-copy-chip">✓ copied</span> : render({ value, row, field: f, query })}
                      </td>
                    );
                  })}
                  {trailing && <td className={cx("qt-cell", "qt-trailing-cell", classNames?.cell)}>{trailing(row)}</td>}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cx("qt-table-summary-row", classNames?.summaryRow)}>
              <td colSpan={totalCols} className={cx("qt-cell", "qt-table-summary-cell", classNames?.summaryCell)}>
                <div className={cx("qt-table-summary", classNames?.summaryControls)}>
                  <button
                    type="button"
                    className={cx("qt-btn", classNames?.summaryButton)}
                    disabled={loading || !canPrev}
                    onClick={prevPage}
                  >
                    ← prev
                  </button>
                  <span className={cx("qt-table-summary-hint", classNames?.summaryHint)}>{summaryText}</span>
                  <button
                    type="button"
                    className={cx("qt-btn", classNames?.summaryButton)}
                    disabled={loading || !canNext}
                    onClick={nextPage}
                  >
                    next →
                  </button>
                </div>
              </td>
            </tr>
          </tfoot>
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
  );
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

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function valueToString(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
