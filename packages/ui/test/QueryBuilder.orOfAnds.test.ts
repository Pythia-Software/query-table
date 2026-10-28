// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_QUERY, type FieldSchema, type QueryState, type WhereClause, type WhereTerm } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: number; provider: string; model: string }
const rows: Row[] = [
  { id: 1, provider: "anthropic", model: "opus" },
  { id: 2, provider: "anthropic", model: "haiku" },
  { id: 3, provider: "openai", model: "gpt-5" },
  { id: 4, provider: "openai", model: "mini" },
];
const schema: FieldSchema<Row> = {
  name: "calls", idField: "id", fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "provider", label: "Provider", type: "text", source: { kind: "backend" } },
    { name: "model", label: "Model", type: "text", source: { kind: "backend" } },
  ],
};
const eq = (field: string, value: string): WhereClause => ({ field, op: "=", value });
const legend: WhereTerm = {
  any: [
    { all: [eq("provider", "anthropic"), eq("model", "opus")] },
    { all: [eq("provider", "openai"), eq("model", "mini")] },
    eq("model", "haiku"),
  ],
};
let root: Root | undefined;
let container: HTMLDivElement;
let api: QueryTableApi<Row>;

afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; });

async function mount(query: QueryState) {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Table() {
    api = useQueryTable({ schema, clientRows: rows, initialQuery: query, syncUrl: false, debounceMs: 0 });
    return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total });
  }
  await act(async () => { root = createRoot(container); root.render(createElement(Table)); });
}

it("renders an OR of conjunctions as one chip with AND branches and keeps it", async () => {
  await mount({ ...EMPTY_QUERY, where: [legend, eq("id", "1")] });
  expect(api.query.where).toEqual([legend, eq("id", "1")]);
  expect(api.rows.map((row) => row.id)).toEqual([1]);
  const chip = container.querySelector(".qt-chip--or")!;
  expect(chip).not.toBeNull();
  expect(chip.querySelectorAll(".qt-and-branch")).toHaveLength(2);
  expect([...chip.querySelectorAll(".qt-chip-or")].map((label) => label.textContent)).toEqual(["AND", "OR", "AND", "OR"]);
});

it("edits literals of an OR of conjunctions in predicatesOf order", async () => {
  await mount({ ...EMPTY_QUERY, where: [legend] });
  expect(api.rows.map((row) => row.id)).toEqual([1, 2, 4]);
  // Replace the second branch's provider.
  await act(async () => api.updatePredicate(0, 2, eq("provider", "anthropic")));
  expect(api.query.where[0]).toEqual({ any: [legend.any[0], { all: [eq("provider", "anthropic"), eq("model", "mini")] }, eq("model", "haiku")] });
  // Removing one literal of a branch leaves the other as a plain member.
  await act(async () => api.removePredicate(0, 1));
  expect(api.query.where[0]).toEqual({ any: [eq("provider", "anthropic"), { all: [eq("provider", "anthropic"), eq("model", "mini")] }, eq("model", "haiku")] });
  await act(async () => api.negatePredicate(0, 3));
  expect(api.query.where[0]).toMatchObject({ any: [{}, {}, { field: "model", op: "!=", value: "haiku" }] });
  // Removing a whole branch's literals collapses to a plain OR group.
  await act(async () => api.removePredicate(0, 1));
  await act(async () => api.removePredicate(0, 1));
  expect(api.query.where).toEqual([{ any: [eq("provider", "anthropic"), { field: "model", op: "!=", value: "haiku" }] }]);
});

it("merges filters as an OR of their branches", async () => {
  await mount({ ...EMPTY_QUERY, where: [legend, eq("model", "gpt-5")] });
  await act(async () => api.mergeFilters(1, 0));
  expect(api.query.where).toEqual([{ any: [...legend.any, eq("model", "gpt-5")] }]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(api.rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
});
