import { useCallback, useRef, useState } from "react";
import { useQueryTable } from "@pythia-software/query-table-react";
import type { FieldSchema, QueryState } from "@pythia-software/query-table-core";
import { ModalSurface, QueryFilterRow } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

export const repositoryValues = [
  "exploration", "exploration-service", "exploration-service-v2", "gbw-utilities",
  "general-purpose-repository",
  "go-query-table-integration-with-a-long-unbroken-suffix-abcdefghijklmnopqrstuvwxyz",
];
type Row = { repository_name: string; tags: string[] };
const schema: FieldSchema<Row> = { name: "repositories", idField: "repository_name", fields: [
  { name: "repository_name", label: "Repository", type: "text", source: { kind: "backend" }, filter: { values: { source: "autocomplete" } } },
  { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, filter: { values: { source: "autocomplete" } } },
] };
const initialQuery: QueryState = { select: [{ field: "repository_name" }], where: [{ field: "repository_name", op: "=", value: "" }], orderBy: [], limit: 25, offset: 0 };
const rows: Row[] = [];

/** Portable synthetic reproduction; no backend or private catalog required. */
export function FilterValueDemo() {
  const api = useQueryTable({ schema, initialQuery, clientRows: rows, debounceMs: 0 });
  const [edge, setEdge] = useState(false);
  const [longList, setLongList] = useState(false);
  const [dialog, setDialog] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const filterValues = useCallback(async (_field: string, search: string) => ({
    values: [...repositoryValues, ...(longList ? Array.from({ length: 70 }, (_, i) => `repository-${String(i).padStart(2, "0")}`) : [])]
      .filter(value => value.toLowerCase().includes(search.toLowerCase())), hasMore: false,
  }), [longList]);
  const editor = <QueryFilterRow api={{ ...api, filterValues }} fields={schema.fields} />;
  return <main style={{ padding: 16, fontFamily: "system-ui" }}>
    <h1>Filter value suggestions</h1>
    <p>Compare full repository names while keeping filter rows compact.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
      <label><input type="checkbox" checked={edge} onChange={event => setEdge(event.target.checked)} /> Near viewport edges</label>
      <label><input type="checkbox" checked={longList} onChange={event => setLongList(event.target.checked)} /> Long list</label>
      <button onClick={() => setDialog(true)}>Open scrollable dialog</button>
      <button onClick={() => api.setQuery(initialQuery)}>Reset filter</button>
      <button onClick={() => api.setQuery(query => ({ ...query, where: [{ field: "tags", op: "includes", value: "" }] }))}>Array filter</button>
    </div>
    {!dialog && <section aria-label="Filter fixture" style={edge ? { position: "fixed", right: 8, bottom: 8, maxWidth: "calc(100vw - 16px)" } : {}}>{editor}</section>}
    <pre aria-label="Current filter" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(api.query.where)}</pre>
    <div style={{ height: "120vh" }} />
    {dialog && <ModalSurface title="Scrollable filter fixture" onClose={() => setDialog(false)}>
      <button onClick={() => scroll.current?.scrollBy(0, 60)}>Scroll dialog</button>
      <div ref={scroll} aria-label="Scrollable content" style={{ height: "45vh", overflowY: "auto", padding: 12 }}>
        <div style={{ height: 100 }} />
        {editor}
        <div style={{ height: 800 }} />
      </div>
    </ModalSurface>}
  </main>;
}
