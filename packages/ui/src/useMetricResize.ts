import { useEffect, useRef, type PointerEvent } from "react";

/** Shared pointer lifecycle for authoring geometry. Escape cancels only the drag. */
export function useMetricResize() {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return {
    stop: () => cleanup.current?.(),
    start: (
      event: PointerEvent<HTMLElement>,
      update: (dx: number, dy: number) => void,
      restore: () => void,
    ) => {
      if (event.button !== 0) return;
      cleanup.current?.();
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      handle.focus({ preventScroll: true });
      handle.setPointerCapture?.(event.pointerId);
      const { clientX: x, clientY: y, pointerId } = event;
      const previousCursor = document.body.style.cursor;
      const previousSelection = ["user-select", "-webkit-user-select"].map(
        (name) => ({
          name,
          value: document.body.style.getPropertyValue(name),
          priority: document.body.style.getPropertyPriority(name),
        }),
      );
      document.body.style.cursor = getComputedStyle(handle).cursor;
      previousSelection.forEach(({ name }) =>
        document.body.style.setProperty(name, "none"),
      );
      let moved = false;
      const move = (e: globalThis.PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        moved ||= e.clientX !== x || e.clientY !== y;
        if (moved) update(e.clientX - x, e.clientY - y);
      };
      const cancel = () => {
        restore();
        cleanup.current?.();
      };
      const end = (e: globalThis.PointerEvent) => {
        if (e.pointerId === pointerId) {
          if (moved || e.clientX !== x || e.clientY !== y)
            update(e.clientX - x, e.clientY - y);
          cleanup.current?.();
        }
      };
      const cancelled = (e: globalThis.PointerEvent) => {
        if (e.pointerId === pointerId) cancel();
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      };
      const blur = () => cancel();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", cancelled);
      window.addEventListener("keydown", key, true);
      window.addEventListener("blur", blur);
      cleanup.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", cancelled);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", blur);
        if (handle.hasPointerCapture?.(pointerId))
          handle.releasePointerCapture(pointerId);
        document.body.style.cursor = previousCursor;
        previousSelection.forEach(({ name, value, priority }) =>
          document.body.style.setProperty(name, value, priority),
        );
        cleanup.current = null;
      };
    },
  };
}
