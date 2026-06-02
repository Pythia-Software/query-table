// QueryBuilder — the chip toolbar: WHERE filters, SELECT columns, ORDER BY
// (multi-sort, reorderable), and LIMIT/OFFSET paging. Type-aware filter inputs
// (enum/static <select>, value autocomplete via Transport.fetchDistinctValues).
// Hosts the Save / saved-queries entry point.
//
// A union of both projects' builders: xplo-perf's chip layout + datalist
// autocomplete and xlsx-collect's draggable column chips, grouped picker, and
// per-clause operator dropdowns. Multi-sort (orderBy is an array) is new to both.

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type {
  DistinctValuesResult,
  FieldDef,
  FilterOp,
  OrderByClause,
  WhereClause,
} from "@query-table/core";
import {
  NULLARY_OPS,
  filterValues as filterValuesFor,
  queriesEqual,
  isFilterable,
  isSelectable,
  isSortable,
  opsForField,
} from "@query-table/core";
import type { QueryTableApi } from "@query-table/react";
import type { QueryBuilderClassNames } from "./classNames";
import { FieldPicker } from "./FieldPicker";
import { SavedQueriesModal } from "./SavedQueriesModal";

export interface QueryBuilderProps<Row> {
  /** The controller; QueryBuilder drives it through the intent helpers. */
  api: QueryTableApi<Row>;
  /** All schema fields (for the field picker / sort picker). */
  fields: FieldDef<Row>[];
  /** Total matching rows, for the "N of M" paging hint. */
  total: number | null;
  /** Disable inputs while a fetch is in flight. */
  running?: boolean;
  classNames?: QueryBuilderClassNames;
}

const cx = (...parts: Array<string | undefined | false>): string =>
  parts.filter((p): p is string => Boolean(p)).join(" ");

