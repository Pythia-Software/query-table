import type { ColumnRole } from "../ColumnRoleBadge";
export { ColumnRoleBadge, type ColumnRole } from "../ColumnRoleBadge";
import { isComputedField } from "@pythia-software/query-table-core";
import {
  OP_LABEL,
  type GroupingView as View,
  type GroupingModel,
} from "@pythia-software/query-table-core";

type ColumnContext = Pick<
  View,
  "mode" | "keys" | "summaries" | "representative"
>;
// Roles describe the result projection; ordinary records carry no badge.
export function columnRole(
  field: string,
  view: ColumnContext,
  model?: Pick<GroupingModel<unknown>, "representativeLabel">,
): ColumnRole | undefined {
  if (isComputedField(field)) return undefined;
  if (view.mode !== "groups" || !view.keys.length) return undefined;
  if (view.keys.includes(field))
    return {
      kind: "key",
      badge: "KEY",
      title: "Group key · shared by every row in this group",
    };
  const column = view.summaries.find((s) => s.id === field);
  // Links present the group; they are not values of it.
  if (!column || column.op === "link") return undefined;
  if (column.op === "row")
    return {
      kind: "row",
      badge: "ROW",
      title: `Value from the representative row · ${view.representative ? (model?.representativeLabel(view.representative) ?? view.representative.orderBy.map((term) => `${term.field} ${term.dir}`).join(", ")) : "ordering not set"}. All ROW columns come from the same row, including null values.`,
    };
  return {
    kind: "aggregate",
    badge: OP_LABEL[column.op],
    title: `Aggregated value · ${OP_LABEL[column.op]} over rows in this group`,
  };
}
