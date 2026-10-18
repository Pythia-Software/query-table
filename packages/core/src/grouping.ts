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
import { isComputedCellError, isComputedField } from "./computed";
import type { CellDisplay } from "./cellDisplay";
import { datetimeValue, groupKeyTerms } from "./groupKeys";
import { fillUrlTemplate, templateFields, urlTemplateProblem } from "./itemPage";
import type { QueryPatch } from "./queryPatch";
import { type QueryEvaluationOptions } from "./relativeTime";
import type { MetricPlan } from "./metrics";
import {
  isFilterable,
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
  type WhereClause,
} from "./query";

export type GroupedRow = Record<string, unknown>;
type Row = GroupedRow;
export type SummaryOp = AggOp | "row" | "formula" | "link";
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
  /** Cell format for this output column (for example `{ kind: "percent" }` for
   * a weighted rate). Replaces any render/display inherited from the source
   * field; metrics measuring the column default their value format from it. */
  display?: CellDisplay;
  /** Required for `op: "link"`; ignored otherwise. */
  link?: LinkSpec;
}

/** Where a link column points. Placeholders and key filters read the group
 * row: its keys and non-link summaries. */
export type LinkDestination =
  /** `{field:name}` placeholders over keys and summaries; values are
   * percent-encoded. The result must be an HTTP(S) or relative URL. */
  | { kind: "template"; template: string }
  /** A query composed by query-table and routed by the host's
   * `linkTargets[target](query, params)`. */
  | {
      kind: "query";
      target: string;
      /** "source" (default) starts from `grouping.source`, keeping its
       * filters, columns and order; "empty" starts from `EMPTY_QUERY`. */
      base?: "source" | "empty";
      /** Add `=`/`is_null` per group key, as `groupSourceQuery` does. Default true. */
      keyFilters?: boolean;
      /** Applied last, with `applyPatch`. */
      patch?: QueryPatch;
      /** Static parameters passed to the host target. */
      params?: Record<string, string>;
    };

/** A group-grain link column (`SummaryColumn` with `op: "link"`). Computed on
 * the client from the returned group row; never sent to a server. */
export interface LinkSpec {
  /** Static text, or the value of a group key or summary column. */
  label: string | { column: string };
  to: LinkDestination;
}

/** The value of a link column for one group row: everything that depends on
 * the row. `resolveGroupLink` combines it with the current query and the
 * host's link targets. */
