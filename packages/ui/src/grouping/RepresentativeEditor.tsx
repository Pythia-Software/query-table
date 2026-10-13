import { useState } from "react";
import { FieldPicker } from "../FieldPicker";
import { Icon } from "../Icon";
import { PickerAnchor, PickerSurface } from "../PickerAnchor";
import { ReorderList } from "../ReorderList";
import {
  MAX_REPRESENTATIVE_SORTS,
  type GroupingModel,
  type GroupedRow as Row,
  type RepresentativeOrder,
  type RepresentativeRow,
} from "@pythia-software/query-table-core";
import { ColumnRoleBadge } from "./ColumnRole";

const representativeHelp =
  "Pick one row from each group. The first row in this ordering supplies every ROW column in the result.";

/** One shared ordering rule, configured from GROUP BY. */
export function RepresentativeEditor({
  model,
  initial,
  onApply,
  onClose,
  onBack,
  onRemove,
  columnCount = 0,
  impact = "",
}: {
  model: GroupingModel<Row>;
  initial: RepresentativeRow | null;
  onApply: (rule: RepresentativeRow) => void;
  onClose: () => void;
  onBack?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  columnCount?: number;
  impact?: string;
}) {
  const { inputSchema, sourceField, representativeFields } = model;
  const [order, setOrder] = useState(
    () => initial?.orderBy.map((term) => ({ ...term })) ?? [],
  );
  const [picking, setPicking] = useState<string | null>(initial ? null : "");
  const [search, setSearch] = useState("");
  const dirty =
    JSON.stringify(order) !== JSON.stringify(initial?.orderBy ?? []);
  const label = (field: string) => sourceField(field)?.label ?? field;
  function patch(field: string, next: Partial<RepresentativeOrder>) {
    setOrder((terms) =>
      terms.map((term) => (term.field === field ? { ...term, ...next } : term)),
    );
  }
  if (picking !== null)
    return (
      <FieldPicker
        title="Representative row · order by"
        description={`${representativeHelp} For the latest row, choose a date field and descending order.`}
        fields={representativeFields}
        excluded={order
          .filter((term) => term.field !== picking)
          .map((term) => term.field)}
        searchValue={search}
        onSearchChange={setSearch}
        onBack={() => {
          if (!order.length) (onBack ?? onClose)();
          else setPicking(null);
        }}
        onPick={(field) => {
          if (picking) patch(picking, { field: field.name });
          else
            setOrder((terms) => [
              ...terms,
              { field: field.name, dir: "desc", nulls: "last" },
            ]);
          setPicking(null);
          setSearch("");
        }}
        onClose={onClose}
      />
    );
  return (
    <PickerSurface
      title="Representative row"
      onClose={onClose}
      mobileChrome={false}
    >
      <div className="qt-representative-editor">
        <div className="qt-picker-heading">
          {onBack && (
            <button
              type="button"
              className="qt-icon-btn qt-representative-back"
              aria-label="Back to column choices"
              onClick={onBack}
            >
              <Icon name="arrowLeft" />
            </button>
          )}
          <strong>Representative row</strong>
          <button
            type="button"
            className="qt-icon-btn"
            aria-label="Close representative editor"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="qt-representative-body">
          <p className="qt-picker-description">{representativeHelp}</p>
          <span className="qt-qb-kw">order by</span>
          <ReorderList
            className="qt-representative-order"
            showHint={false}
            itemClassName={() => "qt-chip qt-chip--sort"}
            items={order.map((term) => ({
              id: term.field,
              label: label(term.field),
            }))}
            onMove={(field, index) =>
              setOrder((terms) => {
                const next = terms.filter((term) => term.field !== field);
                const term = terms.find((term) => term.field === field);
                if (term) next.splice(index, 0, term);
                return next;
              })
            }
            renderItem={(item, index) => {
              const term = order[index]!;
              return (
                <>
                  {order.length > 1 && (
                    <span className="qt-chip-priority">{index + 1}</span>
                  )}
                  <button
                    type="button"
                    className="qt-chip-field qt-representative-field"
                    aria-label={`Change representative field ${item.label}`}
                    title={`Change ${item.label}`}
                    aria-haspopup="dialog"
                    onClick={() => setPicking(item.id)}
                  >
                    <span>{item.label}</span>
                    <Icon name="chevronDown" />
                  </button>
                  <button
                    type="button"
                    className="qt-chip-op-btn"
                    aria-label={`Representative direction for ${item.label}`}
                    title={`${term.dir === "asc" ? "Ascending" : "Descending"}; click to reverse`}
                    onClick={() =>
                      patch(item.id, {
                        dir: term.dir === "asc" ? "desc" : "asc",
                      })
                    }
                  >
                    <Icon name={term.dir === "asc" ? "arrowUp" : "arrowDown"} />
                    {term.dir}
                  </button>
                  <button
                    type="button"
                    className="qt-chip-op-btn"
                    aria-label={`Representative empty values for ${item.label}`}
                    title={`Empty values ${term.nulls}; click to change`}
                    onClick={() =>
                      patch(item.id, {
                        nulls: term.nulls === "last" ? "first" : "last",
                      })
                    }
                  >
                    nulls {term.nulls}
                  </button>
                  <button
                    type="button"
                    className="qt-chip-x"
                    aria-label={`Remove representative sort ${item.label}`}
                    onClick={() =>
                      setOrder((terms) =>
                        terms.filter((t) => t.field !== item.id),
                      )
                    }
                  >
                    <Icon name="close" />
                  </button>
                </>
              );
            }}
          />
          <button
            type="button"
            className="qt-add"
            disabled={order.length >= MAX_REPRESENTATIVE_SORTS}
            onClick={() => setPicking("")}
          >
            <Icon name="add" />
            add sort
          </button>
          {!order.some((term) => term.field === inputSchema.idField) && (
            <div
              className="qt-representative-ties"
              title={`When ordering values tie, ${label(inputSchema.idField)} descending breaks the tie.`}
            >
              <span>Tie-break</span>
              <span className="qt-chip">
                <span className="qt-chip-field">
                  {label(inputSchema.idField)}
                </span>
                <Icon name="arrowDown" /> desc
              </span>
            </div>
          )}
          {dirty && impact && (
            <p className="qt-column-impact">
              Applying clears {impact}. Undo restores them.
            </p>
          )}
        </div>
        <div className="qt-representative-footer">
          {onRemove && (
            <button
              type="button"
              className="qt-link-btn qt-representative-remove"
              onClick={onRemove}
            >
              Remove row
              {columnCount
                ? ` & ${columnCount} column${columnCount === 1 ? "" : "s"}`
                : ""}
            </button>
          )}
          <span className="qt-representative-actions">
            <button type="button" className="qt-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="qt-btn qt-btn--primary"
              disabled={!order.length}
              onClick={() => onApply({ orderBy: order })}
            >
              Apply ordering
            </button>
          </span>
        </div>
      </div>
    </PickerSurface>
  );
}

