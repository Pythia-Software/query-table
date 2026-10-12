// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPropertyView, normalizePropertyView, type FieldSchema, type PropertyViewState } from "@pythia-software/query-table-core";
import { ObjectProperties, formatPropertyValue } from "../src/ObjectProperties";
import { PropertyViewEditor } from "../src/PropertyViewEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema = {
  name: "responses", idField: "id", fields: [
    { name: "payload", label: "Payload", type: "text", source: { kind: "backend" }, display: { kind: "json" } },
    { name: "elapsed", label: "Elapsed", type: "number", source: { kind: "backend" }, display: { kind: "duration", sourceUnit: "seconds", style: "clock" } },
    { name: "status", label: "Status", type: "enum", source: { kind: "backend" }, display: { kind: "chip", labels: { ok: "Ready" }, tones: { ok: "success" } } },
  ],
};
const raw = JSON.stringify(JSON.stringify({ customer: { name: "Ada", id: 42 } }));
let container: HTMLDivElement, root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function input(target: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
describe("JSON in item properties", () => {
  it("embeds the same searchable tree and inherits duration/chip displays without a nested modal", () => {
    act(() => root.render(createElement(ObjectProperties, { schema, row: { payload: raw, elapsed: 61.25, status: "ok" }, view: createPropertyView(schema) })));
    expect(container.querySelector(".qt-json-inline")).not.toBeNull();
    expect(container.querySelector('[aria-label="Inspect Payload"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("00:01:01.250");
    expect(container.textContent).toContain("Ready");
    input(container.querySelector<HTMLInputElement>('input[type="search"]')!, "ada");
    expect(container.querySelectorAll(".qt-json-entry")).toHaveLength(1);
    expect(container.textContent).toContain('$["customer"]["name"]');
    expect(container.textContent).toContain("Ada");
  });
  it("honors saved format overrides and detail-specific JSON formats and renderers", () => {
    const view: PropertyViewState = { version: 1, properties: [{ id: "literal", field: "payload", format: { kind: "text" } }] };
    act(() => root.render(createElement(ObjectProperties, { schema, row: { payload: raw }, view })));
    expect(container.querySelector(".qt-json-inline")).toBeNull();
    const literal = normalizePropertyView({ version: 1, properties: [{ id: "literal", field: "payload", format: { kind: "json", encoding: "value", expandDepth: 0 } }] });
    act(() => root.render(createElement(ObjectProperties, { schema, row: { payload: raw }, view: literal })));
    expect(container.querySelector(".qt-json-inline")).not.toBeNull();
    expect(container.querySelectorAll(".qt-json-entry")).toHaveLength(1);
    expect(container.querySelector(".qt-json-value--string")).not.toBeNull();
    act(() => root.render(createElement(ObjectProperties, { schema, row: { payload: raw }, view: { version: 1, properties: [{ id: "renderer", field: "payload", render: "json" }] } })));
    expect(container.querySelector(".qt-json-inline")).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const propertySchema: FieldSchema = { ...schema, fields: [{ ...schema.fields[0]!, property: { format: { kind: "json", encoding: "value" } } }] };
    act(() => root.render(createElement(ObjectProperties, { schema: propertySchema, row: { payload: raw }, view: createPropertyView(propertySchema) })));
    expect(container.querySelector(".qt-json-value--string")).not.toBeNull();
  });
  it("preserves JSON settings through the transactional property editor", () => {
    const apply = vi.fn();
    const view = normalizePropertyView({ version: 1, properties: [{ id: "payload", field: "payload", format: { kind: "json" } }] });
    act(() => root.render(createElement(PropertyViewEditor, { schema, view, onApply: apply, onClose: () => undefined, preview: { schema, row: { payload: raw } } })));
    input(document.querySelector<HTMLSelectElement>('[aria-label="JSON input for payload"]')!, "json");
    input(document.querySelector<HTMLInputElement>('[aria-label="JSON decode passes for payload"]')!, "6");
    input(document.querySelector<HTMLInputElement>('[aria-label="JSON expand levels for payload"]')!, "2");
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Apply properties")!.click());
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ properties: [expect.objectContaining({ format: { kind: "json", encoding: "json", maxDecodeDepth: 6, expandDepth: 2 } })] }));
  });
  it("formats encoded JSON with the shared decoder and preserves malformed source", () => {
    expect(formatPropertyValue(raw, { kind: "json" }).text).toBe(JSON.stringify({ customer: { name: "Ada", id: 42 } }, null, 2));
    expect(formatPropertyValue('{"bad":}', { kind: "json" })).toMatchObject({ text: '{"bad":}', error: expect.stringContaining("Invalid JSON") });
    expect(formatPropertyValue(["ok", "unknown"], { kind: "chip", labels: { ok: "Ready" } }).text).toBe("Ready, unknown");
  });
});
