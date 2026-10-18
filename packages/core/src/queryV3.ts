import { createGroupingModel, withoutGrouping, type GroupingDefinition } from "./grouping";
import { normalizeQueryState, predicatesOf, type QueryState, type AggregationClause } from "./query";
import { toServerQuery, type ServerQuery, type AggregationResult } from "./encode";
import { validateMetric, toMetricQuery } from "./metrics";
import type { ComputedExecution } from "./computed";
import type { FieldSchema, FieldDef } from "./schema";
import { evaluationTime } from "./relativeTime";

export interface QueryCapabilitiesV3 {
  version: 3;
  groupedRows: boolean;
  calendarGrouping: boolean;
  computedSourceFilters: boolean;
  regex: boolean;
  regexSourceFilters?: boolean;
  regexAggregateExpressions?: boolean;
  /** Executes AggregationClause.where; clauses using it are refused otherwise. */
  metricFilters?: boolean;
  /** Executes AggregationClause.minCount and reports hiddenGroups. */
  metricMinCount?: boolean;
  maxRows: number;
  maxGroups: number;
  maxPopulation: number;
  profile: string;
}
export interface QueryRequestV3 {
  version: 3;
  profile: string;
  now: number;
  expectedRevisions: Record<string, string>;
  planToken?: string;
  snapshot?: string;
  source: ServerQuery;
  result: ServerQuery;
  grouping?: GroupingDefinition;
  rows: boolean;
  metrics: AggregationClause[];
  diagnostics: string[];
}
export interface QueryResultV3 {
  version: 3;
  now: number;
  sourceTotal: number;
  rows: Record<string, unknown>[];
  total: number;
  schema: { name: string; idField: string; fields: { name: string; type: string }[] };
  metrics: AggregationResult["metrics"];
  execution: ComputedExecution;
}
/** The handshake supplies authority, including capabilities for computed keys
 * absent from the base schema. Labels may be supplied by the editable catalogue. */