function useFieldHasNull<Row>(api: QueryTableApi<Row>, fieldName: string | undefined): boolean | undefined {
  const [hasNull, setHasNull] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!fieldName) return;
    let cancelled = false;

    void api
      .filterValues(fieldName, "")
      .then((r) => {
        if (!cancelled && typeof r.hasNull === "boolean") {
          setHasNull(r.hasNull);
        }
      })
      .catch(() => {
        if (!cancelled) setHasNull(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [api, fieldName]);

  return hasNull;
}

function whereClauseAsText<Row>(clause: WhereClause, byName: Map<string, FieldDef<Row>>): string {
  const field = byName.get(clause.field)?.label ?? clause.field;
  const op = clause.op.replace(/_/g, " ");
  if (NULLARY_OPS.has(clause.op)) return `${field} ${op}`;
  const value = clause.value === "" ? "''" : clause.value;
  return `${field} ${op} ${value}`;
}

function orderByAsText<Row>(term: OrderByClause, byName: Map<string, FieldDef<Row>>): string {
  const field = byName.get(term.field)?.label ?? term.field;
  const nulls = term.nulls ? ` nulls ${term.nulls}` : "";
  return `${field} ${term.dir}${nulls}`;
}

function chipFieldWidthChars(text: string, fallback = 5, max = 30): number {
  return Math.min(max, Math.max(fallback, (text || "").length + 1));
}

function chipFieldWidthForInput(text: string, fieldType: string | undefined, fallback = 5, padding = 0): number {
  const cap = fieldType === "number" ? 10 : 30;
  return chipFieldWidthChars(text, fallback, cap) + padding;
}

function chipFieldWidthForSelect(text: string, fallback = 3, max = 30): number {
  return chipFieldWidthChars(text, fallback, max) + 2;
}

function buildCollapsedSummary<Row>(
  where: WhereClause[],
  orderBy: OrderByClause[],
  byName: Map<string, FieldDef<Row>>,
): string {
  const whereText = where.length === 0 ? "all rows" : where.map((c) => whereClauseAsText(c, byName)).join(" and ");
  const orderText = orderBy.length === 0 ? "(default)" : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
  return `WHERE ${whereText} ORDER BY ${orderText}`;
}

function whereClauseSummaryText<Row>(where: WhereClause[], byName: Map<string, FieldDef<Row>>): string {
  return where.length === 0 ? "all rows" : where.map((c) => whereClauseAsText(c, byName)).join(" and ");
}

function orderBySummaryText<Row>(orderBy: OrderByClause[], byName: Map<string, FieldDef<Row>>): string {
  return orderBy.length === 0 ? "(default)" : orderBy.map((term) => orderByAsText(term, byName)).join(", ");
}

export function QueryBuilder<Row>({ api, fields, total, running, classNames }: QueryBuilderProps<Row>): ReactNode {
  const [showSaved, setShowSaved] = useState(false);
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [editingSavedName, setEditingSavedName] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const activeSavedQuery = useMemo(
    () => api.saved.items.find((item) => queriesEqual(item.query, api.query)),
    [api.query, api.saved.items],
  );
  const bodyId = useId();
  const isEditingSaved = editingSavedId != null && activeSavedQuery?.id === editingSavedId;
  const collapsedSummary = useMemo(
    () => buildCollapsedSummary(api.query.where, api.query.orderBy, byName),
    [api.query.where, api.query.orderBy, byName],
  );
  const collapsedWhereText = useMemo(
    () => whereClauseSummaryText(api.query.where, byName),
    [api.query.where, byName],
  );
  const collapsedOrderText = useMemo(
    () => orderBySummaryText(api.query.orderBy, byName),
    [api.query.orderBy, byName],
  );

  useEffect(() => {
    if (editingSavedId != null && activeSavedQuery?.id !== editingSavedId) {
      cancelRenameActiveSaved();
    }
    // activeSavedQuery can become null if edits/loads shift to unsaved or another query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSavedQuery]);

  function saveFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : "Failed to save query.";
    if (typeof window !== "undefined") window.alert(message);
  }

  function save() {
    const name = typeof window !== "undefined" ? window.prompt("Save query as…") : null;
    if (name && name.trim()) void api.saved.save(name.trim()).catch(saveFailed);
  }

  function beginRenameActiveSaved() {
    if (!activeSavedQuery) return;
    setEditingSavedId(activeSavedQuery.id);
    setEditingSavedName(activeSavedQuery.name);
  }

  function cancelRenameActiveSaved() {
    setEditingSavedId(null);
    setEditingSavedName("");
  }

  function commitRenameActiveSaved() {
    if (!isEditingSaved || !activeSavedQuery) return;
    const trimmed = editingSavedName.trim();
    if (!trimmed || trimmed === activeSavedQuery.name) {
      cancelRenameActiveSaved();
      return;
    }
    void api.saved
      .save(trimmed)
      .then(() => void api.saved.remove(activeSavedQuery.id))
      .catch(saveFailed);
    cancelRenameActiveSaved();
  }

  useEffect(() => {
    if (collapsed) setShowSaved(false);
  }, [collapsed]);

  return (
    <div className={cx("qt-qb", classNames?.root)}>
      <div className="qt-qb-row qt-qb-actions">
        {collapsed ? (
          <>
            <span className="qt-qb-summary qt-truncate" title={collapsedSummary}>
              <span className="qt-qb-summary-kw">WHERE</span>{" "}
              <strong>{collapsedWhereText}</strong>{" "}
              <span className="qt-qb-summary-kw">ORDER BY</span>{" "}
              <strong>{collapsedOrderText}</strong>
            </span>
            <button
              type="button"
              className={cx("qt-btn", classNames?.button)}
              onClick={() => setCollapsed((next) => !next)}
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              title={collapsed ? "Expand query builder" : "Collapse query builder"}
            >
              {collapsed ? "Show query builder" : "Hide query builder"}
            </button>
          </>
        ) : (
          <>
            <span className="qt-qb-left">
              <span className="qt-qb-count">{api.loading ? "loading…" : `${api.rows.length} of ${total ?? "?"}`}</span>
              {activeSavedQuery && (
                <span className="qt-qb-saved">
                  <span className="qt-qb-saved-star" aria-hidden>
                    ★
                  </span>
                  {isEditingSaved ? (
                    <input
                      type="text"
                      className="qt-qb-saved-input"
                      value={editingSavedName}
                      disabled={running}
                      autoFocus
                      onChange={(e) => setEditingSavedName(e.target.value)}
                      onBlur={commitRenameActiveSaved}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRenameActiveSaved();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRenameActiveSaved();
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <strong className="qt-qb-saved-name">
                      {activeSavedQuery.name}
                      {api.saved.defaultId === activeSavedQuery.id ? (
                        <span className="qt-qb-saved-default"> default</span>
                      ) : null}
                    </strong>
                  )}
                  <button
                    type="button"
                    className="qt-qb-saved-edit"
                    title="Rename saved query"
                    disabled={running}
                    onClick={beginRenameActiveSaved}
                  >
                    ✎
                  </button>
                </span>
              )}
            </span>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.refresh} disabled={running}>
              ↻ refresh
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.undo} disabled={!api.canUndo}>
              ↶ Undo
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.redo} disabled={!api.canRedo}>
              ↷ Redo
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={save} disabled={running}>
              ★ save
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={() => setShowSaved(true)}>
              ≡ saved{api.saved.items.length > 0 ? ` (${api.saved.items.length})` : ""}
            </button>
            <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.resetAll} disabled={running}>
              Reset All
            </button>
            <button
              type="button"
              className={cx("qt-btn", classNames?.button)}
              onClick={() => setCollapsed((next) => !next)}
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              title={collapsed ? "Expand query builder" : "Collapse query builder"}
            >
              {collapsed ? "Show query builder" : "Hide query builder"}
            </button>
          </>
        )}
      </div>

      {!collapsed ? (
        <div id={bodyId} className="qt-qb-body">
          <SelectRow api={api} fields={fields} classNames={classNames} disabled={running} />
          <WhereRow api={api} byName={byName} fields={fields} classNames={classNames} disabled={running} />
          <OrderRow api={api} fields={fields} classNames={classNames} disabled={running} />
          <WindowRow api={api} classNames={classNames} disabled={running} />
        </div>
      ) : null}

      {!collapsed && showSaved ? (
        <SavedQueriesModal saved={api.saved} onClose={() => setShowSaved(false)} />
      ) : null}
    </div>
  );
}

