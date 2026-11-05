import type { ComputedExecution } from "@pythia-software/query-table-core";
export function executionRevision(
  execution: ComputedExecution | undefined,
  id: string,
): string | undefined {
  return (
    execution?.resolvedRevisions[id] ??
    execution?.resolvedRevisions[`@computed/${id}`]
  );
}