export interface GroupLinkValue {
  kind: "group-link";
  label: string;
  to: LinkDestination | null;
  /** Template links: the substituted, not yet safety-checked href. */
  href?: string;
  /** Query links with key filters: the group's key predicates. */
  terms?: WhereClause[];
  /** Why the link cannot be followed for this row. */
  problem?: string;
}
export const GROUP_LINK_RENDER = "qt_group_link";
export function isGroupLinkValue(value: unknown): value is GroupLinkValue {
  return value != null && typeof value === "object" && (value as GroupLinkValue).kind === "group-link";
}
export function isGroupLinkField(field: Pick<FieldDef, "render"> | undefined): boolean {
  return field?.render === GROUP_LINK_RENDER;
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

/** Leave the grouping stage: the source snapshot restores the record WHERE,
 * layout, ordering, paging, metrics and item details. Ungrouped queries are
 * returned unchanged. */
export function exitGrouping(query: QueryState): QueryState {
  return query.grouping ? query.grouping.source : query;
}

/** The grouping-key transition behind the grouping controls. Empty keys exit
 * the stage; an ungrouped query becomes the source of a new stage that shows
 * only its keys; a grouped query swaps keys, dropping result columns, HAVING
 * terms and sorts on removed keys and clearing group metrics. */
export function withGroupingKeys(query: QueryState, keys: string[]): QueryState {
  const before = query.grouping;
  if (!keys.length) return exitGrouping(query);
  if (!before)
    return {
      select: keys.map((field) => ({ field })),
      where: [],
      orderBy: [],
      limit: query.limit,
      offset: 0,
      grouping: { keys, summaries: [], representative: null, source: query },
    };
  const removed = new Set(before.keys.filter((key) => !keys.includes(key)));
  // An empty SELECT shows the existing keys by default. Materialize them
  // before adding keys so introducing an explicit SELECT keeps those columns.
  const columns = query.select.length
    ? query.select
    : before.keys.map((field) => ({ field }));
  return {
    ...query,
    grouping: { ...before, keys },
    offset: 0,
    aggregations: [],
    select: [
      ...keys
        .filter((key) => !before.keys.includes(key))
        .map((field) => ({ field })),
      ...columns.filter((c) => !removed.has(c.field)),
    ],
    where: query.where.filter(
      (term) => !predicatesOf(term).some((p) => removed.has(p.field)),
    ),
    orderBy: query.orderBy.filter((term) => !removed.has(term.field)),
  };
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
  link: "LINK",
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
    if (column.op === "link") return "";
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
    if (column.op === "link")
      return column.label?.trim() || (typeof column.link?.label === "string" && column.link.label.trim()) || "Link";
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
      link: "",
    };
    return `${prefix[column.op]} ${label}`;
  }

  /** Group-row fields a link column reads, in a stable order. */
  function linkReferences(column: SummaryColumn, keys: string[]): string[] {
    const link = column.link;
    if (!link) return [];
    const names = new Set<string>();
    if (typeof link.label === "object") names.add(link.label.column);
    if (link.to.kind === "template")
      for (const name of templateFields(link.to.template)) names.add(name);
    else if (link.to.keyFilters !== false)
      for (const key of keys) names.add(key);
    return [...names];
  }

  /** Why a link column is invalid for this definition, or null. Problems are
   * diagnostics: the column renders as plain text and the rest of the grouped
   * table runs. Host target registration is checked when rendering. */
  function linkProblem(
    column: SummaryColumn,
    keys: string[],
    summaries: SummaryColumn[],
  ): string | null {
    const link = column.link;
    if (column.op !== "link") return null;
    if (!link) return "Invalid link definition.";
    const readable = (name: string) =>
      keys.includes(name) ||
      summaries.some((other) => other.id === name && other.op !== "link");
    if (typeof link.label === "object" && !readable(link.label.column))
      return `Unknown link label column: ${link.label.column}.`;
    if (link.to.kind === "template") {
      if (!link.to.template.trim()) return "Enter a link URL template.";
      return urlTemplateProblem(link.to.template, [], readable);
    }
    if (link.to.keyFilters !== false)
      for (const key of keys) {
        const field = sourceField(key);
        if (field?.type === "textarray")
          return `Key filters cannot match the textarray key ${field.label}.`;
        if (!field || !isFilterable(field))
          return `Key filters cannot match the key ${field?.label ?? key}.`;
      }
    return null;
  }

  /** One message per invalid link column, prefixed with its label. */
  function linkDiagnostics(definition: Pick<GroupingDefinition, "keys" | "summaries">): string[] {
    return definition.summaries.flatMap((column) => {
      const problem = linkProblem(column, definition.keys, definition.summaries);
      return problem ? [`${summaryLabel(column)}: ${problem}`] : [];
    });
  }

  function linkValue(
    column: SummaryColumn,
    problem: string | null,
    keys: string[],
    schema: FieldSchema<Row>,
    row: Row,
  ): GroupLinkValue {
    const link = column.link;
    const read = (name: string): unknown => {
      const field = schema.fields.find((f) => f.name === name);
      const value = field ? readFieldValue(field, row) : undefined;
      if (value == null || isComputedCellError(value)) return null;
      if (field?.type === "datetime" || value instanceof Date)
        return datetimeValue(value) ?? value;
      return Array.isArray(value) ? value.join(", ") : value;
    };
    const label = !link
      ? summaryLabel(column)
      : typeof link.label === "string"
        ? link.label
        : String(read(link.label.column) ?? "");
    const value: GroupLinkValue = { kind: "group-link", label, to: link?.to ?? null };
    if (problem || !link) return { ...value, problem: problem ?? "Invalid link definition." };
    if (link.to.kind === "template") {
      const href = fillUrlTemplate(link.to.template, [], (token) => read(token.slice(6)));
      return href === null ? { ...value, problem: "A value in this link is empty." } : { ...value, href };
    }
    if (link.to.keyFilters === false) return value;
    const terms = groupKeyTerms(keys, row, inputSchema);
    return terms ? { ...value, terms } : { ...value, problem: "This group cannot be matched exactly." };
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
    let schema: FieldSchema<Row>;
    for (const column of summaries) {
      if (column.op === "link") {
        const problem = linkProblem(column, keys, summaries);
        // Client-only: toServerQuery requests the dependencies instead.
        fields.push({
          name: column.id,
          label: summaryLabel(column),
          type: "text",
          source: {
            kind: "derived",
            dependencies: linkReferences(column, keys),
            accessor: (row) => linkValue(column, problem, keys, schema, row),
          },
          select: { align: "left" },
          filter: { enabled: false },
          sort: { enabled: false },
          aggregate: { measure: false, groupable: false },
          render: GROUP_LINK_RENDER,
          group: "Links",
        });
        continue;
      }
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
          ...(column.display ? { display: column.display } : {}),
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
        // An explicit summary format replaces the inherited source presentation.
        ...(column.display
          ? { display: column.display }
          : {
              ...(typeof input?.render === "string" && !counting
                ? { render: input.render }
                : {}),
              ...(input?.display && !counting ? { display: input.display } : {}),
            }),
      });
    }
    schema = {
      name: `${inputSchema.name}:groups`,
      idField: GROUP_ID_FIELD,
      fields,
      defaultSelect: keys.filter(key => sourceField(key)).map((field) => ({ field })),
      defaultLimit: 25,
    };
    return schema;
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
        .filter((c) => c.op !== "row" && c.op !== "link")
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
        if (column.op === "link") continue;
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
    const sourceNames = new Set(inputSchema.fields.map((field) => field.name));
    for (const column of definition.summaries) {
      if (sourceNames.has(column.id))
        throw new Error(
          `Aggregate column ID "${column.id}" is already a source field name. Choose a different id, such as "${column.op === "formula" || column.op === "row" ? "summary" : column.op}_${column.id}".`,
        );
      if (ids.has(column.id) && column.id !== GROUP_ID_FIELD)
        throw new Error(
          `Aggregate column ID "${column.id}" is used by more than one column.`,
        );
      if (
        !column.id ||
        column.id.length > 256 ||
        ids.has(column.id) ||
        isComputedField(column.id) ||
        ["__proto__", "constructor", "prototype"].includes(column.id)
      )
        throw new Error(
          "Aggregate column IDs must be 1–256 characters and cannot be reserved names or @computed/ references.",
        );
      ids.add(column.id);
      // Link problems are diagnostics (linkDiagnostics), never execution errors.
      if (column.op === "link") continue;
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
    linkProblem,
    linkDiagnostics,
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
