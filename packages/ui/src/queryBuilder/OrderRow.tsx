// ORDER BY row: OrderTermChip (direction, nulls, extraction) and the reorderable
// multi-sort OrderRow.

import { SortExtractionEditor } from "../SortExtractionEditor";
import { SortPicker } from "../SortPicker";
import {
  useMemo,
  useState,
} from "react";
import type {
  FieldDef,
  OrderByClause,
} from "@pythia-software/query-table-core";
import { isSortable } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { QueryBuilderClassNames } from "../classNames";
import { PickerAnchor } from "../PickerAnchor";
import { useMobileLayout } from "../AdaptiveOverlay";
import { ReorderList } from "../ReorderList";
import { Icon } from "../Icon";
import { cx, useFieldHasNull, orderByAsText } from "./helpers";
import { MobileChipEditor } from "./MobileChipEditor";

// ---- ORDER BY (multi-sort, reorderable) -----------------------------------

function OrderTermChip<Row>({
  api,
  field,
  term,
  dataIndex,
  priority,
  showPriority,
  isDragSource,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  disabled,
  updateTerm,
  clearExtract,
  removeTerm,
  classNames,
  label,
  editorOpen,
  onEditorChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  term: OrderByClause;
  /** Index of this term in the real orderBy array (for update/remove). */
  dataIndex: number;
  /** 1-based sort priority to display (reflects the live drag position). */
  priority: number;
  showPriority: boolean;
  isDragSource: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  disabled: boolean | undefined;
  updateTerm: (i: number, patch: Partial<OrderByClause>) => void;
  clearExtract: (i: number) => void;
  removeTerm: (i: number) => void;
  classNames: QueryBuilderClassNames | undefined;
  label: string;
  editorOpen: boolean;
  onEditorChange: (open: boolean) => void;
}) {
  const fieldHasNull = useFieldHasNull(api, field?.name);
  const mobile = useMobileLayout();
  const [extractOpen, setExtractOpen] = useState(false);
  const title = `Sort by ${label}`;
  const summary = `${term.dir === "asc" ? "Ascending" : "Descending"}${showPriority ? ` · Priority ${priority}` : ""}${term.extract ? " · Regex extraction" : ""}`;
  const extractionEditor = extractOpen && (
    <SortExtractionEditor
      api={api}
      field={term.field}
      label={label}
      initialPattern={term.extract?.regex}
      disabled={disabled}
      onApply={(regex) => {
        updateTerm(dataIndex, { extract: { regex } });
        setExtractOpen(false);
      }}
      onRemove={() => {
        clearExtract(dataIndex);
        setExtractOpen(false);
      }}
      onClose={() => setExtractOpen(false)}
    />
  );

  if (mobile)
    return (
      <>
        <MobileChipEditor
          title={title}
          summaryTitle={label}
          summary={summary}
          disabled={disabled}
          open={editorOpen}
          onOpenChange={onEditorChange}
        >
          <div className="qt-mobile-form">
            <label className="qt-mobile-form-field">
              <span>Direction</span>
              <select
                className={cx("qt-input", classNames?.select)}
                value={term.dir}
                disabled={disabled}
                onChange={(event) =>
                  updateTerm(dataIndex, {
                    dir: event.target.value as OrderByClause["dir"],
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            {(term.extract != null || fieldHasNull !== false) && (
              <label className="qt-mobile-form-field">
                <span>Null values</span>
                <select
                  className={cx("qt-input", classNames?.select)}
                  value={term.nulls ?? "last"}
                  disabled={disabled}
                  onChange={(event) =>
                    updateTerm(dataIndex, {
                      nulls: event.target.value as "first" | "last",
                    })
                  }
                >
                  <option value="last">Last</option>
                  <option value="first">First</option>
                </select>
              </label>
            )}
            <div className="qt-mobile-form-field qt-mobile-form-field--wide">
              <span>Extraction</span>
              <button
                type="button"
                className="qt-btn"
                disabled={disabled}
                onClick={() => setExtractOpen(true)}
                aria-label={`Configure regex extract for ${label}`}
              >
                <Icon name={term.extract ? "pencil" : "add"} />
                {term.extract ? "Edit regex extraction" : "regex extract"}
              </button>
            </div>
            <div className="qt-mobile-form-actions">
              <button
                type="button"
                className="qt-mobile-form-remove"
                disabled={disabled}
                onClick={() => removeTerm(dataIndex)}
                aria-label={`Remove ${label} sort`}
              >
                Remove sort
              </button>
            </div>
          </div>
        </MobileChipEditor>
        {extractionEditor}
      </>
    );

  return (
    <>
      <span
        className={cx(
          "qt-chip",
          "qt-chip--col",
          "qt-chip--sort",
          isDragSource && "qt-chip--dragging",
          classNames?.chip,
        )}
        draggable={!disabled}
        onDragStart={(e) => {
          onDragStart();
          // Firefox refuses to start a native drag unless drag data is set here.
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", term.field);
        }}
        onDragOver={onDragOver}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        onDragEnd={onDragEnd}
        title="drag to reorder sort priority"
      >
        <span aria-hidden className="qt-chip-grip">
          <Icon name="grip" />
        </span>
        {showPriority && <span className="qt-chip-priority">{priority}</span>}
        <span className="qt-chip-field">{label}</span>
        <button
          type="button"
          className="qt-chip-op-btn"
          disabled={disabled}
          onClick={() =>
            updateTerm(dataIndex, { dir: term.dir === "asc" ? "desc" : "asc" })
          }
        >
          <Icon name={term.dir === "asc" ? "arrowUp" : "arrowDown"} />
          {term.dir === "asc" ? "asc" : "desc"}
        </button>
        {term.extract && <button
          type="button"
          className="qt-chip-op-btn"
          title={`Regex: ${term.extract.regex}`}
          aria-label={`Configure regex extract for ${label}`}
          disabled={disabled}
          onClick={() => setExtractOpen(true)}
        >
          <Icon name="pencil" />
          regex extraction
        </button>}
        {(term.extract != null || fieldHasNull !== false) && (
          <button
            type="button"
            className="qt-chip-op-btn"
            disabled={disabled}
            title="where NULL values sort"
            onClick={() =>
              updateTerm(dataIndex, {
                nulls: (term.nulls ?? "last") === "last" ? "first" : "last",
              })
            }
          >
            nulls {term.nulls ?? "last"}
          </button>
        )}
        <button
          type="button"
          className="qt-chip-x"
          onClick={() => removeTerm(dataIndex)}
          disabled={disabled}
          aria-label={`Remove ${label} sort`}
        >
          <Icon name="close" />
        </button>
      </span>
      {extractionEditor}
    </>
  );
}

export function OrderRow<Row>({
  api,
  fields,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const orderBy = api.query.orderBy;
  const mobile = useMobileLayout();
  const byName = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  // Local live-reorder drag state (sort terms are their own list, distinct from
  // the columns shared via api.columnDrag) — same dimmed-source + slide preview.
  const [drag, setDrag] = useState<{
    source: string;
    overIndex: number;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  // Field chosen in the "sort with regex extraction" configurator (split-button caret).
  const [regexField, setRegexField] = useState<FieldDef<Row> | null>(null);
  const [regexDirection, setRegexDirection] = useState<OrderByClause["dir"]>("desc");

  const [editingSort, setEditingSort] = useState<string | null>(null);

  function setOrderBy(next: OrderByClause[]) {
    api.setSort(next);
  }
  function updateTerm(i: number, patch: Partial<OrderByClause>) {
    setOrderBy(orderBy.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function clearExtract(i: number) {
    setOrderBy(
      orderBy.map((term, index) => {
        if (index !== i) return term;
        const { extract: _extract, ...plainTerm } = term;
        return plainTerm;
      }),
    );
  }
  function removeTerm(i: number) {
    setEditingSort(null);
    setOrderBy(orderBy.filter((_, k) => k !== i));
  }
  function addTerm(f: FieldDef<Row>, dir: OrderByClause["dir"], extract?: OrderByClause["extract"]) {
    const field = f.sort?.field ?? f.name;
    const nextOrderBy: OrderByClause[] = [
      ...orderBy,
      { field, dir, ...(extract ? { extract } : {}) },
    ];

    const existing = orderBy.findIndex((o) => o.field === field);
    if (existing >= 0) {
      updateTerm(existing, { dir, ...(extract ? { extract } : {}) });
      setAdding(false);
      return;
    }

    const hasSelectColumn = api.select.visible.some((c) => c.field === field);
    if (hasSelectColumn) {
      setOrderBy(nextOrderBy);
      setAdding(false);
      return;
    }

    api.setQuery((q) => ({
      ...q,
      offset: 0,
      orderBy: nextOrderBy,
      select: q.select.length
        ? [...q.select, { field }]
        : [...api.select.visible, { field }],
    }));
    setAdding(false);
  }

  // Order-by terms are identified by their (unique) field; the drag math mirrors
  // the column chips so the live preview equals the committed order.
  const termFields = orderBy.map((o) => o.field);
  const termByField = useMemo(
    () => new Map(orderBy.map((o) => [o.field, o])),
    [orderBy],
  );
  function previewFields(): string[] {
    if (!drag) return termFields;
    const without = termFields.filter((f) => f !== drag.source);
    if (without.length === termFields.length) return termFields;
    const at = Math.max(0, Math.min(drag.overIndex, without.length));
    return [...without.slice(0, at), drag.source, ...without.slice(at)];
  }
  function handleSortOver(e: React.DragEvent, field: string) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drag.source !== field) {
      const without = termFields.filter((f) => f !== drag.source);
      let next = without.indexOf(field);
      if (next >= 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX > rect.left + rect.width / 2) next += 1;
        setDrag((d) =>
          d && d.overIndex !== next ? { source: d.source, overIndex: next } : d,
        );
      }
    }
  }
  function commitSortDrop() {
    if (drag) setOrderBy(previewFields().map((f) => termByField.get(f)!));
    setDrag(null);
  }

  const rendered = previewFields();
  const sortable = fields.filter(isSortable);
  const sortKey = (f: FieldDef<Row>) => f.sort?.field ?? f.name;
  function selectRegexField(field: FieldDef<Row> | null) {
    setRegexField(field);
    setRegexDirection(field ? termByField.get(sortKey(field))?.dir ?? "desc" : "desc");
  }
  function openRegexConfigurator(field?: FieldDef<Row>) {
    const unsorted = sortable.filter((f) => !termFields.includes(sortKey(f)));
    const chosen = field ??
      unsorted.find((f) => f.type === "text") ??
        unsorted[0] ??
        sortable[0] ??
        null;
    selectRegexField(chosen);
    setAdding(false);
  }
  const renderTerm = (name: string, position: number) => {
    const term = termByField.get(name)!;
    return (
      <OrderTermChip
        key={name}
        api={api}
        field={byName.get(name)}
        term={term}
        dataIndex={orderBy.findIndex((candidate) => candidate.field === name)}
        priority={position + 1}
        showPriority={orderBy.length > 1}
        isDragSource={drag?.source === name}
        onDragStart={() =>
          setDrag({ source: name, overIndex: termFields.indexOf(name) })
        }
        onDragOver={(event) => handleSortOver(event, name)}
        onDrop={commitSortDrop}
        onDragEnd={() => setDrag(null)}
        disabled={disabled}
        updateTerm={updateTerm}
        clearExtract={clearExtract}
        removeTerm={removeTerm}
        classNames={classNames}
        label={byName.get(name)?.label ?? name}
        editorOpen={editingSort === name}
        onEditorChange={(open) => setEditingSort(open ? name : null)}
      />
    );
  };
  const isDefaultOrderBy =
    orderBy.length === api.defaults.orderBy.length &&
    orderBy.every((term, i) => {
      const next = api.defaults.orderBy[i];
      return (
        term.field === next?.field &&
        term.dir === next?.dir &&
        (term.nulls ?? "last") === (next?.nulls ?? "last") &&
        (term.extract?.regex ?? null) === (next?.extract?.regex ?? null)
      );
    });

  const actions = (
    <>
      <PickerAnchor>
      <span className="qt-split-btn" role="group" aria-label="Sort actions">
        <button
          type="button"
          className="qt-add"
          aria-label="Add sort"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={() => setAdding(previous => !previous)}
          disabled={disabled || sortable.length === 0}
        >
          <Icon name="add" />
          {mobile ? "Add" : "add sort"}
        </button>
        <button
          type="button"
          className="qt-add qt-split-btn-caret"
          aria-label="Sort with regex extraction"
          title="Sort with regex extraction"
          aria-haspopup="dialog"
          aria-expanded={regexField != null}
          disabled={disabled || sortable.length === 0}
          onClick={() => openRegexConfigurator()}
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </span>
      {adding && (
        <SortPicker
          fields={sortable}
          onPick={addTerm}
          onRegex={openRegexConfigurator}
          onClose={() => setAdding(false)}
        />
      )}
      </PickerAnchor>
      {!isDefaultOrderBy && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => api.setSort(api.defaults.orderBy)}
          disabled={disabled}
        >
          {mobile ? "Reset" : "reset"}
        </button>
      )}
    </>
  );

  return (
    <div className={cx("qt-qb-row qt-qb-row--sort", orderBy.length === 0 && "qt-qb-row--unused")}>
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label="Sort">
          order by
        </span>
        {mobile && actions}
      </div>
      {orderBy.length === 0 && !adding && (
        <span className="qt-qb-hint">(default)</span>
      )}
      {mobile && orderBy.length > 0 ? (
        <ReorderList
          className="qt-query-reorder-list"
          showHint={false}
          items={orderBy.map((term) => ({
            id: term.field,
            label: orderByAsText(term, byName),
          }))}
          disabled={disabled}
          renderItem={(item, position) => renderTerm(item.id, position)}
          onMove={(id, position) => {
            const next = [...orderBy];
            const source = next.findIndex((term) => term.field === id);
            if (source < 0) return;
            const [term] = next.splice(source, 1);
            next.splice(position, 0, term!);
            setOrderBy(next);
          }}
        />
      ) : (
        rendered.map(renderTerm)
      )}
      {!mobile && actions}
      {regexField && (
        <SortExtractionEditor
          api={api}
          field={sortKey(regexField)}
          label={regexField.label}
          initialPattern={termByField.get(sortKey(regexField))?.extract?.regex}
          direction={regexDirection}
          onDirectionChange={setRegexDirection}
          fieldOptions={sortable.map((f) => ({
            name: sortKey(f),
            label: f.label,
          }))}
          onFieldChange={(name) => {
            const next = sortable.find((f) => sortKey(f) === name);
            if (next) selectRegexField(next);
          }}
          title="Sort with regex extraction"
          applyLabel={
            termFields.includes(sortKey(regexField))
              ? "Update sort"
              : "Add sort"
          }
          disabled={disabled}
          onApply={(regex) => {
            addTerm(regexField, regexDirection, { regex });
            setRegexField(null);
          }}
          onRemove={() => {
            clearExtract(orderBy.findIndex((term) => term.field === sortKey(regexField)));
            setRegexField(null);
          }}
          onClose={() => setRegexField(null)}
        />
      )}
    </div>
  );
}
