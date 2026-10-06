// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createSetFilter, decodeQuery, EMPTY_QUERY, encodeQuery, mapSetFilterValues, readSetFilter, type FieldSchema, type FilterValues, type QueryState, type SetFilterMode, type Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../src/QueryBuilder";
import { FilterValueProvider } from "../src/FilterValuePresentation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: number; tags: string[] }
const rows: Row[] = [[], ["a"], ["b"], ["a", "b"], ["c"]].map((tags, id) => ({ id, tags }));
const schema: FieldSchema<Row> = {
  name: "tags", idField: "id", fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, filter: { editor: "set", arrayCaseSensitive: true, values: { source: "static", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }] } } },
  ],
};
let root: Root | undefined;
let container: HTMLDivElement;
let api: QueryTableApi<Row>;

afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; vi.restoreAllMocks(); });

async function mount(query: QueryState, configuredSchema = schema, canonicalizeQuery?: (query: QueryState) => QueryState, validateQuery?: (query: QueryState) => void, transport?: Transport<Row>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Table() {
    api = useQueryTable({ schema: configuredSchema, clientRows: rows, initialQuery: query, syncUrl: false, debounceMs: 0, ...(canonicalizeQuery ? { canonicalizeQuery } : {}), ...(validateQuery ? { validateQuery } : {}), ...(transport ? { transport } : {}) });
    return createElement(FilterValueProvider, { value: { render: (field, value) => createElement("strong", { "data-badge": `${field}:${value}` }, value) } }, createElement(QueryBuilder<Row>, { api, fields: configuredSchema.fields, total: api.total }));
  }
  await act(async () => { root = createRoot(container); root.render(createElement(Table)); });
}

function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === label || button.textContent === label);
  expect(button, label).toBeDefined();
  act(() => button!.click());
}

function inputValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function changeMode(mode: SetFilterMode) {
  const select = container.querySelector<HTMLSelectElement>("[aria-label='Match mode']")!;
  act(() => { select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

function schemaWithValues(values: FilterValues): FieldSchema<Row> {
  return { ...schema, fields: schema.fields.map((field) => field.name === "tags" ? { ...field, filter: { ...field.filter, values } } : field) };
}

function pressEnter(input: HTMLInputElement) {
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}

function openNewTagFilter(method: "keyboard" | "pointer" = "keyboard") {
  click("+ add filter");
  const search = container.querySelector<HTMLInputElement>(".qt-picker-input")!;
  inputValue(search, "tags");
  if (method === "keyboard") pressEnter(search);
  else act(() => container.querySelector<HTMLButtonElement>(".qt-picker-item[title=tags]")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
}

describe("native tag set editing", () => {
  it.each<SetFilterMode>(["any", "all", "none"])("creates exact freeform keys with Enter in %s mode without toggling duplicates", async (mode) => {
    await mount(EMPTY_QUERY, schemaWithValues({ source: "freeform" }));
    openNewTagFilter();
    changeMode(mode);
    const search = container.querySelector<HTMLInputElement>("[aria-label='Search Tags tags']")!;
    inputValue(search, "  NewTag  ");
    pressEnter(search);
    expect(search.value).toBe("");
    inputValue(search, "  NewTag  ");
    pressEnter(search);
    inputValue(search, "newtag");
    click("Add “newtag”");
    expect(document.activeElement).toBe(search);
    click("Apply filter");
    expect(readSetFilter(api.query.where, 0)?.metadata).toMatchObject({ mode, values: ["  NewTag  ", "newtag"] });
  });

  it("adds typed autocomplete keys when the backend returns no suggestions", async () => {
    const fetchDistinctValues = vi.fn<NonNullable<Transport<Row>["fetchDistinctValues"]>>().mockResolvedValue({ values: [], hasMore: false });
    const transport: Transport<Row> = { fetchRows: async () => ({ rows: [], total: 0 }), fetchDistinctValues };
    await mount(EMPTY_QUERY, schemaWithValues({ source: "autocomplete" }), undefined, undefined, transport);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    openNewTagFilter();
    const search = container.querySelector<HTMLInputElement>("[aria-label='Search Tags tags']")!;
    inputValue(search, "BrandNewKey");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    expect(fetchDistinctValues).toHaveBeenCalledWith({ field: "tags", search: "BrandNewKey" });
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    pressEnter(search);
    click("Apply filter");
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["BrandNewKey"]);
  });

  it("keeps static catalogues constrained and resolves Enter to canonical option keys", async () => {
    await mount(EMPTY_QUERY);
    openNewTagFilter();
    const search = container.querySelector<HTMLInputElement>("[aria-label='Search Tags tags']")!;
    inputValue(search, "UnknownKey");
    pressEnter(search);
    expect(container.querySelector(".qt-set-selected")?.textContent).toBe("");
    expect(container.textContent).not.toContain("Add “UnknownKey”");
    inputValue(search, "Beta");
    pressEnter(search);
    click("Apply filter");
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["b"]);
  });

  it("does not add blank or still-composing freeform text", async () => {
    await mount(EMPTY_QUERY, schemaWithValues({ source: "freeform" }));
    openNewTagFilter();
    const search = container.querySelector<HTMLInputElement>("[aria-label='Search Tags tags']")!;
    inputValue(search, "   ");
    pressEnter(search);
    inputValue(search, "PendingKey");
    act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(container.querySelector(".qt-set-selected")?.textContent).toBe("");
  });

  it.each(["keyboard", "pointer"] as const)("anchors new filters to the persistent add button and restores focus after %s selection", async (method) => {
    await mount(EMPTY_QUERY);
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ add filter")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(180, 88, 120, 24));
    openNewTagFilter(method);
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    expect(trigger.isConnected).toBe(true);
    expect(dialog.style.top).toBe("120px");
    expect(dialog.style.left).toBe("180px");
    click("Cancel");
    expect(document.activeElement).toBe(trigger);
    openNewTagFilter(method);
    act(() => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    click("Apply filter");
    expect(document.activeElement).toBe(trigger);
  });

  it("anchors clicked existing filters explicitly even when clicking does not move focus", async () => {
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "any", ["a"], "editor") });
    const trigger = container.querySelector<HTMLButtonElement>("[aria-label='Edit Tags tag filter']")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(240, 64, 100, 24));
    const unrelated = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ add filter")!;
    unrelated.focus();
    click("Edit Tags tag filter");
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.style.top).toBe("96px");
    expect(dialog.style.left).toBe("240px");
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
  });

  it.each<SetFilterMode>(["any", "all", "none", "empty"])("edits %s without dragging and preserves unrelated terms", async (mode) => {
    const unrelated = { field: "id", op: ">=" as const, value: "0" };
    await mount({ ...EMPTY_QUERY, offset: 25, where: [unrelated, ...createSetFilter("tags", "any", ["a", "b"], "editor")] });
    click("Edit Tags tag filter");
    changeMode(mode);
    click("Apply filter");
    expect(api.query.offset).toBe(0);
    expect(api.query.where[0]).toEqual(unrelated);
    expect(readSetFilter(api.query.where, 1)?.metadata.mode).toBe(mode);
    expect(container.querySelectorAll("[aria-label='Edit Tags tag filter']")).toHaveLength(1);
    expect(decodeQuery(encodeQuery(api.query))).toEqual(api.query);
  });

  it("adds a multi-select from the field picker, searching display names and stable keys", async () => {
    await mount(EMPTY_QUERY);
    click("+ add filter");
    const fieldSearch = container.querySelector<HTMLInputElement>(".qt-picker-input")!;
    inputValue(fieldSearch, "tags");
    act(() => fieldSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const search = container.querySelector<HTMLInputElement>("[aria-label='Search Tags tags']")!;
    inputValue(search, "Beta");
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    act(() => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    inputValue(search, "a");
    act(() => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    click("Apply filter");
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["b", "a"]);
    expect(container.querySelector("[data-badge='tags:a']")).not.toBeNull();
  });

  it("preserves deleted keys for validation and repairs them without losing aliases or mode", async () => {
    const canonicalizeQuery = (query: QueryState) => ({ ...query, where: mapSetFilterValues(query.where, (_field, value) => value === "alias-a" ? "a" : value) });
    const validateQuery = (query: QueryState) => { if (query.where.some((term) => term.setFilter?.values.includes("deleted"))) throw new Error("Deleted tag"); };
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "all", ["alias-a", "deleted"], "editor") }, schema, canonicalizeQuery, validateQuery);
    expect(api.error?.message).toBe("Deleted tag");
    click("Edit Tags tag filter");
    expect(container.textContent).toContain("unavailable: deleted");
    click("Remove deleted");
    click("Apply filter");
    expect(readSetFilter(api.query.where, 0)?.metadata).toEqual({ id: "editor", mode: "all", values: ["a"] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(api.error).toBeNull();
  });

  it("supports Escape, focus containment, chip removal, undo and redo", async () => {
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "none", ["a", "b"], "editor") });
    const trigger = container.querySelector<HTMLButtonElement>("[aria-label='Edit Tags tag filter']")!;
    trigger.focus();
    click("Edit Tags tag filter");
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    const select = dialog.querySelector("select")!;
    expect(document.activeElement).toBe(select);
    act(() => select.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Apply filter");
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    click("Remove tag a");
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["b"]);
    act(() => api.undo());
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["a", "b"]);
    act(() => api.redo());
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["b"]);
    click("Remove tag b");
    expect(api.query.where).toEqual([]);
  });

  it("keeps legacy ORs and non-opted-in fields in their original editor", async () => {
    const legacy = createSetFilter("tags", "any", ["a", "b"], "editor").map(({ setFilter: _metadata, ...term }) => term);
    await mount({ ...EMPTY_QUERY, where: legacy });
    expect(container.querySelector("[aria-label='Edit Tags tag filter']")).toBeNull();
    expect(container.querySelector(".qt-or-group")).not.toBeNull();
    act(() => root?.unmount());
    root = undefined;
    container.remove();
    const plain: FieldSchema<Row> = { ...schema, fields: schema.fields.map((field) => field.name === "tags" ? { ...field, filter: { values: { source: "static", options: ["a", "b"] } } } : field) };
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "all", ["a", "b"], "editor") }, plain);
    expect(container.querySelector("[aria-label='Edit Tags tag filter']")).toBeNull();
    expect(container.querySelectorAll(".qt-pred")).toHaveLength(2);
  });

  it("rejects oversized selections instead of silently truncating NONE", async () => {
    const keys = Array.from({ length: 51 }, (_, index) => `key${index}`);
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "any", keys, "editor") });
    click("Edit Tags tag filter");
    changeMode("none");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Too many tags");
    const apply = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply filter")!;
    expect(apply.disabled).toBe(true);
    click("Remove key0");
    expect(apply.disabled).toBe(false);
    click("Apply filter");
    expect(api.query.where).toHaveLength(50);
    expect(readSetFilter(api.query.where, 0)?.metadata.mode).toBe("none");
  });

  it("honors restrictive operator allowlists", async () => {
    const restricted: FieldSchema<Row> = { ...schema, fields: schema.fields.map((field) => field.name === "tags" ? { ...field, filter: { ...field.filter, ops: ["includes"] } } : field) };
    await mount({ ...EMPTY_QUERY, where: createSetFilter("tags", "any", ["a"], "editor") }, restricted);
    click("Edit Tags tag filter");
    expect(container.querySelector<HTMLOptionElement>("option[value=none]")!.disabled).toBe(true);
    expect(container.querySelector<HTMLOptionElement>("option[value=empty]")!.disabled).toBe(true);
  });

  it("replaces the stored span correctly when canonical aliases collapse multiple ALL terms", async () => {
    const unrelated = { field: "id", op: ">=" as const, value: "0" };
    const canonicalizeQuery = (query: QueryState) => ({ ...query, where: mapSetFilterValues(query.where, (_field, value) => value === "alias-a" ? "a" : value) });
    await mount({ ...EMPTY_QUERY, where: [...createSetFilter("tags", "all", ["alias-a", "a", "b"], "editor"), unrelated] }, schema, canonicalizeQuery);
    click("Remove tag a");
    expect(api.query.where).toHaveLength(2);
    expect(readSetFilter(api.query.where, 0)?.metadata.values).toEqual(["b"]);
    expect(api.query.where[1]).toEqual(unrelated);
    click("Remove Tags tag filter");
    expect(api.query.where).toEqual([unrelated]);
  });
});
