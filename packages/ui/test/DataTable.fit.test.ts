// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  decodeQuery, memoryStorageAdapter,
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
const plain: QueryState = { select: [{ field: "a" }, { field: "b" }], where: [], orderBy: [], limit: 100, offset: 0 };
const screen: QueryState = { ...plain, fit: "screen" };
const content: QueryState = { ...plain, fit: "content" };
const rows: Row[] = [{ id: 1, a: "a much longer value", b: "short" }];
// What Fit All to Content gives: 10px per character in the probes, the cell
// padding and the 4px autofit allowance; never below 48px.
const LONG = 196, SHORT = 56, MIN = 48;
const renderers = {};
const rowId = (row: Row) => row.id;
let viewport: number;
let container: HTMLDivElement;

/**
 * Lays a probe out at 10px per character. A `min-content` probe, like a
 * browser, breaks lines only inside elements whose own `white-space` allows
 * wrapping, where its widest word counts; other content stays on one line.
 */
function probeWidth(probe: HTMLElement): number {
  if (probe.style.width !== "min-content") return (probe.textContent?.length ?? 0) * 10;
  const visit = (node: Node, wraps: boolean): number => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      return 10 * (wraps ? Math.max(0, ...text.split(/\s+/).map((word) => word.length)) : text.length);
    }
    const own = (node as HTMLElement).style?.whiteSpace;
    const wrap = own ? own !== "nowrap" && own !== "pre" : wraps;
    const parts = Array.from(node.childNodes, (child) => visit(child, wrap));
    return wrap ? Math.max(0, ...parts) : parts.reduce((a, b) => a + b, 0);
  };
  return visit(probe, false);
}
let root: Root;

beforeEach(() => {
  viewport = 602;
  window.history.replaceState(null, "", "/");
  // Supply layout for the viewport, virtualizer and intrinsic text probes.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("qt-table-wrap") ? viewport : 0;
  });
  // TanStack Virtual measures the scroll viewport through clientHeight.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("aria-hidden") !== "true" || this.tagName !== "SPAN") return real.call(this);
    return { width: probeWidth(this) } as DOMRect;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {});
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function widths(names = ["a", "b"]): number[] {
  return names.map((name) => parseFloat(container.querySelector<HTMLTableColElement>(`col[data-qt-column="${name}"]`)!.style.width));
}

