import type { ComputedExecution } from "./computed";
import { isComputedField } from "./computed";
import {
  compileFormula,
  formulaRuntime,
  FormulaError,
  type FormulaNode,
  type FormulaPlan,
  type FormulaType,
  type FormulaValue,
  type FormulaDiagnostic,
  type FormulaResult,
  type FormulaFunction,
} from "./formula";
import { aggOpsForField, isGroupable, isMeasurable } from "./agg";
import {
  indexFields,
  isFilterable,
  readFieldValue,
  resolveFieldName,
  type FieldDef,
  type FieldSchema,
} from "./schema";
import {
  EMPTY_QUERY,
  MAX_WHERE_CLAUSES,
  normalizeQueryState,
  predicatesOf,
  type AggregationClause,
  type AggOp,
  type QueryState,
  type WhereTerm,
} from "./query";
import { opsForField } from "./ops";
import { hasMetricSeries, planMetricSeries, validateMetricSeries } from "./metricSeries";
import { applyQuery } from "./apply";
import { prepareGrouping, withoutGrouping, type GroupedRow } from "./grouping";
import { computedInputAllowed } from "./apply";
import { toServerQueryV2 } from "./execution";
import {
  toServerQuery,
  type AggregationResult,
  type AggregationBucket,
} from "./encode";
import type { MetricQuery, MetricValue, MetricSort } from "./metricTypes";
import {
  boxSummary,
  histogramEdges,
  histogramCounts,
} from "./metricDistributions";
import { assertMetricNumber, checkedMetricResult } from "./metricPrecision";
import { evaluationTime, type QueryEvaluationOptions } from "./relativeTime";
import {
  metricDateTime,
  metricDateFloor,
  metricDateNext,
  metricDateRange,
  isMetricCycle,
  metricCycleSlot,
  metricCycleSlots,
  validateDateGrouping,
} from "./metricDates";
const aggregates = new Set([
  "COUNT",
  "COUNT_DISTINCT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "MEDIAN",
]);
/** Functions available only in aggregate expressions, separate from row formulas. */
export const METRIC_FUNCTIONS: FormulaFunction[] = [
  ["COUNT", "Count rows, or non-empty values."],
  ["COUNT_DISTINCT", "Count distinct non-empty values."],
  ["SUM", "Total numeric values in each group."],
  ["AVG", "Average numeric values in each group."],
  ["MIN", "Smallest non-empty value in each group."],
  ["MAX", "Largest non-empty value in each group."],
  [
    "MEDIAN",
    "Middle numeric value; averages the middle pair. Ignores empty values.",
  ],
].map(([name, description]) => ({
  name: name!,
  description: description!,
  signature: `${name}(row expression${name === "COUNT" ? "?" : ""})`,
  min: name === "COUNT" ? 0 : 1,
  max: 1,
  result: name === "MIN" || name === "MAX" ? "branch" : "number",
  args: ["SUM", "AVG", "MEDIAN"].includes(name!) ? ["number"] : "any",
}));
export interface MetricPlan extends FormulaPlan {
  aggregates: Extract<FormulaNode, { kind: "call" }>[];
  aggregateTypes: FormulaType[];
}
export function compileMetric(
  expression: string,
  schema: FieldSchema | readonly FieldDef[],
  resolve?: (name: string) => FormulaPlan | undefined,
): MetricPlan {
  const fields: readonly FieldDef[] = Array.isArray(schema)
    ? schema
    : (schema as FieldSchema).fields;
  const nodes: MetricPlan["aggregates"] = [];
  const aggregateTypes: FormulaType[] = [];
  let inAggregate = false;
  const plan = compileFormula(
    expression,
    resolve
      ? fields.filter(
          (f) => f.source.kind !== "derived" || !f.source.computedId,
        )
      : fields,
    resolve,
    (node, check) => {
      if (node.kind !== "call" || !aggregates.has(node.name)) return undefined;
      if (inAggregate)
        throw new FormulaError(
          "Nested aggregates are not allowed.",
          node.from,
          node.to,
        );
      if (
        node.args.length > 1 ||
        (node.name !== "COUNT" && node.args.length !== 1)
      )
        throw new FormulaError(
          `${node.name} requires ${node.name === "COUNT" ? "zero or one argument" : "one argument"}.`,
          node.from,
          node.to,
        );
      inAggregate = true;
      let type: FormulaType;
      try {
        type = node.args[0] ? check(node.args[0]) : "number";
      } finally {
        inAggregate = false;
      }
      const visit = (n: FormulaNode) => {
        if (n.kind === "field") {
          const field = fields.find((f) => f.name === n.name);
          if (!field)
            throw new FormulaError(
              `Unresolved dependency ${n.name}.`,
              n.from,
              n.to,
            );
          // MEDIAN is formula-only, so it is absent from the default AggOp
          // list. Explicit field restrictions still apply to every reduction.
          if (
            !isMeasurable(field) ||
            ((field.aggregate?.ops !== undefined ||
              (node.args[0] === n && node.name !== "MEDIAN")) &&
              !aggOpsForField(field).includes(node.name.toLowerCase() as AggOp))
          )
            throw new FormulaError(
              `Field ${n.name} does not allow ${node.name}.`,
              n.from,
              n.to,
            );
        } else if (n.kind === "call") {
          if (aggregates.has(n.name))
            throw new FormulaError(
              "Nested aggregates are not allowed.",
              n.from,
              n.to,
            );
          n.args.forEach(visit);
        }
      };
      node.args.forEach(visit);
      if (
        ["SUM", "AVG", "MEDIAN"].includes(node.name) &&
        !["number", "null"].includes(type)
      )
        throw new FormulaError(
          `${node.name} requires numeric input.`,
          node.from,
          node.to,
        );
      if (
        ["MIN", "MAX", "COUNT_DISTINCT"].includes(node.name) &&
        (type === "textarray" ||
          (type === "bool" && node.name !== "COUNT_DISTINCT"))
      )
        throw new FormulaError(
          `Unsupported ${node.name} input type.`,
          node.from,
          node.to,
        );
      nodes.push(node);
      aggregateTypes.push(type);
      return ["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MEDIAN"].includes(
        node.name,
      )
        ? "number"
        : type;
    },
  );
  const groupCheck = (node: FormulaNode) => {
    if (node.kind === "field")
      throw new FormulaError(
        "Row fields must be inside an aggregate.",
        node.from,
        node.to,
      );
    if (node.kind === "call" && !aggregates.has(node.name)) {
      if (node.name.startsWith("REGEX_"))
        throw new FormulaError(
          "Regex is supported only inside aggregate row expressions.",
          node.from,
          node.to,
        );
      node.args.forEach(groupCheck);
    }
  };
  groupCheck(plan.ast);
  if (!nodes.length)
    throw new FormulaError("A metric must contain an aggregate.");
  if (plan.type === "textarray")
    throw new FormulaError("Metrics must return scalar values.");
  return { ...plan, aggregates: nodes, aggregateTypes };
}
/** Row plans for worker evaluation. Null denotes COUNT(), which requires only row count. */
export function metricAggregatePlans(plan: MetricPlan): (FormulaPlan | null)[] {
  return plan.aggregates.map((node) => {
    if (!node.args[0]) return null;
    const dependencies = new Set<string>();
    const visit = (n: FormulaNode): void => {
      if (n.kind === "field") dependencies.add(n.name);
      else if (n.kind === "call") n.args.forEach(visit);
    };
    visit(node.args[0]);
    // Aggregate argument type is retained by the compiler in aggregateTypes.
    return {
      ast: node.args[0],
      dependencies: [...dependencies].sort(),
      type: plan.aggregateTypes[plan.aggregates.indexOf(node)]!,
    };
  });
}
/** Reduce exact per-row worker results; errors are not silently treated as NULL. */
export interface MetricReductionOptions {
  /** Retained distinct entries, independently bounded from row count. */
  maxDistinctValues?: number;
  /** Conservative UTF-16 payload plus per-entry storage estimate. */
  maxDistinctBytes?: number;
}
function distinctAccumulator(options: MetricReductionOptions) {
  const values = new Set<string | number | boolean>();
  let bytes = 0;
  const cardinality = options.maxDistinctValues ?? 100000;
  const byteLimit = options.maxDistinctBytes ?? 16000000;
  if (
    !Number.isSafeInteger(cardinality) ||
    cardinality < 0 ||
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 0
  )
    throw Error("Invalid distinct budget.");
  return {
    add(value: FormulaValue) {
      const v = scalar(value);
      if (typeof v === "number") assertMetricNumber(v);
      if (v === null || values.has(v)) return;
      const size = 64 + (typeof v === "string" ? v.length * 2 : 8);
      if (values.size >= cardinality || size > byteLimit - bytes)
        throw Error("Metric distinct retained-memory budget exceeded.");
      values.add(v);
      bytes += size;
    },
    result: () => ({ value: values.size }),
  };
}
export function reduceMetricValues(
  node: Extract<FormulaNode, { kind: "call" }>,
  results: readonly FormulaResult[],
  options: MetricReductionOptions = {},
): FormulaResult {
  return reduceResults(node, results, options);
}
function reduceResults(
  node: Extract<FormulaNode, { kind: "call" }>,
  results: Iterable<FormulaResult>,
  options: MetricReductionOptions,
): FormulaResult {
  try {
    if (!aggregates.has(node.name)) throw Error("Expected an aggregate node.");
    const distinct =
      node.name === "COUNT_DISTINCT" ? distinctAccumulator(options) : undefined;
    const values: FormulaValue[] = [];
    let count = 0,
      nonnull = 0,
      error: string | undefined;
    for (const r of results) {
      count++;
      if (r.error) {
        error ??= r.error;
        continue;
      }
      if (r.value === null) continue;
      if (node.name !== "COUNT" && !distinct && typeof r.value === "number")
        assertMetricNumber(r.value);
      nonnull++;
      if (distinct) distinct.add(r.value);
      else if (node.name !== "COUNT") values.push(r.value);
    }
    if (error) return { value: null, error };
    if (distinct) return distinct.result();
    if (node.name === "COUNT")
      return { value: node.args.length ? nonnull : count };
    if (!values.length) return { value: null };
    if (node.name === "MEDIAN") {
      const sorted = values
        .map((value) => {
          if (typeof value !== "number" || !Number.isFinite(value))
            throw Error("Expected a finite number.");
          return value;
        })
        .sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const value =
        sorted.length % 2
          ? sorted[mid]!
          : sorted[mid - 1]! / 2 + sorted[mid]! / 2;
      assertMetricNumber(value);
      return { value };
    }
    if (node.name === "SUM" || node.name === "AVG") {
      let sum = 0;
      for (const v of values) {
        if (typeof v !== "number" || !Number.isFinite(v))
          throw Error("Expected a finite number.");
        sum += v / (node.name === "AVG" ? values.length : 1);
        assertMetricNumber(sum);
      }
      return { value: sum };
    }
    return {
      value: values.reduce((a, b) =>
        compareMetricValues(scalar(a), scalar(b)) *
          (node.name === "MIN" ? 1 : -1) <=
        0
          ? a
          : b,
      ),
    };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}
/** Evaluate the group AST lazily from reductions indexed like plan.aggregates.
 * A dead IF/COALESCE branch does not observe a failed aggregate in that branch. */
export function evaluateMetricReductions(
  plan: MetricPlan,
  reductions: readonly FormulaResult[],
): FormulaResult {
  const key = (n: FormulaNode) =>
    `${n.from}:${n.to}:${n.kind === "call" ? n.name : n.kind}`;
  const byNode = new Map(
    plan.aggregates.map((n, i) => [key(n), reductions[i]]),
  );
  return checkedMetricResult(
    formulaRuntime(plan.ast, {}, (node) =>
      byNode.has(key(node))
        ? checkedMetricResult(
            byNode.get(key(node)) ?? {
              value: null,
              error: "Missing aggregate reduction.",
            },
          )
        : undefined,
    ),
  );
}
export function metricExpression(clause: AggregationClause): string {
  return (
    clause.expression ??
    `${clause.op.toUpperCase()}(${clause.field ? `[${clause.field.replace(/]/g, "]]")}]` : ""})`
  );
}
export function hasRegex(plan: FormulaPlan): boolean {
  const visit = (n: FormulaNode): boolean =>
    n.kind === "call" && (n.name.startsWith("REGEX_") || n.args.some(visit));
  return visit(plan.ast);
}
function distributionActive(c: AggregationClause): boolean {
  return (
    !!c.distribution &&
    (!c.display || c.display.kind === "box" || c.display.kind === "histogram")
  );
}
/** A box over a cyclic slot's per-occurrence values: its input is the
 * metric itself, evaluated once per occurrence. */
