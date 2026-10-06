// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "../src/Icon";
import { defaultRenderers } from "../src/renderers";

const names: IconName[] = ["add", "close", "check", "chevronDown", "chevronRight", "arrowUp", "arrowDown", "arrowLeft", "arrowRight", "grip", "pencil", "star", "undo", "redo", "copy", "share", "refresh", "clock", "reset", "bookmark"];

function renderIcon(name: IconName, options = {}) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(Icon, { name, ...options }));
  return container.querySelector("svg")!;
}

describe("Icon", () => {
  it.each(names)("renders %s as decorative, themeable SVG artwork", (name) => {
    const icon = renderIcon(name);
    expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon.getAttribute("stroke")).toBe("currentColor");
    expect(icon.getAttribute("stroke-width")).toBe("1.8");
    expect(icon.getAttribute("stroke-linecap")).toBe("round");
    expect(icon.getAttribute("stroke-linejoin")).toBe("round");
    expect(icon.getAttribute("fill")).toBe("none");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.getAttribute("data-icon")).toBe(name);
    expect(icon.querySelector("path, circle, rect")).not.toBeNull();
    expect(icon.textContent).toBe("");
    expect(icon.querySelector("image, use, text")).toBeNull();
  });

  it("supports component-specific sizes and class names", () => {
    const icon = renderIcon("chevronDown", { size: 24, className: "qt-qb-collapse-caret" });
    expect(icon.getAttribute("width")).toBe("24");
    expect(icon.getAttribute("height")).toBe("24");
    expect(icon.classList.contains("qt-icon")).toBe(true);
    expect(icon.classList.contains("qt-qb-collapse-caret")).toBe(true);
  });

  it("uses fill intentionally for saved stars and drag dots, not line icons", () => {
    expect(renderIcon("star", { filled: true }).getAttribute("fill")).toBe("currentColor");
    expect(renderIcon("close", { filled: true }).getAttribute("fill")).toBe("none");
    const grip = renderIcon("grip");
    expect(grip.querySelectorAll("circle")).toHaveLength(6);
    expect(grip.querySelector("g")!.getAttribute("stroke")).toBe("none");
  });

  it("keeps boolean cell indicators accessible without a Unicode checkmark", () => {
    const result = defaultRenderers.bool_check!({ value: true } as never);
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement("div", null, result));
    expect(container.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("True");
    expect(container.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(container.textContent).toBe("");
  });
});
