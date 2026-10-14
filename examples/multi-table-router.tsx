import { useEffect } from "react";
import type { FieldSchema, StorageAdapter, Transport } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { QueryBuilder, DataTable } from "@pythia-software/query-table-ui";

type Row = Record<string, unknown>;
type Router = { subscribe(listener: (location: string) => void): () => void };
/** Subscribe should publish absolute or relative locations after the host's
 * pushState/router commit. Back/forward
 * is also supported by the controller's existing popstate listener. */
export function MultiTableRouter({ route, router, librarySchema, toolsSchema, libraryTransport, toolsTransport, storage }: {
  route: "library" | "tools"; router: Router;
  librarySchema: FieldSchema<Row>; toolsSchema: FieldSchema<Row>;
  libraryTransport: Transport<Row>; toolsTransport: Transport<Row>; storage: StorageAdapter;
}) {
  const library = useQueryTable({ schema: librarySchema, transport: libraryTransport, storage,
    queryParameter: "q_library", syncUrl: true, active: route === "library" });
  const tools = useQueryTable({ schema: toolsSchema, transport: toolsTransport, storage,
    queryParameter: "q_tools", syncUrl: true, active: route === "tools" });
  useEffect(() => router.subscribe(location => {
    const active = route === "library" ? library : tools;
    void active.restoreLocation(location).catch(() => { /* The controller exposes the error and holds execution. */ });
  }), [router, route, library.restoreLocation, tools.restoreLocation]);
  return <>
    <section hidden={route !== "library"}>
      <QueryBuilder api={library} fields={library.schema!.fields} total={library.total} />
      <DataTable fields={library.visibleFields} rows={library.rows} query={library.query} onQueryChange={library.setQuery} rowId={library.rowId} renderers={{}} />
    </section>
    <section hidden={route !== "tools"}>
      <QueryBuilder api={tools} fields={tools.schema!.fields} total={tools.total} />
      <DataTable fields={tools.visibleFields} rows={tools.rows} query={tools.query} onQueryChange={tools.setQuery} rowId={tools.rowId} renderers={{}} />
    </section>
  </>;
}
