// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type FieldSchema, type QueryState } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder, type QueryBuilderProps } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; name: string };
const schema: FieldSchema<Row> = {
  name: "collapse-regression",
  idField: "id",
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};
const initialQuery: QueryState = {
  select: [{ field: "name" }],
  where: [{ field: "name", op: "contains", value: "Ada" }],
  orderBy: [{ field: "name", dir: "asc" }],
  limit: 25,
  offset: 0,
};
const rows: Row[] = [{ id: 1, name: "Ada" }];
let root: Root;
let container: HTMLDivElement;
let api: QueryTableApi<Row>;

function Fixture(props: Partial<QueryBuilderProps<Row>>) {
  api = useQueryTable<Row>({ schema, initialQuery, clientRows: rows, debounceMs: 0 });
  return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total, ...props });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const toggle = () => container.querySelector<HTMLButtonElement>(".qt-qb-collapse-btn")!;

it("folds without changing query state and keeps history and saved-name editing independent", async () => {
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => api.setQuery({ ...api.query, where: [{ field: "name", op: "contains", value: "Grace" }] }));
  const query = api.query;
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-label")).toBe("Expand query builder");
  expect(api.query).toEqual(query);
  expect(container.querySelector(".qt-qb-summary")!.textContent).toContain("Grace");
  expect(container.querySelector(".qt-qb-editor-bar")).toBeNull();
  expect(container.querySelector(".qt-qb-run-bar")).not.toBeNull();

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click());
  expect(api.query.where).toEqual(initialQuery.where);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".qt-qb-summary")!.textContent).toContain("Ada");
  await act(async () => container.querySelector<HTMLButtonElement>(".qt-qb-saved-name")!.click());
  expect(container.querySelector(".qt-qb-saved-input")).not.toBeNull();
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggle().click());
  expect(container.querySelector(".qt-qb-editor-bar")).not.toBeNull();
  expect(container.querySelector(".qt-qb-run-bar")).not.toBeNull();
  expect(api.query.where).toEqual(initialQuery.where);
});

it("preserves controlled collapse behavior and the body reference", async () => {
  const onCollapsedChange = vi.fn();
  await act(async () => root.render(createElement(Fixture, { collapsed: false, onCollapsedChange })));
  const bodyId = toggle().getAttribute("aria-controls")!;
  expect(document.getElementById(bodyId)).not.toBeNull();
  await act(async () => toggle().click());
  expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  await act(async () => root.render(createElement(Fixture, { collapsed: true, onCollapsedChange })));
  expect(toggle().getAttribute("aria-controls")).toBe(bodyId);
  expect(container.querySelector(".qt-qb-editor-bar")).toBeNull();
  await act(async () => toggle().click());
  expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

it("keeps host controls and summaries available in initially collapsed queries", async () => {
  const hostAction = vi.fn();
  await act(async () => root.render(createElement(Fixture, {
    defaultCollapsed: true,
    summary: "Host query summary",
    savedQueryControls: createElement("button", { onClick: hostAction }, "Host action"),
  })));
  expect(container.querySelector(".qt-qb-summary")!.textContent).toBe("Host query summary");
  const hostButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Host action")!;
  await act(async () => hostButton.click());
  expect(hostAction).toHaveBeenCalledOnce();
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".qt-qb-saved")).toBeNull();
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-label")).toBe("Collapse query builder");
  expect(container.querySelector(".qt-qb-summary")).toBeNull();
});