export function RepresentativeControl({
  model,
  value,
  onChange,
  columnCount = 0,
  impact = "",
  allowRemove = false,
}: {
  model: GroupingModel<Row>;
  value: RepresentativeRow | null;
  onChange: (rule: RepresentativeRow | null) => void;
  columnCount?: number;
  impact?: string;
  allowRemove?: boolean;
}) {
  const { representativeLabel } = model;
  const [open, setOpen] = useState(false);
  return (
    <PickerAnchor>
      <button
        type="button"
        className={value ? "qt-btn qt-representative-trigger" : "qt-add"}
        data-column-role={value ? "row" : undefined}
        aria-label={
          value ? "Edit representative row" : "Add representative row"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          value
            ? `Representative row: ${representativeLabel(value)}`
            : "Choose one row per group to supply individual field values"
        }
        onClick={() => setOpen(!open)}
      >
        {value ? (
          <>
            <ColumnRoleBadge
              role={{ kind: "row", badge: "ROW", title: "Representative row" }}
            />
            <span className="qt-chip-field">{representativeLabel(value)}</span>
            <Icon name="chevronDown" />
          </>
        ) : (
          <>
            <Icon name="add" />
            representative row
          </>
        )}
      </button>
      {open && (
        <RepresentativeEditor
          model={model}
          initial={value}
          onApply={(rule) => {
            onChange(rule);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          onRemove={
            value && allowRemove
              ? () => {
                  onChange(null);
                  setOpen(false);
                }
              : undefined
          }
          columnCount={columnCount}
          impact={impact}
        />
      )}
    </PickerAnchor>
  );
}
