// useAggregations — the metric panel's data side.
//
// Runs the optional GROUP BY queries that back the metrics shown above the table.
// Kept separate from the rows fetch so the panel loads/refreshes independently:
// metrics depend ONLY on the WHERE filter + the aggregation specs (scope is the
// whole filtered set — never the page window), so paging or re-sorting the table
// does not re-issue them. Debounced + abortable, mirroring the rows fetch.

import { useEffect, useMemo, useState } from "react";
import { applyAggregations, toAggregationQuery } from "@pythia-software/query-table-core";
import type { AggregationResult, FieldSchema, QueryState, Transport } from "@pythia-software/query-table-core";

export interface AggregationsApiState {
  results: AggregationResult | null;
  loading: boolean;
  error: Error | null;
}

const EMPTY_RESULT: AggregationResult = { metrics: [] };

export function useAggregations<Row>(
  query: QueryState,
  schema: FieldSchema<Row>,
  transport: Transport<Row> | undefined,
  clientRows: Row[] | undefined,
  debounceMs: number,
  nonce: number,
): AggregationsApiState {
  const [results, setResults] = useState<AggregationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Metrics depend only on WHERE + the agg specs. Keying on just those avoids
  // refetching when the user pages or re-sorts the table.
  const key = useMemo(
    () => JSON.stringify({ where: query.where, aggregations: query.aggregations ?? [] }),
    [query.where, query.aggregations],
  );
  const hasAggregations = (query.aggregations?.length ?? 0) > 0;

  useEffect(() => {
    if (!hasAggregations) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        let res: AggregationResult;
        if (transport?.fetchAggregations) {
          res = await transport.fetchAggregations(toAggregationQuery(query, schema), ac.signal);
        } else if (clientRows) {
          res = applyAggregations(clientRows, query, schema);
        } else {
          res = EMPTY_RESULT;
        }
        if (!cancelled) setResults(res);
      } catch (e) {
        if (!cancelled && !ac.signal.aborted) setError(e as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const t = setTimeout(run, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
      ac.abort();
    };
    // `key` captures the relevant query subset; clientRows/nonce force a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasAggregations, transport, clientRows, schema, debounceMs, nonce]);

  return { results, loading, error };
}