export function occurrenceDistribution(c: AggregationClause): boolean {
  return distributionActive(c) && !!c.dateGrouping?.occurrence;
}
export function metricPlans(
  c: AggregationClause,
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): FormulaPlan[] {
  if (distributionActive(c) && !occurrenceDistribution(c)) {
    const p = compileFormula(
      c.distribution!.input,
      resolve
        ? schema.fields.filter(
            (f) => f.source.kind !== "derived" || !f.source.computedId,
          )
        : schema.fields,
      resolve,
    );
    if (p.type !== "number" && p.type !== "null")
      throw new FormulaError("Distribution input must be numeric.");
    if (!["box", "histogram"].includes(c.distribution!.kind))
      throw new FormulaError("Invalid distribution kind.");
    if (
      c.distribution!.kind === "histogram" &&
      (!Number.isInteger(c.distribution!.bins ?? 10) ||
        (c.distribution!.bins ?? 10) < 2 ||
        (c.distribution!.bins ?? 10) > 30)
    )
      throw new FormulaError("Choose 2–30 histogram bins.");
    for (const name of p.dependencies) {
      const field = schema.fields.find((f) => f.name === name)!;
      if (!isMeasurable(field))
        throw new FormulaError(`Field ${name} cannot be a distribution input.`);
    }
    if (c.scope !== "shownRows" && hasRegex(p))
      throw new FormulaError("Regex is unavailable for all-matching metrics.");
    return [p];
  }
  const out = [
    compileMetric(
      metricExpression(
        c.expression === undefined && c.field
          ? { ...c, field: resolveFieldName(schema, c.field) ?? c.field }
          : c,
      ),
      schema,
      resolve,
    ),
  ];
  if (c.display?.kind === "scatter") {
    out.push(compileMetric(c.expressionY ?? "", schema, resolve));
    if (out.some((p) => p.type !== "number" && p.type !== "null"))
      throw new FormulaError("Scatter expressions must be numeric.");
  }
  if (c.scope !== "shownRows" && out.some(hasRegex))
    throw new FormulaError("Regex is unavailable for all-matching metrics.");
  return out;
}
export function validateMetric(
  c: AggregationClause,
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): FormulaDiagnostic[] {
  try {
    if (c.diagnostics?.length) throw new FormulaError(c.diagnostics.join(" "));
    if (c.groupBy.length > 20)
      throw new FormulaError("At most 20 grouping fields are allowed.");
    for (const key of c.groupBy) {
      const f = schema.fields.find(
        (f) => f.name === (resolveFieldName(schema, key) ?? key),
      );
      if (!f || !isGroupable(f))
        throw new FormulaError(`Field ${key} cannot group metrics.`);
    }
    if (c.dateGrouping) {
      validateDateGrouping(c.dateGrouping);
      const field =
        resolveFieldName(schema, c.dateGrouping.field) ?? c.dateGrouping.field;
      if (
        field !==
          (resolveFieldName(schema, c.groupBy[0] ?? "") ?? c.groupBy[0]) ||
        schema.fields.find((f) => f.name === field)?.type !== "datetime"
      )
        throw new FormulaError(
          "Date grouping must use the first grouping field, with a datetime type.",
        );
      const { occurrence } = c.dateGrouping;
      if (occurrence) {
        if (distributionActive(c) && c.distribution!.kind !== "box")
          throw new FormulaError(
            "Occurrences summarise as a mean or a box plot, not a histogram.",
          );
        if (c.display?.kind === "scatter")
          throw new FormulaError(
            "Occurrences summarise single-value metrics, not scatters.",
          );
        if (c.window || c.share !== undefined)
          throw new FormulaError(
            "Windows and shares do not apply to occurrences of a slot.",
          );
      } else if (distributionActive(c))
        throw new FormulaError(
          "Date grouping currently supports scalar metrics, not distributions.",
        );
    }
    if (
      c.groupLimit !== undefined &&
      (!Number.isInteger(c.groupLimit) ||
        c.groupLimit < 1 ||
        c.groupLimit > 10000)
    )
      throw new FormulaError("Group limit must be 1–10,000.");
    if (c.minCount !== undefined) validateMinCount(c, schema);
    validateMetricWhere(c.where, schema);
    for (const s of c.sort ?? []) {
      if (s.key === "y" && c.display?.kind !== "scatter")
        throw new FormulaError("Y sorting requires a scatter metric.");
      if (s.key === "samples" && !distributionActive(c))
        throw new FormulaError(
          "Sample sorting requires a distribution metric.",
        );
      if (
        s.key.startsWith("group") &&
        Number(s.key.slice(5)) >= c.groupBy.length
      )
        throw new FormulaError("Sort refers to an unavailable grouping key.");
    }
    const compiled = metricPlans(c, schema, resolve);
    if (c.scope !== "shownRows" && compiled.some(hasRegex))
      throw new FormulaError("Regex is unavailable for all-matching metrics.");
    validateMetricSeries(c, compiled[0]!);
    return [];
  } catch (e) {
    return [
      {
        message: e instanceof Error ? e.message : String(e),
        from: e instanceof FormulaError ? e.from : 0,
        to: e instanceof FormulaError ? e.to : 1,
      },
    ];
  }
}
/** The threshold of `AggregationClause.minCount` in either form. */
export function metricMinCount(
  c: { minCount?: AggregationClause["minCount"] | undefined },
): number | undefined {
  const m = c.minCount;
  return m === undefined ? undefined : typeof m === "number" ? m : m?.min;
}
/** What an object `minCount` measures: the aggregate whose value per group
 * must reach `min`. Undefined when `minCount` counts rows. */
