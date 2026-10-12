// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModalSurface } from "../src/AdaptiveOverlay";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps resize/drag gestures open and dismisses a full outside click", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const close = vi.fn();
  try {
    await act(async () => root.render(createElement(ModalSurface, { title: "Details", onClose: close })));
    const backdrop = container.querySelector<HTMLElement>(".qt-modal-backdrop")!;
    const surface = container.querySelector<HTMLElement>(".qt-modal-surface")!;
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.click();
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.click();
    });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
