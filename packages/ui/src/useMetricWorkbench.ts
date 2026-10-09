import { useMetricResize } from "./useMetricResize";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

const DEFAULT_PANES = [240, 390, 250, 460] as const;
const MIN_PANES = [180, 300, 200, 280] as const;

/** Workbench geometry is deliberately independent of query and metric state. */
function initialPanes(available: number): number[] {
  return [240, 390, 250, Math.max(280, available - 880)];
}
function fitPanes(
  previous: number[],
  available: number,
  visible: boolean[],
): number[] {
  const total = Math.max(
    MIN_PANES.reduce((sum, width, i) => sum + (visible[i] ? width : 0), 0),
    available,
  );
  const shown = previous.map((width, i) => (visible[i] ? width : 0));
  if (Math.abs(shown.reduce((sum, width) => sum + width, 0) - total) < 0.5)
    return shown;
  let low = 0,
    high = Math.max(
      2,
      (total / shown.reduce((sum, width) => sum + width, 0)) * 2,
    );
  for (let i = 0; i < 40; i++) {
    const scale = (low + high) / 2;
    const sum = previous.reduce(
      (sum, width, index) =>
        sum +
        (visible[index] ? Math.max(MIN_PANES[index] ?? 0, width * scale) : 0),
      0,
    );
    if (sum > total) high = scale;
    else low = scale;
  }
  return previous.map((width, index) =>
    visible[index] ? Math.max(MIN_PANES[index] ?? 0, width * low) : 0,
  );
}

export function useMetricWorkbench(isEditor = true) {
  const header = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [preferredWidths, setWidths] = useState<number[]>([...DEFAULT_PANES]);
  const [visiblePanes, setVisiblePanes] = useState([true, true, true, true]);
  const [available, setAvailable] = useState(1340);
  const drag = useMetricResize();
  const initialized = useRef(false);
  const visibleIndices = visiblePanes.flatMap((visible, i) =>
    visible ? [i] : [],
  );
  const widths = fitPanes(preferredWidths, available, visiblePanes);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !isEditor) return;
    const fit = () => {
      if (!element.clientWidth) return;
      const space = element.clientWidth - (visibleIndices.length - 1) * 6;
      setAvailable(space);
      if (!initialized.current) {
        initialized.current = true;
        setWidths(initialPanes(space));
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEditor, visibleIndices.length]);
  const resetPanes = (showAll = false) => {
    drag.stop();
    const containerWidth =
      root.current?.clientWidth ??
      header.current?.closest<HTMLElement>("[role=dialog]")?.clientWidth ??
      available + 18;
    setAvailable(
      containerWidth - ((showAll ? 4 : visibleIndices.length) - 1) * 6,
    );
    setWidths(initialPanes(containerWidth - 18));
  };
  const nextPane = (index: number) => visibleIndices.find((i) => i > index);
  const resize = (index: number, delta: number, initial: number[]) => {
    const next = nextPane(index);
    if (next === undefined) return;
    const left = initial[index]!,
      right = initial[next]!;
    const move = Math.max(
      MIN_PANES[index]! - left,
      Math.min(delta, right - MIN_PANES[next]!),
    );
    setWidths((previous) =>
      previous.map((width, i) =>
        i === index
          ? left + move
          : i === next
            ? right - move
            : visiblePanes[i]
              ? initial[i]!
              : width,
      ),
    );
  };
  const startResize = (event: PointerEvent<HTMLElement>, index: number) => {
    const initial = [...widths],
      original = [...preferredWidths];
    drag.start(
      event,
      (dx) => resize(index, dx, initial),
      () => setWidths(original),
    );
  };
  return {
    root,
    header,
    widths,
    minWidths: MIN_PANES,
    visiblePanes,
    visibleIndices,
    nextPane,
    togglePane: (index: number) => {
      drag.stop();
      setVisiblePanes((previous) =>
        previous.filter(Boolean).length === 1 && previous[index]
          ? previous
          : previous.map((visible, i) => (i === index ? !visible : visible)),
      );
    },
    showPane: (index: number) =>
      setVisiblePanes((previous) =>
        previous[index]
          ? previous
          : previous.map((visible, i) => (i === index ? true : visible)),
      ),
    startResize,
    resetPanes: () => resetPanes(),
    stepResize: (index: number, delta: number) => resize(index, delta, widths),
    reset: () => {
      drag.stop();
      const dialog = header.current?.closest<HTMLElement>("[role=dialog]");
      if (dialog) {
        dialog.style.removeProperty("width");
        dialog.style.removeProperty("height");
      }
      setVisiblePanes([true, true, true, true]);
      resetPanes(true);
    },
  };
}
