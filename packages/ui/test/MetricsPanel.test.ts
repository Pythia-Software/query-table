// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricCard } from "../src/MetricsPanel";
import { defaultRenderers } from "../src/renderers";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";
import type { FieldDef } from "@pythia-software/query-table-core";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const clause: RenderingClause = {
  id: "m",
  op: "sum",
  field: "duration",
  groupBy: ["group"],
};
const fields: FieldDef<unknown>[] = [
  {
    name: "duration",
    label: "Duration",
    type: "number",
    source: { kind: "backend" },
    render: "duration_ms",
  },
  { name: "group", label: "Group", type: "text", source: { kind: "backend" } },
];
const buckets: MetricBucket[] = [
  { keys: ["first / full group"], value: -2, count: 5 },
  { keys: ["second"], value: 3, count: 7 },
];
const render = (c: RenderingClause = clause, b: MetricBucket[] = buckets) =>
  renderToStaticMarkup(
    createElement(MetricCard, {
      clause: c,
      buckets: b,
      fields,
      renderers: defaultRenderers,
    }),
  );
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});
describe("shared metric card", () => {
  it("draws constant-value histogram bars with visible widths and usable hover targets", () => {
    const markup = render({ ...clause, display: { kind: "histogram" } }, [
      {
        keys: ["a"],
        count: 3,
        value: null,
        distribution: { kind: "histogram", edges: [5, 5], counts: [3], n: 3 },
      },
      {
        keys: ["b"],
        count: 2,
        value: null,
        distribution: { kind: "histogram", edges: [5, 5], counts: [2], n: 2 },
      },
    ]);
    const host = document.createElement("div");
    host.innerHTML = markup;
    const bars = [...host.querySelectorAll("svg rect")].filter(
      (r) =>
        r.hasAttribute("fill") &&
        r.getAttribute("fill") !== "transparent" &&
        r.hasAttribute("x"),
    );
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(Number(bar.getAttribute("width"))).toBeGreaterThan(10);
      expect(
        Number(bar.nextElementSibling?.getAttribute("width")),
      ).toBeGreaterThan(10);
    }
    expect(markup).toContain("3 rows · 3 numeric samples");
  });
  it("preserves legacy counts and unit renderers", () => {
    const b = [{ keys: [], value: 1200, count: 17 }];
    expect(render({ ...clause, op: "count", groupBy: [] }, b)).toContain(
      "1,200",
    );
    expect(render({ ...clause, groupBy: [] }, b)).toContain("1.2s");
    expect(render({ ...clause, groupBy: [] }, b)).toContain("17 rows");
  });
  it("keeps typed pivot coordinates distinct and supports swap", () => {
    const b = [
      { keys: [1, "x"], value: 11, count: 1 },
      { keys: ["1", "x"], value: 22, count: 1 },
      { keys: [null, "x"], value: 33, count: 1 },
      { keys: ["∅", "x"], value: 44, count: 1 },
    ];
    const html = render(
      {
        ...clause,
        groupBy: ["group", "other"],
        display: { kind: "table", pivot: { swap: true } },
      },
      b,
    );
    expect(html.match(/class="qt-metric-pivot-col"/g)).toHaveLength(4);
    for (const v of [11, 22, 33, 44]) expect(html).toContain(`>${v}ms<`);
  });
  it("renders signed bars, all legend placements and escaped raw data", () => {
    for (const kind of ["bar-horizontal", "bar-vertical"] as const)
      for (const legendPosition of [
        "left",
        "right",
        "top",
        "bottom",
        "none",
      ] as const) {
        const html = render({ ...clause, display: { kind, legendPosition } });
        expect(html).toContain(`qt-metric-legend-${legendPosition}`);
        expect(html).not.toContain("View data");
        expect(html).not.toContain("NaN");
      }
    expect(
      render({
        ...clause,
        display: { kind: "list", list: { showBars: false, showValues: false } },
      }),
    ).not.toContain("qt-metric-bar-track");
    expect(
      render({ ...clause, display: { kind: "bar-horizontal" } }, [
        { keys: ["<img src=x>"], value: 1, count: 1 },
      ]),
    ).toContain("&lt;img src=x&gt;");
  });
  it("draws a chronological path with a gap and paired scatter formats", () => {
    const html = render({ ...clause, display: { kind: "line" } }, [
      { keys: ["2026-10-08"], value: 2, count: 1 },
      { keys: ["2026-10-01"], value: 1, count: 1 },
      { keys: ["2026-10-03"], value: null, count: 1 },
    ]);
    const path = html.match(/<path[^>]* d="([^"]+)"/)?.[1];
    expect(path?.match(/M/g)).toHaveLength(2);
    expect(path).not.toContain("L");
    const scatter = render(
      {
        ...clause,
        display: {
          kind: "scatter",
          xFormat: { kind: "duration" },
          yFormat: { kind: "percent", decimals: 1 },
        },
      },
      [{ keys: ["pair"], value: 1200, y: 0.25, count: 4 }],
    );
    expect(scatter).toContain("1.2s / 25.0%");
  });
  it("retains box statistics, histogram zero bins and count formats", () => {
    const box = render({ ...clause, display: { kind: "box" } }, [
      {
        keys: ["box"],
        value: 2,
        count: 5,
        nullCount: 1,
        distribution: {
          kind: "box",
          summary: {
            n: 4,
            min: 1,
            q1: 2,
            median: 2,
            q3: 3,
            max: 4,
            mean: 2.5,
            low: 1,
            high: 4,
            outliers: [],
            outlierCount: 0,
            whiskers: "minmax",
            method: "exact-linear",
          },
        },
      },
    ]);
    expect(box).toContain("Whiskers 1 – 4");
    expect(box).toContain("4 samples · 1 NULL");
    const histogram = render(
      {
        ...clause,
        display: { kind: "histogram", xFormat: { kind: "duration" } },
      },
      [
        {
          keys: ["hist"],
          value: 3,
          count: 3,
          distribution: {
            kind: "histogram",
            edges: [0, 1000, 2000],
            counts: [0, 3],
            n: 3,
          },
        },
      ],
    );
    expect(histogram).toContain("0 rows · 3 numeric samples");
    expect(histogram).toContain("final upper bound included");
    expect(histogram).toContain("1s");
  });
  it("updates geometry with ResizeObserver and shows immediate keyboard/mouse tooltips", async () => {
    let resize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          resize = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const inspect = vi.fn();
    await act(async () =>
      root!.render(
        createElement(MetricCard, {
          clause: { ...clause, display: { kind: "bar-horizontal" } },
          buckets,
          fields,
          onInspect: inspect,
        }),
      ),
    );
    act(() =>
      resize?.(
        [{ contentRect: { width: 600, height: 300 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 600 300",
    );
    const mark = container.querySelector<SVGGElement>(".qt-metric-mark")!;
    act(() => mark.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(
      "first / full group",
    );
    act(() =>
      mark.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(inspect).toHaveBeenCalledWith(
      buckets[0],
      expect.objectContaining({ id: "m" }),
    );
    act(() =>
      mark.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(() =>
      mark.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => root!.unmount());
    root = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

it("renders separate line series and zero magnitude for NULL list outputs", () => {
  const markup = render(
    { ...clause, display: { kind: "line" }, groupBy: ["time", "region"] },
    [
      { keys: [1, "A"], value: 1, count: 1 },
      { keys: [1, "B"], value: 100, count: 1 },
      { keys: [2, "A"], value: 2, count: 1 },
      { keys: [2, "B"], value: 200, count: 1 },
    ],
  );
  const host = document.createElement("div");
  host.innerHTML = markup;
  expect(host.querySelectorAll('path[stroke-width="2"]')).toHaveLength(2);
  const list = render({ ...clause, display: { kind: "list" } }, [
    { keys: ["missing"], value: null, count: 100 },
    { keys: ["real"], value: 10, count: 1 },
  ]);
  host.innerHTML = list;
  expect(
    host.querySelector<HTMLElement>(".qt-metric-bar-fill")!.style.width,
  ).toBe("0%");
});
it("discloses server group truncation in every card", () => {
  const html = renderToStaticMarkup(
    createElement(MetricCard, {
      clause,
      buckets: [buckets[0]!],
      result: { buckets: [buckets[0]!], groupCount: 100 },
      fields,
    }),
  );
  expect(html).toContain("1 of 100 groups returned");
});

describe("review regressions", () => {
  it("rejects grouped Value and unexpected scalar buckets without choosing the first", () => {
    for (const c of [
      { ...clause, display: { kind: "value" as const } },
      { ...clause, groupBy: [], display: { kind: "value" as const } },
      { ...clause, groupBy: [] },
    ]) {
      const html = render(c);
      expect(html).toContain("Value display requires");
      expect(html).not.toContain('class="qt-metric-big"');
      expect(html).not.toContain("View data");
    }
  });
  it("suppresses magnitude bars for signed lists even when values are hidden", () => {
    const html = render({
      ...clause,
      display: { kind: "list", list: { showValues: false } },
    });
    expect(html).not.toContain("qt-metric-bar-track");
    expect(html).toContain("first / full group");
    expect(
      render({ ...clause, display: { kind: "list" } }, [
        { keys: ["positive"], value: 3, count: 1 },
      ]),
    ).toContain("width:100%");
  });
  it("preserves actual minimum width", () => {
    expect(
      render({
        ...clause,
        layout: {
          widthRem: 30,
          heightRem: 12,
          minWidthRem: 30,
          minHeightRem: 8,
        },
      }),
    ).toContain("min-width:30rem");
  });
  it("visibly discloses omissions while leaving ordinary chart captions compact", () => {
    const host = document.createElement("div");
    host.innerHTML = render({ ...clause, display: { kind: "scatter" } }, [
      { keys: ["ok"], value: 1, y: 2, count: 1 },
      {
        keys: ["bad"],
        value: 2,
        y: null,
        yError: "Division by zero",
        count: 1,
      },
    ]);
    expect(
      host.querySelector(".qt-metric-note:not(.qt-sr-only)")?.textContent,
    ).toContain("1 missing/error pairs");
    host.innerHTML = render(
      { ...clause, display: { kind: "bar-horizontal" } },
      Array.from({ length: 20 }, (_, i) => ({ keys: [i], value: i, count: 1 })),
    );
    expect(
      host.querySelector(".qt-metric-note:not(.qt-sr-only)")?.textContent,
    ).toContain("of 20 returned groups drawn");
    host.innerHTML = render({ ...clause, display: { kind: "scatter" } }, [
      { keys: ["ok"], value: 1, y: 2, count: 1 },
    ]);
    expect(host.querySelector(".qt-metric-note:not(.qt-sr-only)")).toBeNull();
  });
  it("uses the histogram X format for ticks, tooltips and data intervals while frequencies remain counts", () => {
    const html = render(
      {
        ...clause,
        display: {
          kind: "histogram",
          xFormat: {
            kind: "duration",
            sourceUnit: "milliseconds",
            style: "human",
          },
        },
      },
      [
        {
          keys: ["a"],
          value: 2,
          count: 2,
          distribution: {
            kind: "histogram",
            edges: [0, 1000, 2000],
            counts: [1, 1],
            n: 2,
          },
        },
      ],
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("svg")?.textContent).toContain("1s");
    expect(
      host.querySelector(".qt-metric-mark")?.getAttribute("aria-label"),
    ).toContain("0ms ≤ value < 1s");
    const labels = Array.from(host.querySelectorAll(".qt-metric-mark")).map(
      (mark) => mark.getAttribute("aria-label"),
    );
    expect(
      labels.some(
        (label) =>
          label?.includes("1s ≤ value ≤ 2s") && label.includes("1 rows"),
      ),
    ).toBe(true);
    expect(host.querySelector(".qt-metric-data")).toBeNull();
  });
  it("contains malformed distribution results to their card, including collapsed data", () => {
    for (const distribution of [
      {
        kind: "box",
        summary: {
          n: 4,
          min: 1,
          q1: 1,
          median: 2,
          q3: 3,
          max: 4,
          mean: 2.5,
          low: 1,
          high: 4,
          outlierCount: 0,
          method: "exact-linear",
          whiskers: "minmax",
        },
      },
      { kind: "box", summary: [] },
      { kind: "histogram", edges: [0, 1], n: 1 },
      { kind: "histogram", edges: [0, NaN], counts: [1], n: 1 },
      { kind: "histogram", edges: [0, 1], counts: [2], n: 1 },
      { kind: "unknown" },
      null,
    ]) {
      for (const kind of ["box", "histogram", "table"] as const) {
        const html = render({ ...clause, display: { kind } }, [
          {
            keys: [],
            value: 2,
            count: 4,
            distribution,
          } as unknown as MetricBucket,
        ]);
        expect(html).toContain("Invalid distribution result");
        expect(html).not.toContain("View data");
      }
    }
    expect(
      render({ ...clause, display: { kind: "box" } }, [
        {
          keys: [],
          value: null,
          count: 0,
          distribution: { kind: "box", summary: null },
        },
      ]),
    ).not.toContain("Invalid distribution");
    expect(
      render({ ...clause, display: { kind: "histogram" } }, [
        {
          keys: [],
          value: null,
          count: 0,
          distribution: { kind: "histogram", edges: [], counts: [], n: 0 },
        },
      ]),
    ).not.toContain("Invalid distribution");
  });
});

it("renders positive log axes across charts and omits invalid coordinates", () => {
  for (const kind of [
    "bar-horizontal",
    "bar-vertical",
    "scatter",
    "line",
  ] as const) {
    const html = render(
      {
        ...clause,
        display: { kind, xScale: { mode: "log" }, yScale: { mode: "log" } },
      },
      [
        { keys: [1], value: 1, y: 1, count: 1 },
        { keys: [10], value: 10, y: 10, count: 1 },
        { keys: [100], value: 100, y: 100, count: 1 },
        { keys: [200], value: 0, y: -1, count: 1 },
      ],
    );
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain("nonpositive values omitted");
    expect(html).toContain("clipPath");
  }
});
it("offers quick editing only when authorized by the host", () => {
  const onEdit = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const editorRoot = createRoot(host);
  act(() =>
    editorRoot.render(
      createElement(MetricCard, { clause, buckets, fields, onEdit }),
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>(".qt-metric-edit")!.click());
  expect(onEdit).toHaveBeenCalledOnce();
  act(() => editorRoot.unmount());
  host.remove();
  expect(render()).not.toContain("qt-metric-edit");
});

it("applies configured decimals to pie and ring values and shares", () => {
  for (const kind of ["pie", "donut"] as const) {
    const html = render(
      { ...clause, display: { kind, format: { kind: "number", decimals: 3 } } },
      [
        { keys: ["one"], value: 1, count: 1 },
        { keys: ["three"], value: 3, count: 3 },
      ],
    );
    expect(html).toContain("1.000 (25.000% of 4.000)");
    expect(html).toContain("one · 1.000 · 25.000%");
    const integers = render(
      { ...clause, display: { kind, format: { kind: "number", decimals: 0 } } },
      [
        { keys: ["one"], value: 1, count: 1 },
        { keys: ["two"], value: 2, count: 2 },
      ],
    );
    expect(integers).toContain("1 (33% of 3)");
  }
});

it("formats scatter and histogram axes independently of a retained main-value format", () => {
  const host = document.createElement("div");
  host.innerHTML = render(
    { ...clause, display: { kind: "scatter", format: { kind: "percent" } } },
    [{ keys: ["Linux"], value: 10, y: 42, count: 42 }],
  );
  const dot = host.querySelector(".qt-metric-mark")!;
  expect(dot.getAttribute("aria-label")).toContain("10 / 42");
  expect(host.querySelector("svg")?.textContent).not.toContain("%");
  host.innerHTML = render(
    { ...clause, display: { kind: "histogram", format: { kind: "percent" } } },
    [
      {
        keys: ["Linux"],
        value: 2,
        count: 2,
        distribution: {
          kind: "histogram",
          edges: [0, 1, 2],
          counts: [1, 1],
          n: 2,
        },
      },
    ],
  );
  expect(
    host.querySelector(".qt-metric-mark")?.getAttribute("aria-label"),
  ).toContain("0 ≤ value < 1");
  expect(host.querySelector("svg")?.textContent).not.toContain("%");
});

it("lets Escape bubble after dismissing a chart tooltip and never inspects a synthetic Other slice", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onInspect = vi.fn(),
    onKeyDown = vi.fn();
  await act(async () =>
    root!.render(
      createElement(
        "div",
        { onKeyDown },
        createElement(MetricCard, {
          clause: { ...clause, display: { kind: "pie" } },
          buckets: Array.from({ length: 10 }, (_, i) => ({
            keys: [i === 9 ? "Other" : `g${i}`],
            value: 10 - i,
            count: 1,
          })),
          fields,
          renderers: defaultRenderers,
          onInspect,
        }),
      ),
    ),
  );
  const other = [
    ...container.querySelectorAll<SVGGElement>(".qt-metric-mark"),
  ].find((m) =>
    m.getAttribute("aria-label")?.startsWith("Other (combined remainder)"),
  )!;
  expect(other).toBeDefined();
  act(() => other.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onInspect).not.toHaveBeenCalled();
  expect(other.getAttribute("role")).toBe("img");
  const mark = container.querySelector<SVGGElement>(".qt-metric-mark")!;
  act(() => mark.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  const first = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => mark.dispatchEvent(first));
  expect(first.defaultPrevented).toBe(true);
  expect(onKeyDown).not.toHaveBeenCalled();
  const second = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => mark.dispatchEvent(second));
  expect(second.defaultPrevented).toBe(false);
  expect(onKeyDown).toHaveBeenCalledOnce();
});
