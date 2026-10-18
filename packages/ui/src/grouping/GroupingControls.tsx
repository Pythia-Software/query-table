import { useState } from "react";
import {
  MAX_GROUP_BY_FIELDS,
  OP_LABEL,
  type GroupedRow,
  type SummaryOp,
} from "@pythia-software/query-table-core";
import type {
  GroupingApi,
  QueryTableApi,
} from "@pythia-software/query-table-react";
import { Icon } from "../Icon";
import { PickerAnchor } from "../PickerAnchor";
import { FieldPicker } from "../FieldPicker";
import { QueryFilterRow, type SelectPresentation } from "../QueryBuilder";
import { RepresentativeControl } from "./RepresentativeEditor";
import { columnRole, ColumnRoleBadge } from "./ColumnRole";
import { availableSummaryOps, ColumnPicker } from "./ColumnPicker";
import { GroupedColumnsEditor } from "./GroupedColumnsEditor";

/** Intents validate synchronously; keep failures in the query's notice area
 * and let the initiating picker finish closing normally. */
function runGroupingIntent(controller: GroupingApi<GroupedRow>, intent: () => void) {
  try {
    intent();
  } catch (error) {
    controller.setNotice(error instanceof Error ? error.message : String(error));
  }
}

function GroupingClauses({
  controller,
}: {
  controller: GroupingApi<GroupedRow>;
}) {
  const [adding, setAdding] = useState(false);
  const { view, model } = controller;
  const canAddKey = controller.supported && view.keys.length < MAX_GROUP_BY_FIELDS &&
    model.groupableFields.some(field => !view.keys.includes(field.name));
  function changeKeys(keys: string[]) {
    runGroupingIntent(controller, () => controller.changeKeys(keys));
  }
  const picker = adding && canAddKey && (
    <FieldPicker
      title="Group rows by"
      fields={model.groupableFields.filter(
        (field) => !view.keys.includes(field.name),
      )}
      onPick={(field) => {
        changeKeys([...view.keys, field.name]);
        setAdding(false);
      }}
      onClose={() => setAdding(false)}
    />
  );
  if (view.mode === "rows")
    return canAddKey ? (
      <div className="qt-qb-row qt-group-entry qt-qb-row--unused">
        <PickerAnchor>
          <button
            type="button"
            className="qt-add"
            aria-label="Add group by"
            aria-haspopup="dialog"
            aria-expanded={adding}
            onClick={() => setAdding(true)}
          >
            <Icon name="add" />
            add group by
          </button>
          {picker}
        </PickerAnchor>
      </div>
    ) : null;
  return (
    <section
      className={`qt-group-clauses${view.result.where.length ? " qt-group-clauses--filtered" : ""}`}
      aria-label="Grouping and HAVING"
    >
      <div className="qt-qb-row">
        <div className="qt-qb-section-header">
          <span className="qt-qb-kw" data-mobile-label="Group by">
            group by
          </span>
        </div>
        {view.keys.map((key) => (
          <span className="qt-chip" key={key}>
            <span
              className="qt-chip-field qt-column-label"
              data-column-role="key"
            >
              {model.sourceField(key)?.label ?? key}
            </span>
            <button
              type="button"
              className="qt-chip-x"
              aria-label={`Remove ${model.sourceField(key)?.label ?? key} grouping`}
              onClick={() =>
                changeKeys(
                  view.keys.filter((field) => field !== key),
                )
              }
            >
              <Icon name="close" />
            </button>
          </span>
        ))}
        <PickerAnchor>
          {canAddKey && (
              <button
                type="button"
                className="qt-add"
                aria-label="Group by additional key"
                aria-haspopup="dialog"
                aria-expanded={adding}
                onClick={() => setAdding(true)}
              >
                <Icon name="add" />
                group by additional key
              </button>
            )}
          {picker}
        </PickerAnchor>
        <RepresentativeControl
          model={model}
          value={view.representative}
          onChange={rule => runGroupingIntent(controller, () => controller.changeRepresentative(rule))}
          columnCount={
            view.summaries.filter((column) => column.op === "row").length
          }
          impact={controller.representativeImpact()}
          allowRemove
        />
      </div>
      <QueryFilterRow
        api={controller.grouped}
        fields={controller.schema.fields}
        label="having"
      />
    </section>
  );
}