export function sourceExecutionSchema<Row>(schema: FieldSchema<Row>, execution?: ComputedExecution, catalogue: readonly { id: string; label: string; revision: string }[] = []): FieldSchema<Row> {
  const fields = new Map(schema.fields.map(field => [field.name, field]));
  for (const [name, capability] of Object.entries(execution?.fields ?? {})) {
    const definition = catalogue.find(definition => name === `@computed/${definition.id}`);
    const revision = execution?.resolvedRevisions[name] ?? execution?.resolvedRevisions[name.slice(10)];
    const current = !!revision && (!definition || definition.revision === revision);
    fields.set(name, { ...fields.get(name), name, label: definition?.label ?? fields.get(name)?.label ?? name,
      type: capability.type, source: { kind: "backend" },
      select: { enabled: current && capability.select }, filter: { enabled: current && capability.filter === true },
      sort: { enabled: current && capability.sort }, aggregate: { measure: current && capability.measure, groupable: current && capability.group } } as FieldDef<Row>);
  }
  return { ...schema, fields: [...fields.values()] };
}
export function toQueryRequestV3<Row>(query: QueryState, baseSchema: FieldSchema<Row>, capabilities: QueryCapabilitiesV3,
  execution?: ComputedExecution, options: { now?: number; rows?: boolean } = {}): QueryRequestV3 {
  const now = evaluationTime(options), q = normalizeQueryState(query);
  const sourceSchema = sourceExecutionSchema(baseSchema, execution);
  const source = q.grouping?.source ?? withoutGrouping(q);
  const diagnostics: string[] = [];
  if ((query.aggregations?.length ?? 0) !== (q.aggregations?.length ?? 0)) diagnostics.push("The query exceeds its metric budget or contains malformed metric state.");
  if (capabilities.version !== 3 || execution && execution.profile !== capabilities.profile) diagnostics.push("The negotiated query profile is unavailable.");
  let resultSchema = sourceSchema as FieldSchema<any>;
  if (q.grouping) {
    if (!capabilities.groupedRows) diagnostics.push("This server does not support grouped rows.");
    try { const model = createGroupingModel(sourceSchema); model.validate(q.grouping); resultSchema = model.resultSchema(q.grouping.keys, q.grouping.summaries); }
    catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
  }
  const sourceRequest = toServerQuery(withoutGrouping(source), sourceSchema);
  for (const term of source.where) for (const predicate of predicatesOf(term)) if (["matches_regex", "not_matches_regex"].includes(predicate.op) && !capabilities.regexSourceFilters)
    diagnostics.push("This server profile does not support isolated regex source filtering.");
  const result = toServerQuery(withoutGrouping(q), resultSchema);
  if (sourceRequest.where.length !== source.where.length || result.where.length !== q.where.length) diagnostics.push("The query contains unsupported source or result predicates.");
  if (result.orderBy.length !== q.orderBy.length) diagnostics.push("The query contains unsupported result ordering.");
  if (q.grouping) for (const term of q.grouping.source.where) for (const predicate of predicatesOf(term))
    if (predicate.field.startsWith("@computed/") && !capabilities.computedSourceFilters) diagnostics.push("This server does not support computed source predicates.");
  const metricQuery = toMetricQuery(withoutGrouping(q), resultSchema, execution);
  // The projection keeps only pushdown metric-filter terms; never send the
  // narrowed population silently. (Its other diagnostics, such as calendar
  // grouping, describe the v2 transport and do not apply here.)
  diagnostics.push(...metricQuery.diagnostics.filter(issue => issue.code === "residual_metric_filter").map(issue => issue.message));
  const metrics = metricQuery.metrics.map(metric => {
    const dateGrouping = q.aggregations?.find(clause => clause.id === metric.id)?.dateGrouping;
    return dateGrouping ? { ...metric, dateGrouping } : metric;
  });
  for (const metric of metrics) {
    diagnostics.push(...validateMetric(metric, resultSchema).map(issue => issue.message));
    if (metric.dateGrouping && !capabilities.calendarGrouping) diagnostics.push("This server does not support calendar grouping.");
  }
  const revisions: Record<string, string> = Object.create(null);
  for (const [id, revision] of Object.entries(execution?.resolvedRevisions ?? {})) {
    if (!revision || id.length > 256 || revision.length > 256) diagnostics.push("Invalid computed revision envelope.");
    else revisions[id.startsWith("@computed/") ? id.slice(10) : id] = revision;
  }
  return { version: 3, profile: capabilities.profile, now, expectedRevisions: revisions,
    ...(execution?.planToken ? { planToken: execution.planToken } : {}), ...(execution?.snapshot !== undefined ? { snapshot: execution.snapshot } : {}),
    source: sourceRequest, result, ...(q.grouping ? { grouping: { keys: q.grouping.keys,
      // Summary display is presentation only; the wire contract is unchanged.
      summaries: q.grouping.summaries.map(({ display: _display, ...summary }) => summary), representative: q.grouping.representative,
      ...(q.grouping.diagnostics ? { diagnostics: q.grouping.diagnostics } : {}) } } : {}), rows: options.rows !== false, metrics, diagnostics: [...new Set(diagnostics)] };
}
export function validateQueryResultV3(result: QueryResultV3, request: QueryRequestV3, schema: FieldSchema): void {
  if (!result || result.version !== 3 || result.now !== request.now || !Number.isSafeInteger(result.total) || result.total < 0 ||
    !Number.isSafeInteger(result.sourceTotal) || result.sourceTotal < 0 || !Array.isArray(result.rows) || !Array.isArray(result.metrics) ||
    result.execution?.profile !== request.profile || (result.execution.planToken ?? "") !== (request.planToken ?? "") ||
    (result.execution.snapshot ?? "") !== (request.snapshot ?? "") || result.schema?.idField !== schema.idField)
    throw Error("Invalid or mismatched query execution response.");
  const expected = new Map(schema.fields.map(field => [field.name, field.type]));
  if (!Array.isArray(result.schema.fields) || result.schema.fields.some(field => expected.get(field.name) !== field.type) ||
    request.rows && request.result.select.some(name => !result.schema.fields.some(field => field.name === name))) throw Error("The server returned a different projected schema.");
  for (const [id, revision] of Object.entries(request.expectedRevisions)) if (result.execution.resolvedRevisions[id] !== revision)
    throw Error("Computed definitions changed. Refresh the server execution handshake.");
  const seen = new Set<unknown>();
  for (const row of result.rows) { const id = row[schema.idField]; if (typeof id !== "string" && typeof id !== "number" || seen.has(id)) throw Error("The server returned invalid or duplicate group identities."); seen.add(id); }
}
