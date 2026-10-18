import type { FieldSchema } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, QueryBuilder, defaultRenderers } from "@pythia-software/query-table-ui";

interface Sample { id: number; shape: string; payload: unknown; started: number; elapsed: number; status: string; }
const payload = { customer: { id: 42, name: "Ada", email: "ada@example.com" }, status: "ready", tags: ["priority", "export"], attempts: 2, enabled: true, error: null };
const rows: Sample[] = [
  { shape: "Object", payload },
  { shape: "JSON text", payload: JSON.stringify(payload) },
  { shape: "Encoded JSON string", payload: JSON.stringify(JSON.stringify(payload)) },
  { shape: "Escaped JSON", payload: JSON.stringify(payload).replace(/"/g, '\\"') },
  { shape: "JSON array", payload: [{ id: 42, status: "ready" }, { id: 43, status: "waiting" }] },
  { shape: "Malformed JSON", payload: '{"customer": "Ada", broken}' },
  { shape: "Long JSON array", payload: Array.from({ length: 65 }, (_, id) => ({ id, name: id === 21 || id === 61 ? "Ada Ada" : `Customer ${id}`, status: id % 3 ? "ready" : "waiting" })) },
].map((sample, i) => ({ ...sample, id: i, started: 1780315200 + i * 60, elapsed: 61.25 + i * 30, status: i === 5 ? "failed" : i === 4 ? "waiting" : "ready" }));
const schema: FieldSchema<Sample> = {
  name: "cell-displays", idField: "id", defaultSelect: ["shape", "payload", "started", "elapsed", "status"].map((field) => ({ field })),
  fields: [
    { name: "shape", label: "Input shape", type: "text", source: { kind: "backend" }, select: { width: 180 } },
    { name: "payload", label: "Payload", type: "text", source: { kind: "backend" }, display: { kind: "json" }, filter: { enabled: false }, sort: { enabled: false }, select: { width: 340 } },
    { name: "started", label: "Started (UTC)", type: "number", source: { kind: "backend" }, display: { kind: "datetime", sourceUnit: "epochSeconds", style: "iso", timeZone: "UTC" }, select: { width: 240 } },
    { name: "elapsed", label: "Duration", type: "number", source: { kind: "backend" }, display: { kind: "duration", sourceUnit: "seconds", style: "clock" }, select: { width: 130, align: "right" } },
    { name: "status", label: "Status", type: "enum", source: { kind: "backend" }, display: { kind: "chip", labels: { ready: "Ready", waiting: "Waiting", failed: "Failed" }, tones: { ready: "success", waiting: "warning", failed: "danger" } }, select: { width: 100 } },
  ],
};
interface Run { id: number; name: string; command: string; message: string; }
const words = ["--profile", "release", "--features", "duckdb,sqlite,postgres", "--target-dir", "/var/cache/build/query-table", "--jobs", "16", "--verbose", "--locked"];
const runs: Run[] = Array.from({ length: 400 }, (_, id) => ({
  id,
  name: `Run ${id + 1}`,
  // Lengths vary so clamped rows have different measured heights.
  command: `cargo test ${words.slice(0, 2 + (id % 9)).join(" ")} -- shard ${id}; `.repeat(1 + (id % 4)).trim(),
  message: id % 5 ? `Shard ${id} passed` : `Shard ${id} failed:\nassertion failed at src/encode.rs:${100 + id}\nleft: 3, right: 4`,
}));
const runSchema: FieldSchema<Run> = {
  name: "cell-display-layout", idField: "id",
  fields: [
    { name: "name", label: "Run", type: "text", source: { kind: "backend" }, select: { width: 90 } },
    { name: "command", label: "Command", type: "text", source: { kind: "backend" }, select: { width: 360 } },
    { name: "message", label: "Message", type: "text", source: { kind: "backend" }, select: { width: 260 } },
  ],
};
/** A host "reading layout": per-column overrides travel in QueryState.select. */
function ReadingLayoutDemo() {
  const api = useQueryTable({ schema: runSchema, clientRows: runs, initialQuery: { select: [
    { field: "name" },
    { field: "command", display: { kind: "text", lines: 3 } },
    { field: "message", display: { kind: "text", lines: 2 } },
  ], where: [], orderBy: [], limit: 400, offset: 0 } });
  return <section aria-label="Reading layout" style={{ marginTop: 32 }}>
    <h2>Reading layout</h2>
    <p>The Command and Message columns clamp to three and two lines through <code>SelectColumn.display</code>.</p>
    <DataTable fields={api.visibleFields} rows={api.rows} query={api.query} onQueryChange={api.setQuery} renderers={defaultRenderers} rowId={(row) => row.id} total={api.total} maxHeight={480} />
  </section>;
}
export function CellDisplayDemo() {
  const api = useQueryTable({ schema, clientRows: rows, syncUrl: true, itemDetails: { modes: ["hover", "modal", "expand"], defaultModes: ["hover", "modal", "expand"] } });
  return <><section aria-label="Cell displays" style={{ marginTop: 32 }}>
    <p><a href="/">← Main playground</a></p>
    <h1>Cell displays</h1>
    <p>Open a payload to search keys, paths and values, or use Detail to explore the same value inline in a popover, modal or expanded row.</p>
    <QueryBuilder api={api} fields={schema.fields} total={api.total} />
    <DataTable fields={api.visibleFields} rows={api.rows} query={api.query} onQueryChange={api.setQuery} renderers={defaultRenderers} rowId={(row) => row.id} total={api.total} {...(api.itemDetails ? { itemDetails: api.itemDetails } : {})} />
  </section>
  <ReadingLayoutDemo />
  </>;
}
