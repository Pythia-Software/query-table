import type { FieldSchema, LinkTargets, QueryState } from "@pythia-software/query-table-core";
import { ITEM_DETAILS_COLUMN, encodeQuery } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, defaultRenderers } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import "./demo.css";

interface Message { id: number; conversation: string; tool: string; status: string; words: number; tokens: number; cost: number; payload: string; }
const conversations = ["planning the release", "query-table fit to screen", "pharos dashboards", "agent harness review"];
const tools = ["Read", "Bash", "Edit", "Grep"];
const rows: Message[] = Array.from({ length: 24 }, (_, id) => ({
  id,
  conversation: conversations[id % conversations.length]!,
  tool: tools[id % tools.length]!,
  status: id % 5 ? "ok" : "error",
  words: 40 + ((id * 37) % 300),
  tokens: 1000 + ((id * 911) % 9000),
  cost: Math.round(((id * 13) % 97) * 1.7) / 100,
  // Every third payload is malformed, so its preview is the "JSON?" button.
  payload: id % 3 ? JSON.stringify({ id, tool: tools[id % tools.length], ok: id % 5 !== 0 }) : `{"id": ${id}, broken`,
}));
const fields: FieldSchema<Message>["fields"] = [
  { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
  { name: "conversation", label: "Conversation", type: "text", source: { kind: "backend" } },
  { name: "tool", label: "Tool", type: "text", source: { kind: "backend" } },
  { name: "status", label: "Status", type: "text", source: { kind: "backend" } },
  { name: "words", label: "Words", type: "number", source: { kind: "backend" } },
  { name: "tokens", label: "Tokens", type: "number", source: { kind: "backend" } },
  { name: "cost", label: "Cost", type: "number", source: { kind: "backend" } },
  { name: "payload", label: "Payload", type: "text", source: { kind: "backend" }, display: { kind: "json" } },
];
const itemSchema: FieldSchema<Message> = { name: "fit-items", idField: "id", fields };
const itemQuery: QueryState = {
  select: ["id", "conversation", "tool", "status", "words", "tokens", "cost", "payload", ITEM_DETAILS_COLUMN].map((field) => ({ field })),
  where: [], orderBy: [], limit: 25, offset: 0, fitToScreen: true,
};
const groupSchema: FieldSchema<Message> = { name: "fit-groups", idField: "id", fields };
const groupQuery: QueryState = {
  grouping: {
    source: { select: [{ field: "id" }, { field: "conversation" }], where: [], orderBy: [], limit: 25, offset: 0 },
    keys: ["conversation"],
    summaries: [
      { id: "messages", op: "count", label: "Messages" },
      { id: "word_total", op: "sum", field: "words", label: "Words" },
      { id: "token_total", op: "sum", field: "tokens", label: "Tokens" },
      { id: "cost_total", op: "sum", field: "cost", label: "Cost" },
      { id: "max_words", op: "max", field: "words", label: "Longest" },
      { id: "tools", op: "count_distinct", field: "tool", label: "Tools" },
      { id: "records", op: "link", label: "Drill In", link: { label: "Matching records", to: { kind: "query", target: "fixture" } } },
      { id: "open", op: "link", label: "Open", link: { label: "Open conversation", to: { kind: "query", target: "fixture" } } },
    ],
    representative: null,
  },
  select: ["conversation", "messages", "word_total", "token_total", "cost_total", "max_words", "tools", "records", "open"].map((field) => ({ field })),
  where: [], orderBy: [{ field: "conversation", dir: "asc" }], limit: 25, offset: 0, fitToScreen: true,
};
const linkTargets: LinkTargets = { fixture: (query) => `/fit-controls?items=${encodeQuery(query)}` };

/** Fitted tables whose cells hold native controls; see demo/fit-controls-test.mjs. */
export function FitControlsDemo() {
  const items = useQueryTable({ schema: itemSchema, clientRows: rows, initialQuery: itemQuery, syncUrl: true, queryParameter: "items", debounceMs: 0,
    itemDetails: { modes: ["modal", "expand"], defaultModes: ["modal", "expand"] } });
  const groups = useQueryTable({ schema: groupSchema, clientRows: rows, initialQuery: groupQuery, syncUrl: true, queryParameter: "groups", debounceMs: 0,
    itemDetails: { modes: ["modal", "expand"], defaultModes: ["modal", "expand"] } });
  return (
    <main className="qt-demo">
      <h1>Fitted controls</h1>
      <section aria-label="Messages" data-table="items">
        <h2>Messages</h2>
        <DataTable fields={items.visibleFields} rows={items.rows} query={items.query} onQueryChange={items.setQuery} renderers={defaultRenderers}
          rowId={(row) => row.id} total={items.total} loading={items.loading} {...(items.itemDetails ? { itemDetails: items.itemDetails } : {})} />
      </section>
      <section aria-label="Conversations" data-table="groups">
        <h2>Conversations</h2>
        <DataTable fields={groups.visibleFields} rows={groups.rows} query={groups.query} onQueryChange={groups.setQuery} renderers={defaultRenderers}
          rowId={groups.rowId} total={groups.total} loading={groups.loading} linkTargets={linkTargets}
          {...(groups.itemDetails ? { itemDetails: groups.itemDetails } : {})} />
      </section>
    </main>
  );
}
