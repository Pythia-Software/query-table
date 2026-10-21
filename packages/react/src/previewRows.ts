import {
  sourceExecutionSchema,
  toQueryRequestV3,
  toServerQuery,
  toServerQueryV2,
  validateQueryResultV3,
  type ComputedColumn,
  type ComputedExecution,
  type FetchRowsResult,
  type FieldSchema,
  type QueryState,
  type Transport,
} from "@pythia-software/query-table-core";
import { executionRevision, validateComputedResponse } from "./computedExecution";

/** Fetch inputs for local draft evaluation using the negotiated row protocol.
 * The draft source is never sent to a server or substituted for a saved ID. */
export async function fetchPreviewRows<Row>(
  transport: Transport<Row>,
  query: QueryState,
  schema: FieldSchema<Row>,
  execution: ComputedExecution | undefined,
  definitions: ComputedColumn[],
  now: number,
  signal: AbortSignal,
  baseSchema: FieldSchema<Row> = schema,
): Promise<FetchRowsResult<Row>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const sourceSchema = sourceExecutionSchema(baseSchema, execution, definitions);
  let result: FetchRowsResult<Row>;
  const computedFilter = query.where.some(term => ("any" in term ? term.any : [term])
    .some(predicate => predicate.field.startsWith("@computed/")));
  if (transport.fetchRowsV2 && execution && !query.grouping && !computedFilter) {
    const request = toServerQueryV2(query, sourceSchema, execution);
    if (request.diagnostics.length)
      throw Error(request.diagnostics.map(issue => issue.message).join(" "));
    for (const definition of definitions) {
      if (executionRevision(execution, definition.id) !== definition.revision &&
        (request.select.includes(`@computed/${definition.id}`) ||
          request.orderBy.some(term => term.field === `@computed/${definition.id}`) ||
          request.where.some(term => ("any" in term ? term.any : [term]).some(predicate => predicate.field === `@computed/${definition.id}`))))
        throw Error("Computed definitions changed. Refresh the server execution handshake.");
    }
    const response = await transport.fetchRowsV2(request, signal);
    validateComputedResponse(request, response, sourceSchema);
    result = response;
  } else if (transport.fetchQueryV3 && transport.queryCapabilities?.version === 3) {
    const request = toQueryRequestV3({ ...query, aggregations: [] }, sourceSchema,
      transport.queryCapabilities, execution, { now });
    if (request.diagnostics.length) throw Error(request.diagnostics.join(" "));
    const response = await transport.fetchQueryV3(request, signal);
    validateQueryResultV3(response, request, query.grouping ? schema : sourceSchema);
    result = { rows: response.rows as Row[], total: response.total };
  } else if (transport.fetchRows && !query.grouping && !(computedFilter && transport.fetchRowsV2 && execution)) {
    result = await transport.fetchRows(toServerQuery(query, schema), signal);
  } else {
    throw Error("Row execution requires fetchRows, negotiated fetchRowsV2, or negotiated fetchQueryV3.");
  }
  // Transports may ignore abort while completing I/O; never publish that page.
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.rows) || result.rows.length > query.limit)
    throw Error("Invalid preview row response.");
  return result;
}
