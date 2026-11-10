// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_QUERY, type CellDisplay, type FieldDef } from "@pythia-software/query-table-core";
import { ClippedText, distinctTitle, isClipped, numberTitle } from "../src/hoverTitle";
import { defaultRenderers, resolveRenderer } from "../src/renderers";
import { FieldPicker } from "../src/FieldPicker";
import { ReorderList } from "../src/ReorderList";
import { JsonCell, JsonValueView } from "../src/JsonCell";
import { MetricChart } from "../src/MetricChart";
import type { MetricBucket } from "../src/metricTypes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const base: FieldDef = { name: "value", label: "Value", type: "text", source: { kind: "backend" } };
const cell = (value: unknown, display: CellDisplay, render?: FieldDef["render"]) => {
  const field = { ...base, display, ...(render === undefined ? {} : { render }) };
  return resolveRenderer(field, defaultRenderers)({ value, field, row: {}, query: EMPTY_QUERY });
};
const markup = (value: unknown, display: CellDisplay) => renderToStaticMarkup(createElement("div", null, cell(value, display)));
/** Lays the element out as clipped or not, then hovers it as React sees it. */
const hover = (element: HTMLElement, clipped: boolean) => {
  for (const [name, size] of [["scrollWidth", clipped ? 300 : 100], ["clientWidth", 100], ["scrollHeight", 20], ["clientHeight", 20]] as const)
    Object.defineProperty(element, name, { configurable: true, value: size });
  act(() => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  act(() => element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
};

describe("hover help decisions", () => {
  it("detects horizontal and line-clamped clipping", () => {
    expect(isClipped({ scrollWidth: 100, clientWidth: 100, scrollHeight: 40, clientHeight: 40 })).toBe(false);
    expect(isClipped({ scrollWidth: 101, clientWidth: 100, scrollHeight: 40, clientHeight: 40 })).toBe(true);
    expect(isClipped({ scrollWidth: 100, clientWidth: 100, scrollHeight: 60, clientHeight: 40 })).toBe(true);
  });
  it("offers only text that differs from what is shown", () => {
    expect(distinctTitle("ok", "ok")).toBeUndefined();
    expect(distinctTitle("ok", "Ready")).toBe("ok");
    expect(distinctTitle(undefined, "Ready")).toBeUndefined();
  });
  it("keeps raw numbers only when formatting hides them", () => {
    expect(numberTitle("42", "42")).toBeUndefined();
    expect(numberTitle("1234567", "1,234,567")).toBeUndefined();
    expect(numberTitle("1234567", "1 234 567")).toBeUndefined();
    expect(numberTitle("3.14159", "3.14")).toBe("3.14159");
    expect(numberTitle("0.125", "12.50%")).toBe("0.125");
    expect(numberTitle("61.25", "00:01:01.250")).toBe("61.25");
  });
  it("reads grouping, decimal marks and trailing zeros in the cell's locale", () => {
    expect(numberTitle("1234567", "1.234.567", "de-DE")).toBeUndefined();
    expect(numberTitle("1234.5", "1.234,5", "de-DE")).toBeUndefined();
    expect(numberTitle("1234567", "1\u202f234\u202f567", "fr-FR")).toBeUndefined();
    expect(numberTitle("-3", "\u22123", "sv-SE")).toBeUndefined();
    expect(numberTitle("42", "42.00", "en-US")).toBeUndefined();
    expect(numberTitle("3.14159", "3,14", "de-DE")).toBe("3.14159");
    expect(numberTitle("1234.5", "1.234", "de-DE")).toBe("1234.5");
  });
});

describe("cell hover help", () => {
  it("titles rounded but not exact numbers", () => {
    expect(markup(42, { kind: "number" })).toBe("<div><span>42</span></div>");
    expect(markup(1234567, { kind: "number", decimals: 0 })).toBe("<div><span>1,234,567</span></div>");
    expect(markup(3.14159, { kind: "number", decimals: 2 })).toContain('title="3.14159">3.14');
    expect(markup(0.125, { kind: "percent" })).toContain('title="0.125">12.50%');
    expect(markup(42, { kind: "number", decimals: 2 })).toBe("<div><span>42.00</span></div>");
    expect(markup(1234567, { kind: "number", decimals: 0, locale: "de-DE" })).toBe("<div><span>1.234.567</span></div>");
  });
  it("titles renamed chips with their raw key only", () => {
    const display: CellDisplay = { kind: "chip", labels: { ok: "Ready" } };
    expect(markup("ok", display)).toContain('title="ok">Ready');
    expect(markup("other", display)).not.toContain("title=");
  });
  for (const display of [{ kind: "text", lines: 2 }, { kind: "text", truncate: true }] as CellDisplay[]) {
    it(`offers ${JSON.stringify(display)} text in full only while it is clipped`, () => {
      const text = "a long command line that may or may not fit its cell";
      act(() => root.render(createElement("div", null, cell(text, display))));
      const span = container.querySelector<HTMLElement>("span")!;
      expect(span.textContent).toBe(text);
      expect(span.hasAttribute("title")).toBe(false);
      hover(span, true);
      expect(span.title).toBe(text);
      hover(span, false);
      expect(span.hasAttribute("title")).toBe(false);
    });
  }
  it("applies the same rule to the truncate renderer", () => {
    act(() => root.render(createElement("div", null, cell("long text", { kind: "text" }, "truncate"))));
    const span = container.querySelector<HTMLElement>(".qt-truncate")!;
    expect(span.hasAttribute("title")).toBe(false);
    hover(span, true);
    expect(span.title).toBe("long text");
  });
  it("drops a hover title once the text it described changes", () => {
    act(() => root.render(createElement(ClippedText, { text: "first value" })));
    const span = container.querySelector<HTMLElement>("span")!;
    hover(span, true);
    expect(span.title).toBe("first value");
    act(() => root.render(createElement(ClippedText, { text: "second" })));
    expect(span.hasAttribute("title")).toBe(false);
  });
  it("always offers a different full label", () => {
    act(() => root.render(createElement(ClippedText, { text: "Mon", title: "Monday, 3 November 2026" })));
    const span = container.querySelector<HTMLElement>("span")!;
    expect(span.title).toBe("Monday, 3 November 2026");
    hover(span, false);
    expect(span.title).toBe("Monday, 3 November 2026");
  });
  it("keeps JSON parse errors, and offers a valid preview only while clipped", () => {
    act(() => root.render(createElement(JsonCell, { value: '{"id":42}', display: { kind: "json" } })));
    const preview = container.querySelector<HTMLElement>(".qt-json-preview-text")!;
    expect(preview.tagName).toBe("CODE");
    expect(preview.hasAttribute("title")).toBe(false);
    hover(preview, true);
    expect(preview.title).toBe(preview.textContent);
    hover(preview, false);
    expect(preview.hasAttribute("title")).toBe(false);
    act(() => root.render(createElement(JsonCell, { value: "{not json", display: { kind: "json" } })));
    expect(container.querySelector<HTMLElement>(".qt-json-preview-text")!.title).toMatch(/\S/);
  });
  it("leaves legend labels without repeated text", () => {
    const buckets: MetricBucket[] = [{ keys: ["linux"], value: 3, count: 3 }, { keys: ["mac"], value: 1, count: 1 }];
    act(() => root.render(createElement(MetricChart, { clause: { id: "m", op: "count", groupBy: ["os"], display: { kind: "pie" } }, buckets })));
    const items = [...container.querySelectorAll(".qt-metric-legend li")];
    expect(items.length).toBe(2);
    expect(container.querySelectorAll(".qt-metric-legend [title]").length).toBe(0);
  });
});

describe("icon-only button tooltips", () => {
  it("names the field picker's back arrow", () => {
    act(() => root.render(createElement(FieldPicker, { fields: [base], onPick: () => {}, onBack: () => {}, onClose: () => {} })));
    const back = container.ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Back to fields"]')!;
    expect(back.title).toBe("Back to fields");
  });
  it("names the reorder handle", () => {
    act(() => root.render(createElement(ReorderList, { items: [{ id: "a", label: "Alpha" }], onMove: () => {}, renderItem: () => "Alpha" })));
    const handle = container.querySelector<HTMLButtonElement>(".qt-reorder-handle")!;
    expect(handle.getAttribute("aria-label")).toBe("Drag to reorder Alpha");
    expect(handle.title).toBe("Reorder");
  });
  it("says whether a JSON toggle expands or collapses", () => {
    act(() => root.render(createElement(JsonValueView, { value: { customer: { id: 42 } }, display: { kind: "json", expandDepth: 8 } })));
    const toggle = () => container.querySelector<HTMLButtonElement>('.qt-json-toggle[aria-label="Collapse $"], .qt-json-toggle[aria-label="Expand $"]')!;
    expect(toggle().title).toBe("Collapse");
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-label")).toBe("Expand $");
    expect(toggle().title).toBe("Expand");
  });
});
