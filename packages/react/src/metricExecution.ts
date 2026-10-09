import {
  applyAggregations,
  normalizeQueryState,
  evaluateMetrics,
  metricPlans,
  hasRegex,
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
  schema: FieldSchema<Row>;
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
      isComputedField(c.field ?? "") ||
      c.groupBy.some(isComputedField) ||
      c.diagnostics?.length ||
      c.expression !== undefined ||
      c.expressionY !== undefined ||
      c.scope !== undefined ||
      c.distribution ||
      c.sort ||
      c.groupLimit !== undefined,
  );
  if (
    advanced.length &&
    (originalClauses.length > 20 ||
      normalizeQueryState(query).aggregations?.length !==
        originalClauses.length)
  )
    return evaluateMetrics(rows, query, context.schema, {
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
      ...(signal ? { signal } : {}),
    },
  );
  if (!advanced.length) return compatible;
  query = { ...query, aggregations: advanced };
  const options = {
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
  const supportsV2 =
    !!context.transport?.fetchMetrics &&
    context.transport.metricCapabilities?.version === 2;
  if (
    context.clientRows &&
    !supportsV2 &&
    !context.transport?.fetchAggregations
  )
    return localMetrics(context.clientRows, query, context, signal);
  const needsWorker = (c: AggregationClause) =>
    metricPlans(c, context.schema, context.resolveComputed).some(hasRegex);
  const shown = clauses.filter(
    (c) => c.scope === "shownRows" && (!supportsV2 || needsWorker(c)),
  );
  const matching = clauses.filter(
    (c) => c.scope !== "shownRows" || (supportsV2 && !needsWorker(c)),
  );
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
    const pageQuery = {
      ...query,
      where: [],
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
  if (matching.length) {
    const transport = context.transport;
    const scoped = { ...query, aggregations: matching };
    if (
      transport?.fetchMetrics &&
      transport.metricCapabilities?.version === 2
    ) {
      const request = toMetricQuery(scoped, context.schema, context.execution);
      if (request.diagnostics.length)
        throw Error(request.diagnostics.map((d) => d.message).join(" "));
      if (
        matching.some((c) => c.scope === "shownRows") &&
        !transport.metricCapabilities.shownRows
      )
        throw Error("This server does not support shown-row metrics.");
      if (
        request.profile &&
        transport.metricCapabilities.profile &&
        request.profile !== transport.metricCapabilities.profile
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
      if (
        matching.some((clause) =>
          [
            ...clause.groupBy,
            ...metricPlans(clause, remoteSchema).flatMap(
              (plan) => plan.dependencies,
            ),
          ].some(isComputedField),
        ) &&
        !transport.metricCapabilities.computedFields
      )
        throw Error("This metric server does not support computed fields.");
      if (
        request.metrics.some(
          (c) =>
            !c.distribution &&
            (c.expression !== undefined || c.expressionY !== undefined),
        ) &&
        !transport.metricCapabilities.expressions
      )
        throw Error(
          "This server does not support composed metric expressions.",
        );
      if (
        matching.some(
          (c) =>
            c.distribution &&
            (!c.display || ["box", "histogram"].includes(c.display.kind)),
        ) &&
        !transport.metricCapabilities.distributions
      )
        throw Error("This server does not support distributions.");
      results.push(...(await transport.fetchMetrics(request, signal)).metrics);
    } else if (transport?.fetchAggregations) {
      const request = toAggregationQuery(scoped, context.schema);
      if (request.diagnostics?.length)
        throw Error(request.diagnostics.map((d) => d.message).join(" "));
      results.push(
        ...(await transport.fetchAggregations(request, signal)).metrics,
      );
    } else
      throw Error(
        "All-matching metrics require a complete client dataset or a metric-capable server transport.",
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
