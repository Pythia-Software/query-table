// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricChart } from "../src/MetricChart";
import { nearestMetricPoint, type MetricPoint } from "../src/MetricPointLayer";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
// One series stays near zero; the other peaks once and is padded with zeros.
const buckets: MetricBucket[] = [
  ...days.map((day, i) => ({ keys: [day, "Read"], value: [3, 4, 3][i]!, count: 1 })),
  ...days.map((day, i) => ({ keys: [day, "Bash"], value: [0, 120, 0][i]!, count: 1 })),
];
const lineClause: RenderingClause = { id: "calls", op: "sum", field: "n", groupBy: ["day", "tool"], display: { kind: "line" } };

async function mount(clause: RenderingClause, data: MetricBucket[], onInspect: (b: MetricBucket) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(MetricChart, { clause, buckets: data, onInspect })));
  const svg = container.querySelector("svg")!;
  // The default 400×220 plot, drawn at its own size.
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 220, right: 400, bottom: 220, x: 0, y: 0, toJSON() {} });
  return svg;
}
const marks = () => [...container!.querySelectorAll<SVGGElement>(".qt-metric-mark")];
const centre = (mark: SVGGElement) => {
  const circle = mark.querySelector("circle")!;
  return { clientX: Number(circle.getAttribute("cx")), clientY: Number(circle.getAttribute("cy")) };
};
const layer = () => container!.querySelector<SVGRectElement>(".qt-metric-point-layer rect")!;
const click = (at: { clientX: number; clientY: number }) =>
  act(() => layer().dispatchEvent(new MouseEvent("click", { bubbles: true, ...at })));

describe("nearest-point picking", () => {
  it("picks the nearest point and breaks exact ties toward the one drawn on top", () => {
    const point = (x: number, y: number, n: number): MetricPoint => ({ x, y, label: String(n), color: "red", bucket: { keys: [n], value: n, count: 1 } });
    const points = [point(10, 10, 0), point(10, 12, 1), point(10, 10, 2)];
    expect(nearestMetricPoint(points, 10, 12.4)).toBe(1);
    expect(nearestMetricPoint(points, 10, 10)).toBe(2);
    expect(nearestMetricPoint(points, 10, 40)).toBe(-1);
  });

  it("activates the visible low point beneath a padded zero of another series", async () => {
    const onInspect = vi.fn();
    await mount(lineClause, buckets, onInspect);
    const read = marks().find((m) => m.getAttribute("aria-label")!.startsWith("2026-10-03 / Read"))!;
    const bashZero = marks().find((m) => m.getAttribute("aria-label")!.startsWith("2026-10-03 / Bash"))!;
    // The two marks sit within each other's former 12px hit circles.
    expect(Math.abs(centre(read).clientY - centre(bashZero).clientY)).toBeLessThan(12);
    click(centre(read));
    click(centre(bashZero));
    expect(onInspect.mock.calls.map(([b]) => b.keys)).toEqual([["2026-10-03", "Read"], ["2026-10-03", "Bash"]]);
    // Marks no longer take the pointer themselves.
    expect(read.getAttribute("pointer-events")).toBe("none");
  });

  it("keeps keyboard activation and exact bucket identity", async () => {
    const onInspect = vi.fn();
    await mount(lineClause, buckets, onInspect);
    const peak = marks().find((m) => m.getAttribute("aria-label")!.startsWith("2026-10-02 / Bash"))!;
    expect(peak.tabIndex).toBe(0);
    act(() => peak.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onInspect).toHaveBeenCalledWith(buckets[4]);
  });

  it("ignores clicks away from every point and skips missing values", async () => {
    const onInspect = vi.fn();
    const gappy = buckets.map((b, i) => (i === 1 ? { ...b, value: null } : b));
    await mount(lineClause, gappy, onInspect);
    expect(marks()).toHaveLength(5);
    click({ clientX: 5, clientY: 5 });
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("resolves scatter points with negative coordinates", async () => {
    const onInspect = vi.fn();
    const pairs: MetricBucket[] = [
      { keys: ["a", "x"], value: -5, y: -5, count: 1 },
      { keys: ["a", "y"], value: -4.9, y: -5, count: 1 },
      { keys: ["b", "z"], value: 5, y: 5, count: 1 },
    ];
    await mount({ id: "s", op: "count", groupBy: ["series", "point"], display: { kind: "scatter" } }, pairs, onInspect);
    for (const mark of marks()) click(centre(mark));
    expect(onInspect.mock.calls.map(([b]) => b)).toEqual(pairs);
  });
});
