// WHERE row: QueryFilterRow (public), WhereRow with drag reorder/merge, TermChip
// (one predicate or OR group) and the MobileFilter sheet.

import type { QueryFilterApi } from "@pythia-software/query-table-react";
import { PresentedFilterValue } from "../FilterValuePresentation";
import { SetFilterEditor } from "../SetFilterEditor";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FieldDef,
  WhereTerm,
  SetFilterMetadata,
} from "@pythia-software/query-table-core";
import {
  NULLARY_OPS,
  MAX_WHERE_CLAUSES,
  filterValues as filterValuesFor,
  branchesOf,
  isWhereGroup,
  predicatesOf,
  isFilterable,
  opsForField,
  createSetFilter,
  readSetFilter,
  setFilterTarget,
  type SetFilterTarget,
} from "@pythia-software/query-table-core";
import type { QueryBuilderClassNames } from "../classNames";
import { PickerAnchor } from "../PickerAnchor";
import { FieldPicker } from "../FieldPicker";
import {
  ModalSurface,
  useMobileLayout,
} from "../AdaptiveOverlay";
import { Icon } from "../Icon";
import {
  cx,
  positiveOpsForField,
  whereTermAsText,
  predicateJoiners,
} from "./helpers";
import { choiceLabel, PredicateEditor } from "./PredicateEditor";
import { MobileClauseSummary } from "./MobileChipEditor";

// ---- WHERE ----------------------------------------------------------------

/** Reuse the same typed predicates for a host's source or result filter stage. */
export function QueryFilterRow<Row>({
  api,
  fields,
  label = "where",
}: {
  api: QueryFilterApi<Row>;
  fields: FieldDef<Row>[];
  label?: "where" | "having";
}) {
  const byName = useMemo(
    () => new Map(fields.map(field => [field.name, field])),
    [fields],
  );
  return (
    <WhereRow
      api={api}
      fields={fields}
      byName={byName}
      label={label}
      classNames={undefined}
      disabled={api.loading}
    />
  );
}

/** Where a drop lands relative to the hovered term chip: reorder before/after
 *  it, or drop onto its center to OR the two together. */
type DropMode = "before" | "after" | "merge";

interface WhereDrag {
  /** Index of the term being dragged. */
  from: number;
  /** Current hovered term + intent, or null when over dead space. */
  over: { index: number; mode: DropMode } | null;
}

/** Classify a drag position within a chip: outer thirds reorder, the center
 *  merges into an OR group. */
function dropModeFor(e: React.DragEvent): DropMode {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.3) return "before";
  if (x > rect.width * 0.7) return "after";
  return "merge";
}

