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
} from "./formula";
import { aggOpsForField, isGroupable, isMeasurable } from "./agg";
import {
  indexFields,
  readFieldValue,
  resolveFieldName,
  type FieldDef,
  type FieldSchema,
} from "./schema";
import {
  normalizeQueryState,
  predicatesOf,
  type AggregationClause,
  type AggOp,
  type QueryState,
} from "./query";
import { applyQuery } from "./apply";
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
const aggregates = new Set([
  "COUNT",
  "COUNT_DISTINCT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
]);
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
          if (
            !isMeasurable(field) ||
            ((field.aggregate?.ops !== undefined || node.args[0] === n) &&
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
        ["SUM", "AVG"].includes(node.name) &&
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
      return ["COUNT", "COUNT_DISTINCT", "SUM", "AVG"].includes(node.name)
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
export function metricPlans(
  c: AggregationClause,
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): FormulaPlan[] {
  if (distributionActive(c)) {
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
    if (
      c.groupLimit !== undefined &&
      (!Number.isInteger(c.groupLimit) ||
        c.groupLimit < 1 ||
        c.groupLimit > 10000)
    )
      throw new FormulaError("Group limit must be 1–10,000.");
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
export function metricDependencies(
  c: AggregationClause,
  schema: FieldSchema,
  resolve?: (name: string) => FormulaPlan | undefined,
): string[] {
  return [
    ...new Set([
      ...c.groupBy.map((name) => resolveFieldName(schema, name) ?? name),
      ...metricPlans(c, schema, resolve).flatMap((p) => p.dependencies),
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
        expression: distributionActive(c) ? undefined : metricExpression(c),
        expressionY: c.display?.kind === "scatter" ? c.expressionY : undefined,
        scope: c.scope ?? "allMatching",
        groupBy: c.groupBy,
        sort: c.sort,
        groupLimit: c.groupLimit,
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
  const metrics = (q.aggregations ?? []).map((c) => {
    const {
      label,
      layout,
      display,
      distribution,
      expression,
      expressionY,
      ...rest
    } = c;
    return {
      ...rest,
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
    {
      ...q,
      orderBy: orderBy.some((s) => s.field === schema.idField)
        ? orderBy
        : [...orderBy, { field: schema.idField, dir: "asc" }],
    },
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
          isComputedField(p.field) ||
          !fields.has(resolveFieldName(schema, p.field) ?? p.field),
      ),
    )
  )
    throw Error("Metric filter references an unavailable field.");
  if (
    orderBy.some(
      (s) =>
        isComputedField(s.field) ||
        !fields.has(resolveFieldName(schema, s.field) ?? s.field),
    )
  )
    throw Error("Shown-row ordering requires an authoritative committed page.");
}
export interface MetricEvaluationOptions<Row = unknown>
  extends QueryEvaluationOptions, MetricReductionOptions {
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
export function evaluateMetrics<Row>(
  rows: Row[],
  q: QueryState,
  schema: FieldSchema<Row>,
  options: MetricEvaluationOptions<Row> = {},
): AggregationResult {
  const now = evaluationTime(options),
    fields = indexFields(schema);
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
        let buckets: AggregationBucket[] = [...groups.values()].map((g) => {
          const bucket: AggregationBucket = {
            keys: g.keys,
            count: g.rows.length,
            value: null,
          };
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
        const ordering: MetricSort[] = c.sort?.length
          ? c.sort
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
        buckets.sort((a, b) => {
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
          processedRows: inputRows.length,
          groupCount,
          coverage: "exact" as const,
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
