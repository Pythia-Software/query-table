import type { FieldSchema, QueryCapabilitiesV3, QueryResultV3, StorageAdapter, Transport } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, QueryBuilder, MetricsPanel } from "@pythia-software/query-table-ui";

/** Keep this adapter stable. The endpoint authorizes the dataset and executes
 * grouping/calendar queries on the server, returning pages and metric buckets. */
export function withServerExecution<Row>(services: Transport<Row>, endpoint: string, capabilities: QueryCapabilitiesV3): Transport<Row> {
  return {
    ...services,
    queryCapabilities: capabilities,
    async fetchQueryV3(request, signal) {
      const response = await fetch(endpoint, { method: "POST", ...(signal ? { signal } : {}),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      if (!response.ok) throw Error(`Query execution failed (HTTP ${response.status}).`);
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