export function WhereRow<Row>({
  api,
  byName,
  fields,
  classNames,
  disabled,
  label = "where",
}: {
  api: QueryFilterApi<Row>;
  byName: Map<string, FieldDef<Row>>;
  fields: FieldDef<Row>[];
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  label?: "where" | "having";
}) {
  const [adding, setAdding] = useState(false);
  const mobile = useMobileLayout();
  const editorId = useId();
  const nextSetId = useRef(0);
  const addFilterButton = useRef<HTMLButtonElement>(null);
  const [editingSet, setEditingSet] = useState<{
    field: FieldDef<Row>;
    returnFocus: HTMLElement;
    index: number;
    count: number;
    metadata: SetFilterMetadata;
    signature: string;
  } | null>(null);
  // Local drag state (WHERE terms are their own list, unlike the columns shared
  // via api.columnDrag). Order is committed only on drop, so the DOM order stays
  // put during the drag and index keys never remount the dragged node.
  const [drag, setDrag] = useState<WhereDrag | null>(null);
  const [editingFilter, setEditingFilter] = useState<number | null>(null);
  const where = api.query.where;
  const whereSignature = JSON.stringify(where);
  const setEditors = new Map<
    number,
    { field: FieldDef<Row>; metadata: SetFilterMetadata; count: number; target: SetFilterTarget }
  >();
  const hiddenSetTerms = new Set<number>();
  for (let index = 0; index < where.length; index++) {
    const set = readSetFilter(where, index);
    const field = set && byName.get(set.field);
    if (!set || !field || setFilterTarget(field) !== set.target)
      continue;
    setEditors.set(index, { field, metadata: set.metadata, count: set.count, target: set.target });
    for (let offset = 1; offset < set.count; offset++)
      hiddenSetTerms.add(index + offset);
    index += set.count - 1;
  }
  useEffect(() => {
    if (editingSet && editingSet.signature !== whereSignature)
      setEditingSet(null);
  }, [editingSet, whereSignature]);
  // Only make the top-level conjunction explicit ("AND" between terms) once an
  // OR group is present — otherwise a plain AND-list reads fine unadorned.
  const hasOr = where.some(isWhereGroup);

  function replaceSet(id: string, terms: WhereTerm[]) {
    api.setQuery((query) => {
      const index = query.where.findIndex((term) => term.setFilter?.id === id);
      const current = readSetFilter(query.where, index);
      if (!current) return query;
      return {
        ...query,
        offset: 0,
        where: [
          ...query.where.slice(0, index),
          ...terms,
          ...query.where.slice(index + current.count),
        ],
      };
    });
  }

  function addClause(f: FieldDef<Row>) {
    if (setFilterTarget(f)) {
      const anchor = addFilterButton.current;
      if (!anchor) return;
      setEditingSet({
        field: f,
        returnFocus: anchor,
        index: where.length,
        count: 0,
        metadata: {
          id: `${editorId}-${Date.now()}-${nextSetId.current++}`,
          mode: "any",
          values: [],
        },
        signature: whereSignature,
      });
      setAdding(false);
      return;
    }
    // Desktop uses inline controls; avoid leaving a pending sheet that opens
    // unexpectedly when the viewport later crosses the mobile breakpoint.
    if (mobile) setEditingFilter(where.length);
    const op = positiveOpsForField(f)[0] ?? opsForField(f)[0] ?? "=";
    api.addFilter({ field: f.name, op, value: "" });
    setAdding(false);
  }

  function handleOver(e: React.DragEvent, index: number) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const mode = dropModeFor(e);
    setDrag((d) =>
      d && (d.over?.index !== index || d.over?.mode !== mode)
        ? { from: d.from, over: { index, mode } }
        : d,
    );
  }

  function handleDrop() {
    if (!drag || !drag.over) {
      setDrag(null);
      return;
    }
    const { from } = drag;
    const { index: target, mode } = drag.over;
    if (mode === "merge") {
      if (target !== from) api.mergeFilters(from, target);
    } else {
      // Translate "before/after term `target`" into an index in the list with the
      // dragged term already removed (what reorderFilters expects).
      const tPrime = target < from ? target : target - 1;
      const insertAt = mode === "after" ? tPrime + 1 : tPrime;
      if (insertAt !== from) api.reorderFilters(from, insertAt);
    }
    setDrag(null);
  }

  const actions = (
    <>
      <PickerAnchor>
      <button
        ref={addFilterButton}
        type="button"
        className="qt-add"
        aria-haspopup="dialog"
        aria-label={label === "having" ? "Add HAVING filter" : "Add filter"}
        aria-expanded={adding}
        onClick={() => setAdding(!adding)}
        disabled={disabled}
      >
        <Icon name="add" />
        {label === "having" ? "having" : "add filter"}
      </button>
      {adding && (
        <FieldPicker
          anchor={addFilterButton.current ?? undefined}
          fields={fields.filter(isFilterable)}
          gateOnDistinct
          onPick={addClause}
          onClose={() => setAdding(false)}
        />
      )}
      </PickerAnchor>
      {where.length > 0 && (
        <button
          type="button"
          className="qt-link-btn"
          onClick={api.clearFilters}
          disabled={disabled}
          title="Reset filters"
        >
          reset
        </button>
      )}
    </>
  );

  return (
    <div className={cx("qt-qb-row qt-qb-row--filters", where.length === 0 && "qt-qb-row--unused")} data-clause={label}>
      <div className="qt-qb-section-header">
        <span className="qt-qb-kw" data-mobile-label={label === "having" ? "Having" : "Filters"}>
          {label}
        </span>
        {mobile && actions}
      </div>
      {where.map((term, index) => {
        if (hiddenSetTerms.has(index)) return null;
        const set = setEditors.get(index);
        return (
          <span className="qt-where-term-wrap" key={index}>
            {index > 0 && hasOr && <span className="qt-where-and">AND</span>}
            {set ? (
              <span className={cx("qt-chip", classNames?.chip)}>
                <button
                  type="button"
                  className="qt-link-btn"
                  disabled={disabled}
                  aria-label={`Edit ${set.field.label} ${set.target === "array" ? "tag" : "value"} filter`}
                  onClick={(event) =>
                    setEditingSet({
                      field: set.field,
                      returnFocus: event.currentTarget,
                      index,
                      count: set.count,
                      metadata: set.metadata,
                      signature: whereSignature,
                    })
                  }
                >
                  {set.field.label} {set.metadata.mode.toUpperCase()}
                </button>
                {set.metadata.values.map((value) => (
                  <span key={value} className="qt-set-tag">
                    <PresentedFilterValue
                      field={set.field.name}
                      value={value}
                      label={setFilterValueLabel(set.field, value)}
                    />
                    <button
                      type="button"
                      className="qt-chip-x"
                      aria-label={`Remove ${set.target === "array" ? "tag" : "value"} ${value}`}
                      disabled={disabled}
                      onClick={() =>
                        replaceSet(
                          set.metadata.id,
                          createSetFilter(
                            set.field.name,
                            set.metadata.mode,
                            set.metadata.values.filter((key) => key !== value),
                            set.metadata.id,
                            set.target,
                          ),
                        )
                      }
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="qt-chip-x"
                  aria-label={`Remove ${set.field.label} ${set.target === "array" ? "tag" : "value"} filter`}
                  disabled={disabled}
                  onClick={() => replaceSet(set.metadata.id, [])}
                >
                  ✕
                </button>
              </span>
            ) : (
              <TermChip
                api={api}
                term={term}
                index={index}
                byName={byName}
                classNames={classNames}
                disabled={disabled}
                isDragSource={drag?.from === index}
                dropHint={drag?.over?.index === index ? drag.over.mode : null}
                onDragStart={() => setDrag({ from: index, over: null })}
                onDragOver={(e) => handleOver(e, index)}
                onDrop={handleDrop}
                onDragEnd={() => setDrag(null)}
                editorOpen={editingFilter === index}
                onEditorChange={(open) => setEditingFilter(open ? index : null)}
              />
            )}
          </span>
        );
      })}
      {editingSet && (
        <SetFilterEditor
          api={api}
          field={editingSet.field}
          returnFocus={editingSet.returnFocus}
          classNames={classNames}
          mode={editingSet.metadata.mode}
          values={editingSet.metadata.values}
          maxPredicates={
            MAX_WHERE_CLAUSES -
            where.reduce(
              (count, term, index) =>
                index >= editingSet.index &&
                index < editingSet.index + editingSet.count
                  ? count
                  : count + predicatesOf(term).length,
              0,
            )
          }
          disabled={disabled}
          onClose={() => setEditingSet(null)}
          onApply={(mode, values) => {
            const terms = createSetFilter(
              editingSet.field.name,
              mode,
              values,
              editingSet.metadata.id,
              setFilterTarget(editingSet.field) ?? "array",
            );
            if (editingSet.count > 0) replaceSet(editingSet.metadata.id, terms);
            else
              api.setQuery((query) => ({
                ...query,
                offset: 0,
                where: [...query.where, ...terms],
              }));
            setEditingSet(null);
          }}
        />
      )}
      {!mobile && actions}
    </div>
  );
}

function setFilterValueLabel(field: FieldDef, value: string): string {
  const strategy = filterValuesFor(field);
  if (strategy.source !== "static") return value;
  const option = strategy.options.find(
    (option) => (typeof option === "string" ? option : option.value) === value,
  );
  return typeof option === "string" ? option : (option?.label ?? value);
}

/** One top-level WHERE term: a single predicate, or a bordered OR group holding
 *  several (an AND branch of an OR of conjunctions has its own dashed border). Draggable by its grip; a drop onto another chip's center ORs them,
 *  onto its edges reorders. */
function TermChip<Row>({
  api,
  term,
  index,
  byName,
  classNames,
  disabled,
  isDragSource,
  dropHint,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  editorOpen,
  onEditorChange,
}: {
  api: QueryFilterApi<Row>;
  term: WhereTerm;
  index: number;
  byName: Map<string, FieldDef<Row>>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  isDragSource: boolean;
  dropHint: DropMode | null;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  editorOpen: boolean;
  onEditorChange: (open: boolean) => void;
}) {
  const mobile = useMobileLayout();
  const group = isWhereGroup(term);

  if (mobile)
    return (
      <MobileFilter
        api={api}
        term={term}
        index={index}
        byName={byName}
        classNames={classNames}
        disabled={disabled}
        open={editorOpen}
        onOpenChange={onEditorChange}
      />
    );

  const grip = (
    <span
      className="qt-chip-grip"
      aria-hidden
      draggable={!disabled}
      onDragStart={(e) => {
        onDragStart();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      }}
      onDragEnd={onDragEnd}
      title="drag to reorder, or drop onto another filter to make an OR"
    >
      <Icon name="grip" />
    </span>
  );

  return (
    <span
      className={cx(
        "qt-chip",
        "qt-chip--where",
        group && "qt-chip--or",
        isDragSource && "qt-chip--dragging",
        dropHint ? `qt-chip--drop-${dropHint}` : undefined,
        classNames?.chip,
      )}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {grip}
      {group ? (
        <span className="qt-or-group">
          {(() => {
            // Literals are addressed in predicatesOf order across branches.
            let predIndex = 0;
            return branchesOf(term).map((branch, branchIndex) => (
              <span className="qt-or-member" key={branchIndex}>
                {branchIndex > 0 && (
                  <span className="qt-chip-and qt-chip-or">OR</span>
                )}
                <span className={cx("qt-or-member", branch.length > 1 && "qt-and-branch")}>
                  {branch.map((clause, i) => {
                    const at = predIndex++;
                    return (
                      <Fragment key={i}>
                        {i > 0 && (
                          <span className="qt-chip-and qt-chip-or">AND</span>
                        )}
                        <PredicateEditor
                          api={api}
                          field={byName.get(clause.field)}
                          clause={clause}
                          classNames={classNames}
                          disabled={disabled}
                          onChange={(next) => api.updatePredicate(index, at, next)}
                          onRemove={() => api.removePredicate(index, at)}
                        />
                      </Fragment>
                    );
                  })}
                </span>
              </span>
            ));
          })()}
        </span>
      ) : (
        <PredicateEditor
          api={api}
          field={byName.get(term.field)}
          clause={term}
          classNames={classNames}
          disabled={disabled}
          onChange={(next) => api.updatePredicate(index, 0, next)}
          onRemove={() => api.removeFilter(index)}
        />
      )}
    </span>
  );
}

function MobileFilter<Row>({
  api,
  term,
  index,
  byName,
  classNames,
  disabled,
  open,
  onOpenChange,
}: {
  api: QueryFilterApi<Row>;
  term: WhereTerm;
  index: number;
  byName: Map<string, FieldDef<Row>>;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const predicates = predicatesOf(term);
  const joiners = predicateJoiners(term);
  return (
    <>
      <MobileClauseSummary
        editLabel={`Edit filter: ${whereTermAsText(term, byName)}`}
        disabled={disabled}
        className={classNames?.chip}
        filter
        onEdit={() => onOpenChange(true)}
      >
        <span>
          {predicates.map((clause, position) => {
            const strategy = byName.get(clause.field)?.filter?.values;
            const option =
              strategy?.source === "static"
                ? strategy.options.find(
                    (choice) =>
                      typeof choice !== "string" &&
                      choice.value === clause.value,
                  )
                : undefined;
            const label =
              typeof option === "object"
                ? option.label
                : clause.value === ""
                  ? '""'
                  : clause.value;
            const emptyStringCondition =
              clause.value === "0" &&
              (clause.op === "length_eq" || clause.op === "length_gt");
            return (
              <span key={position} className="qt-mobile-filter-summary">
                {joiners[position] && <small>{joiners[position]}</small>}
                <strong>
                  {byName.get(clause.field)?.label ?? clause.field}
                </strong>
                <span>
                  {choiceLabel(
                    clause.op,
                    Boolean(clause.negated),
                    clause.value,
                  )}{" "}
                  {!NULLARY_OPS.has(clause.op) && !emptyStringCondition && (
                    <PresentedFilterValue
                      field={clause.field}
                      value={clause.value}
                      label={label}
                    />
                  )}
                </span>
              </span>
            );
          })}
        </span>
      </MobileClauseSummary>
      {open && (
        <ModalSurface
          title={
            predicates.length > 1
              ? "Edit filter group"
              : `Filter by ${byName.get(predicates[0]!.field)?.label ?? predicates[0]!.field}`
          }
          onClose={() => onOpenChange(false)}
        >
          <div className="qt-overlay-body qt-filter-editor">
            {predicates.map((clause, position) => (
              <Fragment key={position}>
                {joiners[position] && <p className="qt-muted">{joiners[position]}</p>}
                <PredicateEditor
                  api={api}
                  clause={clause}
                  field={byName.get(clause.field)}
                  showField={predicates.length > 1}
                  classNames={classNames}
                  disabled={disabled}
                  onChange={(next) =>
                    api.updatePredicate(index, position, next)
                  }
                  onRemove={() => {
                    if (predicates.length === 1) onOpenChange(false);
                    api.removePredicate(index, position);
                  }}
                />
              </Fragment>
            ))}
            {predicates.length > 1 && (
              <button
                type="button"
                className="qt-mobile-form-remove"
                aria-label="Remove filter group"
                disabled={disabled}
                onClick={() => {
                  onOpenChange(false);
                  api.removeFilter(index);
                }}
              >
                Remove filter group
              </button>
            )}
            {api.query.where.length > 1 && (
              <label className="qt-filter-combine">
                Match either filter (OR)
                <select
                  className="qt-input"
                  value=""
                  disabled={disabled}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    onOpenChange(false);
                    api.mergeFilters(index, Number(event.target.value));
                  }}
                >
                  <option value="">Combine with another filter…</option>
                  {api.query.where.map(
                    (candidate, position) =>
                      position !== index && (
                        <option key={position} value={position}>
                          {whereTermAsText(candidate, byName)}
                        </option>
                      ),
                  )}
                </select>
              </label>
            )}
          </div>
        </ModalSurface>
      )}
    </>
  );
}
