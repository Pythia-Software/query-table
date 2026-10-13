import { useMetricResize } from "./useMetricResize";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

export interface EditorPaneSize {
  width: number;
  minWidth: number;
  /** Initial/reset visibility. Updated defaults take effect on the next reset. */
  defaultVisible?: boolean;
}

/** Workbench geometry is deliberately independent of query and metric state. */
function fitPanes(
  previous: number[],
  available: number,
  visible: boolean[],
  minimums: number[],
): number[] {
  const total = Math.max(
    minimums.reduce((sum, width, i) => sum + (visible[i] ? width : 0), 0),
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
        (visible[index] ? Math.max(minimums[index] ?? 0, width * scale) : 0),
      0,
    );
    if (sum > total) high = scale;
    else low = scale;
  }
  return previous.map((width, index) =>
    visible[index] ? Math.max(minimums[index] ?? 0, width * low) : 0,
  );
}

export function useEditorWorkbench(
  panes: readonly EditorPaneSize[],
  isEditor = true,
) {
  const defaults = panes.map((p) => p.width);
  const minimums = panes.map((p) => p.minWidth);
  function initialPanes(available: number, visible: boolean[]) {
    const last = visible.lastIndexOf(true);
    return defaults.map((width, i) =>
      i === last
        ? Math.max(
            minimums[i]!,
            available -
              defaults.reduce(
                (sum, width, index) =>
                  sum + (visible[index] && index !== last ? width : 0),
                0,
              ),
          )
        : width,
    );
  }
  const header = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [preferredWidths, setWidths] = useState<number[]>(defaults);
  const [visiblePanes, setVisiblePanes] = useState(
    panes.map((p) => p.defaultVisible !== false),
  );
  const [available, setAvailable] = useState(
    defaults.reduce((a, b) => a + b, 0),
  );
  const drag = useMetricResize();
  const initialized = useRef(false);
  const visibleIndices = visiblePanes.flatMap((visible, i) =>
    visible ? [i] : [],
  );
  const widths = fitPanes(preferredWidths, available, visiblePanes, minimums);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !isEditor) return;
    const fit = () => {
      if (!element.clientWidth) return;
      const space = element.clientWidth - (visibleIndices.length - 1) * 6;
      setAvailable(space);
      if (!initialized.current) {
        initialized.current = true;
        setWidths(initialPanes(space, visiblePanes));
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEditor, visibleIndices.length]);
  const resetPanes = (visibility = visiblePanes) => {
    drag.stop();
    const containerWidth =
      root.current?.clientWidth ??
      header.current?.closest<HTMLElement>("[role=dialog]")?.clientWidth ??
      available + (panes.length - 1) * 6;
    const space = containerWidth - (visibility.filter(Boolean).length - 1) * 6;
    setAvailable(space);
    setWidths(initialPanes(space, visibility));
  };
  const nextPane = (index: number) => visibleIndices.find((i) => i > index);
  const resize = (index: number, delta: number, initial: number[]) => {
    const next = nextPane(index);
    if (next === undefined) return;
    const left = initial[index]!,
      right = initial[next]!;
    const move = Math.max(
      minimums[index]! - left,
      Math.min(delta, right - minimums[next]!),
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
    minWidths: minimums,
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
    hidePane: (index: number) => {
      drag.stop();
      setVisiblePanes((previous) =>
        !previous[index] || previous.filter(Boolean).length === 1
          ? previous
          : previous.map((visible, i) => (i === index ? false : visible)),
      );
    },
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
      const visibility = panes.map((pane) => pane.defaultVisible !== false);
      setVisiblePanes(visibility);
      resetPanes(visibility);
    },
  };
}
