// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalSurface } from "../src/AdaptiveOverlay";
import { FieldPicker } from "../src/FieldPicker";
import { ReorderList, type ReorderItem } from "../src/ReorderList";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pointer(target: Element, type: string, clientY: number, clientX = 0) {
  act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY, clientX })));
}

describe("adaptive mobile sheets", () => {
  it("portals out of clipping containers, traps focus, closes on Escape, and restores focus and scrolling", () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return createElement("div", null,
        createElement("button", { onClick: () => setOpen(true) }, "Open"),
        open && createElement(ModalSurface, { title: "Settings", onClose: () => setOpen(false) }, createElement("button", null, "Last")),
      );
    }
    document.body.style.overflow = "auto";
    act(() => root.render(createElement(Fixture)));
    const trigger = container.querySelector("button")!;
    trigger.focus();
    act(() => trigger.click());
    const sheet = document.querySelector<HTMLElement>(".qt-sheet")!;
    expect(container.contains(sheet)).toBe(false);
    expect(document.activeElement).toBe(sheet);
    expect(document.body.style.overflow).toBe("hidden");
    const buttons = sheet.querySelectorAll("button");
    act(() => sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(buttons[1]);
    act(() => trigger.focus());
    expect(document.activeElement).toBe(sheet);
    act(() => sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".qt-sheet")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("keeps the parent modal open and locked when a nested sheet closes", () => {
    const parentClose = vi.fn();
    function Fixture() {
      const [child, setChild] = useState(false);
      return createElement(ModalSurface, { title: "Parent", onClose: parentClose },
        createElement("button", { onClick: () => setChild(true) }, "Child"),
        child && createElement(ModalSurface, { title: "Child", onClose: () => setChild(false) }, "Choices"),
      );
    }
    act(() => root.render(createElement(Fixture)));
    act(() => (document.querySelector(".qt-sheet > button") as HTMLButtonElement).click());
    const sheets = document.querySelectorAll(".qt-sheet");
    expect(sheets).toHaveLength(2);
    act(() => sheets[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelectorAll(".qt-sheet")).toHaveLength(1);
    expect(document.body.style.overflow).toBe("hidden");
    expect(parentClose).not.toHaveBeenCalled();
  });

  it("follows the visible viewport when the keyboard opens", () => {
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 400;
    viewport.offsetTop = 20;
    vi.stubGlobal("visualViewport", viewport);
    act(() => root.render(createElement(ModalSurface, { title: "Search", onClose: vi.fn() }, "Content")));
    const backdrop = document.querySelector<HTMLElement>(".qt-overlay-backdrop")!;
    expect(backdrop.style.height).toBe("400px");
    expect(backdrop.style.top).toBe("20px");
    act(() => {
      viewport.height = 280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(backdrop.style.height).toBe("280px");
  });

  it("supports scrim dismissal, swipe dismissal, and cancellation without closing", () => {
    const close = vi.fn();
    act(() => root.render(createElement(ModalSurface, { title: "Settings", onClose: close }, "Content")));
    const handle = document.querySelector<HTMLElement>(".qt-sheet-handle")!;
    handle.setPointerCapture = vi.fn();
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 200);
    pointer(handle, "pointercancel", 200);
    expect(close).not.toHaveBeenCalled();
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointerup", 200);
    expect(close).toHaveBeenCalledTimes(1);
    act(() => (document.querySelector(".qt-overlay-backdrop") as HTMLElement).click());
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("leaves desktop pickers inline and lets touch users scroll before selecting", () => {
    const pick = vi.fn();
    const props = { fields: [{ name: "name", label: "Name", type: "text" as const, source: { kind: "backend" as const } }], onPick: pick, onClose: vi.fn() };
    act(() => root.render(createElement(FieldPicker, props)));
    const input = document.querySelector(".qt-picker-input")!;
    expect(document.activeElement).not.toBe(input);
    const item = document.querySelector<HTMLButtonElement>(".qt-picker-item")!;
    pointer(item, "pointerdown", 100);
    pointer(item, "pointermove", 160);
    pointer(item, "pointercancel", 160);
    expect(pick).not.toHaveBeenCalled();
    act(() => item.click());
    expect(pick).toHaveBeenCalledWith(props.fields[0]);
    act(() => root.unmount());
    root = createRoot(container);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    act(() => root.render(createElement(FieldPicker, props)));
    expect(container.querySelector(".qt-picker")).not.toBeNull();
    expect(document.querySelector(".qt-sheet")).toBeNull();
  });

  it("preserves desktop picker focus until click even when pointer presses do not focus buttons", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const pick = vi.fn();
    const close = vi.fn();
    const field = { name: "name", label: "Name", type: "text" as const, source: { kind: "backend" as const } };
    act(() => root.render(createElement(FieldPicker, { fields: [field], onPick: pick, onClose: close })));
    const input = container.querySelector<HTMLInputElement>(".qt-picker-input")!;
    const item = container.querySelector<HTMLButtonElement>(".qt-picker-item")!;
    expect(document.activeElement).toBe(input);
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      if (item.dispatchEvent(press)) input.blur();
    });
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(close).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
    act(() => item.click());
    expect(pick).toHaveBeenCalledExactlyOnceWith(field);
    act(() => input.blur());
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("mobile list ordering", () => {
  const items: ReorderItem[] = [{ id: "a", label: "First" }, { id: "b", label: "Second" }, { id: "c", label: "Third" }];

  it("drags wrapped chips across rows and horizontally without changing order until release", () => {
    const move = vi.fn();
    act(() => root.render(createElement(ReorderList, { items, onMove: move, layout: "wrap", showHint: false })));
    const list = container.querySelector<HTMLOListElement>("ol")!;
    list.style.columnGap = "4px";
    list.style.rowGap = "4px";
    list.getBoundingClientRect = () => ({ left: 0, right: 204, width: 204, top: 0 }) as DOMRect;
    const boxes = [{ left: 0, top: 0, width: 90 }, { left: 94, top: 0, width: 110 }, { left: 0, top: 36, width: 90 }];
    Array.from(list.querySelectorAll("li")).forEach((row, index) => {
      row.getBoundingClientRect = () => ({ ...boxes[index], height: 32 }) as DOMRect;
    });
    const handle = list.querySelector<HTMLButtonElement>(".qt-reorder-handle")!;
    handle.setPointerCapture = vi.fn();
    pointer(handle, "pointerdown", 16, 10);
    pointer(handle, "pointermove", 52, 10);
    expect(list.querySelector("li")!.style.transform).toBe("translate(0px, 36px)");
    expect(move).not.toHaveBeenCalled();
    pointer(handle, "pointercancel", 52, 10);
    expect(move).not.toHaveBeenCalled();
    pointer(handle, "pointerdown", 16, 10);
    pointer(handle, "pointermove", 16, 150);
    expect(list.querySelector("li")!.style.transform).toBe("translate(114px, 0px)");
    pointer(handle, "pointerup", 16, 150);
    expect(move).toHaveBeenCalledWith("a", 1);
  });

  it("supports left/right keys for wrapped chips and ignores disabled handles", () => {
    const move = vi.fn();
    act(() => root.render(createElement(ReorderList, { items, onMove: move, layout: "wrap" })));
    act(() => container.querySelector(".qt-reorder-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(move).toHaveBeenLastCalledWith("a", 1);
    move.mockClear();
    act(() => root.render(createElement(ReorderList, { items, onMove: move, layout: "wrap", disabled: true })));
    act(() => container.querySelector(".qt-reorder-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(move).not.toHaveBeenCalled();
  });

  it("previews handle dragging, commits only on release, and cancels cleanly", () => {
    const move = vi.fn();
    act(() => root.render(createElement(ReorderList, { items, onMove: move })));
    const bounds = () => Array.from(container.querySelectorAll("li")).forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 60, bottom: (index + 1) * 60, height: 60 }) as DOMRect;
    });
    bounds();
    const handle = container.querySelector<HTMLButtonElement>(".qt-reorder-handle")!;
    handle.setPointerCapture = vi.fn();
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 170);
    expect(container.querySelector("li")!.style.transform).toBe("translateY(120px)");
    expect(Array.from(container.querySelectorAll(".qt-reorder-label")).map((node) => node.textContent)).toEqual(["First", "Second", "Third"]);
    expect(move).not.toHaveBeenCalled();
    pointer(handle, "pointercancel", 170);
    expect(container.querySelector(".qt-reorder-label")!.textContent).toBe("First");
    expect(move).not.toHaveBeenCalled();
    bounds();
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 170);
    pointer(handle, "pointerup", 170);
    expect(move).toHaveBeenCalledWith("a", 2);
    expect(container.querySelector('[role="status"]')!.textContent).toBe("First moved to position 3 of 3");
  });

  it("omits numeric controls and supports keyboard reordering through the handle", () => {
    const move = vi.fn();
    act(() => root.render(createElement(ReorderList, { items, onMove: move })));
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("li")!.firstElementChild!.className).toBe("qt-reorder-handle");
    act(() => container.querySelector(".qt-reorder-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(move).toHaveBeenLastCalledWith("a", 1);
  });

  it("renders editable rows directly without an extra action or hint", () => {
    const browse = vi.fn();
    act(() => root.render(createElement(ReorderList, {
      items,
      onMove: vi.fn(),
      showHint: false,
      className: "qt-editor-columns",
      renderItem: (item) => createElement("button", { onClick: () => browse(item.id) }, item.label),
    })));
    expect(container.querySelector(".qt-reorder-hint")).toBeNull();
    expect(container.querySelector(".qt-reorder-trigger")).toBeNull();
    const first = container.querySelector("li")!;
    expect(first.firstElementChild!.className).toBe("qt-reorder-handle");
    act(() => (first.querySelector("button:last-child") as HTMLButtonElement).click());
    expect(browse).toHaveBeenCalledWith("a");
  });
});
