import { createGroupingModel, withoutGrouping, type GroupingDefinition } from "./grouping";
import { MAX_AGGREGATIONS, normalizeQueryState, predicatesOf, type QueryState, type AggregationClause } from "./query";
import { toServerQuery, type ServerQuery, type AggregationResult } from "./encode";
import { validateMetric, toMetricQuery } from "./metrics";
import { isMetricCycle } from "./metricDates";
import type { ComputedExecution } from "./computed";
import type { FieldSchema, FieldDef } from "./schema";
import { isSelectable } from "./schema";
import { aggOpsForField, isMeasurable } from "./agg";
import type { FieldStats, Transport } from "./adapters";
import type { HostQueryState, RowId, WhereTerm, WhereClause, AggOp } from "./query";
import { evaluationTime } from "./relativeTime";
import { withoutLinkSummaries } from "./groupLinks";
import { isCalendarGroupKey } from "./groupKeys";

export interface QueryCapabilitiesV3 {
  version: 3;
  groupedRows: boolean;
  calendarGrouping: boolean;
  /** Executes the cyclic `hourOfDay` and `dayOfWeek` date intervals. */
  calendarCycles?: boolean;
  /** Executes calendar grouping keys (`{ field, interval, timeZone }`) in a
   * grouping stage. Requests using them are refused otherwise. */
  calendarGroupKeys?: boolean;
  computedSourceFilters: boolean;
  regex: boolean;
  regexSourceFilters?: boolean;
  regexAggregateExpressions?: boolean;
  /** Executes AggregationClause.where; clauses using it are refused otherwise. */
  metricFilters?: boolean;
  /** Executes AggregationClause.minCount and reports hiddenGroups. */
  metricMinCount?: boolean;
  /** Also executes an object minCount: distinct values or a sum per group. */
  metricMinCountMeasures?: boolean;
  maxRows: number;
  maxGroups: number;
  maxPopulation: number;
  profile: string;
}
export interface QueryRequestV3 {
  /** The table's host-owned state when `hostQuery` is configured. */
  hostState?: import("./query").HostQueryState;
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
  /** Filter-value suggestions over `source.where`. Requires `rows: false`, no
   * metrics and no grouping. */
  distinct?: DistinctRequestV3;
  diagnostics: string[];
}
/** Distinct values of one server-filterable field: a literal, case-insensitive
 * substring match on the value as text (empty matches all), ordered by count
 * desc then value asc. `textarray` fields contribute each element. */
