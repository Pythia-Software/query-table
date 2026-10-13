import { aggOpsForField, isGroupable, isMeasurable } from "./agg";
import {
  compileMetric,
  metricAggregatePlans,
  reduceMetricValues,
  evaluateMetricReductions,
  metricPlans,
  hasRegex,
  selectMetricShownRows,
} from "./metrics";
import { formulaRuntime, type FormulaNode, type FormulaValue } from "./formula";
import { isComputedField } from "./computed";
import { type QueryEvaluationOptions } from "./relativeTime";
import type { MetricPlan } from "./metrics";
import {
  isSortable,
  isSelectable,
  readFieldValue,
  type FieldDef,
  type FieldSchema,
} from "./schema";
import {
  MAX_GROUP_BY_FIELDS,
  normalizeQueryState,
  predicatesOf,
  type AggOp,
  type QueryState,
} from "./query";

export type GroupedRow = Record<string, unknown>;
type Row = GroupedRow;
export type SummaryOp = AggOp | "row" | "formula";
export interface RepresentativeOrder {
  field: string;
  dir: "asc" | "desc";
  nulls: "first" | "last";
}
export interface RepresentativeRow {
  orderBy: RepresentativeOrder[];
}
export interface SummaryColumn {
  id: string;
  op: SummaryOp;
  field?: string;
  expression?: string;
  label?: string;
}
export interface GroupingView {
  version: 2;
  mode: "rows" | "groups";
  keys: string[];
  summaries: SummaryColumn[];
  representative: RepresentativeRow | null;
  input: QueryState;
  result: QueryState;
}

/** One grouping stage over the complete source population. QueryState.where is
 * HAVING in this mode; source.where is the pre-group WHERE. The source snapshot
 * also restores the record layout, paging, metrics and item details on exit. */
export interface GroupingDefinition {
  keys: string[];
  summaries: SummaryColumn[];
  representative: RepresentativeRow | null;
  diagnostics?: string[];
}
export interface GroupingState extends GroupingDefinition {
  source: QueryState;
}
export const GROUP_ID_FIELD = "__qt_group_id__";
export const MAX_REPRESENTATIVE_SORTS = 8;
export const MAX_SUMMARY_COLUMNS = 64;
export const MAX_RESULT_GROUPS = 10000;
export function withoutGrouping(query: QueryState): QueryState {
  const { grouping: _grouping, ...result } = query;
  return result;
}
export const OP_LABEL: Record<SummaryOp, string> = {
  count: "COUNT",
  count_distinct: "DISTINCT",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
  row: "ROW",
  formula: "ƒx",
};

