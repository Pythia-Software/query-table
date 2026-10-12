import { useEffect, useMemo, useState } from "react";
import {
  objectReferenceKey,
  type ObjectReference,
  type RelationshipAdapter,
  type ResolvedObjectReference,
} from "@pythia-software/query-table-core";

/** One cancellable batch per displayed reference set; rejects unrelated results. */
export function useObjectReferences(
  references: ObjectReference[],
  adapter?: RelationshipAdapter,
) {
  const fingerprint = JSON.stringify(references.map(objectReferenceKey).sort());
  const batch = useMemo(
    () => [
      ...new Map(
        references.map((reference) => [
          objectReferenceKey(reference),
          reference,
        ]),
      ).values(),
    ],
    [fingerprint],
  );
  const [state, setState] = useState({
    fingerprint: "",
    adapter: undefined as RelationshipAdapter | undefined,
    values: new Map<string, ResolvedObjectReference>(),
    error: null as Error | null,
  });
  useEffect(() => {
    const controller = new AbortController();
    if (!adapter || batch.length === 0) return;
    const allowed = new Set(batch.map(objectReferenceKey));
    void Promise.resolve()
      .then(() => adapter.resolve(batch, controller.signal))
      .then((results) => {
        if (controller.signal.aborted) return;
        const values = new Map<string, ResolvedObjectReference>();
        for (const result of results) {
          const key = objectReferenceKey(result.reference);
          if (allowed.has(key)) values.set(key, result);
        }
        setState({ fingerprint, adapter, values, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            fingerprint,
            adapter,
            values: new Map(),
            error: error instanceof Error ? error : new Error(String(error)),
          });
      });
    return () => controller.abort();
  }, [batch, adapter]);
  const current =
    state.fingerprint === fingerprint && state.adapter === adapter;
  return {
    values: current ? state.values : new Map<string, ResolvedObjectReference>(),
    error: current ? state.error : null,
  };
}
