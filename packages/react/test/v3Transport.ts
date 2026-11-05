// A v3 server over in-memory rows, for tests: rows, grouping, metrics and
// distinct values are evaluated with core's local engines.
import { vi } from "vitest";
import {
  EMPTY_QUERY,
  applyQuery,
  createGroupingModel,
  evaluateMetrics,
  readFieldValue,
  type FieldSchema,
  type QueryCapabilitiesV3,
  type QueryRequestV3,
  type QueryResultV3,
  type QueryState,
  type ServerQuery,
  type Transport,
  type GroupingState,
} from "@pythia-software/query-table-core";

export const MEMORY_V3_CAPABILITIES: QueryCapabilitiesV3 = {
  version: 3, profile: "memory-v3", groupedRows: true, calendarGrouping: true, calendarCycles: true, calendarGroupKeys: true,
  computedSourceFilters: true, regex: true, regexSourceFilters: true, metricFilters: true, metricMinCount: true,
  metricMinCountMeasures: true, maxRows: 10000, maxGroups: 10000, maxPopulation: 1_000_000,
};

export interface MemoryV3Options {
  capabilities?: Partial<QueryCapabilitiesV3>;
  /** Return only the selected fields and the identity, as a server would. */
  project?: boolean;
  /** Runs before each request is served; throw to fail it. */
  before?: (request: QueryRequestV3, signal?: AbortSignal) => void | Promise<void>;
}

const stage = (query: ServerQuery): QueryState => ({ ...EMPTY_QUERY, ...query, select: query.select.map(field => ({ field })) });

/** Serve one v3 request over `rows`, as a v3 server would. */
export function serveQueryV3<Row>(rows: Row[], schema: FieldSchema<Row>, request: QueryRequestV3, options: MemoryV3Options = {}): QueryResultV3 {
  const now = { now: request.now };
  const execution = { profile: request.profile, planToken: request.planToken ?? "", resolvedRevisions: { ...request.expectedRevisions }, fields: {},
    ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}) };
  const population = applyQuery(rows, { ...stage(request.source), limit: 0, offset: 0 }, schema, now).rows;
  if (request.distinct) {
    const { field: name, search, limit } = request.distinct;
    const field = schema.fields.find(f => f.name === name);
    if (!field) throw Error(`Unknown distinct field ${name}.`);
    const counts = new Map<string, number>();
    let hasNull = false;
    for (const row of population) {
      const value = readFieldValue(field, row);
      const values = field.type === "textarray" ? (Array.isArray(value) ? value : []) : [value];
      if (value == null || !values.length) hasNull = true;
      for (const item of values) {
        if (item == null) continue;
        const text = String(item);
        if (text.toLowerCase().includes(search.toLowerCase())) counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }
    const values = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([value]) => value);
    return { version: 3, now: request.now, sourceTotal: 0, rows: [], total: 0, metrics: [], execution,
      schema: { name: schema.name, idField: schema.idField, fields: [] },
      distinct: { values: values.slice(0, limit), hasMore: values.length > limit, hasNull } };
  }
  const query: QueryState = { ...stage(request.result), aggregations: request.metrics,
    ...(request.grouping ? { grouping: { ...request.grouping, source: stage(request.source) } as GroupingState } : {}) };
  const resultSchema = (request.grouping ? createGroupingModel(schema).resultSchema(request.grouping.keys, request.grouping.summaries) : schema) as FieldSchema;
  const input = request.grouping ? rows : population;
  const page = applyQuery(input, query, schema, now);
  const names = [...new Set([resultSchema.idField, ...request.result.select])];
  return { version: 3, now: request.now, sourceTotal: population.length, total: page.total, execution,
    rows: !request.rows ? [] : (page.rows as Record<string, unknown>[]).map(row => options.project
      ? Object.fromEntries(names.map(name => [name, row[name]])) : row),
    schema: { name: resultSchema.name, idField: resultSchema.idField, fields: resultSchema.fields.map(field => ({ name: field.name, type: field.type })) },
    metrics: request.metrics.length ? evaluateMetrics(input, query, schema, now).metrics : [] };
}

/** A Transport whose fetchQueryV3 is a spy serving `rows`. */
export function memoryV3Transport<Row>(rows: Row[] | (() => Row[]), schema: FieldSchema<Row>, options: MemoryV3Options = {}) {
  const fetchQueryV3 = vi.fn(async (request: QueryRequestV3, signal?: AbortSignal): Promise<QueryResultV3> => {
    await options.before?.(request, signal);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return serveQueryV3(typeof rows === "function" ? rows() : rows, schema, request, options);
  });
  const transport = { queryCapabilities: { ...MEMORY_V3_CAPABILITIES, ...options.capabilities }, fetchQueryV3 } satisfies Transport<Row>;
  return transport;
}

/** The requests a memory transport received, by kind. */
export const rowRequests = (transport: { fetchQueryV3: { mock: { calls: [QueryRequestV3, ...unknown[]][] } } }) =>
  transport.fetchQueryV3.mock.calls.map(([request]) => request).filter(request => request.rows);
export const metricRequests = (transport: { fetchQueryV3: { mock: { calls: [QueryRequestV3, ...unknown[]][] } } }) =>
  transport.fetchQueryV3.mock.calls.map(([request]) => request).filter(request => !request.rows && !request.distinct);
export const distinctRequests = (transport: { fetchQueryV3: { mock: { calls: [QueryRequestV3, ...unknown[]][] } } }) =>
  transport.fetchQueryV3.mock.calls.map(([request]) => request).filter(request => request.distinct);

/** A valid empty response to `request`, echoing its envelope; `part` overrides. */
export function v3Response(request: QueryRequestV3, part: Partial<QueryResultV3> = {}, idField = "id"): QueryResultV3 {
  return { version: 3, now: request.now, sourceTotal: 0, rows: [], total: 0, metrics: [],
    schema: { name: "v3", idField, fields: [] },
    execution: { profile: request.profile, planToken: request.planToken ?? "", resolvedRevisions: { ...request.expectedRevisions }, fields: {},
      ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}) }, ...part };
}
