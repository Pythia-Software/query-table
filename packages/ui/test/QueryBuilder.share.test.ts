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
});