// ---- SELECT ---------------------------------------------------------------

function SelectRow<Row>({
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
  const { select, columnDrag } = api;
  const [adding, setAdding] = useState(false);
  const fieldLabelByName = useMemo(() => new Map(select.fields.map((f) => [f.name, f.label])), [select.fields]);

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

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">select</span>
      {rendered.map((name) => {
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
            columnDrag.start(name, fieldNames.indexOf(name));
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
              const withoutDragged = fieldNames.filter((n) => n !== columnDrag.source);
              let next = withoutDragged.indexOf(name);
              if (next >= 0) {
                // Drop after the hovered chip when past its midpoint, so a column
                // can be moved into the last slot.
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
          title="drag to reorder"
        >
          <span aria-hidden className="qt-chip-grip">
            ⋮⋮
          </span>
          <span className="qt-chip-field">{label}</span>
          <button type="button" className="qt-chip-x" onClick={() => select.hide(name)} disabled={disabled}>
            ✕
          </button>
        </span>
        );
      })}
      {adding ? (
        <FieldPicker
          fields={select.hidden.filter(isSelectable)}
          onPick={(f) => {
            select.show(f.name);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className="qt-add"
          onClick={() => setAdding(true)}
          disabled={disabled || select.hidden.length === 0}
        >
          + add column
        </button>
      )}
      {api.query.select.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={select.reset} disabled={disabled} title="Reset to default columns">
          reset
        </button>
      )}
    </div>
  );
}

// ---- WHERE ----------------------------------------------------------------

function WhereRow<Row>({
  api,
  byName,
  fields,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  byName: Map<string, FieldDef<Row>>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const [adding, setAdding] = useState(false);

  function addClause(f: FieldDef<Row>) {
    const op = opsForField(f)[0] ?? "=";
    api.addFilter({ field: f.name, op, value: "" });
    setAdding(false);
  }

  const groupedWhere = useMemo(() => {
    const groups = new Map<string, { field: string; clauses: { clause: WhereClause; index: number }[] }>();
    const order: string[] = [];

    api.query.where.forEach((c, i) => {
      if (!groups.has(c.field)) order.push(c.field);
      const group = groups.get(c.field) ?? { field: c.field, clauses: [] };
      group.clauses.push({ clause: c, index: i });
      groups.set(c.field, group);
    });

    return order.map((fieldName) => groups.get(fieldName)!);
  }, [api.query.where]);

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">where</span>
      {api.query.where.length === 0 && !adding && <span className="qt-qb-hint">all rows</span>}
      {groupedWhere.map((g) => (
        <ClauseChip
          key={g.field}
          api={api}
          field={byName.get(g.field)}
          clauses={g.clauses}
          classNames={classNames}
          disabled={disabled}
          onChange={(index, next) => api.updateFilter(index, next)}
          onRemove={(index) => api.removeFilter(index)}
        />
      ))}
      {adding ? (
        <FieldPicker
          fields={fields.filter(isFilterable)}
          gateOnDistinct
          onPick={addClause}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="qt-add" onClick={() => setAdding(true)} disabled={disabled}>
          + add filter
        </button>
      )}
      {api.query.where.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={api.clearFilters} disabled={disabled} title="Reset filters">
          reset
        </button>
      )}
    </div>
  );
}