export function metricMinCountMeasure(
  c: { minCount?: AggregationClause["minCount"] | undefined },
): { op: "count_distinct" | "sum"; field: string } | undefined {
  const m = c.minCount;
  if (m === undefined || m === null || typeof m !== "object") return undefined;
  return m.distinct !== undefined
    ? { op: "count_distinct", field: m.distinct }
    : { op: "sum", field: m.sum! };
}
/** A minimum in words: "3 rows", "5 distinct Conversation values" or
 * "10 total Calls". `label` names a field (default: its name). */
export function metricMinCountText(
  c: { minCount?: AggregationClause["minCount"] | undefined },
  label: (field: string) => string = (field) => field,
): string | undefined {
  const min = metricMinCount(c),
    measure = metricMinCountMeasure(c);
  if (min === undefined) return undefined;
  const n = min.toLocaleString();
  if (!measure) return `${n} ${min === 1 ? "row" : "rows"}`;
  return measure.op === "sum"
    ? `${n} total ${label(measure.field)}`
    : `${n} distinct ${label(measure.field)} ${min === 1 ? "value" : "values"}`;
}
/** The aggregate plan of an object `minCount`, such as SUM([calls]). */
export function metricMinCountPlan(
  c: { minCount?: AggregationClause["minCount"] | undefined },
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): MetricPlan | undefined {
  const measure = metricMinCountMeasure(c);
  return measure
    ? compileMetric(
        metricExpression({
          id: "",
          groupBy: [],
          op: measure.op,
          field: resolveFieldName(schema, measure.field) ?? measure.field,
        }),
        schema,
        resolve,
      )
    : undefined;
}
/** Whether a group survives `minCount`. Calendar fill-ins (no rows) always do.
 * Otherwise the row count, or for an object `minCount` the group's measure
 * (null counts as 0), must reach `min`. A measure that is an error keeps its
 * group, so the error stays visible. */
