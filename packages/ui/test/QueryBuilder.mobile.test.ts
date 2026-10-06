// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { decodeQuery, type FieldSchema, type QueryState } from "@pythia-software/query-table-core";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  name: string;
  status: string;
  duration: number;
}

const schema: FieldSchema<Row> = {
  name: "mobile",
  idField: "name",
  fields: [
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
    { name: "status", label: "Status", type: "text", source: { kind: "backend" }, filter: { values: { source: "static", options: [{ value: "Ready", label: "Ready for pickup" }] } } },
    { name: "duration", label: "Duration", type: "number", source: { kind: "backend" } },
  ],
};
const initialQuery: QueryState = {
  select: [{ field: "name" }, { field: "status" }],
  where: [{ field: "name", op: "contains", value: "Ada" }, { field: "status", op: "=", value: "Ready" }],
  orderBy: [],
  limit: 25,
  offset: 0,
};
let root: Root;
let container: HTMLDivElement;
let api: QueryTableApi<Row>;

function Fixture({ running = false, total }: { running?: boolean; total?: number }) {
  api = useQueryTable<Row>({ schema, initialQuery, clientRows: [], debounceMs: 0 });
  return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: total ?? api.total, running });
}

beforeEach(async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Fixture)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses an SVG caret that reflects the query builder's expanded state", async () => {
  const toggle = container.querySelector<HTMLButtonElement>(".qt-qb-collapse-btn")!;
  expect(toggle.querySelector("svg.qt-qb-collapse-caret path")).not.toBeNull();
  expect(toggle.querySelector("svg")!.getAttribute("width")).toBe("18");
  expect(toggle.querySelector("svg")!.getAttribute("height")).toBe("18");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.querySelector(".qt-qb-collapse-caret--collapsed")).not.toBeNull();
  expect(container.querySelector(".qt-qb-editor-bar")).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".qt-qb-editor-bar")).not.toBeNull();
});