function ClauseChip<Row>({
  api,
  field,
  clauses,
  classNames,
  disabled,
  onChange,
  onRemove,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  clauses: Array<{ clause: WhereClause; index: number }>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  onChange: (index: number, c: WhereClause) => void;
  onRemove: (index: number) => void;
}) {
  const labelField = field?.label;
  const fieldName = clauses[0]?.clause.field;
  const fieldHasNull = useFieldHasNull(api, field?.name);

  return (
    <span className={cx("qt-chip", "qt-chip--where", classNames?.chip)}>
      <span className="qt-chip-field">{labelField ?? fieldName}</span>
      <span className="qt-chip-where-list">
        {clauses.map((entry, idx) => {
          const clause = entry.clause;
          const baseOps: FilterOp[] = field ? opsForField(field) : [clause.op];
          const filteredBaseOps = fieldHasNull === false ? baseOps.filter((op) => !NULLARY_OPS.has(op)) : baseOps;
          const clauseOps: FilterOp[] = filteredBaseOps.includes(clause.op)
            ? filteredBaseOps
            : [...filteredBaseOps, clause.op];
          const needsValue = !NULLARY_OPS.has(clause.op);
          return (
            <span className="qt-chip-where-clause" key={entry.index}>
              {idx > 0 && <span className="qt-chip-and">and</span>}
              <select
                className={cx("qt-chip-op", classNames?.select)}
                value={clause.op}
                disabled={disabled}
                style={{ width: `${chipFieldWidthForSelect(clause.op, 3)}ch` }}
                onChange={(e) => onChange(entry.index, { ...clause, op: e.target.value as FilterOp })}
              >
                {clauseOps.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {needsValue && (
                <ValueInput
                  api={api}
                  field={field}
                  value={clause.value}
                  classNames={classNames}
                  onChange={(v) => onChange(entry.index, { ...clause, value: v })}
                />
              )}
              <button
                type="button"
                className="qt-chip-x"
                onClick={() => onRemove(entry.index)}
                disabled={disabled}
              >
                ✕
              </button>
            </span>
          );
        })}
      </span>
    </span>
  );
}

// ---- value input: autocomplete by default --------------------------------

function ValueInput<Row>({
  api,
  field,
  value,
  classNames,
  onChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  value: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const strategy = field ? filterValuesFor(field) : { source: "freeform" as const };

  // Static closed domain → a plain <select> of the options.
  if (strategy.source === "static") {
    const selectedText = value || "—";
    const widthChars = chipFieldWidthForSelect(selectedText, 4);
    return (
      <select
        className={cx("qt-chip-val", classNames?.select)}
        value={value}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {strategy.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  // Freeform → a plain input, no suggestions.
  if (strategy.source === "freeform" || !field) {
    const widthChars = chipFieldWidthForInput(value || "value", field?.type, 5, 4);
    return (
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder="value"
        size={widthChars}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // Autocomplete (the default) → debounced combobox backed by api.filterValues.
  return <AutocompleteInput api={api} field={field} value={value} classNames={classNames} onChange={onChange} />;
}

function AutocompleteInput<Row>({
  api,
  field,
  value,
  classNames,
  onChange,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row>;
  value: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const [result, setResult] = useState<DistinctValuesResult>({ values: [], hasMore: false });
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .filterValues(field.name, value)
        .then((r) => {
          if (!cancelled) setResult(r);
        })
        .catch(() => {
          if (!cancelled) setResult({ values: [], hasMore: false });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, field.name, value]);

  return (
    <span className="qt-autocomplete">
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder="value"
        list={listId}
        size={chipFieldWidthForInput(value || "value", field.type, 5, 4)}
        style={{ width: `${chipFieldWidthForInput(value || "value", field.type, 5, 4)}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {result.values.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      {result.hasMore && <span className="qt-autocomplete-hint">keep typing to refine…</span>}
    </span>
  );
}

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
  removeTerm,
  classNames,
  label,
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
  removeTerm: (i: number) => void;
  classNames: QueryBuilderClassNames | undefined;
  label: string;
}) {
  const fieldHasNull = useFieldHasNull(api, field?.name);

  return (
    <span
      className={cx("qt-chip", "qt-chip--col", "qt-chip--sort", isDragSource && "qt-chip--dragging", classNames?.chip)}
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
        ⋮⋮
      </span>
      {showPriority && <span className="qt-chip-priority">{priority}</span>}
      <span className="qt-chip-field">{label}</span>
      <button
        type="button"
        className="qt-chip-op-btn"
        disabled={disabled}
        onClick={() => updateTerm(dataIndex, { dir: term.dir === "asc" ? "desc" : "asc" })}
      >
        {term.dir === "asc" ? "↑ asc" : "↓ desc"}
      </button>
      {fieldHasNull !== false && (
        <button
          type="button"
          className="qt-chip-op-btn"
          disabled={disabled}
          title="where NULL values sort"
          onClick={() => updateTerm(dataIndex, { nulls: (term.nulls ?? "last") === "last" ? "first" : "last" })}
        >
          nulls {term.nulls ?? "last"}
        </button>
      )}
      <button type="button" className="qt-chip-x" onClick={() => removeTerm(dataIndex)} disabled={disabled}>
        ✕
      </button>
    </span>
  );
}

function OrderRow<Row>({
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
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  // Local live-reorder drag state (sort terms are their own list, distinct from
  // the columns shared via api.columnDrag) — same dimmed-source + slide preview.
  const [drag, setDrag] = useState<{ source: string; overIndex: number } | null>(null);
  const [adding, setAdding] = useState(false);

  function setOrderBy(next: OrderByClause[]) {
    api.setSort(next);
  }
  function updateTerm(i: number, patch: Partial<OrderByClause>) {
    setOrderBy(orderBy.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function removeTerm(i: number) {
    setOrderBy(orderBy.filter((_, k) => k !== i));
  }
  function addTerm(f: FieldDef<Row>) {
    if (orderBy.some((o) => o.field === (f.sort?.field ?? f.name))) {
      setAdding(false);
      return;
    }
    setOrderBy([...orderBy, { field: f.sort?.field ?? f.name, dir: "desc" }]);
    setAdding(false);
  }

  // Order-by terms are identified by their (unique) field; the drag math mirrors
  // the column chips so the live preview equals the committed order.
  const termFields = orderBy.map((o) => o.field);
  const termByField = useMemo(() => new Map(orderBy.map((o) => [o.field, o])), [orderBy]);
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
        setDrag((d) => (d && d.overIndex !== next ? { source: d.source, overIndex: next } : d));
      }
    }
  }
  function commitSortDrop() {
    if (drag) setOrderBy(previewFields().map((f) => termByField.get(f)!));
    setDrag(null);
  }

  const rendered = previewFields();
  const sortable = fields.filter(isSortable);
  const isDefaultOrderBy =
    orderBy.length === api.defaults.orderBy.length &&
    orderBy.every((term, i) => {
      const next = api.defaults.orderBy[i];
      return (
        term.field === next?.field &&
        term.dir === next?.dir &&
        (term.nulls ?? "last") === (next?.nulls ?? "last")
      );
    });

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">order by</span>
      {orderBy.length === 0 && !adding && <span className="qt-qb-hint">(default)</span>}
      {rendered.map((f, pos) => {
        const term = termByField.get(f)!;
        return (
          <OrderTermChip
            // Stable key (term field) so React MOVES the dragged chip, not remounts it.
            key={f}
            api={api}
            field={byName.get(f)}
            term={term}
            dataIndex={orderBy.findIndex((o) => o.field === f)}
            priority={pos + 1}
            showPriority={orderBy.length > 1}
            isDragSource={drag?.source === f}
            onDragStart={() => setDrag({ source: f, overIndex: termFields.indexOf(f) })}
            onDragOver={(e) => handleSortOver(e, f)}
            onDrop={commitSortDrop}
            onDragEnd={() => setDrag(null)}
            disabled={disabled}
            updateTerm={updateTerm}
            removeTerm={removeTerm}
            classNames={classNames}
            label={byName.get(f)?.label ?? f}
          />
        );
      })}
      {adding ? (
        <FieldPicker fields={sortable} onPick={addTerm} onClose={() => setAdding(false)} />
      ) : (
        <button type="button" className="qt-add" onClick={() => setAdding(true)} disabled={disabled}>
          + add sort
        </button>
      )}
      {!isDefaultOrderBy && (
        <button type="button" className="qt-link-btn" onClick={() => api.setSort(api.defaults.orderBy)} disabled={disabled}>
          reset
        </button>
      )}
    </div>
  );
}

// ---- LIMIT / OFFSET -------------------------------------------------------

function WindowRow<Row>({
  api,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { query } = api;
  const [limitDraft, setLimitDraft] = useState(String(query.limit));
  const [offsetDraft, setOffsetDraft] = useState(String(query.offset));
  useEffect(() => setLimitDraft(String(query.limit)), [query.limit]);
  useEffect(() => setOffsetDraft(String(query.offset)), [query.offset]);
  const hasLimitDefault = query.limit === api.defaults.limit;
  const hasOffsetDefault = query.offset === api.defaults.offset;
  const hasWindowDefault = hasLimitDefault && hasOffsetDefault;

  function commitLimit() {
    api.setLimit(Math.max(1, Number(limitDraft) || query.limit));
  }
  function commitOffset() {
    api.setOffset(Math.max(0, Number(offsetDraft) || 0));
  }

  return (
    <div className="qt-qb-row qt-qb-pagination">
      <span className="qt-qb-kw">limit</span>
      <input
        className={cx("qt-qb-num", classNames?.input)}
        type="number"
        min={1}
        value={limitDraft}
        disabled={disabled}
        onChange={(e) => setLimitDraft(e.target.value)}
        onBlur={commitLimit}
        onKeyDown={(e) => e.key === "Enter" && commitLimit()}
      />
      <span className="qt-qb-kw">offset</span>
      <input
        className={cx("qt-qb-num", classNames?.input)}
        type="number"
        min={0}
        value={offsetDraft}
        disabled={disabled}
        onChange={(e) => setOffsetDraft(e.target.value)}
        onBlur={commitOffset}
        onKeyDown={(e) => e.key === "Enter" && commitOffset()}
      />
      {!hasWindowDefault && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => {
            api.setLimit(api.defaults.limit);
            api.setOffset(api.defaults.offset);
          }}
          disabled={disabled}
          title="Reset limit and offset"
        >
          reset
        </button>
      )}
    </div>
  );
}
