// usage.tsx — a worked example of the full public surface, for design review.
// This is the "does it compose?" test: it typechecks against the real packages
// (see examples/tsconfig.json). Not shipped; not part of any package build.

import { loadSchema, localStorageAdapter, queryErrorFromResponse, type Transport, type QueryCapabilitiesV3, type QueryResultV3, type QueryState, type RowId } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  DataTable,
  QueryBuilder,
  SelectionToolbar,
  defaultRenderers,
  type RenderRegistry,
  type CellContext,
} from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

import runsDoc from "../schema/examples/runs.schema.json";

// 1. The dataset's row type (would be generated alongside the schema).
interface Run {
  id: number;
  job_name: string | null;
  platform: string;
  overall: "PASS" | "FAIL" | "DIFFERENCES" | null;
  total_ms: number | null;
  is_starred: boolean;
  error_codes: string[] | null;
}

// 2. Load the schema (the JSON doc shared with the Go backend).
const schema = loadSchema<Run>(runsDoc);

// 3. A Transport — the only backend-specific glue. Every request (row pages,
//    metrics, grouped views, filter-value suggestions, row lookups and field
//    statistics) is one QueryRequestV3, POSTed here to the Go NewQueryV3Handler.
//    The capabilities come from the server's handshake.
declare const capabilities: QueryCapabilitiesV3;
const transport: Transport<Run> = {
  queryCapabilities: capabilities,
  async fetchQueryV3(request, signal) {
    const res = await fetch("/api/runs/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: signal ?? null,
    });
    // The Go handlers answer failures with a JSON QueryErrorBody; keep its code.
    if (!res.ok) throw await queryErrorFromResponse(res);
    return res.json() as Promise<QueryResultV3>;
  },
};

// 4. Domain renderers the generic package intentionally does NOT ship. Keyed by
//    the `render` strings in the schema doc.
const renderers: RenderRegistry<Run> = {
  ...defaultRenderers,
  overall_pill: ({ value }: CellContext<Run>) => <span className={`qt-pill--${String(value).toLowerCase()}`}>{String(value)}</span>,
  tag_marker: ({ value }: CellContext<Run>) => <span title="priority">{value ? "★" : "☆"}</span>,
  link_run: ({ value }: CellContext<Run>) => <a href={`/runs/${value}`}>{String(value).slice(0, 8)}</a>,
  code_tags: ({ value }: CellContext<Run>) => (
    <>
      {((value as string[] | null) ?? []).map((s) => (
        <span key={s} className="qt-pill--fail">
          {s}
        </span>
      ))}
    </>
  ),
  detail_link: ({ row }: CellContext<Run>) => <button onClick={() => openDetails(row.id)}>view</button>,
};

declare function openDetails(id: number): void;
declare function bulkRerun(ids: RowId[]): void;

// 5. The component. ~15 lines of glue; everything else is the schema.
export function RunsTable({ initialQuery }: { initialQuery?: QueryState }) {
  const api = useQueryTable<Run>({
    schema,
    transport,
    // Opt in only for non-sensitive filters: this is cleartext JSON.
    // Prefer a server adapter with access controls for sensitive datasets.
    storage: localStorageAdapter(),
    // initialQuery is typically decodeQuery(searchParams.q) for SSR first paint.
    ...(initialQuery ? { initialQuery } : {}),
  });

  return (
    <div>
      <QueryBuilder api={api} fields={schema.fields} total={api.total} running={api.loading} />

      <SelectionToolbar
        selection={api.selection}
        actions={(ids: RowId[]) => <button onClick={() => bulkRerun(ids)}>Re-run {ids.length}</button>}
      />

      <DataTable
        fields={api.visibleFields}
        rows={api.rows}
        query={api.query}
        onQueryChange={api.setQuery}
        total={api.total}
        renderers={renderers}
        rowId={(r: Run) => r.id}
        selection={api.selection}
        loading={api.loading}
        emptyMessage="No runs match this query."
      />
    </div>
  );
}