it("keeps the split Add button and Reset in the mobile Columns header", async () => {
  const header = container.querySelector(".qt-qb-row--select .qt-qb-section-header")!;
  expect(Array.from(header.querySelectorAll("button"), (button) => button.textContent)).toEqual(["Add", "", "Reset"]);
  expect(container.querySelector(".qt-qb-row--select > .qt-add")).toBeNull();
  await act(async () => header.querySelector<HTMLButtonElement>('[aria-label="Add column"]')!.click());
  expect(document.querySelector('[aria-label="Search fields"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>(".qt-picker-item")!.click());
  expect(api.query.select.map((column) => column.field)).toContain("duration");
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  const add = header.querySelector<HTMLButtonElement>('[aria-label="Add column"]')!;
  const customize = header.querySelector<HTMLButtonElement>('[aria-label="Customize columns"]')!;
  expect(add.disabled).toBe(true);
  expect(customize.disabled).toBe(false);
  expect(customize.querySelector('[data-icon="chevronRight"]')).not.toBeNull();
  await act(async () => customize.click());
  expect(customize.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Cancel layout changes")!.click());
  expect(customize.getAttribute("aria-expanded")).toBe("false");
  await act(async () => header.querySelector<HTMLButtonElement>('[aria-label="Reset columns"]')!.click());
  expect(api.query.select).toEqual([]);
});

it("places desktop column actions after the selected chips, like other clauses", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  await act(async () => root.render(createElement(Fixture)));
  const section = container.querySelector(".qt-qb-row--select")!;
  expect(section.querySelector(".qt-qb-section-header button")).toBeNull();
  expect(Array.from(section.children, (element) => element.textContent)).toEqual(["select", "Name", "Status", "add column", "reset"]);
  expect(section.querySelector('[aria-label="Customize columns"]')!.parentElement!.className).toBe("qt-split-btn");
  await act(async () => section.querySelector<HTMLButtonElement>('[aria-label="Add column"]')!.click());
  expect(document.querySelector('[aria-label="Search fields"]')).not.toBeNull();
});

it("omits placeholders for empty filters and metrics", async () => {
  await act(async () => api.clearFilters());
  expect(container.querySelector(".qt-qb-row--filters .qt-qb-hint")).toBeNull();
  expect(container.querySelector(".qt-qb-row--metrics .qt-qb-hint")).toBeNull();
  expect(container.querySelector('[aria-label="Add filter"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Add metric"]')).not.toBeNull();
});

it("renders a smaller save star without reducing its button target", () => {
  expect(container.querySelector('.qt-qb-saved-star svg')!.getAttribute("width")).toBe("16");
  expect(container.querySelector('.qt-qb-saved-star')!.getAttribute("aria-label")).toBe("Save query");
});

it("distinguishes scheduled updates, immediate refresh, and resetting with icons", () => {
  expect(container.querySelector('.qt-auto-refresh > button [data-icon="clock"]')).not.toBeNull();
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(Array.from(container.querySelectorAll(".qt-qb-editor-stack button"), (button) => button.textContent)).toEqual(["Undo", "Redo", "Reset"]);
  expect(container.querySelector('.qt-qb-editor-stack [data-icon="reset"]')).not.toBeNull();
  expect(buttons.find((button) => button.textContent === "Run Now")?.querySelector('[data-icon="refresh"]')).not.toBeNull();
});

it("groups each pagination keyword with its own labeled input", () => {
  const fields = container.querySelectorAll(".qt-qb-pagination > .qt-qb-window-field");
  expect(fields).toHaveLength(2);
  expect(fields[0]!.textContent).toBe("limit");
  expect(fields[0]!.querySelector("input")!.value).toBe("25");
  expect(fields[1]!.querySelector("label")!.textContent).toBe("offset");
  expect(fields[1]!.querySelector("input")!.value).toBe("0");
  expect(Array.from(fields[1]!.querySelectorAll("button"), (button) => button.textContent)).toEqual(["+25"]);
});

it("pages the offset forward and back by the current limit", async () => {
  await act(async () => root.render(createElement(Fixture, { total: 1000 })));
  const stepLabels = () => Array.from(container.querySelectorAll(".qt-qb-num-step"), (button) => button.textContent);
  const step = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>(".qt-qb-num-step")).find((button) => button.textContent === label)!;
  await act(async () => step("+25").click());
  expect(api.query.offset).toBe(25);
  expect(stepLabels()).toEqual(["−25", "+25"]);
  await act(async () => step("+25").click());
  expect(api.query.offset).toBe(50);
  await act(async () => step("−25").click());
  await act(async () => step("−25").click());
  expect(api.query.offset).toBe(0);
  expect(stepLabels()).toEqual(["+25"]);
});

it("stops paging forward once the next page would start past the known total", async () => {
  await act(async () => root.render(createElement(Fixture, { total: 40 })));
  const next = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".qt-qb-num-step")).at(-1)!;
  expect(next().disabled).toBe(false);
  await act(async () => next().click());
  expect(api.query.offset).toBe(25);
  expect(next().disabled).toBe(true);
});

