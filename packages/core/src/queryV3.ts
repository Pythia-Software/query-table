import { createGroupingModel, withoutGrouping, type GroupingDefinition } from "./grouping";
import { MAX_AGGREGATIONS, normalizeQueryState, predicatesOf, type QueryState, type AggregationClause } from "./query";
import { toServerQuery } from "./encode";
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
import { QueryError, type ErrorCode } from "./errors";

import type { QueryCapabilitiesV3, QueryRequestV3, DistinctRequestV3, DistinctResultV3, QueryResultV3, ServerQuery, MetricSpecV3, WireSummaryColumn } from "./wire.generated";
// The wire types are generated from schema/query-wire.schema.json.
export type { QueryCapabilitiesV3, QueryRequestV3, DistinctRequestV3, DistinctResultV3, QueryResultV3 };
export const MAX_DISTINCT_LIMIT = 500;
export const MAX_DISTINCT_SEARCH_LENGTH = 2000;
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
/** A reason the client will not send a request. */
interface Refusal { code: ErrorCode; message: string; field?: string; metricId?: string; capability?: keyof QueryCapabilitiesV3 }
const unsupported = (capability: keyof QueryCapabilitiesV3, message: string, field?: string): Refusal =>
  ({ code: "capability_unsupported", message, capability, ...(field !== undefined ? { field } : {}) });
/** Throws the refusals as one QueryError: the first refusal's code and
 * details, with every distinct message. Nothing is sent. */
function refuse(refusals: Refusal[]): void {
  const [first] = refusals;
  if (!first) return;
  const { code, message: _message, ...details } = first;
  throw new QueryError(code, [...new Set(refusals.map(refusal => refusal.message))].join(" "), details);
}
/** The negotiated identity every request carries. Pushes envelope issues onto `refusals`. */
function requestEnvelope(capabilities: QueryCapabilitiesV3, execution: ComputedExecution | undefined, now: number, refusals: Refusal[]) {
  const revisions: Record<string, string> = Object.create(null);
  for (const [id, revision] of Object.entries(execution?.resolvedRevisions ?? {})) {
    if (!revision || id.length > 256 || revision.length > 256) refusals.push({ code: "definition_changed", message: "Invalid computed revision envelope." });
    else revisions[id.startsWith("@computed/") ? id.slice(10) : id] = revision;
  }
  return { version: 3 as const, profile: capabilities.profile, now, expectedRevisions: revisions,
    ...(execution?.planToken ? { planToken: execution.planToken } : {}), ...(execution?.snapshot !== undefined ? { snapshot: execution.snapshot } : {}) };
}
const profileRefusal: Refusal = { code: "profile_mismatch", message: "The negotiated query profile is unavailable." };
/** The v3 request for a query. Throws a QueryError, before anything is sent,
 * when the query needs a capability the server does not advertise or would
 * leave a filter or sort on the client (see docs/errors.md). */
