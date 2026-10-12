// @vitest-environment jsdom
import { act, createElement as h, StrictMode, useState, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Menu, MenuButton, MenuGroup, MenuItem, MenuSeparator, MenuSubmenu } from "../src/Menu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let selected: Mock<(label?: string) => void>;
let closed: Mock<() => void>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selected = vi.fn(); closed = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const item = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
  .find((element) => element.querySelector('.qt-menu-item-label')?.textContent === label)!;
const menus = () => document.querySelectorAll('[role="menu"]');
async function key(element: Element, value: string, options: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value, ...options })); });
}
async function renderFixture({ mobile = false, rtl = false, disabled = false, focusTrigger = true } = {}) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  function Fixture() {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    return h("div", { dir: rtl ? "rtl" : "ltr", style: { direction: rtl ? "rtl" : "ltr", "--qt-bg": "#161b22", colorScheme: "dark" } as React.CSSProperties },
      h("button", { onClick: (event: MouseEvent<HTMLButtonElement>) => setAnchor(event.currentTarget) }, "Actions"),
      h("button", null, "After"),
      anchor && h(Menu, { anchor, label: "Actions", onClose: () => { closed(); setAnchor(null); }, children: [
        h(MenuItem, { key: "a", disabled, onSelect: () => selected("Alpha") }, "Alpha"),
        h(MenuItem, { key: "d", disabled: true, onSelect: selected }, "Disabled"),
        h(MenuSeparator, { key: "sep" }),
        h(MenuItem, { key: "b", checked: false, onSelect: () => selected("Beta") }, "Beta"),
        h(MenuSubmenu, { key: "sub", label: "More", children: [
          h(MenuItem, { key: "child", onSelect: () => selected("Child") }, "Child"),
          h(MenuSubmenu, { key: "deep", label: "Nested", children: h(MenuItem, { onSelect: () => selected("Leaf") }, "Leaf") }),
        ] }),
        h(MenuSubmenu, { key: "sib", label: "Other", children: h(MenuItem, { onSelect: selected }, "Other child") }),
        h(MenuItem, { key: "s", closeOnSelect: false, onSelect: () => selected("Stay") }, "Stay"),
      ] }),
    );
  }
  await act(async () => root.render(h(StrictMode, null, h(Fixture))));
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { if (focusTrigger) trigger.focus(); trigger.click(); });
  return trigger;
}