/** Default presentation for the headless grouping API. The ordinary row editor
 * stays intact; the aggregate workbench appears only after GROUP BY. */
export function useGroupingPresentation<Row>(
  api: QueryTableApi<Row>,
  enabled = true,
) {
  const [formulaField, setFormulaField] = useState<string | null>(null);
  const controller = enabled
    ? (api.grouping as unknown as GroupingApi<GroupedRow> | undefined)
    : undefined;
  if (!controller) return {};
  const { view, model } = controller;
  const grouped = view.mode === "groups";
  const selectPresentation: SelectPresentation | undefined = grouped
    ? {
        renderChip: (field, label) => {
          const role = columnRole(field, view, model);
          const column = view.summaries.find((c) => c.id === field);
          if (!column || column.op === "formula" || column.op === "row" || column.op === "link")
            return (
              <span className="qt-column-label" data-column-role={role?.kind}>
                <ColumnRoleBadge role={role} />
                <span className="qt-chip-field" title={label}>
                  {column?.op === "row" && column.field
                    ? (model.sourceField(column.field)?.label ?? label)
                    : label}
                </span>
              </span>
            );
          return (
            <span className="qt-column-label" data-column-role={role?.kind}>
              <span className="qt-group-op-control">
                <span aria-hidden="true">{OP_LABEL[column.op]}</span>
                <Icon name="chevronDown" size={12} />
                <select
                  className="qt-group-op"
                  aria-label={`Aggregation for ${label}`}
                  title={role?.title}
                  value={column.op}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    runGroupingIntent(controller, () =>
                      controller.changeSummary(
                        column.id,
                        event.target.value as SummaryOp,
                      ),
                    )
                  }
                >
                  {availableSummaryOps(
                    model,
                    column.field,
                    view.summaries,
                    api.select.visible.map((c) => c.field),
                    view.representative,
                    column.id,
                  ).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op]}
                    </option>
                  ))}
                </select>
              </span>
              <span className="qt-chip-field">
                {column.field ? model.sourceField(column.field)?.label : "Rows"}
              </span>
            </span>
          );
        },
        renderPicker: (onClose) => (
          <ColumnPicker
            model={model}
            keys={view.keys}
            summaries={view.summaries}
            representative={view.representative}
            fields={controller.schema.fields}
            selected={api.select.visible.map((c) => c.field)}
            onField={api.select.show}
            onSummary={(op, field) => runGroupingIntent(controller, () => controller.addSummary(op, field))}
            onCustom={setFormulaField}
            onClose={onClose}
          />
        ),
        renderEditor: (onClose) => (
          <GroupedColumnsEditor controller={controller} onClose={onClose} />
        ),
      }
    : undefined;
  return {
    clauses: <GroupingClauses controller={controller} />,
    whereRow: grouped ? (
      <QueryFilterRow
        api={controller.source}
        fields={model.inputSchema.fields}
      />
    ) : undefined,
    selectPresentation,
    summary: grouped ? (
      <span>
        WHERE{" "}
        {view.input.where.length
          ? `${view.input.where.length} source filter(s)`
          : "all rows"}{" "}
        · GROUP BY{" "}
        <strong>
          {view.keys
            .map((key) => model.sourceField(key)?.label ?? key)
            .join(" + ")}
        </strong>{" "}
        · HAVING{" "}
        {view.result.where.length
          ? `${view.result.where.length} group filter(s)`
          : "all groups"}
      </span>
    ) : undefined,
    overlays: (
      <>
        {formulaField !== null && grouped && (
          <GroupedColumnsEditor
            controller={controller}
            initialFormulaField={formulaField}
            onClose={() => setFormulaField(null)}
          />
        )}
        {controller.notice && (
          <div className="qt-group-notice" role="status">
            <span>{controller.notice}</span>
            <button
              type="button"
              className="qt-icon-btn"
              aria-label="Dismiss notice"
              onClick={() => controller.setNotice("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </>
    ),
  };
}
