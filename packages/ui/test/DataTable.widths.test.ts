// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FieldDef, QueryState } from "@pythia-software/query-table-core";
import { DataTable } from "../src/DataTable";
import type { RenderRegistry } from "../src/renderers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  a: string;
  b: string;
}

const fields: FieldDef<Row>[] = ["a", "b"].map((name) => ({
  name,
  label: name.toUpperCase(),
  type: "text",
  source: { kind: "backend" },
}));

const query: QueryState = {
  select: [{ field: "a", width: 300 }, { field: "b" }],
  where: [],
  orderBy: [],
  limit: 100,
  offset: 0,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {});
  vi.restoreAllMocks();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderTable(onQueryChange: (update: unknown) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(DataTable<Row>, {
      fields,
      rows: [{ id: 1, a: "a much longer value", b: "short" }],
      query,
      onQueryChange,
      renderers: {} as RenderRegistry<Row>,
      rowId: (row) => row.id,
    }));
  });
  const wrap = container.querySelector<HTMLElement>(".qt-table-wrap")!;
  Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 602 });
  return container;
}

/** jsdom has no layout: give the viewport a size (so the virtualizer renders
 *  rows) and each measurement probe 10px per character. */
function mockTextLayout() {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("aria-hidden") !== "true" || this.tagName !== "SPAN") return real.call(this);
    return { width: (this.textContent?.length ?? 0) * 10 } as DOMRect;
  });
}

function openWidthsSubmenu(root: HTMLElement) {
  const header = root.querySelector<HTMLElement>('th[data-qt-field="b"] .qt-th-label')!;
  act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 })));
  const trigger = document.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger");
  expect(trigger).not.toBeNull();
  expect(trigger!.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger!.click());
  expect(trigger!.getAttribute("aria-expanded")).toBe("true");
}

function chooseWidthPreset(root: HTMLElement, label: string) {
  openWidthsSubmenu(root);
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-cm-submenu .qt-cm-item"))
    .find((button) => button.textContent === label);
  expect(item, label).toBeDefined();
  act(() => item!.click());
  expect(document.querySelector(".qt-cell-menu")).toBeNull();
}

describe("DataTable column width presets", () => {
  it("toggles header menus on repeated pointer clicks, including with a submenu open", async () => {
    const table = renderTable(vi.fn());
    const header = table.querySelector<HTMLElement>('th[data-qt-field="b"]')!;
    const label = header.querySelector<HTMLElement>(".qt-th-label")!;
    const clickHeader = async () => {
      // Outside dismissal runs on pointerdown, before focus and the React click.
      await act(async () => label.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await act(async () => header.focus());
      await act(async () => label.click());
    };

    await clickHeader();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"][aria-label="B column"]')).not.toBeNull();
    await clickHeader();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(header);

    await clickHeader();
    const submenu = document.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger")!;
    await act(async () => submenu.click());
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
    await clickHeader();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("switches to another header and restores its focus after keyboard dismissal", async () => {
    const table = renderTable(vi.fn());
    const a = table.querySelector<HTMLElement>('th[data-qt-field="a"]')!;
    const b = table.querySelector<HTMLElement>('th[data-qt-field="b"]')!;
    await act(async () => a.click());
    await act(async () => b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await act(async () => b.focus());
    await act(async () => b.click());
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("B column");
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(document.activeElement).toBe(b);
    await act(async () => b.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("B column");
  });

  it("switches and toggles headers with pointerless clicks", async () => {
    const table = renderTable(vi.fn());
    const a = table.querySelector<HTMLElement>('th[data-qt-field="a"]')!;
    const b = table.querySelector<HTMLElement>('th[data-qt-field="b"]')!;
    await act(async () => a.click());
    await act(async () => b.click());
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("B column");
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(b);
    await act(async () => b.click());
    await act(async () => b.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("restores cell focus when its context menu closes", async () => {
    mockTextLayout();
    const table = renderTable(vi.fn());
    const cell = table.querySelector<HTMLElement>('td[data-qt-field="a"]')!;
    await act(async () => cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    const panel = document.querySelector('[role="menu"]')!;
    await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(cell);
  });

  it("splits the viewport evenly in a single query update", () => {
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Equal Widths");

    expect(onQueryChange).toHaveBeenCalledTimes(1);
    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    expect(update(query).select).toEqual([{ field: "a", width: 300 }, { field: "b", width: 300 }]);
  });

  it("sizes columns from their measured content", () => {
    mockTextLayout();
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Fit All to Content");

    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    const [a = 0, b = 0] = update(query).select.map((c) => c.width ?? 0);
    // "a much longer value" (190px) vs "short" (50px); padding is shared.
    expect(a - b).toBe(140);
  });

  it("fills the viewport in proportion to content when it fits", () => {
    mockTextLayout();
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Fit All to Screen");

    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    expect(update(query).fitToScreen).toBe(true);
    const [a = 0, b = 0] = update(query).select.map((c) => c.width ?? 0);
    expect(a + b).toBe(600);
    expect(a).toBeGreaterThan(b * 3);
  });

  it("fits only the clicked column", () => {
    mockTextLayout();
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Fit This Column");

    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    const [a, b] = update(query).select;
    expect(a).toEqual({ field: "a", width: 300 });
    expect(b?.width).toBeGreaterThan(48);
    expect(b?.width).toBeLessThan(120);
  });

  it("keeps the desktop submenu open when its hovered row is clicked", async () => {
    vi.useFakeTimers();
    const table = renderTable(vi.fn());
    const header = table.querySelector<HTMLElement>('th[data-qt-field="b"] .qt-th-label')!;
    act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 })));
    const trigger = document.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger")!;
    act(() => trigger.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: document.body })));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".qt-cm-submenu")).not.toBeNull();
    vi.useRealTimers();
  });

  it("resets explicit widths back to schema defaults", () => {
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Reset Widths");

    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    expect(update(query).select).toEqual([{ field: "a" }, { field: "b" }]);
  });
});
