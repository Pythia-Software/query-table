import {
  applyAggregations,
  normalizeQueryState,
  evaluateMetrics,
  metricPlans,
  metricDependencies,
  hasRegex,
  metricPopulationError,
  hasMetricSeries,
  planMetricSeries,
  predicatesOf,
  sourceExecutionSchema,
  toQueryRequestV3,
  validateQueryResultV3,
  validateMetric,
  selectMetricShownRows,
  readFieldValue,
  resolveFieldName,
  isComputedField,
  type AggregationClause,
  type AggregationResult,
  type FieldSchema,
  type FormulaNode,
  type FormulaPlan,
  type FormulaResult,
  type FormulaValue,
  type QueryState,
  type Transport,
  type ComputedExecution,
} from "@pythia-software/query-table-core";
import {
  evaluateFormulaRows,
  type FormulaWorkerFactory,
} from "./formulaWorker";

export interface MetricExecutionContext<Row> {
  /** Remote execution; defaults to executeV3Metrics over `transport`. */
  executeV3?: (query: QueryState, signal?: AbortSignal) => Promise<AggregationResult>;
  queryContextKey?: string;
  schema: FieldSchema<Row>;
  /** One clock shared by source grouping, HAVING, rows and local metrics. */
  now?: number;
  /** Group projections use typed semantics even for shorthand metric clauses. */
  strictLocalMetrics?: boolean;
  transport?: Transport<Row> | undefined;
  clientRows?: Row[] | undefined;
  shownRows?: Row[] | undefined;
  rowsReady?: boolean | undefined;
  rowsError?: Error | null | undefined;
  shownFields?: readonly string[] | undefined;
  resolveComputed?: ((name: string) => FormulaPlan | undefined) | undefined;
  workerFactory?: FormulaWorkerFactory | undefined;
  revisions?: Record<string, string> | undefined;
  execution?: ComputedExecution;
}
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

/** Keep dispatch and the hook's committed-page lifecycle on the same route:
 * without a remote executor, shown-row metrics read the committed page. So do
 * shown-row regex metrics a server does not advertise (regexAggregateExpressions),
 * which run in a formula worker over that page. */
export function usesLocalMetricPage<Row>(
  clause: AggregationClause,
  context: MetricExecutionContext<Row>,
): boolean {
  if (clause.scope !== "shownRows") return false;
  if (!context.executeV3 && !context.transport) return true;
  if (context.transport?.queryCapabilities.regexAggregateExpressions) return false;
  try {
    return metricPlans(clause, context.schema, context.resolveComputed).some(hasRegex);
  } catch {
    return false; // An invalid metric fails on the server, with its diagnostic.
  }
}

/** Run a metric batch as one v3 request (`rows: false`). A clause using a
 * population control the server does not advertise fails on its own; the
 * rest of the batch is still sent. `query.grouping`, when present, is the
 * population the metrics describe. */
export async function executeV3Metrics<Row>(
  transport: Transport<Row>,
  query: QueryState,
  baseSchema: FieldSchema<Row>,
  resultSchema: FieldSchema<Row>,
  execution: ComputedExecution | undefined,
  now: number,
  signal?: AbortSignal,
): Promise<AggregationResult> {
  const capabilities = transport.queryCapabilities;
  const refused = new Map<string, string>();
  for (const clause of query.aggregations ?? []) {
    const issue = metricPopulationError(clause, { filters: capabilities.metricFilters, minCount: capabilities.metricMinCount, minCountMeasures: capabilities.metricMinCountMeasures });
    if (issue) refused.set(clause.id, issue);
  }
  let runnable = (query.aggregations ?? []).filter(clause => !refused.has(clause.id));
  // Only shown-row metrics depend on the page. The rest omit its order and
  // window, so an order only the client can evaluate never refuses them.
  const unpaged = { ...query, orderBy: [], offset: 0 };
  const shown = runnable.filter(clause => clause.scope === "shownRows");
  if (shown.length) {
    const issues = toQueryRequestV3({ ...query, aggregations: shown }, baseSchema, capabilities, execution, { now, rows: false }).diagnostics;
    const pageIssues = issues.filter(issue => !toQueryRequestV3({ ...unpaged, aggregations: shown }, baseSchema, capabilities, execution, { now, rows: false }).diagnostics.includes(issue));
    if (pageIssues.length) {
      for (const clause of shown) refused.set(clause.id, pageIssues.join(" "));
      runnable = runnable.filter(clause => clause.scope !== "shownRows");
    }
  }
  let metrics: AggregationResult["metrics"] = [];
  if (runnable.length) {
    const paged = runnable.some(clause => clause.scope === "shownRows");
    const request = toQueryRequestV3({ ...(paged ? query : unpaged), aggregations: runnable }, baseSchema, capabilities, execution, { now, rows: false });
    if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
    const result = await transport.fetchQueryV3(request, signal);
    validateQueryResultV3(result, request, resultSchema);
    metrics = result.metrics;
  }
  if (!refused.size) return { metrics };
  const byId = new Map(metrics.map(metric => [metric.id, metric]));
  return { metrics: (query.aggregations ?? []).flatMap((clause): AggregationResult["metrics"] => {
    const issue = refused.get(clause.id);
    if (issue) return [{ id: clause.id, buckets: [], error: issue }];
    const metric = byId.get(clause.id);
    return metric ? [metric] : [];
  }) };
}