/** Bind aggregation helpers to this instance's source catalogue. */
export function createGroupingModel<InputRow>(
  inputSchema: FieldSchema<InputRow>,
) {
  const sourceField = (name: string) =>
    inputSchema.fields.find((f) => f.name === name);
  const groupableFields = inputSchema.fields.filter(
    (field) => isGroupable(field) && isSelectable(field),
  );
  const summaryFields = inputSchema.fields.filter(
    (f) => f.type !== "textarray" && isSelectable(f),
  );
  const representativeFields = inputSchema.fields.filter(
    (field) => isSortable(field) && field.type !== "textarray",
  );

  function representativeLabel(rule: RepresentativeRow): string {
    return rule.orderBy
      .map(
        (term) =>
          `${sourceField(term.field)?.label ?? term.field} ${term.dir === "asc" ? "↑" : "↓"}${term.nulls === "first" ? " (empty first)" : ""}`,
      )
      .join(", ");
  }

  function allowedOps(field?: string): SummaryOp[] {
    if (!field) return ["count"];
    const f = sourceField(field);
    return f && isSelectable(f)
      ? [...(isMeasurable(f) ? aggOpsForField(f) : []), "row"]
      : [];
  }
  function summaryExpression(column: SummaryColumn): string {
    if (column.op === "formula") return column.expression ?? "";
    const field = column.field ? `[${column.field.replace(/\]/g, "]]")}]` : "";
    return `${column.op === "row" ? "COUNT" : column.op.toUpperCase()}(${field})`;
  }
  function summaryProblem(column: SummaryColumn): string | null {
    if (column.op !== "formula") return null;
    try {
      const plan = compileMetric(summaryExpression(column), inputSchema);
      if (plan.dependencies.some((name) => !isSelectable(sourceField(name)!)))
        throw new Error("Aggregate fields must be selectable.");
      if (hasRegex(plan))
        throw new Error(
          "Regex aggregate formulas require isolated execution and are not supported in grouped columns.",
        );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  function summaryLabel(column: SummaryColumn): string {
    if (column.op === "formula")
      return column.label?.trim() || "Custom aggregate";
    if (!column.field) return "Row count";
    const label = sourceField(column.field)?.label ?? column.field;
    const prefix: Record<SummaryOp, string> = {
      count: "Count of",
      count_distinct: "Distinct",
      sum: "Total",
      avg: "Average",
      min: "Min",
      max: "Max",
      row: "Representative ·",
      formula: "",
    };
    return `${prefix[column.op]} ${label}`;
  }

  function resultSchema(
    keys: string[],
    summaries: SummaryColumn[],
  ): FieldSchema<Row> {
    const fields: FieldDef<Row>[] = [
      {
        name: GROUP_ID_FIELD,
        label: "Group identity",
        type: "text",
        source: { kind: "backend" },
        select: { enabled: false },
        filter: { enabled: false },
        sort: { enabled: false },
        aggregate: { measure: false, groupable: false },
      },
      ...keys.flatMap((key): FieldDef<Row>[] => {
        const field = sourceField(key);
        // Draft/saved views may contain fields removed by the host. Leave
        // them in query state for repair; validate() still rejects execution.
        if (!field) return [];
        return [{
          name: key,
          label: field.label,
          type: field.type,
          source: { kind: "backend" },
          ...(field.select ? { select: { ...field.select } } : {}),
          ...(field.filter ? { filter: { ...field.filter } } : {}),
          ...(field.aggregate ? { aggregate: { ...field.aggregate } } : {}),
          ...(field.sort?.enabled !== undefined
            ? { sort: { enabled: field.sort.enabled } }
            : {}),
          ...(typeof field.render === "string" ? { render: field.render } : {}),
          ...(field.display ? { display: field.display } : {}),
          group: "Group keys",
        }];
      }),
    ];
    for (const column of summaries) {
      if (column.op === "formula") {
        let type: FieldDef<Row>["type"] = "number";
        try {
          const compiled = compileMetric(
            summaryExpression(column),
            inputSchema,
          );
          type = compiled.type === "null" ? "number" : compiled.type;
        } catch {
          /* Invalid drafts show diagnostics in the editor. */
        }
        fields.push({
          name: column.id,
          label: summaryLabel(column),
          type,
          source: { kind: "backend" },
          group: "Aggregates",
          select: { align: type === "number" ? "right" : "left" },
        });
        continue;
      }
      const input = column.field ? sourceField(column.field) : undefined;
      const counting = column.op === "count" || column.op === "count_distinct";
      const numeric = counting || column.op === "sum" || column.op === "avg";
      const example = column.op === "row";
      fields.push({
        name: column.id,
        label: summaryLabel(column),
        type: numeric ? "number" : (input?.type ?? "number"),
        source: { kind: "backend" },
        select: {
          align: numeric || input?.type === "number" ? "right" : "left",
        },
        group: example ? "Representative row" : "Summaries",
        ...(!numeric && input?.aggregate?.groupable !== undefined
          ? { aggregate: { groupable: input.aggregate.groupable } }
          : {}),
        ...(typeof input?.render === "string" && !counting
          ? { render: input.render }
          : {}),
        ...(input?.display && !counting ? { display: input.display } : {}),
      });
    }
    return {
      name: `${inputSchema.name}:groups`,
      idField: GROUP_ID_FIELD,
      fields,
      defaultSelect: keys.filter(key => sourceField(key)).map((field) => ({ field })),
      defaultLimit: 25,
    };
  }

  // Typed tuples distinguish NULL, empty string, booleans and numbers. Key field
  // names are part of identity; key order and row arrival order are not.
  function keyValue(value: unknown): FormulaValue {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    throw new Error("Group keys must be finite scalar values.");
  }
  function groupId(
    row: InputRow,
    keys: string[],
    schema: FieldSchema<InputRow>,
  ): string {
    const tuple = [...keys]
      .sort()
      .map((key) => [
        key,
        keyValue(
          readFieldValue(schema.fields.find((f) => f.name === key)!, row),
        ),
      ]);
    // Bound source strings before JSON escaping can multiply their allocation.
    if (
      tuple.some(
        ([key, value]) => String(key).length + String(value).length > 10000,
      )
    )
      throw new Error("Grouping key length budget exceeded.");
    const id = JSON.stringify(tuple);
    if (id.length > 65536)
      throw new Error("Grouping key length budget exceeded.");
    return id;
  }
  function compare(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a < b ? -1 : 1;
  }
  function representative(
    rows: InputRow[],
    rule: RepresentativeRow,
    schema: FieldSchema<InputRow>,
  ): InputRow {
    const identityField = schema.fields.find(
      (field) => field.name === schema.idField,
    );
    const identities = new Set<string | number>();
    for (const row of rows) {
      const id = identityField
        ? readFieldValue(identityField, row)
        : (row as Record<string, unknown>)[schema.idField];
      if (
        !(
          typeof id === "string" ||
          (typeof id === "number" && Number.isFinite(id))
        ) ||
        identities.has(id)
      )
        throw new Error(
          "Representative rows require unique string or finite numeric source IDs.",
        );
      identities.add(id);
    }
    // The same stable identity tie-break is used for every projection. Explicit
    // ordering by ID takes precedence; no arrival-order fallback is needed.
    const order = rule.orderBy.some((term) => term.field === schema.idField)
      ? rule.orderBy
      : [
          ...rule.orderBy,
          { field: schema.idField, dir: "desc", nulls: "last" } as const,
        ];
    const terms = order.map((term) => ({
      ...term,
      def: schema.fields.find((field) => field.name === term.field)!,
    }));
    return rows.reduce((best, row) => {
      for (const term of terms) {
        const value = (record: InputRow) => {
          const raw = term.def
            ? readFieldValue(term.def, record)
            : (record as Record<string, unknown>)[schema.idField];
          if (raw == null || term.def?.type !== "datetime") return raw;
          const instant = Date.parse(String(raw));
          return Number.isFinite(instant) ? instant : null;
        };
        const a = value(row),
          b = value(best);
        if (a == null || b == null) {
          if (a == null && b == null) continue;
          return (a == null) === (term.nulls === "first") ? row : best;
        }
        const rank = compare(a, b);
        if (rank !== 0)
          return (term.dir === "asc" ? rank < 0 : rank > 0) ? row : best;
      }
      return best;
    });
  }
  function groupRows(
    rows: InputRow[],
    schema: FieldSchema<InputRow>,
    keys: string[],
    summaries: SummaryColumn[],
    rule: RepresentativeRow | null = null,
  ): Row[] {
    if (!rule && summaries.some((column) => column.op === "row"))
      throw new Error(
        "Configure representative-row ordering before selecting row values.",
      );
    if (keys.length === 0) return [];
    if (keys.length > MAX_GROUP_BY_FIELDS || summaries.length > MAX_SUMMARY_COLUMNS)
      throw new Error("Grouping definition exceeds column limits.");
    if (rows.length > 1_000_000)
      throw new Error("Grouping row budget exceeded.");
    let bytes = rows.length * 16;
    let operations = 0;
    const groups = new Map<string, InputRow[]>();
    for (const row of rows) {
      const id = groupId(row, keys, schema);
      const bucket = groups.get(id);
      if (bucket) bucket.push(row);
      else {
        if (groups.size >= MAX_RESULT_GROUPS)
          throw new Error(
            `Grouping exceeds ${MAX_RESULT_GROUPS.toLocaleString()} groups.`,
          );
        bytes += id.length * 2 + 256;
        if (bytes > 16_000_000)
          throw new Error("Grouping retained-memory budget exceeded.");
        groups.set(id, [row]);
      }
    }
    const formulas = new Map<string, { plan?: MetricPlan; error?: string }>(
      summaries
        .filter((c) => c.op !== "row")
        .map((column) => {
          try {
            const problem = summaryProblem(column);
            if (problem) throw new Error(problem);
            return [
              column.id,
              { plan: compileMetric(summaryExpression(column), schema) },
            ] as const;
          } catch (error) {
            return [
              column.id,
              { error: error instanceof Error ? error.message : String(error) },
            ] as const;
          }
        }),
    );
    const nodeCost = (node: FormulaNode): number =>
      1 +
      (node.kind === "call"
        ? node.args.reduce((cost, child) => cost + nodeCost(child), 0)
        : 0);
    const costs = new Map(
      [...formulas].map(([id, compiled]) => [
        id,
        compiled.plan?.aggregates.map(nodeCost) ?? [],
      ]),
    );
    return [...groups].map(([id, members]) => {
      const output: Row = Object.assign(Object.create(null), {
        [GROUP_ID_FIELD]: id,
      });
      for (const key of keys)
        output[key] = readFieldValue(
          schema.fields.find((f) => f.name === key)!,
          members[0]!,
        );
      const chosen =
        rule && summaries.some((column) => column.op === "row")
          ? representative(members, rule, schema)
          : null;
      for (const column of summaries) {
        if (column.op !== "row") {
          const compiled = formulas.get(column.id)!;
          if (!compiled.plan) {
            output[column.id] = { computedError: compiled.error };
            continue;
          }
          const plan = compiled.plan;
          const rowPlans = metricAggregatePlans(plan);
          const reductions = plan.aggregates.map((node, i) =>
            reduceMetricValues(
              node,
              members.map((row) => {
                if ((operations += costs.get(column.id)?.[i] ?? 1) > 10_000_000)
                  throw new Error("Grouping operation budget exceeded.");
                const rowPlan = rowPlans[i];
                if (!rowPlan) return { value: 1 };
                const values = Object.fromEntries(
                  rowPlan.dependencies.map((name) => {
                    const value = readFieldValue(
                      schema.fields.find((f) => f.name === name)!,
                      row,
                    );
                    return [
                      name,
                      (value instanceof Date
                        ? value.toISOString()
                        : (value ?? null)) as FormulaValue,
                    ];
                  }),
                );
                return formulaRuntime(rowPlan.ast, values);
              }),
            ),
          );
          const result = evaluateMetricReductions(plan, reductions);
          output[column.id] = result.error
            ? { computedError: result.error }
            : result.value;
          continue;
        }
        const field = schema.fields.find((f) => f.name === column.field);
        if (column.op === "row") {
          output[column.id] =
            field && chosen ? readFieldValue(field, chosen) : null;
          continue;
        }
      }
      return output;
    });
  }
  function filteredInput(
    rows: InputRow[],
    query: QueryState,
    schema: FieldSchema<InputRow>,
    options: QueryEvaluationOptions = {},
  ): InputRow[] {
    // GROUP BY operates on all matching source records, never on a displayed page.
    return selectMetricShownRows(
      rows,
      {
        ...withoutGrouping(query),
        aggregations: [],
        orderBy: [],
        offset: 0,
        limit: Math.max(1, rows.length),
      },
      { ...schema, defaultSort: [] },
      options,
    );
  }

  /** Reconcile only consumers of row values when the shared selection changes.
   * Aggregate outputs and metrics over them keep their meaning. */
  function reconcileRepresentative(
    query: QueryState,
    summaries: SummaryColumn[],
    schema: FieldSchema<Row>,
    remove: boolean,
  ): QueryState {
    const affected = new Set(
      summaries.filter((s) => s.op === "row").map((s) => s.id),
    );
    if (!affected.size) return query;
    // Computed columns can depend on representative fields transitively.
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of schema.fields) {
        if (
          !affected.has(f.name) &&
          f.source.kind === "derived" &&
          f.source.dependencies?.some((name) => affected.has(name))
        ) {
          affected.add(f.name);
          grew = true;
        }
      }
    }
    return {
      ...query,
      offset: 0,
      select: remove
        ? query.select.filter((c) => !affected.has(c.field))
        : query.select,
      where: query.where.filter(
        (term) => !predicatesOf(term).some((p) => affected.has(p.field)),
      ),
      orderBy: query.orderBy.filter((term) => !affected.has(term.field)),
      aggregations: (query.aggregations ?? []).filter((metric) => {
        if (metric.groupBy.some((name) => affected.has(name))) return false;
        try {
          return !metricPlans(metric, schema).some((plan) =>
            plan.dependencies.some((name) => affected.has(name)),
          );
        } catch {
          // A broken expression cannot be proven independent of the changed values.
          return false;
        }
      }),
    };
  }

  function validate(definition: GroupingDefinition): void {
    if (definition.diagnostics?.length)
      throw new Error(definition.diagnostics.join(" "));
    if (
      !definition.keys.length ||
      definition.keys.length > MAX_GROUP_BY_FIELDS ||
      new Set(definition.keys).size !== definition.keys.length ||
      definition.keys.some(
        (key) =>
          key === GROUP_ID_FIELD ||
          !groupableFields.some((f) => f.name === key),
      )
    )
      throw new Error("Choose valid group keys from the source schema.");
    if (definition.summaries.length > MAX_SUMMARY_COLUMNS)
      throw new Error("Too many aggregate columns.");
    const ids = new Set([
      GROUP_ID_FIELD,
      ...inputSchema.fields.map((field) => field.name),
    ]);
    for (const column of definition.summaries) {
      if (
        !column.id ||
        column.id.length > 256 ||
        ids.has(column.id) ||
        isComputedField(column.id) ||
        ["__proto__", "constructor", "prototype"].includes(column.id)
      )
        throw new Error(
          "Aggregate column IDs must be unique and distinct from source fields.",
        );
      ids.add(column.id);
      if (column.op === "formula") {
        const error = summaryProblem(column);
        if (error) throw new Error(error);
      } else if (
        !allowedOps(column.field).includes(column.op) ||
        (column.op === "row" && (!column.field || !definition.representative))
      )
        throw new Error("Invalid aggregate or representative column.");
    }
    const rule = definition.representative;
    if (
      rule &&
      (!rule.orderBy.length ||
        rule.orderBy.length > MAX_REPRESENTATIVE_SORTS ||
        new Set(rule.orderBy.map((t) => t.field)).size !==
          rule.orderBy.length ||
        rule.orderBy.some(
          (t) =>
            !representativeFields.some((f) => f.name === t.field) ||
            !["asc", "desc"].includes(t.dir) ||
            !["first", "last"].includes(t.nulls),
        ))
    )
      throw new Error("Choose valid representative-row ordering.");
  }

  return {
    inputSchema,
    sourceField,
    groupableFields,
    summaryFields,
    representativeFields,
    representativeLabel,
    allowedOps,
    summaryExpression,
    summaryProblem,
    summaryLabel,
    resultSchema,
    groupRows,
    filteredInput,
    reconcileRepresentative,
    validate,
  };
}
export type GroupingModel<Row> = ReturnType<typeof createGroupingModel<Row>>;

/** Evaluate the WHERE and grouping stages once; callers apply HAVING and paging
 * with the resulting schema and withoutGrouping(query). Never accepts a page
 * fetched by a transport as a complete source dataset. */
export function prepareGrouping<Row>(
  rows: Row[],
  schema: FieldSchema<Row>,
  grouping: GroupingState,
  options: QueryEvaluationOptions = {},
) {
  const model = createGroupingModel(schema);
  if (grouping.source.grouping)
    throw new Error("Only one grouping stage is supported.");
  model.validate(grouping);
  const inputs = model.filteredInput(rows, grouping.source, schema, options);
  return {
    inputs,
    rows: model.groupRows(
      inputs,
      schema,
      grouping.keys,
      grouping.summaries,
      grouping.representative,
    ),
    schema: model.resultSchema(grouping.keys, grouping.summaries),
  };
}
