// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  decodeQuery, encodeQuery, memoryStorageAdapter,
  type FieldSchema, type QueryState,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { DataTable } from "../src/DataTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: number; a: string; b: string }
const schema: FieldSchema<Row> = {
  name: "fitted", idField: "id", defaultSelect: [{ field: "a" }, { field: "b" }],
  fields: ["a", "b"].map((name) => ({ name, label: name.toUpperCase(), type: "text", source: { kind: "backend" } })),
};
const fitted: QueryState = {
  select: [{ field: "a", width: 300 }, { field: "b", width: 300 }],
  where: [], orderBy: [], limit: 100, offset: 0, fitToScreen: true,
};
const rows: Row[] = [{ id: 1, a: "a much longer value", b: "short" }];
const renderers = {};
const rowId = (row: Row) => row.id;
let viewport: number;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  viewport = 602;
  window.history.replaceState(null, "", "/");
  // Supply layout for the viewport, virtualizer and intrinsic text probes.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("qt-table-wrap") ? viewport : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("aria-hidden") !== "true" || this.tagName !== "SPAN") return real.call(this);
    return { width: (this.textContent?.length ?? 0) * 10 } as DOMRect;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function widths(): number[] {
  return ["a", "b"].map((name) => parseFloat(container.querySelector<HTMLTableColElement>(`col[data-qt-column="${name}"]`)!.style.width));
}

function preset(label: string) {
  act(() => container.querySelector<HTMLElement>('th[data-qt-field="a"] .qt-th-label')!.click());
  act(() => container.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger")!.click());
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>(".qt-cm-submenu button"))
    .find((button) => button.textContent === label)!.click());
}

describe("persistent fit to screen", () => {
  it("restores a URL to the local viewport, follows resizing, and freezes widths on manual resize", async () => {
    window.history.replaceState(null, "", `/?q=${encodeQuery(fitted)}`);
    let api!: QueryTableApi<Row>;
    function Table() {
      api = useQueryTable({ schema, clientRows: rows, syncUrl: true, debounceMs: 0 });
      return createElement(DataTable<Row>, {
        fields: api.visibleFields, rows: api.rows, loading: api.loading,
        query: api.query, onQueryChange: api.setQuery, renderers, rowId,
      });
    }
    await act(async () => {
      root.render(createElement(Table));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(widths().reduce((a, b) => a + b)).toBe(600);
    expect(widths()[0]).toBeGreaterThan(widths()[1]! * 3);
    expect(api.query).toEqual(fitted);
    const sharedUrl = window.location.href;

    viewport = 1202;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths().reduce((a, b) => a + b)).toBe(1200);
    // Wide viewports are not capped by the manual-resize 800px limit.
    expect(widths()[0]).toBeGreaterThan(800);
    expect(api.query).toEqual(fitted);
    expect(window.location.href).toBe(sharedUrl);

    viewport = 402;
    act(() => window.dispatchEvent(new Event("resize")));
    const displayed = widths();
    expect(displayed.reduce((a, b) => a + b)).toBe(400);
    act(() => container.querySelector<HTMLElement>('[aria-label="Resize A column"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(api.query.fitToScreen).toBeUndefined();
    expect(widths()).toEqual([displayed[0]! + 10, displayed[1]]);
    expect(decodeQuery(new URL(window.location.href).searchParams.get("q")!).fitToScreen).toBeUndefined();
    viewport = 902;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths()).toEqual([displayed[0]! + 10, displayed[1]]);

    act(() => api.undo());
    expect(api.query.fitToScreen).toBe(true);
    expect(widths().reduce((a, b) => a + b)).toBe(900);
    act(() => api.redo());
    expect(api.query.fitToScreen).toBeUndefined();
    expect(widths()).toEqual([displayed[0]! + 10, displayed[1]]);
  });

  it("saves the menu preference, restores named queries, and clears it through other width actions", async () => {
    const storage = memoryStorageAdapter();
    let api!: QueryTableApi<Row>;
    function Table() {
      api = useQueryTable({ schema, clientRows: rows, storage, initialQuery: { ...fitted, fitToScreen: false }, debounceMs: 0 });
      return createElement(DataTable<Row>, {
        fields: api.visibleFields, rows: api.rows, query: api.query,
        onQueryChange: api.setQuery, renderers, rowId,
      });
    }
    await act(async () => { root.render(createElement(Table)); });
    preset("Fit All to Screen");
    expect(api.query.fitToScreen).toBe(true);
    let savedId!: string;
    await act(async () => { savedId = (await api.saved.save("Responsive")).id; });
    expect((await storage.listSaved(schema.name))[0]?.query.fitToScreen).toBe(true);
    preset("Reset Widths");
    expect(api.query.fitToScreen).toBeUndefined();
    viewport = 402;
    act(() => api.saved.load(savedId));
    expect(api.query.fitToScreen).toBe(true);
    expect(widths().reduce((a, b) => a + b)).toBe(400);
    for (const label of ["Fit This Column", "Fit All to Content", "Equal Widths", "Reset Widths"]) {
      act(() => api.saved.load(savedId));
      preset(label);
      expect(api.query.fitToScreen, label).toBeUndefined();
    }
    act(() => api.saved.load(savedId));
    act(() => api.select.setWidth("a", 200));
    expect(api.query.fitToScreen).toBeUndefined();
  });

  it("waits for loaded rows and a visible viewport before fitting without query writes", () => {
    const onQueryChange = vi.fn();
    const render = (data: Row[], loading: boolean) => act(() => root.render(createElement(DataTable<Row>, {
      fields: schema.fields, rows: data, loading, query: fitted, onQueryChange, renderers, rowId,
    })));
    viewport = 0;
    render([], true);
    expect(widths()).toEqual([300, 300]);
    render(rows, false);
    expect(widths()).toEqual([300, 300]);
    viewport = 602;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths().reduce((a, b) => a + b)).toBe(600);
    expect(widths()[0]).toBeGreaterThan(widths()[1]! * 3);
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it.each(["loading", "hidden"])("does not restore a removed column when freezing stale widths while %s", (paused) => {
    let query = fitted;
    let loading = false;
    const onQueryChange = vi.fn((update: QueryState | ((previous: QueryState) => QueryState)) => {
      query = typeof update === "function" ? update(query) : update;
    });
    const render = () => act(() => root.render(createElement(DataTable<Row>, {
      fields: schema.fields.filter((field) => query.select.some((column) => column.field === field.name)),
      rows, loading, query, onQueryChange, renderers, rowId,
    })));
    render();
    const displayed = widths();
    expect(displayed.reduce((a, b) => a + b)).toBe(600);

    // Remove B using the header menu, then suspend fitting during the refetch
    // or while the viewport is hidden. The local widths still contain B.
    act(() => container.querySelector<HTMLElement>('th[data-qt-field="b"] .qt-th-label')!.click());
    act(() => Array.from(container.querySelectorAll<HTMLButtonElement>(".qt-cm-item"))
      .find((button) => button.textContent === "Remove Column")!.click());
    expect(query.select.map((column) => column.field)).toEqual(["a"]);
    if (paused === "loading") loading = true;
    else viewport = 0;
    render();
    expect(container.querySelector('col[data-qt-column="b"]')).toBeNull();
    act(() => container.querySelector<HTMLElement>('[aria-label="Resize A column"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));

    expect(query.fitToScreen).toBeUndefined();
    expect(query.select).toEqual([{ field: "a", width: displayed[0]! + 10 }]);
  });
});
