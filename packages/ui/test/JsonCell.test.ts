// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonCell, JsonValueView } from "../src/JsonCell";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  clipboard = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
});

describe("pretty JSON structure", () => {
  const code = () => [...container.querySelectorAll(".qt-json-line-code")].map(node => node.textContent).join("\n");
  it("preserves array syntax, empty containers, escaped keys and falsy primitives", () => {
    const value = [{ 'quote"\\key': [0, false, null, ""], emptyObject: {}, emptyArray: [] }, 7];
    act(() => root.render(createElement(JsonValueView, { value, display: { kind: "json", expandDepth: 8 } })));
    expect(JSON.parse(code())).toEqual(value);
    expect(code()).not.toContain('"0":'); // array indices aren't object keys
    act(() => button('Collapse $[0]["quote\\"\\\\key"]').click());
    expect(code()).toContain('"quote\\"\\\\key": [ … ],');
    act(() => button('Expand $[0]["quote\\"\\\\key"]').click());
    expect(JSON.parse(code())).toEqual(value);
  });
  it("pages wide objects with balanced braces and copies the complete object", async () => {
    const value = Object.fromEntries(Array.from({ length: 260 }, (_, index) => [`key${index}`, index]));
    act(() => root.render(createElement(JsonValueView, { value })));
    expect(container.querySelectorAll(".qt-json-entry")).toHaveLength(200);
    expect(code().startsWith("{\n")).toBe(true);
    expect(code().endsWith("\n…\n}")).toBe(true);
    await act(async () => button("Copy value at $").click());
    expect(clipboard).toHaveBeenLastCalledWith(JSON.stringify(value, null, 2));
    act(() => button("Show more").click());
    expect(JSON.parse(code())).toEqual(value);
    expect(button("Show more")).toBeUndefined();
  });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!;
function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe.each([false, true])("JSON inspector (mobile: %s)", (mobile) => {
  beforeEach(() => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }))));
  it("opens without triggering cell actions, finds hidden values, copies raw/decoded/nested values and restores focus", async () => {
    const payload = { customer: { "display.name": "Ada", id: 42 }, empty: [], ok: false };
    const original = JSON.stringify(JSON.stringify(payload));
    const cellClick = vi.fn(); const cellCopy = vi.fn();
    act(() => root.render(createElement("div", { onClick: cellClick, onDoubleClick: cellCopy }, createElement(JsonCell, { value: original, label: "Payload" }))));
    const trigger = button("Inspect Payload"); trigger.focus();
    act(() => trigger.click());
    expect(cellClick).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    expect(dialog.classList.contains("qt-sheet")).toBe(mobile);
    expect(dialog.querySelector(".qt-overlay-header")).toBeNull();
    expect(button("Close Payload · JSON").textContent).not.toContain("Done");
    expect(dialog.querySelector('.qt-json-toolbar input[type="search"]')).not.toBeNull();
    expect(dialog.querySelector(".qt-json-content input")).toBeNull();
    expect(dialog.textContent).not.toContain("Ada");
    expect(dialog.querySelector('[data-json-path="$[\\"customer\\"]"] code')?.textContent).toBe('"customer": { … },');
    search("aDa");
    expect(dialog.querySelectorAll(".qt-json-match")).toHaveLength(1);
    expect(dialog.querySelectorAll(".qt-json-entry")).toHaveLength(3);
    expect(dialog.querySelector("mark")?.textContent).toBe("Ada");
    expect([...dialog.querySelectorAll(".qt-json-line-code")].map(node => node.textContent).join("\n")).toBe('{\n"customer": {\n"display.name": "Ada"\n}\n}');
    expect(dialog.textContent).toContain("1 matching paths");
    await act(async () => button('Copy value at $["customer"]["display.name"]').click());
    expect(clipboard).toHaveBeenLastCalledWith('"Ada"');
    await act(async () => button('Copy value at $["customer"]').click());
    expect(clipboard).toHaveBeenLastCalledWith(JSON.stringify(payload.customer, null, 2));
    await act(async () => button("Copy original").click());
    expect(clipboard).toHaveBeenLastCalledWith(original);
    await act(async () => button("Copy JSON").click());
    expect(clipboard).toHaveBeenLastCalledWith(JSON.stringify(payload, null, 2));
    search("no such value"); expect(dialog.textContent).toContain("No matching keys or values");
    search("");
    expect(dialog.textContent).not.toContain("Ada");
    act(() => button('Expand $["customer"]').click());
    expect(dialog.textContent).toContain("Ada");
    expect(JSON.parse([...dialog.querySelectorAll(".qt-json-line-code")].map(node => node.textContent).join("\n"))).toEqual(payload);
    act(() => button("Collapse $").click());
    expect(dialog.querySelectorAll(".qt-json-entry")).toHaveLength(1);
    expect(dialog.querySelector(".qt-json-line-code")?.textContent).toBe("{ … }");
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
    expect(cellClick).not.toHaveBeenCalled();
    expect(cellCopy).not.toHaveBeenCalled();
  });
  it("keeps malformed input readable and reports clipboard denial", async () => {
    const malformed = '{"broken":}';
    act(() => root.render(createElement(JsonCell, { value: malformed })));
    act(() => button("Inspect JSON").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Invalid JSON");
    expect(document.querySelector("pre")?.textContent).toBe(malformed);
    expect(button("Copy JSON").disabled).toBe(true);
    clipboard.mockRejectedValueOnce(Error("denied"));
    await act(async () => button("Copy original").click());
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Copy failed");
  });
});
