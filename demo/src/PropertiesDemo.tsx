import { useState } from "react";
import {
  discoverFieldRelationships,
  localPropertyViewStorage,
  type FieldSchema,
  type RelationshipAdapter,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, ObjectInspector, QueryBuilder, ItemDetailShare, defaultRenderers } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import "./demo.css";

type Row = Record<string, unknown>;
const storage = localPropertyViewStorage();
const names = [
  "Tool",
  "Status",
  "Started",
  "Duration",
  "Command",
  "Context added",
  "Carried tokens",
  "Cost",
  "Exit code",
  "Work",
  "Input",
  "Result",
];
const fieldNames = [
  "tool_name",
  "status",
  "started_at",
  "duration_ms",
  "command",
  "result_tokens",
  "carried_tokens",
  "cost",
  "exit_code",
  "workspace_id",
  "input",
  "result",
];
const schema: FieldSchema<Row> = {
  name: "demo_tool_calls",
  idField: "id",
  defaultSelect: ["tool_name", "status", "duration_ms"].map((field) => ({ field })),
  fields: fieldNames.map((name, index) => ({
    name,
    label: names[index]!,
    type:
      name === "status"
        ? "enum"
        : name === "started_at"
          ? "datetime"
          : [
                "duration_ms",
                "result_tokens",
                "carried_tokens",
                "cost",
                "exit_code",
              ].includes(name)
            ? "number"
            : "text",
    source: { kind: "backend" },
    ...(name === "duration_ms" ? { render: "duration_ms" } : {}),
    property: {
      default: !["input", "result"].includes(name),
      ...(name === "duration_ms"
        ? { format: { kind: "duration", sourceUnit: "milliseconds" } as const }
        : name === "cost"
          ? {
              format: {
                kind: "currency",
                currency: "USD",
                decimals: 4,
              } as const,
            }
          : name === "command" || name === "input" || name === "result"
            ? { format: { kind: "code" } as const }
            : {}),
    },
    ...(name === "workspace_id"
      ? { origin: { table: "tool_calls", column: "workspace_id" } }
      : {}),
  })),
};
schema.fields = discoverFieldRelationships(
  schema.fields,
  [
    {
      sourceTable: "tool_calls",
      sourceColumns: ["workspace_id"],
      targetTable: "workspaces",
      targetColumns: ["id"],
    },
  ],
  [{ name: "work", table: "workspaces", keyFields: ["id"] }],
);
const rows: Row[] = [
  {
    id: "call-1",
    tool_name: "exec_command",
    status: "success",
    started_at: "2026-10-12T09:42:00Z",
    duration_ms: 8420,
    command: "npm run check\ngo test ./...",
    result_tokens: 4821,
    carried_tokens: 28750,
    cost: 0.0472,
    exit_code: 0,
    workspace_id: "work-1",
    input: '{"cmd":"npm run check"}',
    result: "All checks passed.",
  },
  {
    id: "call-2",
    tool_name: "exec_command",
    status: "error",
    started_at: "2026-10-12T09:44:00Z",
    duration_ms: 120_040,
    command: "npm run build",
    result_tokens: 870,
    carried_tokens: 0,
    cost: 0.0048,
    exit_code: 1,
    workspace_id: "work-1",
    input: '{"cmd":"npm run build"}',
    result: "Build failed: missing environment configuration.",
  },
];
const relationships: RelationshipAdapter = {
  async resolve(references) {
    return references.map((reference) => ({
      reference,
      label: "Query-table · Object property views",
      href: "#work-1",
    }));
  },
};

export function PropertiesDemo() {
  const [index, setIndex] = useState(0);
  const table = useQueryTable({ schema, clientRows: rows, syncUrl: true, itemDetails: { storage, relationships } });
  return (
    <main className="qt-demo qt-object-demo">
      <header className="qt-demo-header">
        <p className="qt-demo-eyebrow">Object views</p>
        <h1>One catalogue. Two perspectives.</h1>
      </header>
      <p className="qt-demo-intro">
        Query the collection, inspect an item. Choose and format its properties,
        then save a view that follows you across every tool call.
      </p>
      <p>
        <a href="/">Collection playground</a>
      </p>
      <div className="qt-object-demo-grid">
      <section className="qt-object-demo-collection" aria-label="Tool call collection">
        <div className="qt-object-demo-section-title"><h2>Collection</h2><span>Query + results</span></div>
        <QueryBuilder api={table} fields={schema.fields} total={table.total} defaultCollapsed />
        <DataTable
          fields={table.visibleFields}
          rows={table.rows}
          query={table.query}
          onQueryChange={table.setQuery}
          renderers={defaultRenderers}
          rowId={(row) => String(row.id)}
          total={table.total}
          maxHeight={table.itemDetails?.active?.mode === "expand" ? 620 : 230}
          loading={table.loading}
          itemDetails={table.itemDetails!}
          columnDrag={table.columnDrag}
        />
        <p className="qt-object-demo-note">Open a modal from Detail. Select columns adds popovers, row expansion, or a Page link with your own URL template. Share an item with its query and property view.</p>
      </section>
      <section aria-label="Tool call item" className="qt-object-demo-item">
      <div className="qt-object-demo-section-title"><h2>Item</h2><label>
        <span className="qt-sr-only">Tool call</span>
        <select
          aria-label="Inspected tool call"
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
        >
          <option value={0}>Successful check · call-1</option>
          <option value={1}>Failed build · call-2</option>
        </select>
      </label></div>
      <ObjectInspector
        schema={schema}
        row={rows[index]!}
        propertyApi={table.itemDetails!.properties} viewScope="Modal"
        shareAction={<ItemDetailShare api={table.itemDetails!} query={table.query} id={String(rows[index]!.id)} />}
        relationships={relationships}
        typeLabel="Tool call"
        title={String(rows[index]!.tool_name)}
      />
      </section>
      </div>
      <p id="work-1" className="qt-object-demo-note">Work: Query-table · Object property views</p>
    </main>
  );
}