it("edits conditions in nested sheets and offers OR grouping without drag-and-drop", async () => {
  const filter = container.querySelector<HTMLButtonElement>(".qt-mobile-filter")!;
  expect(filter.textContent).toContain("Namecontains Ada");
  expect(container.querySelectorAll("[data-qt-filter]")[1]!.textContent).toContain("Ready for pickup");
  await act(async () => filter.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".qt-op-trigger")!.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
  const startsWith = Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-op-cell")).find((button) => button.textContent === "starts with")!;
  await act(async () => startsWith.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  expect(api.query.where[0]).toEqual({ field: "name", op: "starts_with", value: "Ada" });
  const combine = document.querySelector<HTMLSelectElement>(".qt-filter-combine select")!;
  await act(async () => {
    combine.value = "1";
    combine.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.query.where).toEqual([{ any: [initialQuery.where[1], { field: "name", op: "starts_with", value: "Ada" }] }]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(container.querySelector(".qt-mobile-filter")!.textContent).toContain("OR");
});

it("uses the native share sheet with the complete live query", async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.create(navigator, { share: { value: share } }));
  const button = Array.from(container.querySelectorAll("button")).find((target) => target.textContent === "Share")!;
  await act(async () => button.click());
  expect(share).toHaveBeenCalledTimes(1);
  const sharedUrl = new URL(share.mock.calls[0]![0].url);
  expect(decodeQuery(sharedUrl.searchParams.get("q")!)).toEqual(initialQuery);
});

it("does not fall back to copying when native sharing is cancelled", async () => {
  const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  const copy = vi.fn();
  vi.stubGlobal("navigator", Object.create(navigator, { share: { value: share }, clipboard: { value: { writeText: copy } } }));
  const button = Array.from(container.querySelectorAll("button")).find((target) => target.textContent === "Share")!;
  await act(async () => button.click());
  expect(share).toHaveBeenCalledTimes(1);
  expect(copy).not.toHaveBeenCalled();
});

async function changeSelect(selector: string, value: string) {
  const control = document.querySelector<HTMLSelectElement>(selector)!;
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("puts mobile section actions before their summaries in keyboard and document order", () => {
  for (const section of container.querySelectorAll(".qt-qb-row--filters, .qt-qb-row--sort, .qt-qb-row--metrics")) {
    expect(section.firstElementChild?.className).toBe("qt-qb-section-header");
    expect(section.firstElementChild?.querySelector(".qt-add")).not.toBeNull();
  }
});

it("opens a new sort directly and edits direction, null placement, and optional extraction", async () => {
  await act(async () => container.querySelector<HTMLButtonElement>(".qt-qb-row--sort .qt-add")!.click());
  const name = Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-picker-item")).find((button) => button.querySelector(".qt-picker-label")?.textContent === "Name")!;
  await act(async () => name.click());
  expect(document.querySelector('[aria-modal="true"]')?.textContent).toContain("Sort by Name");
  await changeSelect(".qt-mobile-form select", "asc");
  const regex = Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-mobile-form button")).find((button) => button.textContent === "regex extract")!;
  await act(async () => regex.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
  expect(api.query.orderBy[0]!.extract).toBeUndefined();
  expect(document.querySelector(".qt-sort-extract-table")).not.toBeNull();
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-sort-extract-footer button")).find((button) => button.textContent === "Cancel")!.click());
  await act(async () => api.setSort([{ ...api.query.orderBy[0]!, extract: { regex: "(.+)" } }]));
  await changeSelect(".qt-mobile-form-field:nth-child(2) select", "first");
  await act(async () => regex.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove regex extract for Name"]')!.click());
  expect(api.query.orderBy[0]).toEqual({ field: "name", dir: "asc", nulls: "first" });
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Name sort"]')!.click());
  expect(api.query.orderBy).toEqual([]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => api.undo());
  expect(api.query.orderBy).toHaveLength(1);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
});

it("opens new metrics immediately and keeps function, measure, and grouping in sync", async () => {
  await act(async () => container.querySelector<HTMLButtonElement>(".qt-qb-row--metrics .qt-add")!.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  await changeSelect('[aria-label="Aggregation function"]', "avg");
  await changeSelect('[aria-label="Metric measure"]', "duration");
  const addGroup = document.querySelector<HTMLButtonElement>(".qt-chip-agg-add")!;
  expect(addGroup.textContent).toBe("group");
  expect(addGroup.querySelector('[data-icon="add"]')).not.toBeNull();
  await act(async () => addGroup.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
  const status = Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-picker-item")).find((button) => button.querySelector(".qt-picker-label")?.textContent === "Status")!;
  await act(async () => status.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  expect(api.aggregations.clauses[0]).toMatchObject({ op: "avg", field: "duration", groupBy: ["status"] });
  expect(document.querySelector(".qt-mobile-form-hint")!.textContent).toContain("all filtered rows");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Status grouping"]')!.click());
  expect(api.aggregations.clauses[0]!.groupBy).toEqual([]);
  await changeSelect('[aria-label="Aggregation function"]', "count_distinct");
  await changeSelect('[aria-label="Metric measure"]', "name");
  await changeSelect('[aria-label="Aggregation function"]', "sum");
  expect(api.aggregations.clauses[0]).toMatchObject({ op: "sum", groupBy: [] });
  expect(api.aggregations.clauses[0]!.field).toBeUndefined();
  await act(async () => document.querySelector<HTMLButtonElement>(".qt-mobile-form-remove")!.click());
  expect(api.aggregations.clauses).toEqual([]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => api.undo());
  expect(api.aggregations.clauses).toHaveLength(1);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
});

it("omits duplicate single-filter headings and hides value controls for nullary conditions", async () => {
  await act(async () => api.updatePredicate(0, 0, { field: "name", op: "is_null", value: "" }));
  await act(async () => container.querySelector<HTMLButtonElement>("[data-qt-filter]")!.click());
  expect(document.querySelector(".qt-mobile-predicate strong")).toBeNull();
  expect(document.querySelector(".qt-mobile-predicate input")).toBeNull();
  expect(document.querySelector(".qt-mobile-predicate .qt-mobile-form-field--wide")?.textContent).toContain("Condition");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Name filter"]')!.click());
  expect(api.query.where).toHaveLength(1);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
});

it("disables filter, sort, and metric summaries while a query runs", async () => {
  await act(async () => {
    api.setSort([{ field: "name", dir: "asc" }]);
    api.aggregations.add();
  });
  await act(async () => root.render(createElement(Fixture, { running: true })));
  const summaries = container.querySelectorAll<HTMLButtonElement>(".qt-mobile-filter");
  expect(summaries).toHaveLength(4);
  for (const summary of summaries) {
    expect(summary.disabled).toBe(true);
    await act(async () => summary.click());
  }
  expect(container.querySelector(".qt-mobile-clause-delete")).toBeNull();
  for (const handle of container.querySelectorAll<HTMLButtonElement>(".qt-reorder-handle")) expect(handle.disabled).toBe(true);
  expect(api.query.where).toHaveLength(2);
  expect(api.query.orderBy).toHaveLength(1);
  expect(api.aggregations.clauses).toHaveLength(1);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
});

it("uses the pencil as the only entry point for editing and deletion", async () => {
  const edit = container.querySelector<HTMLButtonElement>("[data-qt-filter]")!;
  expect(edit.querySelector("svg")).not.toBeNull();
  expect(edit.getAttribute("aria-label")).toContain("Edit filter:");
  expect(edit.textContent).not.toContain("Edit ›");
  expect(edit.querySelector("button")).toBeNull();
  expect(container.querySelector(".qt-mobile-clause-delete")).toBeNull();
  await act(async () => edit.click());
  const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove Name filter"]')!;
  await act(async () => remove.click());
  expect(api.query.where).toEqual([initialQuery.where[1]]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => api.undo());
  expect(api.query.where).toEqual(initialQuery.where);
});

it("can delete a complete OR group from its editor and supports undo", async () => {
  await act(async () => api.mergeFilters(0, 1));
  const group = api.query.where[0];
  await act(async () => container.querySelector<HTMLButtonElement>("[data-qt-filter]")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove filter group"]')!.click());
  expect(api.query.where).toEqual([]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => api.undo());
  expect(api.query.where).toEqual([group]);
});

it("deletes only the tapped sort or metric while retaining the other clauses", async () => {
  await act(async () => {
    api.setSort([{ field: "name", dir: "asc" }, { field: "status", dir: "desc" }]);
    api.aggregations.add({ label: "First metric" });
    api.aggregations.add({ label: "Second metric" });
  });
  await act(async () => container.querySelector<HTMLButtonElement>(".qt-qb-row--sort .qt-mobile-filter")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Name sort"]')!.click());
  expect(api.query.orderBy).toEqual([{ field: "status", dir: "desc" }]);
  await act(async () => container.querySelector<HTMLButtonElement>(".qt-qb-row--metrics .qt-mobile-filter")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".qt-mobile-form-remove")!.click());
  expect(api.aggregations.clauses).toHaveLength(1);
  expect(api.aggregations.clauses[0]!.label).toBe("Second metric");
  expect(api.query.where).toEqual(initialQuery.where);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => api.undo());
  expect(api.aggregations.clauses).toHaveLength(2);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
});

it("reorders columns, sort priority, and metrics directly without Order buttons or filter handles", async () => {
  await act(async () => {
    api.setSort([{ field: "name", dir: "asc" }, { field: "status", dir: "desc" }]);
    api.aggregations.add({ label: "First" });
    api.aggregations.add({ label: "Second" });
  });
  expect(container.querySelector(".qt-reorder-trigger")).toBeNull();
  expect(container.querySelector(".qt-qb-row--filters .qt-reorder-handle")).toBeNull();
  const reorder = async (section: string, key: string) => {
    await act(async () => container.querySelector(`.qt-qb-row--${section} .qt-reorder-handle`)!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  };
  await reorder("select", "ArrowRight");
  expect(api.query.select.map((column) => column.field)).toEqual(["status", "name"]);
  await reorder("sort", "ArrowDown");
  expect(api.query.orderBy.map((term) => term.field)).toEqual(["status", "name"]);
  await reorder("metrics", "ArrowDown");
  expect(api.aggregations.clauses.map((clause) => clause.label)).toEqual(["Second", "First"]);
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(api.query.where).toEqual(initialQuery.where);
});
