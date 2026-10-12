import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_QUERY, type CellDisplay, type FieldDef } from "@pythia-software/query-table-core";
import { defaultRenderers, resolveRenderer } from "../src/renderers";

const base: FieldDef = { name: "value", label: "Value", type: "text", source: { kind: "backend" } };
function render(value: unknown, display: CellDisplay, render?: FieldDef["render"]) {
  const field = { ...base, display, ...(render === undefined ? {} : { render }) };
  return renderToStaticMarkup(createElement("div", null, resolveRenderer(field, defaultRenderers)({ value, field, row: {}, query: EMPTY_QUERY })));
}
describe("declarative cell displays", () => {
  it("uses explicit units, clock rollover and timezone settings", () => {
    expect(render(59.9996, { kind: "duration", sourceUnit: "seconds", style: "clock" })).toContain("0:01:00");
    expect(render(3661, { kind: "duration", sourceUnit: "seconds", style: "clock" })).toContain("1:01:01");
    expect(render("13:05", { kind: "time", style: "iso" })).toContain("13:05:00");
    expect(render(0, { kind: "datetime", sourceUnit: "epochSeconds", style: "iso" })).toContain("1970-01-01 00:00:00 +00:00");
    expect(render("2026-05-01T12:00:00Z", { kind: "time", timeZone: "America/Denver", style: "iso" })).toContain("06:00:00");
    expect(render(0.125, { kind: "percent", decimals: 1 })).toContain("12.5%");
    expect(render(0.125, { kind: "percent" })).toContain("12.50%");
    expect(render(1.125, { kind: "number" })).toContain("1.125");
  });
  it("preserves invalid source values with actionable errors", () => {
    expect(render("bad", { kind: "duration" })).toContain("bad");
    expect(render("bad", { kind: "duration" })).toContain("Expected a finite number");
    expect(render("2026-02-30", { kind: "date" })).toContain("Invalid calendar date");
    expect(render(" ", { kind: "number" })).toContain("Expected a finite number");
    expect(render(new Date(NaN), { kind: "date" })).toContain("Expected a string or number");
  });
  it("supports labeled scalar/array chips without changing raw values", () => {
    const display: CellDisplay = { kind: "chip", labels: { ok: "Ready" }, tones: { ok: "success" } };
    expect(render(["ok", "other"], display)).toContain('class="qt-pill qt-pill--pass" title="ok">Ready');
    expect(render("__proto__", display)).toContain("__proto__");
    expect(render(0, display)).toContain('title="0">0');
  });
  it("resolves explicit custom renderers before display hints and preserves legacy fallback", () => {
    expect(render("42", { kind: "json" }, () => "custom")).toBe("<div>custom</div>");
    expect(render("42", { kind: "json" }, "text")).toBe("<div>42</div>");
    expect(render("42", { kind: "json" }, "missing")).toContain("Inspect Value");
    expect(resolveRenderer(base, defaultRenderers)).toBe(defaultRenderers.text);
  });
  it("renders JSON payload previews safely, including empty objects and arrays", () => {
    expect(render([], { kind: "json" })).toContain("[]");
    expect(render({}, { kind: "json" })).toContain("{}");
    expect(render({ html: "<script>alert(1)</script>" }, { kind: "json" })).not.toContain("<script>");
    expect(render(null, { kind: "json" })).toContain("—");
  });
});
