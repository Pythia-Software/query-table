import {
  applyAggregations,
  normalizeQueryState,
  evaluateMetrics,
  metricPlans,
  hasRegex,
  metricPopulationError,
  hasMetricSeries,
  planMetricSeries,
  predicatesOf,
  toAggregationQuery,
  toMetricQuery,
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

/** Keep dispatch and the hook's committed-page lifecycle on the same route. */
export function usesLocalMetricPage<Row>(
  clause: AggregationClause,
  context: MetricExecutionContext<Row>,
): boolean {
  return !context.executeV3 && clause.scope === "shownRows" && (
    !context.transport?.fetchMetrics ||
    context.transport.metricCapabilities?.version !== 2 ||
    context.transport.metricCapabilities.shownRows !== true ||
    !!clause.dateGrouping ||
    metricPlans(clause, context.schema, context.resolveComputed).some(hasRegex)
  );
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
  if (context.executeV3) return context.executeV3(query, signal);
  if (context.rowsReady === false && clauses.some(c => usesLocalMetricPage(c, context)))
    throw Error("Wait for the current table page before previewing shown-row metrics.");
  const supportsV2 =
    !!context.transport?.fetchMetrics &&
    context.transport.metricCapabilities?.version === 2;
  if (
    context.clientRows &&
    !supportsV2 &&
    !context.transport?.fetchAggregations
  )
    return localMetrics(context.clientRows, query, context, signal);
  const shown = clauses.filter(c => usesLocalMetricPage(c, context));
  let matching = clauses.filter(c => !shown.includes(c));
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
        ...metricPlans(clause, context.schema, context.resolveComputed).flatMap(
          (p) => p.dependencies,
        ),
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
  // A capability the server lacks fails only the clauses that need it; the
  // rest of the batch is still sent.
  const unsupported = (clause: AggregationClause, error: string) =>
    results.push({ id: clause.id, buckets: [], error });
  const calendar = matching.filter((c) => c.dateGrouping);
  for (const clause of calendar)
    unsupported(
      clause,
      "This server does not support calendar grouping. Enable the v3 query executor.",
    );
  matching = matching.filter((c) => !c.dateGrouping);
  // Population controls are never dropped: a v1 endpoint, or a v2 server that
  // does not advertise them, fails only the clauses that use them.
  {
    const transport = context.transport;
    if (transport?.fetchMetrics || transport?.fetchAggregations) {
      const support =
        transport.fetchMetrics && transport.metricCapabilities?.version === 2
          ? transport.metricCapabilities
          : {};
      matching = matching.filter((c) => {
        const error = metricPopulationError(c, support);
        if (error) unsupported(c, error);
        return !error;
      });
    }
  }
  if (matching.length) {
    const transport = context.transport;
    if (
      transport?.fetchMetrics &&
      transport.metricCapabilities?.version === 2
    ) {
      const capabilities = transport.metricCapabilities;
      const request = toMetricQuery(
        { ...query, aggregations: matching },
        context.schema,
        context.execution,
      );
      if (request.diagnostics.length)
        throw Error(request.diagnostics.map((d) => d.message).join(" "));
      if (
        request.profile &&
        capabilities.profile &&
        request.profile !== capabilities.profile
      )
        throw Error(
          "Metric transport and computed execution profiles do not match. Refresh the handshake.",
        );
      const remoteFields = new Map(
        context.schema.fields.map((field) => [field.name, field]),
      );
      for (const [name, capability] of Object.entries(
        context.execution?.fields ?? {},
      ))
        if (isComputedField(name))
          remoteFields.set(name, {
            name,
            label: name,
            type: capability.type,
            source: { kind: "backend" },
          });
      const remoteSchema = {
        ...context.schema,
        fields: [...remoteFields.values()],
      };
      const wire = new Map(request.metrics.map((m) => [m.id, m]));
      const limitation = (clause: AggregationClause): string | undefined => {
        if (clause.scope === "shownRows" && !capabilities.shownRows)
          return "This server does not support shown-row metrics.";
        if (
          !capabilities.computedFields &&
          [
            ...clause.groupBy,
            ...metricPlans(clause, remoteSchema).flatMap(
              (plan) => plan.dependencies,
            ),
          ].some(isComputedField)
        )
          return "This metric server does not support computed fields.";
        const sent = wire.get(clause.id);
        if (
          !capabilities.expressions &&
          sent &&
          !sent.distribution &&
          (sent.expression !== undefined || sent.expressionY !== undefined)
        )
          return "This server does not support composed metric expressions.";
        if (
          !capabilities.distributions &&
          clause.distribution &&
          (!clause.display ||
            ["box", "histogram"].includes(clause.display.kind))
        )
          return "This server does not support distributions.";
        return undefined;
      };
      const rejected = new Set<string>();
      for (const clause of matching) {
        const error = limitation(clause);
        if (error) {
          rejected.add(clause.id);
          unsupported(clause, error);
        }
      }
      const metrics = request.metrics.filter((m) => !rejected.has(m.id));
      if (metrics.length)
        results.push(
          ...(await transport.fetchMetrics({ ...request, metrics }, signal))
            .metrics,
        );
    } else if (transport?.fetchAggregations) {
      const request = toAggregationQuery(
        { ...query, aggregations: matching },
        context.schema,
      );
      if (request.diagnostics?.length)
        throw Error(request.diagnostics.map((d) => d.message).join(" "));
      results.push(
        ...(await transport.fetchAggregations(request, signal)).metrics,
      );
    } else
      throw Error(
        "Remote all-matching metrics require a metric-capable server transport.",
      );
  }
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