export function metricMinCountKeeps(
  min: number,
  count: number,
  measure?: { value: unknown; error?: string | undefined },
): boolean {
  if (count === 0) return true;
  if (!measure) return count >= min;
  return measure.error !== undefined || Number(measure.value ?? 0) >= min;
}
/** A row-count minimum, or exactly one of a distinct or summed schema field. */
function validateMinCount(c: AggregationClause, schema: FieldSchema): void {
  const m = c.minCount as unknown;
  const measured = m !== null && typeof m === "object";
  const min = measured ? (m as { min?: unknown }).min : m;
  const label = measured ? "Minimum per group" : "Minimum rows per group";
  if (
    typeof min !== "number" ||
    !Number.isInteger(min) ||
    min < 1 ||
    min > 1000000
  )
    throw new FormulaError(`${label} must be 1–1,000,000.`);
  if (measured) {
    const o = m as Record<string, unknown>;
    if (
      Object.keys(o).some((k) => !["min", "distinct", "sum"].includes(k)) ||
      (o.distinct === undefined) === (o.sum === undefined)
    )
      throw new FormulaError(
        "A minimum per group needs exactly one of distinct and sum.",
      );
    const name = o.distinct ?? o.sum;
    const op = o.distinct !== undefined ? "count_distinct" : "sum";
    const resolved =
      typeof name === "string" ? (resolveFieldName(schema, name) ?? name) : "";
    const field = schema.fields.find((f) => f.name === resolved);
    if (op === "sum" && field && field.type !== "number")
      throw new FormulaError(
        `A summed minimum requires a numeric field, not ${resolved}.`,
      );
    if (
      !field ||
      isComputedField(resolved) ||
      !isMeasurable(field) ||
      !aggOpsForField(field).includes(op)
    )
      throw new FormulaError(
        op === "sum"
          ? `Field ${String(name)} cannot be summed for a minimum per group.`
          : `Field ${String(name)} cannot count distinct values for a minimum per group.`,
      );
    if (distributionActive(c))
      throw new FormulaError(
        "A distinct or summed minimum currently supports scalar metrics, not distributions.",
      );
    if (c.window && op === "count_distinct")
      throw new FormulaError(
        "A distinct minimum cannot be combined across a window's intervals.",
      );
    if (c.dateGrouping?.occurrence)
      throw new FormulaError(
        "A distinct or summed minimum does not apply to occurrences of a slot; use a minimum of rows.",
      );
  }
  if (!c.groupBy.length)
    throw new FormulaError(`${label} requires at least one grouping field.`);
}
/** A metric WHERE follows the table WHERE's allowlist and operators. Regex is
 * refused on every engine; local computed inputs need filter authority. */
function validateMetricWhere(
  where: readonly WhereTerm[] | undefined,
  schema: FieldSchema,
): void {
  if (where === undefined) return;
  if (!Array.isArray(where)) throw new FormulaError("Invalid metric filter.");
  const predicates = where.flatMap((term) => predicatesOf(term));
  if (predicates.length > MAX_WHERE_CLAUSES)
    throw new FormulaError(
      `A metric filter allows at most ${MAX_WHERE_CLAUSES} predicates.`,
    );
  const fields = indexFields(schema);
  for (const p of predicates) {
    const name = resolveFieldName(schema, p.field) ?? p.field;
    const field = fields.get(name);
    if (
      !field ||
      !isFilterable(field) ||
      (isComputedField(name) && !computedInputAllowed(schema, name, "filter"))
    )
      throw new FormulaError(`Field ${p.field} cannot filter metrics.`);
    if (p.op === "matches_regex" || p.op === "not_matches_regex")
      throw new FormulaError("Regex is unavailable in metric filters.");
    if (!opsForField(field).includes(p.op))
      throw new FormulaError(
        `Field ${p.field} does not support the ${p.op} filter.`,
      );
  }
}
/** Executor support for population controls, from either capability handshake. */
export interface MetricPopulationSupport {
  filters?: boolean | undefined;
  minCount?: boolean | undefined;
  /** A `minCount` object: distinct values or a sum of a field. */
  minCountMeasures?: boolean | undefined;
}
/** A clause the executor cannot run exactly gets its own error; it is never
 * sent with `where`/`minCount` silently dropped. */
