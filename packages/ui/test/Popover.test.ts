// @vitest-environment jsdom
import { act, createElement as h, StrictMode, useState, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Popover } from "../src/Popover";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
async function mount(mobile = false) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  function Fixture() {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    return h("div", null,
      h("button", { onClick: (event: MouseEvent<HTMLButtonElement>) => { const trigger = event.currentTarget; setAnchor(previous => previous ? null : trigger); } }, "Settings"),
      h("button", { "data-after": true }, "After"),
      anchor && h(Popover, { label: "Settings", anchor, onClose: () => setAnchor(null), children: [
        h("input", { key: "search", "aria-label": "Search" }),
        h("button", { key: "apply", onClick: () => setAnchor(null) }, "Apply"),
      ] }),
    );
  }
  await act(async () => root.render(h(StrictMode, null, h(Fixture))));
  const trigger = host.querySelector('button')!;
  await act(async () => trigger.click()); return trigger;
}
it("focuses form controls, allows Tab within the form, and dismisses on focus leaving", async () => {
  await mount();
  const panel = document.querySelector('[role="dialog"]')!;
  const search = panel.querySelector('input')!;
  expect(document.activeElement).toBe(search);
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => search.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(panel.isConnected).toBe(true);
  await act(async () => panel.querySelector('button')!.focus());
  expect(panel.isConnected).toBe(true);
  const after = host.querySelector<HTMLButtonElement>('[data-after]')!;
  await act(async () => after.focus());
  expect(panel.isConnected).toBe(false);
  expect(document.activeElement).toBe(after);
});
it("restores the trigger on consumer-driven selection, Escape and pointer toggling", async () => {
  const trigger = await mount();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => document.querySelector('input')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => { trigger.dispatchEvent(new Event('pointerdown', { bubbles: true })); trigger.focus(); trigger.click(); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("uses the shared mobile focus trap and restores a pointerless trigger", async () => {
  const trigger = await mount(true);
  const panel = document.querySelector('.qt-sheet')!;
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(document.body.style.overflow).toBe('hidden');
  await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe('');
});
