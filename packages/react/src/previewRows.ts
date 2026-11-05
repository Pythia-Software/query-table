import {
  predicatesOf,
  sourceExecutionSchema,
  toQueryRequestV3,
  validateQueryResultV3,
  type ComputedColumn,
  type ComputedExecution,
  type FieldSchema,
  type QueryState,
  type Transport,
} from "@pythia-software/query-table-core";
import { executionRevision } from "./computedExecution";

/** Fetch inputs for local draft evaluation through the v3 executor. The draft
 * source is never sent to a server or substituted for a saved ID. */
export async function fetchPreviewRows<Row>(
  transport: Transport<Row>,
  query: QueryState,
  schema: FieldSchema<Row>,
  execution: ComputedExecution | undefined,
  definitions: ComputedColumn[],
  now: number,
  signal: AbortSignal,
  baseSchema: FieldSchema<Row> = schema,
): Promise<{ rows: Row[]; total: number }> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const sourceSchema = sourceExecutionSchema(baseSchema, execution, definitions);
  const request = toQueryRequestV3({ ...query, aggregations: [] }, sourceSchema,
    transport.queryCapabilities, execution, { now });
  // The server executes its own revision; never preview a changed local definition with it.
  const executed = new Set([...request.result.select, ...request.result.orderBy.map(term => term.field),
    ...[...request.source.where, ...request.result.where].flatMap(term => predicatesOf(term).map(predicate => predicate.field))]);
  for (const definition of definitions)
    if (executed.has(`@computed/${definition.id}`) && executionRevision(execution, definition.id) !== definition.revision)
      throw Error("Computed definitions changed. Refresh the server execution handshake.");
  const response = await transport.fetchQueryV3(request, signal);
  // Transports may ignore abort while completing I/O; never publish that page.
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  validateQueryResultV3(response, request, query.grouping ? schema : sourceSchema);
  if (response.rows.length > query.limit) throw Error("Invalid preview row response.");
  return { rows: response.rows as Row[], total: response.total };
}