function preset(label: string) {
  act(() => container.querySelector<HTMLElement>("th[data-qt-field] .qt-th-label")!.click());
  act(() => document.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger")!.click());
  act(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-cm-submenu button"))
    .find((button) => button.textContent === label)!.click());
}

function resizeA() {
  act(() => container.querySelector<HTMLElement>('[aria-label="Resize A column"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
}

/** A controlled DataTable whose query and rows a test changes directly. */
function controlled(query: QueryState, data: Row[] = rows) {
  const state = { query, rows: data, loading: false };
  const onQueryChange = vi.fn((update: QueryState | ((previous: QueryState) => QueryState)) => {
    state.query = typeof update === "function" ? update(state.query) : update;
  });
  const render = () => act(() => root.render(createElement(DataTable<Row>, {
    fields: state.query.select.map((column) => schema.fields.find((field) => field.name === column.field)!),
    rows: state.rows, loading: state.loading, query: state.query, onQueryChange, renderers, rowId,
  })));
  render();
  return { state, onQueryChange, render };
}

describe("live fit to content", () => {
  it("keeps every column fitted through sorting, column changes, filtering and refreshes without query writes", () => {
    const { state, onQueryChange, render } = controlled(content);
    expect(widths()).toEqual([LONG, SHORT]);
    // The table does not stretch fitted columns to fill the viewport.
    expect(container.querySelector<HTMLElement>(".qt-table")!.style.width).toBe(`${LONG + SHORT}px`);

    state.query = { ...content, orderBy: [{ field: "b", dir: "desc" }] };
    state.rows = [{ id: 2, a: "tiny", b: "a much longer value" }];
    render();
    expect(widths()).toEqual([MIN, LONG]);

    state.query = { ...state.query, select: [{ field: "b" }] };
    render();
    expect(widths(["b"])).toEqual([LONG]);
    state.query = { ...state.query, select: [{ field: "b" }, { field: "a" }] };
    render();
    expect(widths()).toEqual([MIN, LONG]);

    // A refresh of the same query only grows columns, so a live table is calm.
    state.rows = [{ id: 2, a: "a much longer value", b: "short" }];
    render();
    expect(widths()).toEqual([LONG, LONG]);
    // Changing the query itself refits from scratch.
    state.query = { ...state.query, where: [{ field: "a", op: "contains", value: "much" }] };
    render();
    expect(widths()).toEqual([LONG, SHORT]);

    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("keeps the previous widths while loading and refits once loading ends", () => {
    const { state, render } = controlled(content);
    state.loading = true;
    state.query = { ...content, orderBy: [{ field: "a", dir: "asc" }] };
    state.rows = [{ id: 2, a: "tiny", b: "a much longer value" }];
    render();
    expect(widths()).toEqual([LONG, SHORT]);
    state.loading = false;
    render();
    expect(widths()).toEqual([MIN, LONG]);
  });

  it("persists only a resized column's width and returns it to fitting with Fit This Column", () => {
    const { state, render } = controlled(content);
    resizeA();
    expect(state.query).toEqual({ ...content, select: [{ field: "a", width: LONG + 10 }, { field: "b" }] });
    render();
    state.query = { ...state.query, orderBy: [{ field: "b", dir: "asc" }] };
    state.rows = [{ id: 2, a: "tiny", b: "a much longer value" }];
    render();
    expect(widths()).toEqual([LONG + 10, LONG]);

    preset("Fit This Column");
    expect(state.query.select).toEqual([{ field: "a" }, { field: "b" }]);
    expect(state.query.fit).toBe("content");
    render();
    expect(widths()).toEqual([MIN, LONG]);
  });

  it("resets explicit widths but keeps the mode, and choosing the mode again freezes its widths", () => {
    const { state, render } = controlled({ ...content, select: [{ field: "a", width: 300 }, { field: "b" }] });
    expect(widths()).toEqual([300, SHORT]);
    preset("Reset Widths");
    expect(state.query).toEqual(content);
    render();
    expect(widths()).toEqual([LONG, SHORT]);
    preset("Fit All to Content");
    expect(state.query).toEqual({ ...plain, select: [{ field: "a", width: LONG }, { field: "b", width: SHORT }] });
  });

  it("does not refit while scrolling a virtualized body", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i, a: i >= 100 ? "a much longer value" : "tiny", b: `r${i}` }));
    controlled(content, many);
    expect(widths()).toEqual([MIN, MIN]);
    const wrap = container.querySelector<HTMLElement>(".qt-table-wrap")!;
    wrap.scrollTop = 140 * 37;
    await act(async () => {
      wrap.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("a much longer value");
    expect(widths()).toEqual([MIN, MIN]);
  });

  it("fits once a hidden table gets a viewport", () => {
    viewport = 0;
    const { onQueryChange } = controlled(content);
    expect(widths()).toEqual([120, 120]);
    viewport = 602;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths()).toEqual([LONG, SHORT]);
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("measures afresh when the mode is turned back on", () => {
    const { state, render } = controlled(content);
    preset("Fit All to Content");
    expect(state.query.fit).toBeUndefined();
    render();
    state.rows = [{ id: 2, a: "tiny", b: "tiny" }];
    render();
    preset("Fit All to Content");
    expect(state.query).toEqual(content);
    render();
    expect(widths()).toEqual([MIN, MIN]);
  });

  it("lets the table shrink again after a pointer resize", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { state, render } = controlled(content);
    const handle = container.querySelector<HTMLElement>('[aria-label="Resize A column"]')!;
    act(() => handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 })));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200 })));
    act(() => window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 200 })));
    expect(state.query.select[0]).toEqual({ field: "a", width: LONG + 100 });
    render();
    const table = container.querySelector<HTMLElement>(".qt-table")!;
    expect(table.style.minWidth).toBe(`${LONG + 100 + SHORT}px`);
    preset("Reset Widths");
    render();
    expect(widths()).toEqual([LONG, SHORT]);
    expect([table.style.width, table.style.minWidth]).toEqual([`${LONG + SHORT}px`, `${LONG + SHORT}px`]);
  });
});

