import { useState } from "react";
import { isComputedField, isSelectable, type FieldDef } from "@pythia-software/query-table-core";
import { FieldPicker } from "../FieldPicker";
import { Icon } from "../Icon";
import {
  OP_LABEL,
  type GroupingModel,
  type GroupedRow as Row,
  type RepresentativeRow,
  type SummaryColumn,
  type SummaryOp,
} from "@pythia-software/query-table-core";
import { columnRole, ColumnRoleBadge, type ColumnRole } from "./ColumnRole";

export const SUMMARY_NAMES: Record<SummaryOp, string> = {
  count: "Count values",
  count_distinct: "Count unique values",
  sum: "Total",
  avg: "Average",
  min: "Smallest",
  max: "Largest",
  row: "Representative row",
  formula: "Custom aggregate…",
  link: "Link",
};
export const SUMMARY_DETAILS: Record<SummaryOp, string> = {
  count: "Number of rows with a value",
  count_distinct: "Number of different values",
  sum: "Add the values together",
  avg: "Average of the available values",
  min: "Lowest value in the group",
  max: "Highest value in the group",
  row: "Use the shared GROUP BY ordering",
  formula: "Write an aggregate formula",
  link: "Open the rows or a page for this group",
};

/** A hidden summary can be restored; a selected one cannot be added twice.
 * Keep the current operation available when editing an existing column. */
export function availableSummaryOps(
  model: GroupingModel<Row>,
  field: string | undefined,
  summaries: SummaryColumn[],
  selected: string[],
  representative: RepresentativeRow | null,
  editingId?: string,
): SummaryOp[] {
  return model.allowedOps(field).filter((op) => {
    if (op === "row" && !representative) return false;
    if (
      summaries.some(
        (s) => s.id === editingId && s.op === op && s.field === field,
      )
    )
      return true;
    return !summaries.some(
      (s) => selected.includes(s.id) && s.op === op && s.field === field,
    );
  });
}

/** The same field → value choice in the quick picker and the column workbench. */
export function ColumnPicker({
  model,
  keys,
  summaries,
  fields,
  selected,
  onField,
  onSummary,
  onClose,
  initialField,
  representative,
  onCustom,
}: {
  model: GroupingModel<Row>;
  onCustom?: (field: string) => void;
  initialField?: string | undefined;
  keys: string[];
  summaries: SummaryColumn[];
  fields: FieldDef<Row>[];
  selected: string[];
  onField: (name: string) => void;
  onSummary: (op: SummaryOp, field?: string) => void;
  representative: RepresentativeRow | null;
  onClose: () => void;
}) {
  const { sourceField, representativeLabel, summaryFields } = model;
  const [source, setSource] = useState<string | null>(initialField ?? null);
  const [search, setSearch] = useState("");
  const [operationSearch, setOperationSearch] = useState("");
  const count: FieldDef<Row> = {
    name: "__count_rows",
    label: "Row count",
    type: "number",
    source: { kind: "backend" },
    group: "Aggregate values",
    aliases: ["count rows", "count(*)"],
  };
  const existing = fields
    .filter(
      (f) =>
        (isComputedField(f.name) || summaries.some((s) => s.id === f.name)) &&
        isSelectable(f) && !selected.includes(f.name),
    )
    .map((f) => ({
      ...f,
      group:
        isComputedField(f.name)
          ? (f.group ?? "Computed columns")
          : summaries.find((s) => s.id === f.name)?.op === "row"
            ? "From representative row"
            : summaries.find((s) => s.id === f.name)?.op === "link"
              ? "Links"
              : "Aggregate values",
    }));
  const availableOps = (field?: string) =>
    availableSummaryOps(model, field, summaries, selected, representative);
  const inputs = summaryFields
    .filter((f) => !keys.includes(f.name) || !selected.includes(f.name))
    .filter(
      (f) => keys.includes(f.name) || onCustom || availableOps(f.name).length,
    )
    .map((f) => ({
      ...f,
      group: keys.includes(f.name)
        ? "Group keys"
        : (f.group ?? "Source fields"),
    }));
  const options: FieldDef<Row>[] = source
    ? [...availableOps(source), ...(onCustom ? ["formula" as const] : [])].map(
        (op) => ({
          name: op,
          label: SUMMARY_NAMES[op],
          type: "text",
          source: { kind: "backend" },
          group: op === "row" ? "From representative row" : "Aggregate values",
          aliases: [OP_LABEL[op]],
        }),
      )
    : [
        // Existing COUNT() definitions are offered once through the catalogue.
        ...(!summaries.some((s) => s.op === "count" && !s.field)
          ? [count]
          : []),
        ...existing,
        ...inputs,
      ];
  function roleFor(field: FieldDef<Row>): ColumnRole | undefined {
    if (source || field.name === count.name) {
      const op = source ? (field.name as SummaryOp) : "count";
      return {
        kind: op === "row" ? "row" : "aggregate",
        badge: OP_LABEL[op],
        title: SUMMARY_DETAILS[op],
      };
    }
    return columnRole(field.name, {
      mode: "groups",
      keys,
      summaries,
      representative,
    });
  }
  return (
    <FieldPicker
      fields={options}
      renderField={(field) => {
        const role = roleFor(field);
        return (
          <span
            className="qt-column-picker-option"
            data-column-role={role?.kind}
          >
            <span className="qt-picker-row">
              <span className="qt-picker-label">{field.label}</span>
              {role ? (
                <ColumnRoleBadge role={role} />
              ) : !isComputedField(field.name) && (
                <Icon name="chevronRight" size={12} />
              )}
            </span>
            {source && field.name === "row" && representative && (
              <span className="qt-column-picker-detail">
                {representativeLabel(representative)}
              </span>
            )}
          </span>
        );
      }}
      title={source ? `${sourceField(source)?.label} · show` : "Add column"}
      searchValue={source ? operationSearch : search}
      onSearchChange={source ? setOperationSearch : setSearch}
      {...(source
        ? {
            onBack: () => {
              setSource(null);
              setOperationSearch("");
            },
          }
        : {})}
      onPick={(field) => {
        if (source) {
          if (field.name === "formula") {
            onCustom?.(source);
            onClose();
            return;
          }
          onSummary(field.name as SummaryOp, source);
          onClose();
        } else if (field.name === count.name) {
          onSummary("count");
          onClose();
        } else if (
          keys.includes(field.name) ||
          existing.some((f) => f.name === field.name)
        ) {
          onField(field.name);
          onClose();
        } else {
          setSource(field.name);
          setOperationSearch("");
        }
      }}
      onClose={onClose}
    />
  );
}