export function metricPopulationError(
  clause: Pick<AggregationClause, "where" | "minCount">,
  support: MetricPopulationSupport,
): string | undefined {
  if (clause.where?.length && !support.filters)
    return "This server does not support metric filters.";
  if (clause.minCount !== undefined && !support.minCount)
    return "This server does not support a minimum rows per group.";
  if (metricMinCountMeasure(clause) && !support.minCountMeasures)
    return "This server does not support a minimum of distinct values or a sum per group.";
  return undefined;
}
export function metricDependencies(
  c: AggregationClause,
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): string[] {
  return [
    ...new Set([
      ...c.groupBy.map((name) => resolveFieldName(schema, name) ?? name),
      ...metricPlans(c, schema, resolve).flatMap((p) => p.dependencies),
      // An invalid minimum fails validation, not dependency discovery.
      ...((() => {
        try {
          return metricMinCountPlan(c, schema, resolve)?.dependencies;
        } catch {
          return undefined;
        }
      })() ?? []),
    ]),
  ].sort();
}
export function metricComputationKey(
  clauses: readonly AggregationClause[],
): string {
  return JSON.stringify(
    clauses
      .map((c) => ({
        id: c.id,
        diagnostics: c.diagnostics,
        unsupportedOp: c.unsupportedOp,
        expression:
          distributionActive(c) && !occurrenceDistribution(c)
            ? undefined
            : metricExpression(c),
        expressionY: c.display?.kind === "scatter" ? c.expressionY : undefined,
        scope: c.scope ?? "allMatching",
        groupBy: c.groupBy,
        dateGrouping: c.dateGrouping,
        sort: c.sort,
        groupLimit: c.groupLimit,
        where: c.where,
        minCount: c.minCount,
        window: c.window,
        share: c.share,
        distribution: distributionActive(c) ? c.distribution : undefined,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}
export function toMetricQuery<Row>(
  q: QueryState,
  schema: FieldSchema<Row>,
  execution?: ComputedExecution,
): MetricQuery {
  const originalSchema = schema;
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  // A local computed field never establishes remote authority.
  for (const [name, prior] of fields)
    if (isComputedField(name))
      fields.set(name, {
        ...prior,
        aggregate: { measure: false, groupable: false },
      });
  for (const [name, cap] of Object.entries(execution?.fields ?? {}))
    if (isComputedField(name)) {
      const prior = fields.get(name);
      fields.set(name, {
        ...prior,
        name,
        label: prior?.label ?? name,
        type: cap.type,
        source: { kind: "backend" },
        filter: { enabled: false },
        sort: { enabled: cap.sort },
        aggregate: {
          ...prior?.aggregate,
          measure: cap.measure,
          groupable: cap.group,
        },
      });
    }
  schema = { ...schema, fields: [...fields.values()] };
  const raw = q;
  q = normalizeQueryState(q);
  const server = toServerQuery(q, schema);
  const metricWhere = new Map<string, WhereTerm[]>();
  for (const c of q.aggregations ?? [])
    if (c.where?.length) {
      const pushed = toServerQuery({ ...EMPTY_QUERY, where: c.where }, schema)
        .where;
      metricWhere.set(c.id, pushed);
    }
  const metrics = (q.aggregations ?? []).map((c) => {
    const {
      label,
      layout,
      display,
      distribution,
      expression,
      expressionY,
      dateGrouping,
      where,
      window: _window,
      share: _share,
      ...rest
    } = c;
    return {
      ...rest,
      ...(where?.length ? { where: metricWhere.get(c.id) ?? [] } : {}),
      ...(!distributionActive(c) && expression !== undefined
        ? { expression }
        : {}),
      ...(display?.kind === "scatter"
        ? {
            display: { kind: "scatter" as const },
            ...(expressionY !== undefined ? { expressionY } : {}),
          }
        : {}),
      ...(distributionActive(c) && distribution ? { distribution } : {}),
    };
  });
  const diagnostics = (q.aggregations ?? []).flatMap((c) =>
    validateMetric(c, schema).map((d) => ({
      ...d,
      metricId: c.id,
      code: "invalid_metric",
    })),
  );
  for (const c of q.aggregations ?? [])
    if (c.where?.length && metricWhere.get(c.id)?.length !== c.where.length)
      diagnostics.push({
        metricId: c.id,
        code: "residual_metric_filter",
        from: 0,
        to: 1,
        message: "Metric filters must use server-filterable fields.",
      });
  // Servers never compute windows, shares, whole intervals or occurrences; sending the
  // clause unexpanded would silently return the plain metric.
  for (const c of q.aggregations ?? [])
    if (hasMetricSeries(c))
      diagnostics.push({
        metricId: c.id,
        code: "unexpanded_series",
        from: 0,
        to: 1,
        message:
          "Windows, shares, whole intervals and occurrences are computed from plain metrics; expand the query with planMetricSeries first.",
      });
  for (const c of q.aggregations ?? [])
    if (c.dateGrouping)
      diagnostics.push({
        metricId: c.id,
        code: "unsupported_date_grouping",
        from: 0,
        to: 1,
        message: "Date grouping currently requires local metric execution.",
      });
  try {
    assertMetricQueryState(raw, originalSchema);
  } catch (e) {
    diagnostics.push({
      message: String(e),
      from: 0,
      to: 1,
      metricId: "",
      code: "invalid_query",
    });
  }
  const ids = new Set<string>();
  for (const c of q.aggregations ?? []) {
    if (ids.has(c.id))
      diagnostics.push({
        message: "Duplicate metric ID.",
        from: 0,
        to: 1,
        metricId: c.id,
        code: "duplicate_metric",
      });
    ids.add(c.id);
  }
  if (
    server.where.length !== q.where.length ||
    queryStateKey(raw.where) !== queryStateKey(q.where)
  )
    diagnostics.push({
      message: "Metrics unavailable with residual client-only filters.",
      from: 0,
      to: 1,
      metricId: "",
      code: "residual_filter",
    });
  for (const c of q.aggregations ?? []) {
    try {
      for (const name of metricDependencies(c, schema))
        if (isComputedField(name)) {
          const revision =
            execution?.resolvedRevisions[name] ??
            execution?.resolvedRevisions[name.slice("@computed/".length)];
          if (
            typeof revision !== "string" ||
            !revision ||
            revision.length > 256
          )
            diagnostics.push({
              metricId: c.id,
              code: "definition_revision",
              message: `Missing expected revision for ${name}.`,
              from: 0,
              to: 1,
            });
          if (!execution?.fields[name])
            diagnostics.push({
              metricId: c.id,
              code: "unsupported_computed",
              message: `Missing server capability for ${name}.`,
              from: 0,
              to: 1,
            });
        }
    } catch {
      /* compilation diagnostic already included */
    }
  }
  // Row and metric page membership share effective defaults and v2 gates.
  const rowProjection = toServerQueryV2(
    { ...q, select: [{ field: schema.idField }] },
    originalSchema,
    execution ?? {
      profile: "",
      planToken: "",
      fields: {},
      resolvedRevisions: {},
    },
  );
  if (q.aggregations?.some((c) => c.scope === "shownRows"))
    diagnostics.push(
      ...rowProjection.diagnostics.map((d) => ({
        ...d,
        metricId: "",
        code: d.code ?? "residual_order",
      })),
    );
  return {
    version: 2,
    where: server.where,
    orderBy: rowProjection.orderBy,
    limit: q.limit,
    offset: q.offset,
    metrics,
    diagnostics,
    ...(execution
      ? {
          profile: execution.profile,
          expectedRevisions: { ...execution.resolvedRevisions },
          planToken: execution.planToken,
          ...(execution.snapshot !== undefined
            ? { snapshot: execution.snapshot }
            : {}),
        }
      : {}),
  };
}
function queryStateKey(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
/** Reject normalization losses before claiming an exact population. */
function assertMetricQueryState<Row>(
  q: QueryState,
  schema: FieldSchema<Row>,
): void {
  const normalized = normalizeQueryState(q);
  if ((q.aggregations?.length ?? 0) !== (normalized.aggregations?.length ?? 0))
    throw Error("Malformed metric definitions cannot be dropped.");
  const orderBy = q.orderBy.length ? q.orderBy : (schema.defaultSort ?? []);
  const normalizedOrder = normalizeQueryState({ ...q, orderBy }).orderBy;
  if (
    queryStateKey(q.where) !== queryStateKey(normalized.where) ||
    queryStateKey(orderBy) !== queryStateKey(normalizedOrder) ||
    q.limit !== normalized.limit ||
    q.offset !== normalized.offset
  )
    throw Error("Malformed metric query state cannot be executed exactly.");
}
/** Safe pre-worker page selection. A supplied committed page needs no query execution.
 * Query regex is never executed here; all-matching regex filtering is unsupported. */
export function selectMetricShownRows<Row>(
  rows: Row[],
  q: QueryState,
  schema: FieldSchema<Row>,
  options: MetricEvaluationOptions<Row> = {},
): Row[] {
  if (options.signal?.aborted) throw Error("Metric evaluation cancelled.");
  assertMetricQueryState(q, schema);
  if (options.shownRows) return options.shownRows;
  const orderBy = q.orderBy.length ? q.orderBy : (schema.defaultSort ?? []);
  assertMetricPopulation(q, schema, orderBy);
  if (rows.length > (options.maxRows ?? 1000000))
    throw Error("Metric row budget exceeded.");
  if ((options.maxOperations ?? 10000000) <= 0)
    throw Error("Metric operation budget exceeded.");
  return applyQuery(
    rows,
    // Local tables use a stable sort: ties retain input order. An extra ID
    // sort here would choose a different page than the one the table shows.
    { ...q, orderBy },
    schema,
    options,
  ).rows;
}
function assertMetricPopulation<Row>(
  q: QueryState,
  schema: FieldSchema<Row>,
  orderBy: QueryState["orderBy"],
): void {
  const fields = indexFields(schema);
  if (
    q.where.some((t) =>
      predicatesOf(t).some(
        (p) => p.op === "matches_regex" || p.op === "not_matches_regex",
      ),
    ) ||
    orderBy.some((s) => s.extract !== undefined)
  )
    throw Error(
      "Query regex requires isolated execution; unavailable for metric population selection.",
    );
  if (
    q.where.some((t) =>
      predicatesOf(t).some(
        (p) =>
          isComputedField(p.field) && !computedInputAllowed(schema, p.field, "filter") ||
          !fields.has(resolveFieldName(schema, p.field) ?? p.field),
      ),
    )
  )
    throw Error("Metric filter references an unavailable field.");
  if (
    orderBy.some(
      (s) =>
        isComputedField(s.field) && !computedInputAllowed(schema, s.field, "sort") ||
        !fields.has(resolveFieldName(schema, s.field) ?? s.field),
    )
  )
    throw Error("Shown-row ordering requires an authoritative committed page.");
}
export interface MetricEvaluationOptions<Row = unknown>
  extends QueryEvaluationOptions,
    MetricReductionOptions {
  resolveComputed?: (name: string) => FormulaPlan | undefined;
  /** Called only for regex row ASTs, using cached results from a terminable worker. */
  evaluateInput?: (
    node: FormulaNode,
    row: Row,
    plan: FormulaPlan,
  ) => FormulaResult;
  /** Exact committed page supplied by the host after filters/order/window. */
  /** Escaped tuple length bound, in UTF-16 code units (default 65,536). */
  maxGroupKeyLength?: number;
  /** Retained group keys, map/bucket overhead and row references, plus key scratch space (default 16 MB). */
  maxGroupBytes?: number;
  shownRows?: Row[];
  maxRows?: number;
  maxGroups?: number;
  /** Per-metric operation budget (default 10,000,000, allowing simple paired
   * aggregates across the default one-million-row population limit). */
  maxOperations?: number;
  /** @deprecated Regex requires cached evaluateInput; this flag grants no execution permission. */ allowRegex?: boolean;
  signal?: AbortSignal;
}
const scalar = (v: unknown): MetricValue => {
  if (v instanceof Date) return v.toISOString();
  if (v == null) return null;
  if (
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  )
    return v;
  throw Error("Metric keys and values must be finite scalars.");
};
/** JSON string length without allocating escaped text; scan only bounded input. */
function groupStringLength(value: string, limit: number): number {
  let length = value.length + 2;
  if (length > limit)
    throw Error("Metric grouping key length budget exceeded.");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    )
      length++;
    else if (code < 32) length += 5;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    )
      i++;
    else if (code >= 0xd800 && code <= 0xdfff) length += 5;
    if (length > limit)
      throw Error("Metric grouping key length budget exceeded.");
  }
  return length;
}
/** Typed lexicographic ordering with null placement independent of direction. */
export function compareMetricValues(a: MetricValue, b: MetricValue): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const ac = Array.from(a),
      bc = Array.from(b);
    for (let i = 0; i < Math.min(ac.length, bc.length); i++) {
      const diff = ac[i]!.codePointAt(0)! - bc[i]!.codePointAt(0)!;
      if (diff) return Math.sign(diff);
    }
    return Math.sign(ac.length - bc.length);
  }
  return a < b ? -1 : 1;
}
/** Order buckets as a metric result: errors last, then `clause.sort`
 * (chronological for calendar groups, largest value first otherwise), then keys. */