export function toQueryRequestV3<Row>(query: QueryState, baseSchema: FieldSchema<Row>, capabilities: QueryCapabilitiesV3,
  execution?: ComputedExecution, options: { now?: number; rows?: boolean } = {}): QueryRequestV3 {
  const now = evaluationTime(options), q = normalizeQueryState(query);
  const sourceSchema = sourceExecutionSchema(baseSchema, execution);
  const source = q.grouping?.source ?? withoutGrouping(q);
  const refusals: Refusal[] = [];
  if ((query.aggregations?.length ?? 0) !== (q.aggregations?.length ?? 0))
    refusals.push({ code: "invalid_metric", message: "The query exceeds its metric budget or contains malformed metric state." });
  if (profileUnavailable(capabilities, execution)) refusals.push(profileRefusal);
  let resultSchema = sourceSchema as FieldSchema<any>;
  if (q.grouping) {
    if (!capabilities.groupedRows) refusals.push(unsupported("groupedRows", "This server does not support grouped rows."));
    else if (q.grouping.keys.some(isCalendarGroupKey) && !capabilities.calendarGroupKeys)
      refusals.push(unsupported("calendarGroupKeys", "This server does not support grouping keys by calendar interval."));
    for (const message of q.grouping.diagnostics ?? []) refusals.push({ code: "grouping", message });
    try { const model = createGroupingModel(sourceSchema); model.validate(q.grouping); resultSchema = model.resultSchema(q.grouping.keys, q.grouping.summaries); }
    catch (error) { refusals.push({ code: "grouping", message: error instanceof Error ? error.message : String(error) }); }
  }
  const sourceRequest = toServerQuery(withoutGrouping(source), sourceSchema);
  for (const term of source.where) for (const predicate of predicatesOf(term)) if (["matches_regex", "not_matches_regex"].includes(predicate.op) && !capabilities.regexSourceFilters)
    refusals.push(unsupported("regexSourceFilters", "This server profile does not support isolated regex source filtering.", predicate.field));
  const result = toServerQuery(withoutGrouping(q), resultSchema);
  if (sourceRequest.where.length !== source.where.length || result.where.length !== q.where.length)
    refusals.push({ code: "residual_query", message: "The query contains unsupported source or result predicates." });
  if (result.orderBy.length !== q.orderBy.length) refusals.push({ code: "residual_query", message: "The query contains unsupported result ordering." });
  if (q.grouping) for (const term of q.grouping.source.where) for (const predicate of predicatesOf(term))
    if (predicate.field.startsWith("@computed/") && !capabilities.computedSourceFilters)
      refusals.push(unsupported("computedSourceFilters", "This server does not support computed source predicates.", predicate.field));
  const metricQuery = toMetricQuery(withoutGrouping(q), resultSchema, execution);
  // The projection keeps only pushdown metric-filter terms; never send the
  // narrowed population silently. (Its other diagnostics, such as calendar
  // grouping, describe the v2 transport and do not apply here.)
  for (const issue of metricQuery.diagnostics)
    if (issue.code === "residual_metric_filter" || issue.code === "unexpanded_series")
      refusals.push({ code: issue.code === "unexpanded_series" ? "unexpanded_series" : "residual_query", message: issue.message, ...(issue.metricId ? { metricId: issue.metricId } : {}) });
  const metrics: MetricSpecV3[] = [];
  // unsupportedOp marks an operation this client cannot read; its op is a
  // placeholder, so the metric is refused rather than run as that op. It and
  // diagnostics are client state and never cross the wire.
  for (const { unsupportedOp, ...clause } of metricQuery.metrics) {
    const { diagnostics: _diagnostics, ...projected } = clause;
    if (unsupportedOp)
      refusals.push({ code: "invalid_metric", message: `Metric ${projected.id} uses an unsupported operation: ${unsupportedOp}.`, metricId: projected.id });
    const dateGrouping = q.aggregations?.find(c => c.id === projected.id)?.dateGrouping;
    for (const issue of validateMetric({ ...clause, ...(dateGrouping ? { dateGrouping } : {}) } as AggregationClause, resultSchema))
      refusals.push({ code: "invalid_metric", message: issue.message, metricId: projected.id });
    if (dateGrouping && !capabilities.calendarGrouping)
      refusals.push({ ...unsupported("calendarGrouping", "This server does not support calendar grouping."), metricId: projected.id });
    else if (isMetricCycle(dateGrouping?.interval) && !capabilities.calendarCycles)
      refusals.push({ ...unsupported("calendarCycles", "This server does not support hour-of-day or day-of-week grouping."), metricId: projected.id });
    // The projection keeps only the scatter display hint.
    metrics.push((dateGrouping ? { ...projected, dateGrouping } : projected) as MetricSpecV3);
  }
  const envelope = requestEnvelope(capabilities, execution, now, refusals);
  refuse(refusals);
  return { ...envelope,
    source: sourceRequest, result, ...(q.grouping ? { grouping: { keys: q.grouping.keys,
      // Summary display is presentation only and link columns are computed on
      // the client; the wire contract is unchanged.
      summaries: withoutLinkSummaries(q.grouping.summaries).map(({ display: _display, link: _link, ...summary }) => summary as WireSummaryColumn),
      representative: q.grouping.representative } } : {}), rows: options.rows !== false, metrics };
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
  part: Pick<QueryRequestV3, "rows" | "metrics"> & { distinct?: DistinctRequestV3 }, refusals: Refusal[] = []): QueryRequestV3 {
  if (profileUnavailable(capabilities, options.execution)) refusals.unshift(profileRefusal);
  // Keys follow the schema's property order, the order Go encodes.
  const envelope = requestEnvelope(capabilities, options.execution, evaluationTime(options), refusals);
  refuse(refusals);
  return { ...envelope,
    source, result, ...part,
    ...(options.hostState ? { hostState: options.hostState } : {}) };
}
async function execute(transport: Transport, request: QueryRequestV3, signal?: AbortSignal): Promise<QueryResultV3> {
  const result = await transport.fetchQueryV3(request, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}

/** Filter autocomplete: distinct values of `field` over `where` (default: the
 * whole source). */
export function toDistinctRequestV3(field: string, search: string, capabilities: QueryCapabilitiesV3,
  options: AuxiliaryRequestOptions & { limit?: number; where?: WhereTerm[] } = {}): QueryRequestV3 {
  const limit = options.limit ?? 50, refusals: Refusal[] = [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISTINCT_LIMIT) refusals.push({ code: "invalid_query", message: `Distinct value limit must be between 1 and ${MAX_DISTINCT_LIMIT}.` });
  if (search.length > MAX_DISTINCT_SEARCH_LENGTH) refusals.push({ code: "invalid_query", message: "Distinct search exceeds its budget." });
  return auxiliaryRequest(capabilities, emptyStage(options.where), emptyStage(), options, { rows: false, metrics: [], distinct: { field, search, limit } }, refusals);
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
/** One row by identity (a refresh after a mutation, or an item lookup). It
 * asks for two rows, within the server's row budget; the total reports a
 * duplicate identity either way. */
export function toRowRequestV3(schema: FieldSchema, id: RowId, capabilities: QueryCapabilitiesV3,
  options: AuxiliaryRequestOptions & { select?: string[] } = {}): QueryRequestV3 {
  const stage: ServerQuery = { select: options.select ? [...new Set([schema.idField, ...options.select])].sort() : rowLookupFields(schema),
    where: [{ field: schema.idField, op: "=", value: String(id) }], orderBy: [], limit: Math.max(1, Math.min(2, capabilities.maxRows)), offset: 0 };
  return auxiliaryRequest(capabilities, stage, stage, options, { rows: true, metrics: [] });
}
/** The matching row, or null when none matches. Two matches are an error. */
export function readRowResultV3<Row = Record<string, unknown>>(result: QueryResultV3, request: QueryRequestV3, schema: FieldSchema): Row | null {
  if (Array.isArray(result?.rows) && result.rows.length > 1 || result?.total > 1) throw Error("Row identity must be unique.");
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
  const metrics: MetricSpecV3[] = [];
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
  // Field names are data: a Map never resolves one such as __proto__ to a prototype.
  const stats = new Map<string, FieldStats>();
  for (const metric of request.metrics) {
    const entry = byId.get(metric.id), value = entry && !entry.error ? entry.buckets[0]?.value : undefined;
    const key = metric.id.slice(metric.field!.length + 1) as keyof FieldStats;
    const item = stats.get(metric.field!) ?? {};
    stats.set(metric.field!, item);
    if (key === "distinct" ? typeof value === "number" : typeof value === "number" || typeof value === "string") item[key] = value as never;
  }
  return Object.fromEntries(stats);
}
/** Requests run in batches of at most MAX_AGGREGATIONS metrics. */
export async function fetchFieldStatsV3(transport: Transport, schema: FieldSchema, fields: string[],
  options: AuxiliaryRequestOptions = {}, signal?: AbortSignal): Promise<Record<string, FieldStats>> {
  const all = toFieldStatsRequestV3(schema, fields, transport.queryCapabilities, options);
  const stats = new Map<string, FieldStats>();
  for (let i = 0; i < all.metrics.length; i += MAX_AGGREGATIONS) {
    const request = { ...all, metrics: all.metrics.slice(i, i + MAX_AGGREGATIONS) };
    for (const [name, item] of Object.entries(readFieldStatsResultV3(await execute(transport, request, signal), request, schema)))
      stats.set(name, { ...stats.get(name), ...item });
  }
  return Object.fromEntries(stats);
}