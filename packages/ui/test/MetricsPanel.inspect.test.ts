// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricCard } from "../src/MetricsPanel";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";
import type { FieldDef } from "@pythia-software/query-table-core";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fields: FieldDef<unknown>[] = [
  { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
  { name: "a", label: "A", type: "text", source: { kind: "backend" } },
  { name: "b", label: "B", type: "text", source: { kind: "backend" } },
  { name: "c", label: "C", type: "text", source: { kind: "backend" } },
];
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  vi.unstubAllGlobals();
});
async function mount(clause: RenderingClause, buckets: MetricBucket[], onInspect?: (bucket: MetricBucket, clause: RenderingClause) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(createElement(MetricCard, { clause, buckets, fields, ...(onInspect ? { onInspect } : {}) })),
  );
  return [...container.querySelectorAll<HTMLElement>("[role=button]")];
}
const press = (element: Element, key: string) =>
  act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const click = (element: Element) => act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("MetricCard onInspect", () => {
  it("fires from list rows by click, Enter and Space", async () => {
    const onInspect = vi.fn();
    const clause: RenderingClause = { id: "list", op: "count", groupBy: ["a"], display: { kind: "list" } };
    const buckets = [{ keys: ["x"], value: 2, count: 2 }, { keys: [null], value: 1, count: 1 }];
    const [first, second] = await mount(clause, buckets, onInspect);
    expect(first!.className).toContain("qt-metric-bar-row");
    expect(first!.tabIndex).toBe(0);
    click(first!);
    press(second!, "Enter");
    press(second!, " ");
    expect(onInspect.mock.calls).toEqual([[buckets[0], clause], [buckets[1], clause], [buckets[1], clause]]);
  });

  it("does not make the synthetic Other row inspectable", async () => {
    const onInspect = vi.fn();
    const clause: RenderingClause = { id: "list", op: "count", groupBy: ["a"], display: { kind: "list", maxGroups: 1, showOther: true } };
    const buttons = await mount(clause, [{ keys: ["x"], value: 2, count: 2 }, { keys: ["y"], value: 1, count: 1 }], onInspect);
    expect(container!.textContent).toContain("Other");
    expect(buttons).toHaveLength(1);
  });

  it("fires from value cards, pivot cells and flat table rows", async () => {
    const onInspect = vi.fn();
    const total = { keys: [], value: 9, count: 9 };
    click((await mount({ id: "v", op: "count", groupBy: [] }, [total], onInspect))[0]!);
    expect(onInspect).toHaveBeenLastCalledWith(total, expect.objectContaining({ id: "v" }));
    act(() => root!.unmount());

    const cell = { keys: ["x", "y"], value: 3, count: 3 };
    const pivot = await mount({ id: "p", op: "count", groupBy: ["a", "b"], display: { kind: "table" } }, [cell, { keys: ["z", "y"], value: 1, count: 1 }], onInspect);
    expect(pivot).toHaveLength(2);
    expect(pivot[0]!.closest("td")).not.toBeNull();
    press(pivot[0]!, "Enter");
    expect(onInspect).toHaveBeenLastCalledWith(cell, expect.objectContaining({ id: "p" }));
    act(() => root!.unmount());

    const row = { keys: ["x", "y", "z"], value: 4, count: 4 };
    const flat = await mount({ id: "f", op: "count", groupBy: ["a", "b", "c"] }, [row], onInspect);
    click(flat[0]!);
    expect(onInspect).toHaveBeenLastCalledWith(row, expect.objectContaining({ id: "f" }));
  });

  it("passes histogram bin bounds and box cohorts", async () => {
    const onInspect = vi.fn();
    const histogram: RenderingClause = {
      id: "h",
      op: "count",
      groupBy: [],
      display: { kind: "histogram" },
      distribution: { kind: "histogram", input: "[amount]", bins: 2 },
    };
    const cohort: MetricBucket = { keys: [], value: 3, count: 3, distribution: { kind: "histogram", edges: [0, 5, 10], counts: [1, 2], n: 3 } };
    const bins = await mount(histogram, [cohort], onInspect);
    expect(bins).toHaveLength(2);
    click(bins[0]!);
    click(bins[1]!);
    expect(onInspect.mock.calls.map(([bucket]) => bucket)).toEqual([
      { keys: [], value: 1, count: 1, bin: { min: 0, max: 5, inclusiveMax: false } },
      { keys: [], value: 2, count: 2, bin: { min: 5, max: 10, inclusiveMax: true } },
    ]);
    act(() => root!.unmount());

    onInspect.mockClear();
    const summary = { n: 3, min: 1, q1: 2, median: 3, q3: 4, max: 5, mean: 3, low: 1, high: 5, outliers: [], outlierCount: 0, whiskers: "minmax" as const, method: "exact-linear" as const };
    const box: MetricBucket = { keys: ["x"], value: 3, count: 3, distribution: { kind: "box", summary } };
    const marks = await mount({ id: "b", op: "count", groupBy: ["a"], display: { kind: "box" }, distribution: { kind: "box", input: "[amount]" } }, [box], onInspect);
    click(marks[0]!);
    expect(onInspect).toHaveBeenCalledWith(box, expect.objectContaining({ id: "b" }));
  });

  it("changes nothing without onInspect", async () => {
    const buttons = await mount({ id: "list", op: "count", groupBy: ["a"], display: { kind: "list" } }, [{ keys: ["x"], value: 2, count: 2 }]);
    expect(buttons).toHaveLength(0);
    expect(container!.querySelector(".qt-metric-inspectable")).toBeNull();
    expect(container!.querySelector("[tabindex]")).toBeNull();
  });
});
