// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { FieldSchema } from "@pythia-software/query-table-core";
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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { current.api.itemDetails!.open("b", "modal"); await new Promise((resolve) => setTimeout(resolve, 20)); });
  const lookup = rowRequests(transport).find((request) => request.result.limit === 2)!;
  expect(lookup.result.select).toContain("owner");
  expect(current.api.itemDetails!.record?.row.owner).toBe("Ada");
  expect(current.api.itemDetails!.record?.loadedFields).toContain("owner");
});
