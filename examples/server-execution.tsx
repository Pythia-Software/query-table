import { queryErrorFromResponse, type FieldSchema, type QueryCapabilitiesV3, type QueryResultV3, type StorageAdapter, type Transport } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, QueryBuilder, MetricsPanel } from "@pythia-software/query-table-ui";

/** Keep this adapter stable. The endpoint authorizes the dataset and executes
 * every request on the server: row pages, grouping, metric buckets, filter
 * suggestions (`distinct`), row lookups and field statistics. */
export function withServerExecution<Row>(endpoint: string, capabilities: QueryCapabilitiesV3): Transport<Row> {
  return {
    queryCapabilities: capabilities,
    async fetchQueryV3(request, signal) {
      const response = await fetch(endpoint, { method: "POST", ...(signal ? { signal } : {}),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      // A QueryError with the server's code (see docs/errors.md).
      if (!response.ok) throw await queryErrorFromResponse(response);
      return await response.json() as QueryResultV3;
    },
  };
}

export function ServerQueryTable<Row>({ schema, transport, storage }: {
  schema: FieldSchema<Row>; transport: Transport<Row>; storage: StorageAdapter;
}) {
  const table = useQueryTable({ schema, transport, storage, syncUrl: true, queryParameter: "q_runs" });
  return <>
    <QueryBuilder api={table} fields={table.schema!.fields} total={table.total} />
    {table.error && <p role="alert">{table.error.message}</p>}
    <DataTable fields={table.visibleFields} rows={table.rows} query={table.query} onQueryChange={table.setQuery} rowId={table.rowId} renderers={{}} />
    <MetricsPanel api={table} aggregations={table.aggregations} fields={table.schema!.fields} />
  </>;
}
