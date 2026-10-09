import {
  isComputedField,
  readFieldValue,
  type ComputedExecution,
  type FetchRowsResultV2,
  type FieldSchema,
  type ServerQueryV2,
} from "@pythia-software/query-table-core";
export function executionRevision(
  execution: ComputedExecution | undefined,
  id: string,
): string | undefined {
  return (
    execution?.resolvedRevisions[id] ??
    execution?.resolvedRevisions[`@computed/${id}`]
  );
}
/** Reject mismatched sidecars before they can be attached to committed row identities. */
export function validateComputedResponse<Row>(
  request: ServerQueryV2,
  result: FetchRowsResultV2<Row>,
  schema: FieldSchema<Row>,
): void {
  const execution = result.execution;
  if (
    result.version !== 2 ||
    !execution ||
    execution.profile !== request.profile ||
    (request.planToken && execution.planToken !== request.planToken) ||
    (request.snapshot !== undefined && execution.snapshot !== request.snapshot)
  )
    throw Error(
      "Server computed execution identity changed. Refresh the handshake.",
    );
  // The backend validates the full transitive envelope. Browser response checks
  // concern only fields actually executed for this row request; a catalogue can
  // also contain revisions for browser-only definitions.
  const executed = new Set([
    ...request.select.filter(isComputedField),
    ...request.orderBy.map((term) => term.field).filter(isComputedField),
  ]);
  for (const [name, revision] of Object.entries(request.expectedRevisions)) {
    const id = name.replace(/^@computed\//, "");
    if (!executed.has(`@computed/${id}`)) continue;
    if (executionRevision(execution, id) !== revision)
      throw Error(
        "Server computed definition revision changed. Refresh the handshake.",
      );
  }
  const idField = schema.fields.find((f) => f.name === schema.idField);
  if (!idField)
    throw Error("Stable row identity is required for computed values.");
  const ids = new Set(result.rows.map((row) => readFieldValue(idField, row)));
  if (ids.has(null) || ids.has(undefined) || ids.size !== result.rows.length)
    throw Error(
      "Computed response contains missing or duplicate row identities.",
    );
  const sidecars = new Map(
    result.computed.map((item) => [item.id, item.values]),
  );
  if (
    sidecars.size !== result.computed.length ||
    [...sidecars.keys()].some((id) => !ids.has(id))
  )
    throw Error("Computed sidecars do not match returned row identities.");
  for (const field of request.select.filter(isComputedField)) {
    const id = field.slice("@computed/".length);
    for (const rowId of ids) {
      const value = sidecars.get(rowId as string | number)?.[id];
      if (
        !value ||
        (value.value !== null &&
          !["string", "number", "boolean"].includes(typeof value.value)) ||
        (typeof value.value === "number" && !Number.isFinite(value.value))
      )
        throw Error(`Missing or invalid server computed result: ${field}.`);
    }
  }
}