describe("live fit to screen", () => {
  it("restores legacy fs links, follows resizing, and keeps fitting around a resized column", async () => {
    // A 0.9.9 link: Fit All to Screen wrote widths it never showed.
    const legacy = Buffer.from(JSON.stringify({ s: [["a", 300], ["b", 300]], fs: true })).toString("base64url");
    window.history.replaceState(null, "", `/?q=2j.${legacy}`);
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
    expect(api.query).toEqual(screen);
    expect(widths().reduce((a, b) => a + b)).toBe(600);
    expect(widths()[0]).toBeGreaterThan(widths()[1]! * 3);

    viewport = 1202;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths().reduce((a, b) => a + b)).toBe(1200);
    // Wide viewports are not capped by the manual-resize 800px limit.
    expect(widths()[0]).toBeGreaterThan(800);
    expect(api.query).toEqual(screen);

    viewport = 402;
    act(() => window.dispatchEvent(new Event("resize")));
    const [a = 0] = widths();
    resizeA();
    const resized = { ...screen, select: [{ field: "a", width: a + 10 }, { field: "b" }] };
    expect(api.query).toEqual(resized);
    expect(widths()).toEqual([a + 10, 400 - a - 10]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(decodeQuery(new URL(window.location.href).searchParams.get("q")!)).toEqual(resized);
    viewport = 902;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths()).toEqual([a + 10, 900 - a - 10]);

    act(() => api.undo());
    expect(api.query).toEqual(screen);
    expect(widths().reduce((x, y) => x + y)).toBe(900);
    act(() => api.redo());
    expect(api.query).toEqual(resized);
  });

  it("saves the mode, keeps it through single-column widths and clears it with Equal Widths", async () => {
    const storage = memoryStorageAdapter();
    let api!: QueryTableApi<Row>;
    function Table() {
      api = useQueryTable({ schema, clientRows: rows, storage, initialQuery: { ...plain, select: [{ field: "a", width: 300 }, { field: "b" }] }, debounceMs: 0 });
      return createElement(DataTable<Row>, {
        fields: api.visibleFields, rows: api.rows, query: api.query,
        onQueryChange: api.setQuery, renderers, rowId,
      });
    }
    await act(async () => { root.render(createElement(Table)); });
    preset("Fit All to Screen");
    expect(api.query).toEqual(screen);
    let savedId!: string;
    await act(async () => { savedId = (await api.saved.save("Responsive")).id; });
    expect((await storage.listSaved(schema.name))[0]?.query.fit).toBe("screen");
    preset("Equal Widths");
    expect(api.query.fit).toBeUndefined();
    viewport = 402;
    act(() => api.saved.load(savedId));
    expect(api.query.fit).toBe("screen");
    expect(widths().reduce((a, b) => a + b)).toBe(400);

    act(() => api.select.setWidth("a", 200));
    expect(api.query).toEqual({ ...screen, select: [{ field: "a", width: 200 }, { field: "b" }] });
    expect(widths()).toEqual([200, 200]);
    preset("Fit This Column");
    expect(api.query).toEqual(screen);
    const displayed = widths();
    preset("Fit All to Screen");
    expect(api.query).toEqual({ ...plain, select: [{ field: "a", width: displayed[0] }, { field: "b", width: displayed[1] }] });
  });

  it("leaves the others the full rendered width of a column wider than 800px", () => {
    viewport = 1802;
    controlled({ ...screen, select: [{ field: "a", width: 1200 }, { field: "b" }] });
    expect(widths()).toEqual([1200, 600]);
  });

  it("waits for loaded rows and a visible viewport before fitting without query writes", () => {
    const onQueryChange = vi.fn();
    const render = (data: Row[], loading: boolean) => act(() => root.render(createElement(DataTable<Row>, {
      fields: schema.fields, rows: data, loading, query: screen, onQueryChange, renderers, rowId,
    })));
    viewport = 0;
    render([], true);
    expect(widths()).toEqual([120, 120]);
    render(rows, false);
    expect(widths()).toEqual([120, 120]);
    viewport = 602;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(widths().reduce((a, b) => a + b)).toBe(600);
    expect(widths()[0]).toBeGreaterThan(widths()[1]! * 3);
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it.each(["loading", "hidden"])("does not restore a removed column when freezing stale widths while %s", (paused) => {
    const { state, render } = controlled(screen);
    const displayed = widths();
    expect(displayed.reduce((a, b) => a + b)).toBe(600);

    // Remove B using the header menu, then suspend fitting during the refetch
    // or while the viewport is hidden. The local widths still contain B.
    act(() => container.querySelector<HTMLElement>('th[data-qt-field="b"] .qt-th-label')!.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-cm-item"))
      .find((button) => button.textContent === "Remove Column")!.click());
    expect(state.query.select.map((column) => column.field)).toEqual(["a"]);
    if (paused === "loading") state.loading = true;
    else viewport = 0;
    render();
    expect(container.querySelector('col[data-qt-column="b"]')).toBeNull();
    preset("Fit All to Screen");

    expect(state.query.fit).toBeUndefined();
    expect(state.query.select).toEqual([{ field: "a", width: displayed[0] }]);
  });
});

describe("control minimums in screen fitting", () => {
  const title = "a long linked conversation title that wraps over two lines";
  const wrappingLink = (value: string) => createElement("span", { style: { whiteSpace: "normal" } }, createElement("a", { href: "/c/1" }, value));
  /** Screen-fits a host-rendered A column next to plain B in a 300px table. */
  function fitWith(render: (value: string) => unknown, minWidth?: number): number[] {
    viewport = 302;
    const [a, b] = schema.fields;
    const fields = [{ ...a!, render: ({ value }: { value: unknown }) => render(String(value)), ...(minWidth ? { select: { minWidth } } : {}) }, b!];
    act(() => root.render(createElement(DataTable<Row>, {
      fields, rows: [{ id: 1, a: title, b: "short" }], loading: false, query: screen, onQueryChange: vi.fn(), renderers, rowId,
    })));
    return widths();
  }

  it("lets a host link that wraps shrink with its column instead of setting a one-line floor", () => {
    const fitted = fitWith(wrappingLink);
    expect(fitted.reduce((x, y) => x + y)).toBe(300);
    expect(fitted[1]).toBeGreaterThanOrEqual(MIN);
  });

  it("keeps the full width of controls that cannot wrap", () => {
    // A nowrap host link cannot shorten without host styling, so the table scrolls.
    expect(fitWith((value) => createElement("a", { href: "/c/1" }, value))[0]).toBeGreaterThanOrEqual(title.length * 10);
    expect(fitWith((value) => createElement("button", { type: "button" }, value))[0]).toBeGreaterThanOrEqual(title.length * 10);
  });

  it("still honours SelectConfig.minWidth for a wrapping link", () => {
    expect(fitWith(wrappingLink, 260)[0]).toBe(260);
  });
});
