// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { EMPTY_QUERY, type FieldSchema } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "../src/useQueryTable";
import { memoryV3Transport, rowRequests } from "./v3Transport";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: string; name: string; owner?: string };
const schema: FieldSchema<Row> = {
  name: "items", idField: "id",
  fields: [
    { name: "id", label: "ID", type: "text", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};
// A property the server returns that only the detail catalogue declares.
const details: FieldSchema<Row> = { ...schema, fields: [...schema.fields, { name: "owner", label: "Owner", type: "text", source: { kind: "backend" } }] };

let root: Root | undefined;
/** Polls until `ready` holds, rendering in between; fails after a second. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(ready()).toBe(true);
}
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it("looks up the properties of the detail catalogue", async () => {
  const transport = memoryV3Transport<Row>([{ id: "a", name: "On page", owner: "x" }, { id: "b", name: "Elsewhere", owner: "Ada" }], details, { project: true });
  const current = { api: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    current.api = useQueryTable<Row>({ schema, transport, debounceMs: 0, itemDetails: { modes: ["modal"], schema: details } });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  // The page itself is refused here (this server projects every catalogue
  // field); only the lookup matters.
  await until(() => rowRequests(transport).length > 0 && !current.api.loading);
  act(() => current.api.itemDetails!.open("b", "modal"));
  await until(() => current.api.itemDetails!.record !== null);
  const lookup = rowRequests(transport).find((request) => request.result.limit === 2)!;
  expect(lookup.result.select).toContain("owner");
  expect(current.api.itemDetails!.record?.row.owner).toBe("Ada");
  expect(current.api.itemDetails!.record?.loadedFields).toContain("owner");
});

it("reads the page when the identity cannot be filtered with =", async () => {
  const noLookup: FieldSchema<Row> = { ...schema, fields: schema.fields.map(field => field.name === "id" ? { ...field, filter: { enabled: false } } : field) };
  const transport = memoryV3Transport<Row>([{ id: "a", name: "On page" }], noLookup, { project: true });
  const current = { api: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    current.api = useQueryTable<Row>({ schema: noLookup, transport, debounceMs: 0, itemDetails: { modes: ["modal"] },
      initialQuery: { ...EMPTY_QUERY, select: [{ field: "name" }] } });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  await until(() => current.api.rows.length === 1 && !current.api.loading);
  const pages = rowRequests(transport).length;
  act(() => current.api.itemDetails!.open("a", "modal"));
  await until(() => current.api.itemDetails!.record?.row.name === "On page");
  // The server would refuse an identity filter, so no lookup is sent.
  expect(rowRequests(transport).some((request) => request.result.limit === 2)).toBe(false);
  await act(async () => { await current.api.refreshRow("a"); });
  await until(() => rowRequests(transport).length > pages);
  expect(rowRequests(transport).some((request) => request.result.limit === 2)).toBe(false);
});

it("does not restart a lookup for inline host options", async () => {
  const transport = memoryV3Transport<Row>([{ id: "b", name: "Elsewhere" }], schema, { project: true });
  const current = { api: undefined as unknown as QueryTableApi<Row> };
  function Probe() {
    // Inline on every render, as hosts commonly write them.
    current.api = useQueryTable<Row>({ schema, transport, debounceMs: 0, evaluationNow: () => 1, itemDetails: { modes: ["modal"], schema: { ...schema } } });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  await until(() => rowRequests(transport).length > 0 && !current.api.loading);
  act(() => current.api.itemDetails!.open("b", "modal"));
  await until(() => current.api.itemDetails!.record?.row.name === "Elsewhere");
  for (let i = 0; i < 3; i++) act(() => root!.render(createElement(Probe)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(rowRequests(transport).filter((request) => request.result.limit === 2)).toHaveLength(1);
});
