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

afterEach(() => {
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
  const trigger = root.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger");
  expect(trigger).not.toBeNull();
  expect(trigger!.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger!.click());
  expect(trigger!.getAttribute("aria-expanded")).toBe("true");
}

function chooseWidthPreset(root: HTMLElement, label: string) {
  openWidthsSubmenu(root);
  const item = Array.from(root.querySelectorAll<HTMLButtonElement>(".qt-cm-submenu .qt-cm-item"))
    .find((button) => button.textContent === label);
  expect(item, label).toBeDefined();
  act(() => item!.click());
  expect(root.querySelector(".qt-cell-menu")).toBeNull();
}

describe("DataTable column width presets", () => {
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

  it("keeps the desktop submenu open when its hovered row is clicked", () => {
    const table = renderTable(vi.fn());
    const header = table.querySelector<HTMLElement>('th[data-qt-field="b"] .qt-th-label')!;
    act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 })));
    const trigger = table.querySelector<HTMLButtonElement>(".qt-cm-submenu-trigger")!;
    // React derives onMouseEnter from mouseover with an outside relatedTarget.
    act(() => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(table.querySelector(".qt-cm-submenu")).not.toBeNull();
  });

  it("resets explicit widths back to schema defaults", () => {
    const onQueryChange = vi.fn();
    const table = renderTable(onQueryChange);
    chooseWidthPreset(table, "Reset Widths");

    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    expect(update(query).select).toEqual([{ field: "a" }, { field: "b" }]);
  });
});
