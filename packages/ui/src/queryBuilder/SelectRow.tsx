// SELECT row: draggable column chips, the add-column picker and the column editor entry.

import { SelectColumnEditor } from "../SelectColumnEditor";
import {
  useMemo,
  useRef,
  useState,
} from "react";
import type { FieldDef } from "@pythia-software/query-table-core";
import {
  ITEM_DETAILS_COLUMN,
  isSelectable,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { QueryBuilderClassNames } from "../classNames";
import { PickerAnchor } from "../PickerAnchor";
import { FieldPicker } from "../FieldPicker";
import { useMobileLayout } from "../AdaptiveOverlay";
import { ReorderList } from "../ReorderList";
import { Icon } from "../Icon";
import type { SelectPresentation } from "./types";
import { cx } from "./helpers";

// ---- SELECT ---------------------------------------------------------------

export function SelectRow<Row>({
  api,
  fields,
  classNames,
  disabled,
  presentation,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  presentation: SelectPresentation | undefined;
}) {
  const { select, columnDrag } = api;
  function removeColumn(field: string) {
    try {
      select.hide(field);
    } catch (error) {
      if (!api.grouping) throw error;
      api.grouping.setNotice(error instanceof Error ? error.message : String(error));
    }
  }
  const mobile = useMobileLayout();
  const [editingColumns, setEditingColumns] = useState(false);
  const [editingField, setEditingField] = useState<string | undefined>();
  function openColumnEditor(field?: string) {
    setEditingField(field);
    setEditingColumns(true);
  }
  const detailSettingsButton = (field: string) => field === ITEM_DETAILS_COLUMN && api.itemDetails ? (
    <button type="button" className="qt-chip-op-btn" aria-label="Configure Detail column" title="Configure Detail column"
      aria-haspopup="dialog" aria-expanded={editingColumns && editingField === field} disabled={disabled}
      onClick={() => openColumnEditor(field)}><Icon name="chevronRight" size={18} /></button>
  ) : null;
  const [adding, setAdding] = useState(false);
  const addColumnRef = useRef<HTMLButtonElement>(null);
  const fieldLabelByName = useMemo(
    () => new Map(select.fields.map((f) => [f.name, f.label])),
    [select.fields],
  );

  // `overIndex` is a position in the list with the dragged column removed —
  // exactly where the live preview shows it. select.move removes-then-inserts at
  // that index, so the committed order matches the preview.
  function reorderByIndex(from: string, overIndex: number) {
    select.move(from, overIndex);
  }

  const fieldNames = select.visible.map((c) => c.field);
  const dragSource = columnDrag.source;

  // Live reorder, driven by the SHARED column-drag state so dragging a chip also
  // live-previews/dims the matching table column (and vice versa). The dragged
  // chip stays MOUNTED (removing the drag-source node mid-drag aborts the native
  // drag) and slides to the hovered slot, dimmed. Rendered order == drop result.
  const rendered = columnDrag.preview(fieldNames);

  const actions = (
    <>
      <PickerAnchor>
      <span className="qt-split-btn" role="group" aria-label="Column actions">
        <button
          type="button"
          className="qt-add"
          aria-label="Add column"
          ref={addColumnRef}
          aria-expanded={adding}
          aria-haspopup="dialog"
          onClick={() => setAdding(!adding)}
          disabled={
            disabled ||
            (!presentation?.renderPicker && select.hidden.length === 0)
          }
        >
          <Icon name="add" />
          {mobile ? "Add" : "add column"}
        </button>
        <button
          type="button"
          className="qt-add qt-split-btn-caret"
          aria-label="Customize columns"
          title="Customize columns"
          aria-haspopup="dialog"
          aria-expanded={editingColumns}
          disabled={disabled}
          onClick={() => openColumnEditor()}
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </span>
      {adding ? presentation?.renderPicker ? (
        presentation.renderPicker(() => setAdding(false))
      ) : (
          <FieldPicker
            anchor={addColumnRef.current ?? undefined}
            fields={select.hidden.filter(isSelectable)}
            onPick={(f) => {
              select.show(f.name);
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
      ) : null}
      </PickerAnchor>
      <button
        type="button"
        className="qt-link-btn"
        aria-label="Reset columns"
        onClick={select.reset}
        disabled={disabled}
        title="Reset to default columns"
      >
        {mobile ? "Reset" : "reset"}
      </button>
    </>
  );

  return (
    <div className="qt-qb-row qt-qb-row--select">
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label="Columns">
          select
        </span>
        {mobile && actions}
      </div>
      {editingColumns && (presentation?.renderEditor ? presentation.renderEditor(() => setEditingColumns(false)) :
        <SelectColumnEditor
          api={api}
          {...(editingField ? { initialField: editingField } : {})}
          onClose={() => setEditingColumns(false)}
          notice={presentation?.editorNotice}
        />
      )}
      {mobile ? (
        <ReorderList
          className="qt-query-reorder-list qt-query-reorder-list--columns"
          layout="wrap"
          showHint={false}
          items={fieldNames.map((name) => ({
            id: name,
            label: fieldLabelByName.get(name) ?? name,
          }))}
          onMove={select.move}
          disabled={disabled}
          renderItem={(item) => (
            <>
              {presentation?.renderChip?.(item.id, item.label) ?? (
                <span className="qt-chip-field">{item.label}</span>
              )}
              {detailSettingsButton(item.id)}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => removeColumn(item.id)}
                disabled={disabled}
                aria-label={`Remove ${item.label} column`}
              >
                <Icon name="close" />
              </button>
            </>
          )}
        />
      ) : (
        rendered.map((name) => {
          const label = fieldLabelByName.get(name) ?? name;
          return (
            <span
              // Stable key (not index-based) so React MOVES the dragged chip instead
              // of remounting it \u2014 a remount removes the drag source and aborts the drag.
              key={name}
              className={cx(
                "qt-chip",
                "qt-chip--col",
                dragSource === name && "qt-chip--dragging",
                classNames?.columnChip ?? classNames?.chip,
              )}
              draggable={!disabled}
              onDragStart={(e) => {
                columnDrag.start(name, fieldNames.indexOf(name), fieldNames);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", name);
              }}
              onDragOver={(e) => {
                if (!columnDrag.source) return;
                // preventDefault on every chip (incl. the dragged one) so there is no
                // dead drop zone along the row.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (columnDrag.source !== name) {
                  const withoutDragged = fieldNames.filter(
                    (n) => n !== columnDrag.source,
                  );
                  let next = withoutDragged.indexOf(name);
                  if (next >= 0) {
                    // Drop after the hovered chip when past its midpoint, so a column
                    // can be moved into the last slot.
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (e.clientX > rect.left + rect.width / 2) next += 1;
                    columnDrag.over(next, fieldNames);
                  }
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const from =
                  columnDrag.source || e.dataTransfer.getData("text/plain");
                if (
                  from &&
                  columnDrag.overIndex != null &&
                  rendered.includes(from)
                ) {
                  reorderByIndex(from, rendered.indexOf(from));
                  columnDrag.end(true);
                } else columnDrag.end();
              }}
              onDragEnd={() => columnDrag.end()}
              title="drag to reorder"
            >
              <span aria-hidden className="qt-chip-grip">
                <Icon name="grip" />
              </span>
              {presentation?.renderChip?.(name, label) ?? (
                <span className="qt-chip-field">{label}</span>
              )}
              {detailSettingsButton(name)}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => removeColumn(name)}
                disabled={disabled}
                aria-label={`Remove ${label} column`}
              >
                <Icon name="close" />
              </button>
            </span>
          );
        })
      )}
      {!mobile && actions}
      {presentation?.hint}
    </div>
  );
}