export function sortMetricBuckets(
  buckets: AggregationBucket[],
  c: Pick<AggregationClause, "sort" | "dateGrouping">,
): AggregationBucket[] {
  const ordering: MetricSort[] = c.sort?.length
    ? c.sort
    : c.dateGrouping
      ? [{ key: "group0", dir: "asc", nulls: "last" }]
      : [{ key: "value", dir: "desc", nulls: "last" }];
  const target = (b: AggregationBucket, s: MetricSort): MetricValue =>
    s.key === "samples"
      ? b.count - (b.nullCount ?? 0) - (b.inputErrorCount ?? 0)
      : s.key.startsWith("group")
        ? (b.keys[Number(s.key.slice(5))] ?? null)
        : s.key === "count"
          ? b.count
          : s.key === "y"
            ? (b.y ?? null)
            : b.value;
  return buckets.sort((a, b) => {
    if (!!(a.error || a.yError) !== !!(b.error || b.yError))
      return a.error || a.yError ? 1 : -1;
    for (const s of ordering) {
      const av = target(a, s),
        bv = target(b, s);
      const cmp =
        av === null || bv === null
          ? av === bv
            ? 0
            : (av === null ? 1 : -1) * (s.nulls === "first" ? -1 : 1)
          : compareMetricValues(av, bv) * (s.dir === "asc" ? 1 : -1);
      if (cmp) return cmp;
    }
    for (let i = 0; i < a.keys.length; i++) {
      const cmp = compareMetricValues(a.keys[i]!, b.keys[i]!);
      if (cmp) return cmp;
    }
    return 0;
  });
}
export function evaluateMetrics<Row>(
  rows: Row[],
  q: QueryState,
  schema: FieldSchema<Row>,
  options: MetricEvaluationOptions<Row> = {},
): AggregationResult {
  if (q.grouping) {
    try {
      if (options.signal?.aborted) throw new Error("Metric evaluation cancelled.");
      if (rows.length > (options.maxRows ?? 1_000_000)) throw new Error("Metric row budget exceeded.");
      const now = evaluationTime(options);
      const prepared = prepareGrouping(rows, schema, q.grouping, { now });
      return evaluateMetrics(prepared.rows, withoutGrouping(q), prepared.schema, {
        ...options, now,
      } as unknown as MetricEvaluationOptions<GroupedRow>);
    } catch (error) {
      return { metrics: (q.aggregations ?? []).map(metric => ({ id: metric.id, buckets: [], error: error instanceof Error ? error.message : String(error) })) };
    }
  }
  const now = evaluationTime(options),
    fields = indexFields(schema);
  const series = planMetricSeries(q, schema, {
    now,
    ...(options.resolveComputed ? { resolveComputed: options.resolveComputed } : {}),
  });
  if (series)
    return {
      metrics: series.combine(
        series.queries.flatMap(
          (part) => evaluateMetrics(rows, part, schema, { ...options, now }).metrics,
        ),
      ),
    };
  let matching: Row[] | undefined;
  let shown: Row[] | undefined;
  return {
    metrics: (q.aggregations ?? []).map((c) => {
      let budget = options.maxOperations ?? 10000000;
      const tick = () => {
        if (--budget < 0) throw Error("Metric operation budget exceeded.");
        if (options.signal?.aborted)
          throw Error("Metric evaluation cancelled.");
      };
      try {
        if (options.signal?.aborted)
          throw Error("Metric evaluation cancelled.");
        assertMetricQueryState(q, schema);
        if ((q.aggregations?.length ?? 0) > 20)
          throw Error("At most 20 metrics are allowed.");
        const diagnostics = validateMetric(c, schema, options.resolveComputed);
        if (diagnostics.length)
          throw Error(diagnostics.map((d) => d.message).join(" "));
        const ps = metricPlans(c, schema, options.resolveComputed);
        if (ps.some(hasRegex) && !options.evaluateInput)
          throw Error(
            "Regex metrics require an isolated worker with a watchdog.",
          );
        let inputRows: Row[];
        if (c.scope === "shownRows")
          inputRows = shown ??= selectMetricShownRows(rows, q, schema, options);
        else {
          if (!matching) {
            assertMetricPopulation(q, schema, []);
            if (rows.length > (options.maxRows ?? 1000000))
              throw Error("Metric row budget exceeded.");
            matching = applyQuery(
              rows,
              { ...q, orderBy: [], offset: 0, limit: Number.MAX_SAFE_INTEGER },
              schema,
              { now },
            ).rows;
          }
          inputRows = matching;
        }
        if (inputRows.length > (options.maxRows ?? 1000000))
          throw Error("Metric row budget exceeded.");
        // processedRows retains the scope population; this metric's own
        // predicate narrows the rows it reduces, inside a shown page as well.
        const population = inputRows.length;
        if (c.where?.length)
          inputRows = applyQuery(
            inputRows,
            {
              ...EMPTY_QUERY,
              where: c.where,
              limit: Number.MAX_SAFE_INTEGER,
            },
            schema,
            { now },
          ).rows;
        const groups = new Map<string, { keys: MetricValue[]; rows: Row[] }>();
        const keyLimit = options.maxGroupKeyLength ?? 65536,
          byteLimit = options.maxGroupBytes ?? 16000000;
        if (
          ![keyLimit, byteLimit].every((v) => Number.isSafeInteger(v) && v >= 0)
        )
          throw Error("Invalid grouping budget.");
        let groupBytes = 0;
        const reserve = (bytes: number) => {
          if (bytes > byteLimit - groupBytes)
            throw Error("Metric grouping retained-memory budget exceeded.");
        };
        if (!c.groupBy.length) {
          if (keyLimit < 2)
            throw Error("Metric grouping key length budget exceeded.");
          reserve(256);
          groupBytes = 256;
          groups.set("[]", { keys: [], rows: [] });
        }
        // Retain only the most recent calendar interval. Dense timestamp rows
        // share its boundaries and ISO key without repeating timezone work.
        // The half-open interval also separates repeated/partial DST hours;
        // out-of-order rows outside it always recompute the correct bucket.
        let dateStart = Infinity,
          dateEnd = -Infinity,
          dateKey: MetricValue = "";
        let dateInput: MetricValue | undefined,
          dateTime = NaN;
        for (const row of inputRows) {
          tick();
          if (!c.groupBy.length) {
            reserve(16);
            groupBytes += 16;
            groups.get("[]")!.rows.push(row);
            continue;
          }
          const keys = c.groupBy.map((k) =>
            scalar(
              readFieldValue(
                fields.get(resolveFieldName(schema, k) ?? k)!,
                row,
              ),
            ),
          );
          if (c.dateGrouping && keys[0] !== null) {
            const config = c.dateGrouping;
            // Repeated date-only values would otherwise resolve local midnight
            // through Temporal for every row as well.
            if (keys[0] !== dateInput) {
              dateTime = metricDateTime(keys[0]!, config.timeZone);
              dateInput = keys[0];
            }
            if (dateTime < dateStart || dateTime >= dateEnd) {
              dateStart = metricDateFloor(
                dateTime,
                config.interval,
                config.timeZone,
              );
              dateEnd = metricDateNext(
                dateStart,
                config.interval,
                config.timeZone,
              );
              // A cyclic slot is the local hour or weekday of the interval
              // its record falls in; a calendar key is the interval start.
              dateKey = isMetricCycle(config.interval)
                ? metricCycleSlot(dateStart, config.interval, config.timeZone)
                : new Date(dateStart).toISOString();
            }
            keys[0] = dateKey;
          }
          // Measure escaping without allocating a serialized key. Check BEFORE
          // stringify: shared source strings must not amplify into unbounded map keys. Charge source payload again
          // per group, even if shared, plus tuple slots, buckets and map overhead.
          let keyLength = 1,
            payloadBytes = 0;
          for (const value of keys) {
            keyLength +=
              1 +
              (typeof value === "string"
                ? groupStringLength(value, keyLimit - keyLength - 1)
                : value === null
                  ? 4
                  : typeof value === "boolean"
                    ? value
                      ? 4
                      : 5
                    : String(value).length);
            payloadBytes += typeof value === "string" ? 2 * value.length : 8;
            if (keyLength > keyLimit)
              throw Error("Metric grouping key length budget exceeded.");
          }
          const retainedBytes =
            256 + 16 * keys.length + payloadBytes + 2 * keyLength;
          // Reserve a candidate group plus serialization scratch, even for a
          // duplicate; this deliberately conservative check needs no large key.
          reserve(retainedBytes + 2 * keyLength + 16);
          const key = JSON.stringify(keys);
          let g = groups.get(key);
          if (!g) {
            if (groups.size >= (options.maxGroups ?? 10000))
              throw Error("Metric group budget exceeded.");
            g = { keys, rows: [] };
            groups.set(key, g);
            groupBytes += retainedBytes;
          }
          groupBytes += 16;
          g.rows.push(row);
        }
        if (c.dateGrouping?.includeEmpty) {
          const config = c.dateGrouping;
          const observed: number[] = [];
          const series = new Map<string, MetricValue[]>();
          for (const group of groups.values())
            if (group.keys[0] !== null) {
              tick();
              reserve(8);
              groupBytes += 8;
              if (!isMetricCycle(config.interval))
                observed.push(metricDateTime(group.keys[0]!));
              const tuple = group.keys.slice(1);
              const key = JSON.stringify(tuple);
              if (!series.has(key)) {
                const bytes = 128 + 16 * tuple.length + 2 * key.length;
                reserve(bytes);
                groupBytes += bytes;
                series.set(key, tuple);
              }
            }
          if (c.groupBy.length === 1 && !series.size) {
            reserve(132);
            groupBytes += 132;
            series.set("[]", []);
          }
          // Every slot of a cycle exists, whatever the date range.
          const slots = isMetricCycle(config.interval)
            ? metricCycleSlots(config.interval)
            : undefined;
          for (const slot of slots ?? [])
            for (const tuple of series.values()) {
              tick();
              const keys: MetricValue[] = [slot, ...tuple];
              const key = JSON.stringify(keys);
              if (key.length > keyLimit)
                throw Error("Metric grouping key length budget exceeded.");
              if (!groups.has(key)) {
                if (groups.size >= (options.maxGroups ?? 10000))
                  throw Error("Metric group budget exceeded.");
                const bytes = 256 + 16 * keys.length + 4 * key.length;
                reserve(bytes);
                groupBytes += bytes;
                groups.set(key, { keys, rows: [] });
              }
            }
          const range = slots
            ? undefined
            : metricDateRange(
                config,
                q,
                observed,
                now,
                (name) => resolveFieldName(schema, name) ?? name,
              );
          if (range)
            for (let time = range[0]; time <= range[1]; ) {
              tick();
              for (const tuple of series.values()) {
                tick();
                const keys: MetricValue[] = [
                  new Date(time).toISOString(),
                  ...tuple,
                ];
                const key = JSON.stringify(keys);
                if (key.length > keyLimit)
                  throw Error("Metric grouping key length budget exceeded.");
                if (!groups.has(key)) {
                  if (groups.size >= (options.maxGroups ?? 10000))
                    throw Error("Metric group budget exceeded.");
                  const bytes = 256 + 16 * keys.length + 4 * key.length;
                  reserve(bytes);
                  groupBytes += bytes;
                  groups.set(key, { keys, rows: [] });
                }
              }
              const next = metricDateNext(
                time,
                config.interval,
                config.timeZone,
              );
              if (!Number.isFinite(next) || next <= time)
                throw Error("Date grouping exceeds calendar limits.");
              time = next;
            }
        }
        const inputs = (
          row: Row,
          p: FormulaPlan,
        ): Record<string, FormulaValue> =>
          Object.fromEntries(
            p.dependencies.map((name) => [
              name,
              (() => {
                const value = readFieldValue(fields.get(name)!, row);
                return value instanceof Date
                  ? value.toISOString()
                  : (value ?? null);
              })(),
            ]),
          ) as Record<string, FormulaValue>;
        const nodeCosts = new Map<FormulaNode, number>();
        const cost = (n: FormulaNode): number => {
          const known = nodeCosts.get(n);
          if (known !== undefined) return known;
          const value =
            1 +
            (n.kind === "call" ? n.args.reduce((s, a) => s + cost(a), 0) : 0);
          nodeCosts.set(n, value);
          return value;
        };
        const rowEval = (node: FormulaNode, row: Row, p: FormulaPlan) => {
          budget -= cost(node);
          tick();
          // A direct aggregate input needs only its own binding, even when the
          // composed metric reaches many other fields. Keep runtime validation.
          if (node.kind === "field") {
            const value = readFieldValue(fields.get(node.name)!, row);
            return formulaRuntime(node, {
              [node.name]:
                value instanceof Date
                  ? value.toISOString()
                  : ((value ?? null) as FormulaValue),
            });
          }
          return options.evaluateInput && hasRegex({ ...p, ast: node })
            ? options.evaluateInput(node, row, p)
            : formulaRuntime(node, inputs(row, p));
        };
        const reduce = (
          p: FormulaPlan,
          rs: Row[],
          inputErrors: Set<number>,
        ): FormulaResult => {
          const cache = new Map<FormulaNode, FormulaResult>();
          return checkedMetricResult(
            formulaRuntime(p.ast, {}, (node) => {
              if (!aggregates.has(node.name)) return undefined;
              if (cache.has(node)) return cache.get(node)!;
              let result: FormulaResult;
              try {
                function* results(): Generator<FormulaResult> {
                  for (let i = 0; i < rs.length; i++) {
                    tick();
                    const v = node.args[0]
                      ? rowEval(node.args[0], rs[i]!, p)
                      : { value: 1 };
                    if (v.error) inputErrors.add(i);
                    yield v;
                  }
                }
                result = reduceResults(node, results(), options);
              } catch (e) {
                result = {
                  value: null,
                  error: e instanceof Error ? e.message : String(e),
                };
              }
              cache.set(node, result);
              return result;
            }),
          );
        };
        const populations = new Map<AggregationBucket, number[]>();
        // An object minCount measures each group with its own aggregate, with
        // the same semantics as that aggregate in a metric expression.
        const minPlan = metricMinCountPlan(c, schema, options.resolveComputed);
        const measures = new Map<AggregationBucket, FormulaResult>();
        let buckets: AggregationBucket[] = [...groups.values()].map((g) => {
          const bucket: AggregationBucket = {
            keys: g.keys,
            count: g.rows.length,
            value: null,
          };
          if (minPlan && g.rows.length)
            measures.set(bucket, reduce(minPlan, g.rows, new Set()));
          if (distributionActive(c)) {
            const values: number[] = [];
            bucket.nullCount = 0;
            bucket.inputErrorCount = 0;
            for (const row of g.rows) {
              const r = checkedMetricResult(rowEval(ps[0]!.ast, row, ps[0]!));
              if (r.error) {
                bucket.inputErrorCount++;
                bucket.error = r.error;
              } else if (r.value === null) bucket.nullCount++;
              else values.push(Number(r.value));
            }
            populations.set(bucket, values);
          } else {
            if (c.dateGrouping && !g.rows.length) {
              const empty = (p: FormulaPlan) =>
                p.ast.kind === "call" &&
                ["COUNT", "COUNT_DISTINCT", "SUM"].includes(p.ast.name)
                  ? 0
                  : null;
              bucket.value = empty(ps[0]!);
              if (ps[1]) bucket.y = empty(ps[1]);
              return bucket;
            }
            const inputErrors = new Set<number>();
            const x = reduce(ps[0]!, g.rows, inputErrors);
            bucket.value = scalar(x.value);
            if (x.error) bucket.error = x.error;
            if (ps[1]) {
              const y = reduce(ps[1], g.rows, inputErrors);
              bucket.y = scalar(y.value);
              if (y.error) bucket.yError = y.error;
            }
            if (inputErrors.size) bucket.inputErrorCount = inputErrors.size;
          }
          return bucket;
        });
        if (distributionActive(c)) {
          const d = c.distribution!;
          if (d.kind === "histogram" && buckets.some((b) => b.error))
            throw Error(
              "Histogram input errors prevent an exact shared extent.",
            );
          const all: number[] = [];
          for (const values of populations.values())
            for (const v of values) all.push(v);
          const edges =
            d.kind === "histogram" ? histogramEdges(all, d.bins ?? 10) : [];
          for (const b of buckets) {
            const vs = populations.get(b)!;
            if (b.error) continue;
            if (d.kind === "box") {
              const summary = boxSummary(vs, d.whiskers);
              b.distribution = { kind: "box", summary };
              b.value = summary?.median ?? null;
            } else {
              b.distribution = {
                kind: "histogram",
                edges: [...edges],
                counts: histogramCounts(vs, edges),
                n: vs.length,
              };
              b.value = vs.length;
            }
          }
        }
        // Calendar fill-ins are the only empty groups; they are never hidden.
        // Hidden groups leave the ranking, the result limit and Other.
        let hiddenGroups: number | undefined;
        const min = metricMinCount(c);
        if (min !== undefined) {
          const kept = buckets.filter((b) =>
            metricMinCountKeeps(min, b.count, minPlan ? measures.get(b) : undefined),
          );
          hiddenGroups = buckets.length - kept.length;
          buckets = kept;
        }
        sortMetricBuckets(buckets, c);
        tick();
        const groupCount = buckets.length;
        let other: AggregationBucket | undefined;
        if (c.groupLimit && buckets.length > c.groupLimit) {
          const omitted = buckets.slice(c.groupLimit),
            ast = ps[0]!.ast;
          if (
            !distributionActive(c) &&
            ast.kind === "call" &&
            ["SUM", "COUNT"].includes(ast.name) &&
            omitted.every(
              (b) =>
                !b.error &&
                (typeof b.value === "number" ||
                  (ast.name === "SUM" && b.value === null)),
            )
          ) {
            const value = omitted.reduce((s, b) => s + Number(b.value), 0);
            if (
              Number.isFinite(value) &&
              (!Number.isInteger(value) || Number.isSafeInteger(value))
            )
              other = {
                keys: [],
                value,
                count: omitted.reduce((s, b) => s + b.count, 0),
              };
          }
          buckets = buckets.slice(0, c.groupLimit);
        }
        return {
          id: c.id,
          buckets,
          scope: c.scope ?? "allMatching",
          processedRows: population,
          groupCount,
          coverage: "exact" as const,
          ...(hiddenGroups !== undefined ? { hiddenGroups } : {}),
          ...(other ? { other } : {}),
        };
      } catch (e) {
        return {
          id: c.id,
          buckets: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  };
}