/** Local regex inputs run in terminable workers; reduction uses only cached values. */
async function localMetrics<Row>(
  rows: Row[],
  query: QueryState,
  context: MetricExecutionContext<Row>,
  signal?: AbortSignal,
): Promise<AggregationResult> {
  // Keep legacy aggregates on their permissive compatibility path. Advanced
  // metrics still use the typed formula engine and isolated regex workers.
  const originalClauses = query.aggregations ?? [];
  const advanced = (query.aggregations ?? []).filter(
    (c) =>
      context.strictLocalMetrics ||
      c.dateGrouping ||
      isComputedField(c.field ?? "") ||
      c.groupBy.some(isComputedField) ||
      c.diagnostics?.length ||
      c.expression !== undefined ||
      c.expressionY !== undefined ||
      c.scope !== undefined ||
      c.distribution ||
      c.sort ||
      c.groupLimit !== undefined ||
      c.where !== undefined ||
      c.minCount !== undefined ||
      hasMetricSeries(c),
  );
  if (
    advanced.length &&
    (originalClauses.length > 20 ||
      normalizeQueryState(query).aggregations?.length !==
        originalClauses.length)
  )
    return evaluateMetrics(rows, query, context.schema, {
      ...(context.now !== undefined ? { now: context.now } : {}),
      ...(signal ? { signal } : {}),
      ...(context.resolveComputed
        ? { resolveComputed: context.resolveComputed }
        : {}),
    });
  const legacy = (query.aggregations ?? []).filter(
    (c) => !advanced.includes(c),
  );
  const compatible = applyAggregations(
    rows,
    { ...query, aggregations: legacy },
    context.schema,
    {
      ...(context.now !== undefined ? { now: context.now } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  if (!advanced.length) return compatible;
  query = { ...query, aggregations: advanced };
  const options = {
    ...(context.now !== undefined ? { now: context.now } : {}),
    ...(context.resolveComputed
      ? { resolveComputed: context.resolveComputed }
      : {}),
    ...(signal ? { signal } : {}),
  };
  for (const clause of query.aggregations ?? []) {
    const diagnostics = validateMetric(
      clause,
      context.schema,
      context.resolveComputed,
    );
    if (diagnostics.length)
      throw Error(diagnostics.map((d) => d.message).join(" "));
  }
  const requiresPage = (query.aggregations ?? []).some(
    (clause) => clause.scope === "shownRows",
  );
  const page = requiresPage
    ? selectMetricShownRows(rows, query, context.schema, {
        ...options,
        ...(context.rowsReady && context.shownRows
          ? { shownRows: context.shownRows }
          : {}),
      })
    : [];
  const caches = new Map<string, Map<Row, FormulaResult>>();
  for (const clause of query.aggregations ?? []) {
    for (const plan of metricPlans(
      clause,
      context.schema,
      context.resolveComputed,
    )) {
      if (!hasRegex(plan)) continue;
      const nodes =
        "aggregates" in plan
          ? (
              plan as FormulaPlan & {
                aggregates: Array<{ args: FormulaNode[] }>;
              }
            ).aggregates.flatMap((a) => a.args)
          : [plan.ast];
      for (const node of nodes) {
        if (!hasRegex({ ...plan, ast: node })) continue;
        const key = JSON.stringify(node);
        if (caches.has(key)) continue;
        let bytes = 0;
        const inputs = page.map((row) => {
          const values: Record<string, FormulaValue> = Object.create(null);
          for (const name of plan.dependencies) {
            const field = context.schema.fields.find((f) => f.name === name);
            if (!field) throw Error(`Unavailable metric input: ${name}`);
            const raw = readFieldValue(field, row);
            values[name] =
              raw instanceof Date
                ? raw.toISOString()
                : ((raw ?? null) as FormulaValue);
          }
          bytes += JSON.stringify(values).length;
          if (bytes > 16000000)
            throw Error(
              "Metric worker input exceeds 16 MB. Reduce the shown rows.",
            );
          return values;
        });
        const values = await evaluateFormulaRows(
          node,
          inputs,
          signal,
          context.workerFactory,
        );
        caches.set(
          key,
          new Map(page.map((row, i) => [row, values[i]!] as const)),
        );
      }
    }
  }
  abort(signal);
  const typed = evaluateMetrics(rows, query, context.schema, {
    ...options,
    shownRows: page,
    ...(caches.size
      ? {
          evaluateInput: (node: FormulaNode, row: Row, plan: FormulaPlan) => {
            const cached = caches.get(JSON.stringify(node));
            if (cached)
              return (
                cached.get(row) ?? {
                  value: null,
                  error: "Metric worker result missing.",
                }
              );
            // Core calls the override only for regex inputs.
            throw Error("Metric regex input was not evaluated in a worker.");
          },
        }
      : {}),
  });
  const byId = new Map(
    [...compatible.metrics, ...typed.metrics].map((m) => [m.id, m]),
  );
  return { metrics: originalClauses.flatMap((c) => byId.get(c.id) ?? []) };
}

export async function executeMetrics<Row>(
  query: QueryState,
  context: MetricExecutionContext<Row>,
  signal?: AbortSignal,
): Promise<AggregationResult> {
  abort(signal);
  const clauses = query.aggregations ?? [];
  if (!clauses.length) return { metrics: [] };
  // Windows, shares and whole intervals are combined from plain metrics, so
  // every engine below runs them.
  const series = planMetricSeries(query, context.schema, {
    ...(context.now !== undefined ? { now: context.now } : {}),
    ...(context.resolveComputed ? { resolveComputed: context.resolveComputed } : {}),
  });
  if (series) {
    const parts = await Promise.all(
      series.queries.map((part) => executeMetrics(part, context, signal)),
    );
    return { metrics: series.combine(parts.flatMap((part) => part.metrics)) };
  }
  if (context.executeV3 || context.transport) {
    const page = clauses.filter(c => usesLocalMetricPage(c, context));
    const remote = (q: QueryState) => context.executeV3 ? context.executeV3(q, signal)
      : executeV3Metrics(context.transport!, q, context.schema, sourceExecutionSchema(context.schema, context.execution),
        context.execution, context.now ?? Date.now(), signal);
    if (!page.length) return remote(query);
    const { executeV3: _executeV3, transport: _transport, ...local } = context;
    const rest = clauses.filter(c => !page.includes(c));
    const [own, served] = await Promise.all([executeMetrics({ ...query, aggregations: page }, local, signal),
      rest.length ? remote({ ...query, aggregations: rest }) : { metrics: [] }]);
    const byId = new Map([...own.metrics, ...served.metrics].map(metric => [metric.id, metric]));
    return { metrics: clauses.flatMap(c => byId.get(c.id) ?? []) };
  }
  if (context.rowsReady === false && clauses.some(c => usesLocalMetricPage(c, context)))
    throw Error("Wait for the current table page before previewing shown-row metrics.");
  if (context.clientRows)
    return localMetrics(context.clientRows, query, context, signal);
  const shown = clauses.filter(c => usesLocalMetricPage(c, context));
  const matching = clauses.filter(c => !shown.includes(c));
  const results: AggregationResult["metrics"] = [];
  if (shown.length) {
    if (!context.rowsReady || !context.shownRows)
      throw Error(
        "Wait for the current table page before previewing shown-row metrics.",
      );
    // Only committed inputs can claim "shown rows". Never hydrate them from a
    // newer response with the same IDs; that would mix data snapshots.
    const names = new Set(
      shown.flatMap((clause) => [
        ...clause.groupBy,
        ...(clause.where ?? []).flatMap((term) =>
          predicatesOf(term).map((predicate) => predicate.field),
        ),
        // Includes a measured minimum's field, which the page must also hold.
        ...metricDependencies(clause, context.schema, context.resolveComputed),
      ]),
    );
    for (const name of names) {
      const canonical = resolveFieldName(context.schema, name) ?? name;
      const field = context.schema.fields.find((f) => f.name === canonical);
      const dependencies =
        field?.source.kind === "derived"
          ? (field.source.dependencies ?? [])
          : [canonical];
      const loaded = context.shownFields
        ? dependencies.every((dep) => context.shownFields!.includes(dep))
        : field &&
          context.shownRows.every(
            (row) =>
              field.source.kind === "derived" ||
              loadedPath(
                row,
                field.source.kind === "backend"
                  ? (field.source.path ?? field.name)
                  : field.name,
              ),
          );
      if (!field || !loaded)
        throw Error(
          `Shown-page input ${name} is not loaded. Add it to the selected columns and refresh, or use a snapshot-capable metric transport.`,
        );
    }
    // Committed shown rows supply the population; original filters still define
    // the calendar domain for completing empty dates.
    const pageQuery = {
      ...query,
      orderBy: [],
      limit: Math.max(1, context.shownRows.length),
      offset: 0,
      aggregations: shown,
    };
    results.push(
      ...(await localMetrics(context.shownRows, pageQuery, context, signal))
        .metrics,
    );
  }
  if (matching.length)
    throw Error(
      "Remote all-matching metrics require a metric-capable server transport.",
    );
  abort(signal);
  const byId = new Map(results.map((r) => [r.id, r]));
  return {
    metrics: clauses.map(
      (c) =>
        byId.get(c.id) ?? {
          id: c.id,
          buckets: [],
          error: "Server omitted this metric.",
        },
    ),
  };
}

function loadedPath(row: unknown, path: string): boolean {
  if (!row || typeof row !== "object") return false;
  if (path in row) return true;
  let value: unknown = row;
  for (const part of path.split(".")) {
    if (value === null) return true;
    if (!value || typeof value !== "object" || !(part in value)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return true;
}
