import {
  memoryStorageAdapter,
  memoryQuerySnapshotCache,
  normalizeQueryState,
  validateQuerySnapshot,
  type FieldSchema,
  type QuerySnapshot,
  type QuerySnapshotStore,
} from "@pythia-software/query-table-core";

export interface ExampleOrder {
  id: string;
  order: string;
  customer: string;
  status: string;
  total: number;
}

export const EXAMPLE_ORDERS: ExampleOrder[] = [
  { id: "1", order: "ORD-1041", customer: "Northwind", status: "Open", total: 240 },
  { id: "2", order: "ORD-1042", customer: "Juniper", status: "Shipped", total: 85 },
  { id: "3", order: "ORD-1043", customer: "Paper Kite", status: "Open", total: 125 },
  { id: "4", order: "ORD-1044", customer: "Atlas", status: "Cancelled", total: 65 },
  { id: "5", order: "ORD-1045", customer: "Juniper", status: "Open", total: 310 },
  { id: "6", order: "ORD-1046", customer: "Northwind", status: "Shipped", total: 180 },
  { id: "7", order: "ORD-1047", customer: "Paper Kite", status: "Open", total: 45 },
  { id: "8", order: "ORD-1048", customer: "Atlas", status: "Shipped", total: 95 },
];

export const EXAMPLE_SCHEMA: FieldSchema<ExampleOrder> = {
  name: "integration-example-orders",
  idField: "id",
  defaultLimit: 5,
  defaultSort: [{ field: "order", dir: "desc" }],
  fields: [
    { name: "id", label: "ID", type: "text", source: { kind: "backend" }, select: { enabled: false } },
    { name: "order", label: "Order", type: "text", source: { kind: "backend" }, select: { default: true, width: 105 } },
    { name: "customer", label: "Customer", type: "text", source: { kind: "backend" }, select: { default: true, width: 140 } },
    { name: "status", label: "Status", type: "enum", source: { kind: "backend" }, filter: { values: { source: "static", options: ["Open", "Shipped", "Cancelled"] } }, select: { default: true, width: 100 }, render: "example-status" },
    { name: "total", label: "Total ($)", type: "number", source: { kind: "backend" }, select: { default: true, width: 105, align: "right" }, display: { kind: "number", decimals: 2 } },
  ],
};

export const EXAMPLE_VIEWS = [
  {
    id: "all",
    label: "Schema defaults",
    query: normalizeQueryState({ select: [], where: [], orderBy: [], limit: 5, offset: 0 }),
    code: `const schema = {
  ...orderSchema,
  defaultLimit: 5,
  defaultSort: [{ field: "order", dir: "desc" }],
};
// Field select.default and select.width choose the columns.
const api = useQueryTable({ schema, clientRows: orders });`,
  },
  {
    id: "open",
    label: "Open orders",
    query: normalizeQueryState({ select: [{ field: "order" }, { field: "customer" }, { field: "status" }, { field: "total" }], where: [{ field: "status", op: "=", value: "Open" }], orderBy: [{ field: "order", dir: "desc" }], limit: 5, offset: 0 }),
    code: `const initialQuery = {
  select: [], // use the schema's default columns
  where: [{ field: "status", op: "=", value: "Open" }],
  orderBy: [], limit: 5, offset: 0,
};
const api = useQueryTable({ schema, transport, initialQuery });`,
  },
  {
    id: "value",
    label: "High value",
    query: normalizeQueryState({ select: [{ field: "order" }, { field: "customer" }, { field: "total" }], where: [{ field: "total", op: ">=", value: "100" }], orderBy: [{ field: "total", dir: "desc" }], limit: 5, offset: 0 }),
    code: `const initialQuery = {
  select: [{ field: "order" }, { field: "customer" },
    { field: "total" }],
  where: [{ field: "total", op: ">=", value: "100" }],
  orderBy: [{ field: "total", dir: "desc" }],
  limit: 5, offset: 0,
};`,
  },
] as const;

/** A simulated host, scoped to one open guide. No production URL or durable
 * server is implied: a new resolver must read the same host-owned store. */
export function createIntegrationHost() {
  const published = new Map<string, QuerySnapshot>();
  let reads = 0;
  const snapshots: QuerySnapshotStore = {
    async save(key, input, signal) {
      signal?.throwIfAborted();
      const snapshot = validateQuerySnapshot(input);
      const id = `${key}:${snapshot.code}`;
      const previous = published.get(id);
      if (previous && previous.token !== snapshot.token)
        throw Error("An immutable link cannot point to a different query.");
      if (!previous) published.set(id, snapshot);
      return { ...(previous ?? snapshot) };
    },
    async resolve(key, code, signal) {
      signal?.throwIfAborted();
      reads++;
      const snapshot = published.get(`${key}:${code}`);
      return snapshot ? { ...snapshot } : null;
    },
  };
  return {
    storage: { ...memoryStorageAdapter(), snapshots },
    snapshots,
    cache: memoryQuerySnapshotCache(),
    get publishedCount() { return published.size; },
    get reads() { return reads; },
  };
}

export const REACT_STARTER = `import type { FieldSchema, Transport }
  from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { DataTable, QueryBuilder, defaultRenderers }
  from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

export function Orders<Row>({ schema, transport }: {
  schema: FieldSchema<Row>; transport: Transport<Row>;
}) {
  const api = useQueryTable({ schema, transport });
  if (!api.schema) return <p>Preparing table…</p>;
  return <>
    <QueryBuilder api={api} fields={api.schema.fields}
      total={api.total} />
    <DataTable fields={api.visibleFields} rows={api.rows}
      query={api.query} onQueryChange={api.setQuery}
      rowId={api.rowId} total={api.total}
      renderers={defaultRenderers} selection={api.selection}
      columnDrag={api.columnDrag} />
  </>;
}`;

export const NATIVE_STARTER = `import SwiftUI
import QueryTableCore
import QueryTableUI

@MainActor
struct OrdersView: View {
    @StateObject private var table: QueryTableController

    init(schema: FieldSchema, transport: any QueryTransport) {
        _table = StateObject(wrappedValue: QueryTableController(
            schema: schema, adapter: transport
        ))
    }

    var body: some View {
        QueryTableView(controller: table)
    }
}`;

export const SNAPSHOT_STARTER = `const storage = {
  ...localStorageAdapter(), // or your named-query adapter
  snapshots: httpQuerySnapshotStore("/api/query-snapshots"),
};
const api = useQueryTable({ schema, transport, storage,
  syncUrl: true });

await api.saved.save("Open orders");
const { url } = await api.links.create();
// The host implements immutable snapshot save + resolve.`;
