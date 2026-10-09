// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReorderList } from "../src/ReorderList";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("uses only direct item geometry when cards contain legend list items", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    onMove = vi.fn();
  act(() =>
    root.render(
      createElement(ReorderList, {
        items: ["a", "b", "c"].map((id) => ({ id, label: id })),
        layout: "wrap",
        onMove,
        renderItem: () =>
          createElement("ul", null, createElement("li", null, "legend")),
      }),
    ),
  );
  const rows = host.querySelectorAll<HTMLElement>("[data-reorder-id]");
  rows.forEach(
    (row, i) =>
      (row.getBoundingClientRect = () => ({
        x: 0,
        y: i * 100,
        top: i * 100,
        left: 0,
        right: 200,
        bottom: i * 100 + 90,
        width: 200,
        height: 90,
        toJSON() {},
      })),
  );
  const legends = host.querySelectorAll<HTMLElement>("ul li");
  legends.forEach(
    (row) =>
      (row.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {},
      }))),
  );
  const handle = rows[1]!.querySelector("button")!;
  handle.setPointerCapture = vi.fn();
  const pointer = (type: string, y: number) =>
    act(() =>
      handle.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 20,
          clientY: y,
        }),
      ),
    );
  pointer("pointerdown", 120);
  pointer("pointermove", 122);
  pointer("pointerup", 122);
  expect(onMove).not.toHaveBeenCalled();
  legends.forEach((row) =>
    expect(row.getBoundingClientRect).not.toHaveBeenCalled(),
  );
  pointer("pointerdown", 120);
  pointer("pointermove", 220);
  pointer("pointerup", 220);
  expect(onMove).toHaveBeenCalledWith("b", 2);
  act(() => root.unmount());
  host.remove();
});
