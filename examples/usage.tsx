// usage.tsx — a worked example of the full public surface, for design review.
// This is the "does it compose?" test: it typechecks against the real packages
// (see examples/tsconfig.json). Not shipped; not part of any package build.

import { loadSchema, localStorageAdapter, type Transport, type QueryState, type RowId } from "@query-table/core";
import { useQueryTable } from "@query-table/react";
import {
  DataTable,
  QueryBuilder,
  SelectionToolbar,
  defaultRenderers,
  type RenderRegistry,
  type CellContext,
} from "@query-table/ui";
import "@query-table/ui/theme.css";

import runsDoc from "../schema/examples/runs.schema.json";

// 1. The dataset's row type (would be generated alongside the schema).
interface Run {
  id: number;
  workbook_case_name: string | null;
  platform: string;
  overall: "PASS" | "FAIL" | "DIFFERENCES" | null;
  total_ms: number | null;
  is_starred: boolean;
  failed_steps: string[] | null;
}

// 2. Load the schema (the JSON doc shared with the Go backend).
const schema = loadSchema<Run>(runsDoc);

// 3. A Transport — the only backend-specific glue. Talks the ServerQuery wire
//    format the Go `Compile` understands; here, the project's existing API.
const transport: Transport<Run> = {
  async fetchRows(query, signal) {
    const res = await fetch("/api/v1/runs", { method: "POST", body: JSON.stringify(query), signal: signal ?? null });
    return res.json(); // { rows, total }
  },
  // Powers filter-value autocomplete: the backend matches `search` (ILIKE) and
  // returns the top matches + whether it truncated (so the UI says "keep typing").
  // If available, include `hasNull` to let the UI suppress null-only operators /
  // order controls when a column is guaranteed non-null.
  async fetchDistinctValues(q, signal) {
    const res = await fetch(`/api/v1/runs/distinct?f=${q.field}&q=${encodeURIComponent(q.search)}`, {
      signal: signal ?? null,
    });
    return res.json(); // { values, hasMore, hasNull? }
  },
};

// 4. Domain renderers the generic package intentionally does NOT ship. Keyed by
//    the `render` strings in the schema doc.
const renderers: RenderRegistry<Run> = {
  ...defaultRenderers,
  overall_pill: ({ value }: CellContext<Run>) => <span className={`qt-pill--${String(value).toLowerCase()}`}>{String(value)}</span>,
  tag_marker: ({ value }: CellContext<Run>) => <button title="rerun-after-deploy">{value ? "★" : "☆"}</button>,
  link_run: ({ value }: CellContext<Run>) => <a href={`/runs/${value}`}>{String(value).slice(0, 8)}</a>,
  step_tags: ({ value }: CellContext<Run>) => (
    <>
      {((value as string[] | null) ?? []).map((s) => (
        <span key={s} className="qt-pill--fail">
          {s}
        </span>
      ))}
    </>
  ),
  artifact_link: ({ row }: CellContext<Run>) => <button onClick={() => openArtifact(row.id, "deviations")}>view</button>,
};

declare function openArtifact(id: number, kind: string): void;
declare function bulkRerun(ids: RowId[]): void;

// 5. The component. ~15 lines of glue; everything else is the schema.
export function RunsTable({ initialQuery }: { initialQuery?: QueryState }) {
  const api = useQueryTable<Run>({
    schema,
    transport,
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
        renderers={renderers}
        rowId={(r: Run) => r.id}
        selection={api.selection}
        loading={api.loading}
        emptyMessage="No runs match this query."
      />
    </div>
  );
}
