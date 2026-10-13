// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  decodeQuery,
  queriesEqual,
  type FieldSchema,
  type QueryState,
  type SavedQuery,
  type StorageAdapter,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name: string;
}

const schema: FieldSchema<Row> = {
  name: "things",
  idField: "id",
  defaultLimit: 25,
  defaultSelect: [{ field: "name" }],
  defaultSort: [{ field: "name", dir: "asc" }],
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};

const defaultQuery: QueryState = {
  select: [{ field: "name" }],
  where: [{ field: "name", op: "contains", value: "shared default" }],
  orderBy: [{ field: "name", dir: "desc" }],
  limit: 10,
  offset: 0,
};

const savedDefault: SavedQuery = {
  id: "default-query",
  name: "Team default",
  savedAt: 1,
  query: defaultQuery,
};

function storageWithDefault(): StorageAdapter {
  return {
    loadLast: async () => null,
    saveLast: async () => {},
    listSaved: async () => [savedDefault],
    loadDefaultSaved: async () => savedDefault,
    setDefaultSaved: async () => {},
    saveNamed: async () => savedDefault,
    deleteSaved: async () => {},
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.history.replaceState(null, "", "/runs?section=recent#table");
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("QueryBuilder sharing", () => {
  it("copies the live saved-default query into a URL", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const storage = storageWithDefault();
    let currentQuery: ReturnType<typeof useQueryTable<Row>>["query"] | undefined;

    function TestTable() {
      const api = useQueryTable<Row>({
        schema,
        clientRows: [],
        storage,
        syncUrl: false,
        debounceMs: 0,
      });
      currentQuery = api.query;
      return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total });
    }

    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(TestTable));
      await Promise.resolve();
    });

    expect(queriesEqual(currentQuery!, defaultQuery)).toBe(true);

    const share = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Share");
    expect(share).toBeDefined();

    await act(async () => {
      share!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    const sharedUrl = new URL(writeText.mock.calls[0]![0]);
    expect(sharedUrl.pathname).toBe("/runs");
    expect(sharedUrl.searchParams.get("section")).toBe("recent");
    expect(sharedUrl.hash).toBe("#table");
    expect(sharedUrl.searchParams.get("q")).toBeTruthy();
    expect(queriesEqual(decodeQuery(sharedUrl.searchParams.get("q")!), currentQuery!)).toBe(true);
    expect(share!.textContent).toBe("Copied!");
  });

  it("edits regex filters and regex-extract sort terms", async () => {
    vi.useFakeTimers();
    let currentQuery: ReturnType<typeof useQueryTable<Row>>["query"] | undefined;

    function TestTable() {
      const api = useQueryTable<Row>({
        schema,
        clientRows: [],
        debounceMs: 0,
        initialQuery: {
          select: [{ field: "name" }],
          where: [{ field: "name", op: "matches_regex", value: "^item-" }],
          orderBy: [{ field: "name", dir: "asc" }],
          limit: 25,
          offset: 0,
        },
      });
      currentQuery = api.query;
      return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total });
    }

    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(TestTable));
      await Promise.resolve();
    });

    // The operator is now a keep/exclude picker button labelled with the op.
    const filterOp = container!.querySelector<HTMLButtonElement>(".qt-chip--where .qt-op-trigger");
    const filterInput = container!.querySelector<HTMLInputElement>('.qt-chip--where input[placeholder="regex"]');
    expect(filterOp?.textContent?.replace(/[▾\s]/g, "")).toBe("matches");
    expect(filterInput?.value).toBe("^item-");
    expect(filterInput?.hasAttribute("list")).toBe(false);

    await act(async () => Promise.resolve());
    expect(Array.from(container!.querySelectorAll("button")).some((button) => button.textContent?.trim() === "nulls last")).toBe(
      false,
    );

    expect(container!.querySelector('.qt-chip--sort [aria-label="Configure regex extract for Name"]')).toBeNull();
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Add sort"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('.qt-picker-item[title="name"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('.qt-sort-picker-regex')!.click());
    expect(currentQuery!.orderBy[0]!.extract).toBeUndefined();
    expect(container!.querySelector('[aria-modal="true"]')).not.toBeNull();

    const extractInput = container!.querySelector<HTMLInputElement>('input[aria-label="Regex extract for Name"]');
    expect(extractInput).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(extractInput, "item-(\\d+)");
      extractInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(currentQuery!.orderBy[0]!.extract).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(201));
    const applyExtract = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Update sort")!;
    expect(applyExtract.disabled).toBe(false);
    await act(async () => applyExtract.click());
    expect(currentQuery!.orderBy[0]!.extract).toEqual({ regex: "item-(\\d+)" });
    expect(currentQuery!.orderBy[0]!.dir).toBe("asc");
    expect(container!.querySelector(".qt-chip--sort input")).toBeNull();
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Configure regex extract for Name"]')!.click());

    const removeExtract = container!.querySelector<HTMLButtonElement>('button[aria-label="Remove regex extract for Name"]');
    await act(async () => removeExtract!.click());
    expect(currentQuery!.orderBy[0]!.extract).toBeUndefined();
    expect(Array.from(container!.querySelectorAll("button")).some((button) => button.textContent?.trim() === "nulls last")).toBe(
      false,
    );
  });

  it("adds a regex-extract sort from the add-sort split button", async () => {
    vi.useFakeTimers();
    let currentQuery: ReturnType<typeof useQueryTable<Row>>["query"] | undefined;

    function TestTable() {
      const api = useQueryTable<Row>({
        schema,
        clientRows: [],
        debounceMs: 0,
        initialQuery: { select: [{ field: "name" }], where: [], orderBy: [], limit: 25, offset: 0 },
      });
      currentQuery = api.query;
      return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total });
    }

    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(TestTable));
      await Promise.resolve();
    });

    const split = container!.querySelector('[aria-label="Sort actions"]')!;
    expect(split.className).toBe("qt-split-btn");
    expect(split.querySelector('[aria-label="Add sort"]')!.textContent).toBe("add sort");
    await act(async () => split.querySelector<HTMLButtonElement>('[aria-label="Sort with regex extraction"]')!.click());

    const modal = container!.querySelector('[aria-modal="true"]')!;
    expect(modal.querySelector("h2")!.textContent).toBe("Sort with regex extraction");
    const fieldSelect = modal.querySelector<HTMLSelectElement>("select.qt-sort-extract-field")!;
    expect(Array.from(fieldSelect.options, (option) => option.textContent)).toEqual(["Id", "Name"]);
    expect(fieldSelect.value).toBe("name");
    const directionSelect = modal.querySelector<HTMLSelectElement>('.qt-sort-extract-direction')!;
    await act(async () => {
      directionSelect.value = "asc";
      directionSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const extractInput = modal.querySelector<HTMLInputElement>('input[aria-label="Regex extract for Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(extractInput, "item-(\\d+)");
      extractInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(201));
    expect(currentQuery!.orderBy).toEqual([]);
    await act(async () => Array.from(modal.querySelectorAll("button")).find((button) => button.textContent === "Add sort")!.click());
    expect(currentQuery!.orderBy).toEqual([{ field: "name", dir: "asc", extract: { regex: "item-(\\d+)" } }]);
    expect(container!.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it.each([undefined, "item-(\\d+)"])("loads the selected field's sort direction and extraction (%s) in the regex dialog", async regex => {
    vi.useFakeTimers();
    let currentQuery: QueryState;
    const existing = { field: "name", dir: "asc" as const, nulls: "first" as const,
      ...(regex === undefined ? {} : { extract: { regex } }) };
    function TestTable() {
      const api = useQueryTable<Row>({ schema, clientRows: [], debounceMs: 0,
        initialQuery: { select: [{ field: "name" }], where: [], orderBy: [existing], limit: 25, offset: 0 } });
      currentQuery = api.query;
      return createElement(QueryBuilder<Row>, { api, fields: schema.fields, total: api.total });
    }
    await act(async () => { root = createRoot(container!); root.render(createElement(TestTable)); });
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Sort with regex extraction"]')!.click());
    const field = () => container!.querySelector<HTMLSelectElement>(".qt-sort-extract-field")!;
    const direction = () => container!.querySelector<HTMLSelectElement>(".qt-sort-extract-direction")!;
    const pattern = () => container!.querySelector<HTMLInputElement>(".qt-sort-extract-input")!;
    const selectField = async (name: string) => act(async () => {
      field().value = name; field().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(field().value).toBe("id");
    expect(direction().value).toBe("desc");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pattern(), "draft");
      pattern().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await selectField("name");
    expect(direction().value).toBe("asc");
    expect(pattern().value).toBe(regex ?? "");
    await selectField("id");
    expect(direction().value).toBe("desc");
    expect(pattern().value).toBe("");
    await selectField("name");
    await act(async () => Array.from(container!.querySelectorAll("button")).find(button => button.textContent === "Update sort")!.click());
    expect(currentQuery!.orderBy).toEqual([{ ...existing, extract: { regex: regex ?? "" } }]);
  });
});