export interface DistinctRequestV3 { field: string; search: string; /** 1..500 */ limit: number }
export interface DistinctResultV3 {
  /** Non-NULL matches as text, at most `limit`. */
  values: string[];
  /** More than `limit` values match. */
  hasMore: boolean;
  /** The population has a NULL (textarray: NULL or empty), whatever the search. */
  hasNull: boolean;
}
export const MAX_DISTINCT_LIMIT = 500;
export const MAX_DISTINCT_SEARCH_LENGTH = 2000;
export interface QueryResultV3 {
  version: 3;
  now: number;
  sourceTotal: number;
  rows: Record<string, unknown>[];
  total: number;
  schema: { name: string; idField: string; fields: { name: string; type: string }[] };
  metrics: AggregationResult["metrics"];
  /** Present exactly when the request has `distinct`. */
  distinct?: DistinctResultV3;
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
const profileUnavailable = (capabilities: QueryCapabilitiesV3, execution: ComputedExecution | undefined) =>
  capabilities.version !== 3 || !!execution && execution.profile !== capabilities.profile;
/** The negotiated identity every request carries. Pushes envelope issues onto `diagnostics`. */
function requestEnvelope(capabilities: QueryCapabilitiesV3, execution: ComputedExecution | undefined, now: number, diagnostics: string[]) {
  const revisions: Record<string, string> = Object.create(null);
  for (const [id, revision] of Object.entries(execution?.resolvedRevisions ?? {})) {
    if (!revision || id.length > 256 || revision.length > 256) diagnostics.push("Invalid computed revision envelope.");
    else revisions[id.startsWith("@computed/") ? id.slice(10) : id] = revision;
  }
  return { version: 3 as const, profile: capabilities.profile, now, expectedRevisions: revisions,
    ...(execution?.planToken ? { planToken: execution.planToken } : {}), ...(execution?.snapshot !== undefined ? { snapshot: execution.snapshot } : {}) };
}
export function toQueryRequestV3<Row>(query: QueryState, baseSchema: FieldSchema<Row>, capabilities: QueryCapabilitiesV3,
  execution?: ComputedExecution, options: { now?: number; rows?: boolean } = {}): QueryRequestV3 {
  const now = evaluationTime(options), q = normalizeQueryState(query);
  const sourceSchema = sourceExecutionSchema(baseSchema, execution);
  const source = q.grouping?.source ?? withoutGrouping(q);
  const diagnostics: string[] = [];
  if ((query.aggregations?.length ?? 0) !== (q.aggregations?.length ?? 0)) diagnostics.push("The query exceeds its metric budget or contains malformed metric state.");
  if (profileUnavailable(capabilities, execution)) diagnostics.push("The negotiated query profile is unavailable.");
  let resultSchema = sourceSchema as FieldSchema<any>;
  if (q.grouping) {
    if (!capabilities.groupedRows) diagnostics.push("This server does not support grouped rows.");
    else if (q.grouping.keys.some(isCalendarGroupKey) && !capabilities.calendarGroupKeys)
      diagnostics.push("This server does not support grouping keys by calendar interval.");
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
  diagnostics.push(...metricQuery.diagnostics.filter(issue => issue.code === "residual_metric_filter" || issue.code === "unexpanded_series").map(issue => issue.message));
  const metrics = metricQuery.metrics.map(metric => {
    const dateGrouping = q.aggregations?.find(clause => clause.id === metric.id)?.dateGrouping;
    return dateGrouping ? { ...metric, dateGrouping } : metric;
  });
  for (const metric of metrics) {
    diagnostics.push(...validateMetric(metric, resultSchema).map(issue => issue.message));
    if (metric.dateGrouping && !capabilities.calendarGrouping) diagnostics.push("This server does not support calendar grouping.");
    else if (isMetricCycle(metric.dateGrouping?.interval) && !capabilities.calendarCycles)
      diagnostics.push("This server does not support hour-of-day or day-of-week grouping.");
  }
  return { ...requestEnvelope(capabilities, execution, now, diagnostics),
    source: sourceRequest, result, ...(q.grouping ? { grouping: { keys: q.grouping.keys,
      // Summary display is presentation only and link columns are computed on
      // the client; the wire contract is unchanged.
      summaries: withoutLinkSummaries(q.grouping.summaries).map(({ display: _display, ...summary }) => summary), representative: q.grouping.representative,
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
  if (request.distinct) {
    const distinct = result.distinct;
    if (!distinct || !Array.isArray(distinct.values) || distinct.values.length > request.distinct.limit ||
      distinct.values.some(value => typeof value !== "string") || typeof distinct.hasMore !== "boolean" || typeof distinct.hasNull !== "boolean")
      throw Error("Invalid distinct values response.");
  }
  const seen = new Set<unknown>();
  for (const row of result.rows) { const id = row[schema.idField]; if (typeof id !== "string" && typeof id !== "number" || seen.has(id)) throw Error("The server returned invalid or duplicate group identities."); seen.add(id); }
}

// ---- Folded requests --------------------------------------------------------
// Filter suggestions, single-row lookups and field statistics are ordinary v3
// requests. Each builder pairs with a reader that validates its response.

export interface AuxiliaryRequestOptions {
  /** Evaluation clock; defaults to Date.now(). */
  now?: number;
  /** The computed execution handshake, when the table has one. */
  execution?: ComputedExecution;
  hostState?: HostQueryState;
}
const emptyStage = (where: WhereTerm[] = []): ServerQuery => ({ select: [], where, orderBy: [], limit: 1, offset: 0 });
function auxiliaryRequest(capabilities: QueryCapabilitiesV3, source: ServerQuery, result: ServerQuery, options: AuxiliaryRequestOptions,
  part: Pick<QueryRequestV3, "rows" | "metrics"> & { distinct?: DistinctRequestV3 }, diagnostics: string[] = []): QueryRequestV3 {
  if (profileUnavailable(capabilities, options.execution)) diagnostics.unshift("The negotiated query profile is unavailable.");
  return { ...(options.hostState ? { hostState: options.hostState } : {}),
    ...requestEnvelope(capabilities, options.execution, evaluationTime(options), diagnostics),
    source, result, ...part, diagnostics: [...new Set(diagnostics)] };
}
async function execute(transport: Transport, request: QueryRequestV3, signal?: AbortSignal): Promise<QueryResultV3> {
  if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
  const result = await transport.fetchQueryV3(request, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}

/** Filter autocomplete: distinct values of `field` over `where` (default: the
 * whole source). */
export function toDistinctRequestV3(field: string, search: string, capabilities: QueryCapabilitiesV3,
  options: AuxiliaryRequestOptions & { limit?: number; where?: WhereTerm[] } = {}): QueryRequestV3 {
  const limit = options.limit ?? 50, diagnostics: string[] = [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISTINCT_LIMIT) diagnostics.push(`Distinct value limit must be between 1 and ${MAX_DISTINCT_LIMIT}.`);
  if (search.length > MAX_DISTINCT_SEARCH_LENGTH) diagnostics.push("Distinct search exceeds its budget.");
  return auxiliaryRequest(capabilities, emptyStage(options.where), emptyStage(), options, { rows: false, metrics: [], distinct: { field, search, limit } }, diagnostics);
}
export function readDistinctResultV3(result: QueryResultV3, request: QueryRequestV3, schema: FieldSchema): DistinctResultV3 {
  validateQueryResultV3(result, request, schema);
  const { values, hasMore, hasNull } = result.distinct!;
  return { values: [...values], hasMore, hasNull };
}
export async function fetchDistinctValuesV3(transport: Transport, schema: FieldSchema, field: string, search: string,
  options: AuxiliaryRequestOptions & { limit?: number; where?: WhereTerm[] } = {}, signal?: AbortSignal): Promise<DistinctResultV3> {
  const request = toDistinctRequestV3(field, search, transport.queryCapabilities, options);
  return readDistinctResultV3(await execute(transport, request, signal), request, schema);
}

/** The backend fields a single-row lookup returns by default: every
 * selectable backend field, and the identity. */
export function rowLookupFields(schema: FieldSchema): string[] {
  return [...new Set([schema.idField, ...schema.fields.filter(field => field.source.kind === "backend" && isSelectable(field) &&
    !field.name.startsWith("@computed/")).map(field => field.name)])].sort();
}
/** One row by identity (a refresh after a mutation, or an item lookup). */
export function toRowRequestV3(schema: FieldSchema, id: RowId, capabilities: QueryCapabilitiesV3,
  options: AuxiliaryRequestOptions & { select?: string[] } = {}): QueryRequestV3 {
  const stage: ServerQuery = { select: options.select ? [...new Set([schema.idField, ...options.select])].sort() : rowLookupFields(schema),
    where: [{ field: schema.idField, op: "=", value: String(id) }], orderBy: [], limit: 2, offset: 0 };
  return auxiliaryRequest(capabilities, stage, stage, options, { rows: true, metrics: [] });
}
/** The matching row, or null when none matches. Two matches are an error. */
export function readRowResultV3<Row = Record<string, unknown>>(result: QueryResultV3, request: QueryRequestV3, schema: FieldSchema): Row | null {
  if (Array.isArray(result?.rows) && result.rows.length > 1) throw Error("Row identity must be unique.");
  validateQueryResultV3(result, request, schema);
  const row = result.rows[0];
  if (row && String(row[schema.idField]) !== (request.result.where[0] as WhereClause | undefined)?.value)
    throw Error("The server returned a different row.");
  return (row ?? null) as Row | null;
}
export async function fetchRowV3<Row = Record<string, unknown>>(transport: Transport, schema: FieldSchema, id: RowId,
  options: AuxiliaryRequestOptions & { select?: string[] } = {}, signal?: AbortSignal): Promise<Row | null> {
  const request = toRowRequestV3(schema, id, transport.queryCapabilities, options);
  return readRowResultV3<Row>(await execute(transport, request, signal), request, schema);
}

const STAT_OPS: { op: AggOp; key: keyof FieldStats }[] = [{ op: "count_distinct", key: "distinct" }, { op: "min", key: "min" }, { op: "max", key: "max" }];
/** Field-picker statistics as ungrouped metrics: `<field>:distinct`, and
 * `<field>:min`/`<field>:max` where the field allows them. Fields without a
 * measurable backend source are left out. */
export function toFieldStatsRequestV3(schema: FieldSchema, fields: string[], capabilities: QueryCapabilitiesV3,
  options: AuxiliaryRequestOptions = {}): QueryRequestV3 {
  const metrics: AggregationClause[] = [];
  for (const name of new Set(fields)) {
    const field = schema.fields.find(f => f.name === name);
    if (!field || field.source.kind !== "backend" || !isMeasurable(field)) continue;
    const ops = aggOpsForField(field);
    for (const { op, key } of STAT_OPS) if (ops.includes(op)) metrics.push({ id: `${name}:${key}`, op, field: name, groupBy: [] });
  }
  return auxiliaryRequest(capabilities, emptyStage(), emptyStage(), options, { rows: false, metrics });
}
export function readFieldStatsResultV3(result: QueryResultV3, request: QueryRequestV3, schema: FieldSchema): Record<string, FieldStats> {
  validateQueryResultV3(result, request, schema);
  const byId = new Map(result.metrics.map(metric => [metric.id, metric]));
  const stats: Record<string, FieldStats> = {};
  for (const metric of request.metrics) {
    const entry = byId.get(metric.id), value = entry && !entry.error ? entry.buckets[0]?.value : undefined;
    const key = metric.id.slice(metric.field!.length + 1) as keyof FieldStats, item = stats[metric.field!] ??= {};
    if (key === "distinct" ? typeof value === "number" : typeof value === "number" || typeof value === "string") item[key] = value as never;
  }
  return stats;
}
/** Requests run in batches of at most MAX_AGGREGATIONS metrics. */
export async function fetchFieldStatsV3(transport: Transport, schema: FieldSchema, fields: string[],
  options: AuxiliaryRequestOptions = {}, signal?: AbortSignal): Promise<Record<string, FieldStats>> {
  const all = toFieldStatsRequestV3(schema, fields, transport.queryCapabilities, options);
  if (all.diagnostics.length) throw Error(all.diagnostics.join(" "));
  const stats: Record<string, FieldStats> = {};
  for (let i = 0; i < all.metrics.length; i += MAX_AGGREGATIONS) {
    const request = { ...all, metrics: all.metrics.slice(i, i + MAX_AGGREGATIONS) };
    for (const [name, item] of Object.entries(readFieldStatsResultV3(await execute(transport, request, signal), request, schema)))
      stats[name] = { ...stats[name], ...item };
  }
  return stats;
}