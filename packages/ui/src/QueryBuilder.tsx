// QueryBuilder — the chip toolbar: WHERE filters, SELECT columns, ORDER BY
// (multi-sort, reorderable), and LIMIT/OFFSET paging. Type-aware filter inputs
// (enum/static <select>, value autocomplete via Transport.fetchDistinctValues).
// Hosts the Save / saved-queries entry point.
//
// A union of both projects' builders: xplo-perf's chip layout + datalist
// autocomplete and xlsx-collect's draggable column chips, grouped picker, and
// per-clause operator dropdowns. Multi-sort (orderBy is an array) is new to both.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
        {collapsed ? null : (
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
                <strong className="qt-qb-saved-name">{activeSavedQuery.name}</strong>
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
        <button type="button" className={cx("qt-btn", classNames?.button)} onClick={save} disabled={running}>
          ★ save
        </button>
        <button type="button" className={cx("qt-btn", classNames?.button)} onClick={() => setShowSaved(true)}>
          ≡ saved{api.saved.items.length > 0 ? ` (${api.saved.items.length})` : ""}
        </button>
        <button type="button" className={cx("qt-btn", classNames?.button)} onClick={api.resetAll} disabled={running}>
          Reset All
        </button>
          </>
        )}
      </div>

      <div id={bodyId} hidden={collapsed}>
        <SelectRow api={api} fields={fields} classNames={classNames} disabled={running} />
        <WhereRow api={api} byName={byName} fields={fields} classNames={classNames} disabled={running} />
        <OrderRow api={api} fields={fields} classNames={classNames} disabled={running} />
        <WindowRow api={api} total={total} classNames={classNames} disabled={running} />
      </div>

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
  const { select } = api;
  const [adding, setAdding] = useState(false);
  const dragField = useRef<string | null>(null);
  const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null);
  const fieldLabelByName = useMemo(() => new Map(select.fields.map((f) => [f.name, f.label])), [select.fields]);

  function reorder(from: string, to: string) {
    if (from === to) return;
    const toIdx = select.visible.findIndex((c) => c.field === to);
    if (toIdx < 0) return;
    select.move(from, toIdx);
  }

  const fieldNames = select.visible.map((c) => c.field);
  const dragSource = dragField.current;
  const slotIndex = dragSlotIndex;

  type HeaderItem = { kind: "slot" } | { kind: "field"; name: string };
  const rendered = useMemo<HeaderItem[]>(() => {
    const asFieldItems = (names: string[]): HeaderItem[] => names.map((name) => ({ kind: "field", name }));
    if (!dragSource) return asFieldItems(fieldNames);

    const withoutDragged = fieldNames.filter((name) => name !== dragSource);
    const withoutDraggedFieldItems = asFieldItems(withoutDragged);
    const slotItem: HeaderItem = { kind: "slot" };
    const slot =
      slotIndex == null
        ? withoutDraggedFieldItems
        : [...withoutDraggedFieldItems.slice(0, slotIndex), slotItem, ...withoutDraggedFieldItems.slice(slotIndex)];
    return slot;
  }, [fieldNames, dragSource, slotIndex]);

  return (
    <div className="qt-qb-row">
      <span className="qt-qb-kw">select</span>
      {rendered.map((item, idx) => {
        if (item.kind === "slot") {
          return (
            <span key="drag-slot" className="qt-chip qt-chip-drop-slot">
              {"\u00a0"}
            </span>
          );
        }

        const label = fieldLabelByName.get(item.name) ?? item.name;

        return (
        <span
          key={`${item.name}-${idx}`}
          className={cx("qt-chip", "qt-chip--col", classNames?.columnChip ?? classNames?.chip)}
          draggable={!disabled}
          onDragStart={(e) => {
            dragField.current = item.name;
            const next = fieldNames.indexOf(item.name);
            setDragSlotIndex(next >= 0 ? next : null);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", item.name);
          }}
          onDragOver={(e) => {
            if (dragField.current && dragField.current !== item.name) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const withoutDragged = fieldNames.filter((name) => name !== dragField.current);
              const next = withoutDragged.indexOf(item.name);
              if (next >= 0) setDragSlotIndex(next);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const from = dragField.current || e.dataTransfer.getData("text/plain");
            if (from) reorder(from, item.name);
            dragField.current = null;
            setDragSlotIndex(null);
          }}
          onDragEnd={() => {
            dragField.current = null;
            setDragSlotIndex(null);
          }}
          title="drag to reorder"
        >
          <span aria-hidden className="qt-chip-grip">
            ⋮⋮
          </span>
          {label}
          <button type="button" className="qt-chip-x" onClick={() => select.hide(item.name)} disabled={disabled}>
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
      {api.query.where.length > 0 && (
        <button type="button" className="qt-link-btn" onClick={api.clearFilters} disabled={disabled} title="Reset filters">
          reset
        </button>
      )}
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
    return (
      <select
        className={cx("qt-chip-val", classNames?.select)}
        value={value}
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
    return (
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder="value"
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
  index,
  dragIdx,
  onMoveStart,
  onDrop,
  onMoveEnd,
  disabled,
  updateTerm,
  removeTerm,
  classNames,
  label,
  showPriority,
}: {
  api: QueryTableApi<Row>;
  field: FieldDef<Row> | undefined;
  term: OrderByClause;
  index: number;
  dragIdx: React.RefObject<number | null>;
  onMoveStart: (index: number) => void;
  onDrop: (index: number) => void;
  onMoveEnd: () => void;
  disabled: boolean | undefined;
  updateTerm: (i: number, patch: Partial<OrderByClause>) => void;
  removeTerm: (i: number) => void;
  classNames: QueryBuilderClassNames | undefined;
  label: string;
  showPriority: boolean;
}) {
  const fieldHasNull = useFieldHasNull(api, field?.name);

  return (
    <span
      className={cx("qt-chip", "qt-chip--col", "qt-chip--sort", classNames?.chip)}
      draggable={!disabled}
      onDragStart={() => {
        onMoveStart(index);
      }}
      onDragOver={(e) => {
        if (dragIdx.current != null && dragIdx.current !== index) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      onDragEnd={() => {
        onMoveEnd();
      }}
      title="drag to reorder sort priority"
    >
      <span aria-hidden className="qt-chip-grip">
        ⋮⋮
      </span>
      {showPriority && <span className="qt-chip-priority">{index + 1}</span>}
      <span className="qt-chip-field">{label}</span>
      <button
        type="button"
        className="qt-chip-op-btn"
        disabled={disabled}
        onClick={() => updateTerm(index, { dir: term.dir === "asc" ? "desc" : "asc" })}
      >
        {term.dir === "asc" ? "↑ asc" : "↓ desc"}
      </button>
      {fieldHasNull !== false && (
        <button
          type="button"
          className="qt-chip-op-btn"
          disabled={disabled}
          title="where NULL values sort"
          onClick={() => updateTerm(index, { nulls: (term.nulls ?? "last") === "last" ? "first" : "last" })}
        >
          nulls {term.nulls ?? "last"}
        </button>
      )}
      <button type="button" className="qt-chip-x" onClick={() => removeTerm(index)} disabled={disabled}>
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
  const dragIdx = useRef<number | null>(null);
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
  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...orderBy];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setOrderBy(next);
  }

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
      {orderBy.map((o, i) => (
        <OrderTermChip
          key={`${o.field}-${i}`}
          api={api}
          field={byName.get(o.field)}
          term={o}
          index={i}
          dragIdx={dragIdx}
          onMoveStart={(from) => {
            dragIdx.current = from;
          }}
          onDrop={(to) => {
            if (dragIdx.current != null) reorder(dragIdx.current, to);
            dragIdx.current = null;
          }}
          onMoveEnd={() => {
            dragIdx.current = null;
          }}
          disabled={disabled}
          updateTerm={updateTerm}
          removeTerm={removeTerm}
          classNames={classNames}
          label={byName.get(o.field)?.label ?? o.field}
          showPriority={orderBy.length > 1}
        />
      ))}
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
  total,
  classNames,
  disabled,
}: {
  api: QueryTableApi<Row>;
  total: number | null;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { query } = api;
  const start = query.offset;
  const end = total != null ? Math.min(start + query.limit, total) : start + query.limit;
  const canPrev = start > 0;
  const canNext = total != null ? end < total : api.rows.length >= query.limit;

  const [limitDraft, setLimitDraft] = useState(String(query.limit));
  const [offsetDraft, setOffsetDraft] = useState(String(query.offset));
  useEffect(() => setLimitDraft(String(query.limit)), [query.limit]);
  useEffect(() => setOffsetDraft(String(query.offset)), [query.offset]);
  const hasLimitDefault = query.limit === api.defaults.limit;
  const hasOffsetDefault = query.offset === api.defaults.offset;

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
      {!hasLimitDefault && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => api.setLimit(api.defaults.limit)}
          disabled={disabled}
          title="Reset to default limit"
        >
          reset
        </button>
      )}
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
      {!hasOffsetDefault && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={() => api.setOffset(api.defaults.offset)}
          disabled={disabled}
          title="Reset to default offset"
        >
          reset
        </button>
      )}
      <button type="button" className={cx("qt-btn", classNames?.button)} disabled={disabled || !canPrev} onClick={api.prevPage}>
        ← prev
      </button>
      <span className="qt-qb-hint">
        {total === 0 || total == null
          ? `${api.rows.length} rows`
          : `${start + 1}–${end} of ${total}`}
      </span>
      <button type="button" className={cx("qt-btn", classNames?.button)} disabled={disabled || !canNext} onClick={api.nextPage}>
        next →
      </button>
    </div>
  );
}