describe("reusable menus", () => {
  it("portals outside clipping ancestors and exposes menu and selection semantics", async () => {
    await renderFixture();
    const panel = menus()[0] as HTMLElement;
    expect(container.contains(panel)).toBe(false);
    expect(document.activeElement).toBe(item("Alpha"));
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
    expect(item("Beta").getAttribute("aria-checked")).toBe("false");
  });

  it("wraps arrow navigation, skips disabled items, supports Home/End and typeahead", async () => {
    await renderFixture();
    await key(item("Alpha"), "ArrowDown");
    expect(document.activeElement).toBe(item("Beta"));
    await key(item("Beta"), "End");
    expect(document.activeElement).toBe(item("Stay"));
    await key(item("Stay"), "ArrowDown");
    expect(document.activeElement).toBe(item("Alpha"));
    await key(item("Alpha"), "ArrowUp");
    expect(document.activeElement).toBe(item("Stay"));
    await key(item("Stay"), "Home");
    await key(item("Alpha"), "b");
    expect(document.activeElement).toBe(item("Beta"));
    expect(Array.from(menus()[0]!.querySelectorAll('button')).filter(button => button.tabIndex === 0)).toHaveLength(1);
  });

  it("opens and backs out one level at a time, then restores the root trigger", async () => {
    const trigger = await renderFixture();
    await key(item("Alpha"), "m");
    await key(item("More"), "ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(item("Child"));
    expect(item("More").getAttribute("aria-controls")).toBe(menus()[1]!.id);
    await key(item("Child"), "ArrowDown");
    await key(item("Nested"), "ArrowRight");
    expect(menus()).toHaveLength(3);
    expect(document.activeElement).toBe(item("Leaf"));
    await key(item("Leaf"), "Escape");
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(item("Nested"));
    expect(closed).not.toHaveBeenCalled();
    await key(item("Nested"), "ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(item("More"));
    await key(item("More"), "Escape");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("replaces sibling submenus and selecting a leaf closes the entire tree once", async () => {
    const trigger = await renderFixture();
    await act(async () => item("More").click());
    await act(async () => item("Other").click());
    expect(menus()).toHaveLength(2);
    expect(item("More").getAttribute("aria-expanded")).toBe("false");
    expect(item("Child")).toBeUndefined();
    await act(async () => item("Other child").click());
    expect(selected).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves focus on outside interaction and supports non-closing actions", async () => {
    await renderFixture();
    await act(async () => item("Stay").click());
    expect(selected).toHaveBeenCalledWith("Stay");
    expect(menus()).toHaveLength(1);
    const after = container.querySelectorAll<HTMLButtonElement>("button")[1]!;
    await act(async () => after.focus());
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(after);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("returns to the trigger before Tab leaves the menu", async () => {
    const trigger = await renderFixture();
    await key(item("Alpha"), "Tab");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("reverses submenu open and back arrows in RTL", async () => {
    await renderFixture({ rtl: true });
    await key(item("More"), "ArrowLeft");
    expect(document.activeElement).toBe(item("Child"));
    await key(item("Child"), "ArrowRight");
    expect(document.activeElement).toBe(item("More"));
    expect(menus()).toHaveLength(1);
  });

  it("uses inline submenus in mobile sheets, with Escape returning before dismissing the sheet", async () => {
    const trigger = await renderFixture({ mobile: true });
    expect(document.querySelector('.qt-sheet')).not.toBeNull();
    await act(async () => item("More").click());
    expect(menus()).toHaveLength(2);
    expect((menus()[1] as HTMLElement).style.position).toBe("");
    await key(item("Child"), "Escape");
    expect(menus()).toHaveLength(1);
    expect(document.querySelector('.qt-sheet')).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
    await key(item("More"), "Escape");
    expect(document.querySelector('.qt-sheet')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("keeps an all-disabled menu dismissible from the keyboard", async () => {
    const trigger = document.createElement("button");
    container.append(trigger);
    await act(async () => root.render(h(Menu, {
      label: "Unavailable actions", anchor: trigger, onClose: closed,
      children: h(MenuItem, { disabled: true, onSelect: selected }, "Unavailable"),
    })));
    const panel = menus()[0]!;
    expect(document.activeElement).toBe(panel);
    await key(panel, "ArrowDown");
    expect(document.activeElement).toBe(panel);
    await key(panel, "Escape");
    expect(closed).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
  });

  it("restores a mobile trigger even when tapping it did not focus it", async () => {
    const trigger = await renderFixture({ mobile: true, focusTrigger: false });
    const sheet = document.querySelector('.qt-sheet')!;
    await key(sheet, "Escape");
    expect(document.querySelector('.qt-sheet')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});


describe("menu triggers and grouped actions", () => {
  it("opens at the last item with ArrowUp and toggles off on a pointer trigger click", async () => {
    await act(async () => root.render(h(StrictMode, null, h(MenuButton, {
      trigger: "Actions", label: "Actions", children: [
        h(MenuItem, { key: "first" }, "First"),
        h(MenuItem, { key: "last" }, "Last"),
      ],
    }))));
    const trigger = container.querySelector('button')!;
    await key(trigger, "ArrowUp");
    expect(document.activeElement).toBe(item("Last"));
    await act(async () => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      trigger.focus(); trigger.click();
    });
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    await key(trigger, "ArrowDown");
    expect(document.activeElement).toBe(item("First"));
    await key(item("First"), "Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])("navigates paired actions, skips disabled cells and exits the group (RTL=%s)", async rtl => {
    await act(async () => root.render(h("div", { style: { direction: rtl ? "rtl" : "ltr" } }, h(MenuButton, {
      label: "Conditions", trigger: "Conditions", children: [
        h(MenuItem, { key: "before" }, "Before"),
        h(MenuGroup, { key: "grid", label: "Match", columns: 2, children: [
          h(MenuItem, { key: "a", checked: true, selectionType: "radio" }, "Keep A"),
          h(MenuItem, { key: "b", checked: false, selectionType: "radio" }, "Exclude A"),
          h(MenuItem, { key: "c", disabled: true }, "Keep B"),
          h(MenuItem, { key: "d" }, "Exclude B"),
          h(MenuItem, { key: "e" }, "Keep C"),
          h(MenuItem, { key: "f", disabled: true }, "Exclude C"),
        ] }),
        h(MenuItem, { key: "after" }, "After"),
      ],
    }))));
    await act(async () => container.querySelector('button')!.click());
    await key(item("Before"), "ArrowDown");
    expect(document.activeElement).toBe(item("Keep A"));
    expect(item("Keep A").getAttribute("role")).toBe("menuitemradio");
    expect(item("Exclude A").getAttribute("aria-checked")).toBe("false");
    await key(item("Keep A"), rtl ? "ArrowLeft" : "ArrowRight");
    expect(document.activeElement).toBe(item("Exclude A"));
    await key(item("Exclude A"), "ArrowDown");
    expect(document.activeElement).toBe(item("Exclude B"));
    await key(item("Exclude B"), "ArrowDown");
    expect(document.activeElement).toBe(item("After"));
    await act(async () => item("Keep A").focus());
    await key(item("Keep A"), "ArrowDown");
    expect(document.activeElement).toBe(item("Keep C"));
    await key(item("Keep C"), "ArrowDown");
    expect(document.activeElement).toBe(item("After"));
    await act(async () => item("Keep A").focus());
    await key(item("Keep A"), "ArrowUp");
    expect(document.activeElement).toBe(item("Before"));
  });
});
