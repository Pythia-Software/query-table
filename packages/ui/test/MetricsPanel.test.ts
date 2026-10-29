// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricCard } from "../src/MetricsPanel";
import { defaultRenderers } from "../src/renderers";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";
import { boxSummary, type AggregationClause, type FieldDef } from "@pythia-software/query-table-core";
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
  it("shows a per-metric server error instead of an empty result", () => {
    const message =
      "MEDIAN exceeded the 100,000-sample budget for one or more groups";
    const html = renderToStaticMarkup(
      createElement(MetricCard, {
        clause,
        result: { buckets: [], error: message },
        fields,
        renderers: defaultRenderers,
      }),
    );
    expect(html).toContain(message);
    expect(html).toContain("qt-metrics-error");
    expect(html).not.toContain("no data");
  });
  it("formats explicitly calendar-grouped line and vertical bar axes without changing raw groups", () => {
    const dateBuckets: MetricBucket[] = [
      { keys: ["2026-10-01T00:00:00.000Z"], value: 0, count: 0 },
      { keys: ["2026-10-03T00:00:00.000Z"], value: 5, count: 5 },
    ];
    for (const kind of ["line", "bar-vertical"] as const) {
      const c: RenderingClause = {
        ...clause,
        dateGrouping: {
          field: "group",
          interval: "day",
          includeEmpty: false,
          range: "observed",
        },
        display: {
          kind,
          xFormat: {
            kind: "date",
            style: "custom",
            pattern: "MMM DD",
            timeZone: "UTC",
          },
        },
      };
      const html = render(c, dateBuckets);
      expect(html).toContain(">Oct 01</text>");
      expect(html).toContain(">Oct 03</text>");
      expect(html).toContain("2026-10-01 00:00 +00:00");
      // A raw label too wide for its bar's slot keeps its start and full title.
      expect(render({ ...clause, display: { kind } }, dateBuckets)).toMatch(
        kind === "line" ? />2026-10-01T00:00:00.000Z<\/text>/ : /<title>2026-10-01T00:00:00.000Z<\/title>2026-10-01T[^<]*…<\/text>/,
      );
    }
    expect(dateBuckets[0]!.keys[0]).toBe("2026-10-01T00:00:00.000Z");
  });
  it("keeps raw group labels after switching away from a scatter or histogram with a retained X format", () => {
    for (const previousKind of ["scatter", "histogram"] as const)
      for (const formatKind of ["duration", "date", "time"] as const) {
        const previous: RenderingClause = {
          ...clause,
          display: { kind: previousKind, xFormat: { kind: formatKind } },
        };
        const bars = render(
          {
            ...previous,
            display: { ...previous.display!, kind: "bar-vertical" },
          },
          [
            { keys: ["prod"], value: 1, count: 1 },
            { keys: ["staging"], value: 2, count: 2 },
          ],
        );
        expect(bars).toContain(">prod</text>");
        expect(bars).toContain(">staging</text>");
        expect(bars).not.toContain("Invalid format");
        // Line coordinates must still be chronological, but their raw keys
        // must not inherit the previous measure's X formatter either.
        const line = render(
          { ...previous, display: { ...previous.display!, kind: "line" } },
          [
            { keys: ["2026-10-01T00:00:00.000Z"], value: 1, count: 1 },
            { keys: ["2026-10-03T00:00:00.000Z"], value: 2, count: 2 },
          ],
        );
        expect(line).toContain(">2026-10-01T00:00:00.000Z</text>");
        expect(line).toContain(">2026-10-03T00:00:00.000Z</text>");
        expect(line).not.toContain("Invalid format");
      }
  });
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
    expect(box).toContain("Observed whiskers 1 – 4");
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

it("compact box covers share one axis and retain observed extremes and full summaries", () => {
  const boxes: MetricBucket[] = ["Fast command with a long descriptive label", "Slow command", "Third command"].map((key, i) => {
    const factor = 10 ** i;
    return { keys: [key], value: null, count: 10, nullCount: 1, distribution: { kind: "box", summary: {
      n: 9, min: 1000 * factor, q1: 3000 * factor, median: 5000 * factor, q3: 7000 * factor,
      max: 100000000 * factor, mean: 10000000 * factor, low: 1000 * factor, high: 9000 * factor,
      outliers: [100000000 * factor], outlierCount: 1, whiskers: "tukey", method: "exact-linear",
    } } };
  });
  const c: RenderingClause = { ...clause, display: { kind: "box", format: { kind: "duration", sourceUnit: "milliseconds" } } };
  const html = renderToStaticMarkup(createElement(MetricCard, { clause: c, buckets: boxes, fields, compact: true }));
  const host = document.createElement("div"); host.innerHTML = html;
  expect(host.querySelectorAll(".qt-metric-box-row")).toHaveLength(3);
  expect(host.querySelectorAll(".qt-metric-box-outlier")).toHaveLength(3);
  expect(host.querySelectorAll(".qt-metric-box-label title")[0]?.textContent).toBe(boxes[0]!.keys[0]);
  expect(host.querySelector(".qt-metric-compact-guide")?.textContent).toContain("Shared axis");
  const boxesDrawn = [...host.querySelectorAll(".qt-metric-box-quartiles")];
  expect(Number(boxesDrawn[1]!.getAttribute("width"))).toBeGreaterThanOrEqual(Number(boxesDrawn[0]!.getAttribute("width")));
  const outliers = [...host.querySelectorAll(".qt-metric-box-outlier")].map(mark => Number(mark.getAttribute("cx")));
  expect(outliers[0]).toBeLessThan(outliers[1]!);
  expect(outliers[1]).toBeLessThan(outliers[2]!);
  expect(host.querySelectorAll(".qt-metric-box-axis-tick")).toHaveLength(3);
  expect(html).toContain("9 samples · 1 NULL · 1 outliers");
  expect(html).toContain("Max 1d3h");
  expect(render(c, boxes)).toContain("Scale includes all returned summaries");
});

it("underline lists keep labels, values and bar proportions with independent visibility switches", () => {
  const b: MetricBucket[] = [{ keys: ["A long error signature with several meaningful words"], value: 10, count: 1 }, { keys: ["Second signature"], value: 5, count: 1 }];
  for (const showBars of [true, false]) for (const showValues of [true, false]) {
    const host = document.createElement("div");
    host.innerHTML = render({ ...clause, display: { kind: "list", list: { barPosition: "below", showBars, showValues } } }, b);
    expect(host.querySelectorAll(".qt-metric-bar-row--below")).toHaveLength(2);
    expect(host.querySelector(".qt-metric-bar-label")?.textContent).toBe(b[0]!.keys[0]);
    expect(host.querySelectorAll(".qt-metric-bar-track")).toHaveLength(showBars ? 2 : 0);
    expect(host.querySelectorAll(".qt-metric-bar-value")).toHaveLength(showValues ? 2 : 0);
    if (showBars) expect([...host.querySelectorAll<HTMLElement>(".qt-metric-bar-fill")].map(el => el.style.width)).toEqual(["100%", "50%"]);
  }
  expect(render({ ...clause, display: { kind: "list" } }, b)).not.toContain("qt-metric-bar-row--below");
});

it("limits only below-list labels while preserving the full label and title", () => {
  const text = "A very long error signature that wraps across several lines without losing its full tooltip";
  const buckets: MetricBucket[] = [{ keys: [text], value: 5, count: 1 }];
  for (const barPosition of ["inline", "below"] as const) {
    for (const maxLabelLines of [undefined, 1, 2, 3, 0, -1, 1.5, Infinity, 1000001]) {
      const host = document.createElement("div");
      host.innerHTML = render({ ...clause, display: { kind: "list", list: { barPosition, ...(maxLabelLines === undefined ? {} : { maxLabelLines }) } } }, buckets);
      const label = host.querySelector<HTMLElement>(".qt-metric-bar-label")!;
      const limited = barPosition === "below" && [1, 2, 3].includes(maxLabelLines!);
      expect(label.classList.contains("qt-metric-bar-label--clamped")).toBe(limited);
      expect(label.style.webkitLineClamp).toBe(limited ? String(maxLabelLines) : "");
      expect(label.textContent).toBe(text);
      expect(label.title).toBe(text);
    }
  }
});

it("compact charts put both axis labels in a footer while full charts retain their axis labels", () => {
  const c: RenderingClause = { ...clause, display: { kind: "scatter", xLabel: "Duration", yLabel: "Output" } };
  const b: MetricBucket[] = [{ keys: ["A"], value: 2, y: 3, count: 1 }];
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MetricCard, { clause: c, buckets: b, fields, compact: true }));
  expect(host.querySelector(".qt-metric-axis-labels")?.textContent).toBe("↑ Output→ Duration");
  expect(host.querySelectorAll("svg text[transform]")).toHaveLength(0);
  expect(host.querySelector("svg")?.textContent).not.toContain("Duration");
  expect(render(c, b)).toContain("rotate(-90)");
});

it("limits rendered list groups and exposes an accessible animated loading state", () => {
  const b: MetricBucket[] = [1, 2, 3].map(n => ({ keys: [String(n)], value: n, count: 1 }));
  for (const showOther of [true, false]) {
    const host = document.createElement("div");
    host.innerHTML = render({ ...clause, op: "count", display: { kind: "list", maxGroups: 2, showOther } }, b);
    expect(host.querySelectorAll(".qt-metric-bar-row")).toHaveLength(showOther ? 3 : 2);
    expect(host.textContent?.includes("Other (combined remainder)")).toBe(showOther);
  }
  const html = renderToStaticMarkup(createElement(MetricCard, { clause, buckets: [], fields, loading: true }));
  expect(html).toContain("qt-metric-spinner");
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading metric");
});


it("keeps sparse interpolated boxes inside true extremes with outward whiskers in compact and full charts", () => {
  const summary = boxSummary([30000,750000,3200000,1700000000], "tukey")!;
  for (const compact of [false,true]) {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(MetricCard, {
      compact, fields, clause: { ...clause, display: {kind:"box",boxMean:false,xScale:{mode:"log"}} },
      buckets: [{keys:["Ultra"], value:summary.median,count:summary.n,distribution:{kind:"box",summary}}],
    }));
    const mark = host.querySelector(".qt-metric-mark")!;
    const box = mark.querySelector("rect:not([fill=transparent])")!;
    const cap = mark.querySelectorAll("line")[2]!;
    const edge = Number(box.getAttribute("x"))+Number(box.getAttribute("width"));
    expect(Number(cap.getAttribute("x1"))).toBeCloseTo(edge);
    const extreme = mark.querySelector("circle")!;
    expect(Number(extreme.getAttribute("cx"))).toBeGreaterThan(edge);
    expect(mark.getAttribute("aria-label")).toContain("Max 1,700,000,000");
    expect(mark.getAttribute("aria-label")).toContain("3,200,000");
  }
});

it("honors compact logarithmic boxes and keeps zero-valued boxes on an explicitly linear shared axis", () => {
  for (const mode of ["linear","log"] as const) {
    const host = document.createElement("div");
    const values = [[0,10,100],[10,100,1000],[100,1000,10000]];
    host.innerHTML = renderToStaticMarkup(createElement(MetricCard, {
      compact:true,fields,clause:{...clause,display:{kind:"box",boxMean:false,xScale:{mode}}},
      buckets:values.map((values,i)=>({keys:[String(i)],value:null,count:3,distribution:{kind:"box" as const,summary:boxSummary(values)}})),
    }));
    expect(host.querySelectorAll(".qt-metric-mark")).toHaveLength(mode==="log"?2:3);
    if(mode==="log") {
      expect(host.textContent).toContain("Nonpositive samples");
      const medians = [...host.querySelectorAll(".qt-metric-mark")].map(mark=>Number(mark.querySelectorAll("line")[3]!.getAttribute("x1")));
      expect(medians[1]!-medians[0]!).toBeGreaterThan(0);
    } else expect(host.textContent).not.toContain("Nonpositive samples");
  }
});

it("compact composition legends separate labels, values and shares and keep the exact Other", () => {
  const host=document.createElement("div");
  host.innerHTML=renderToStaticMarkup(createElement(MetricCard, {
    compact:true,fields,clause:{...clause,display:{kind:"pie",maxGroups:1,legendPosition:"bottom"}},
    buckets:[{keys:["First category"],value:60,count:1},{keys:["Second"],value:30,count:1},{keys:["Third"],value:10,count:1}],
  }));
  expect([...host.querySelectorAll(".qt-metric-legend-label")].map(el=>el.textContent)).toEqual(["First category","Other"]);
  expect([...host.querySelectorAll(".qt-metric-legend-value")].map(el=>el.textContent)).toEqual(["60","40"]);
  expect([...host.querySelectorAll(".qt-metric-legend-share")].map(el=>el.textContent)).toEqual(["60.0%","40.0%"]);
  expect(host.querySelector(".qt-metric-mark")?.getAttribute("aria-label")).toContain("of 100");
  expect(host.querySelector(".qt-metric-legend")?.classList.contains("qt-metric-legend--composition")).toBe(true);
  host.innerHTML=renderToStaticMarkup(createElement(MetricCard, {
    compact:true,fields,clause:{...clause,display:{kind:"bar-vertical",legendPosition:"bottom"}},
    buckets:[{keys:["First category"],value:60,count:1},{keys:["Second"],value:30,count:1}],
  }));
  expect(host.querySelector(".qt-metric-legend")?.classList.contains("qt-metric-legend--composition")).toBe(false);
});

it("compact histogram hover shows the bin count without repeating its population denominator", () => {
  const host=document.createElement("div");
  const props={fields,clause:{...clause,display:{kind:"histogram" as const}},buckets:[{keys:["A"],value:2,count:3,distribution:{kind:"histogram" as const,edges:[0,1,2],counts:[1,2],n:3}}]};
  host.innerHTML=renderToStaticMarkup(createElement(MetricCard,{...props,compact:true}));
  expect(host.querySelector(".qt-metric-mark")?.getAttribute("aria-label")).toBe("A\n0 ≤ value < 1\n1 rows");
  host.innerHTML=renderToStaticMarkup(createElement(MetricCard,props));
  expect(host.querySelector(".qt-metric-mark")?.getAttribute("aria-label")).toContain("3 numeric samples");
});

it("tooltip transitions keep chart nodes and formatted axes intact and show the actual multi-series color", async () => {
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const theme={dimensions:{series:{layer:"series",overrides:[{value:"blue",color:"#123456"}]}},layers:[{id:"series",colors:["#abcdef"]}]};
  await act(async()=>root!.render(createElement(MetricCard,{
    fields,theme,clause:{...clause,groupBy:["date","series"],display:{kind:"line"}},
    buckets:[{keys:["2026-10-01","blue"],value:10,count:1},{keys:["2026-10-02","blue"],value:20,count:1}],
  })));
  const svg=container.querySelector("svg"),mark=container.querySelector(".qt-metric-mark")!;
  const formatter=vi.spyOn(Number.prototype,"toLocaleString");
  try {
    act(()=>mark.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})));
    expect(container.querySelector('[role="tooltip"] .qt-metric-swatch')?.getAttribute("style")).toContain("rgb(18, 52, 86)");
    expect(container.querySelector("svg")).toBe(svg);
    expect(formatter).not.toHaveBeenCalled();
    act(()=>mark.dispatchEvent(new MouseEvent("mouseout",{bubbles:true,relatedTarget:svg})));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(()=>mark.dispatchEvent(new FocusEvent("focusin",{bubbles:true})));
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    act(()=>mark.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(formatter).not.toHaveBeenCalled();
  } finally {formatter.mockRestore();}
});


it("counts omitted outliers after supplementing a transport sample with actual extremes", () => {
  const html=render({...clause,display:{kind:"box"}},[{keys:["sampled"],value:3,count:30,distribution:{kind:"box",summary:{
    n:30,min:0,q1:2,median:3,q3:4,max:100,mean:10,low:1,high:10,outliers:[11],outlierCount:5,whiskers:"tukey",method:"exact-linear",
  }}}]);
  expect(html).toContain("2 outlier markers omitted.");
  expect(html).toContain("5 outliers (3 retained markers)");
});

describe("measure display defaults", () => {
  const rateFields: FieldDef<unknown>[] = [
    { name: "rate", label: "Rate", type: "number", source: { kind: "backend" }, display: { kind: "percent", decimals: 1 } },
  ];
  const card = (c: RenderingClause) => renderToStaticMarkup(createElement(MetricCard, {
    clause: c, buckets: [{ keys: [], value: 0.0743, count: 4 }], fields: rateFields, renderers: defaultRenderers,
  }));
  it("formats a measured summary column with its cell display", () => {
    expect(card({ id: "m", op: "avg", field: "rate", groupBy: [] })).toContain("7.4%");
  });
  it("keeps explicit formats, counts, and expressions unchanged", () => {
    expect(card({ id: "m", op: "avg", field: "rate", groupBy: [], display: { kind: "auto", format: { kind: "number", decimals: 3 } } })).toContain("0.074");
    expect(card({ id: "m", op: "count_distinct", field: "rate", groupBy: [] })).not.toContain("%");
    expect(card({ id: "m", op: "avg", field: "rate", expression: "AVG([rate])", groupBy: [] })).not.toContain("%");
  });
  it("passes the host's own clause to onInspect, without the derived format", () => {
    const host: RenderingClause = { id: "m", op: "avg", field: "rate", groupBy: [] };
    const inspected: RenderingClause[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(MetricCard, {
      clause: host, buckets: [{ keys: [], value: 0.0743, count: 4 }], fields: rateFields,
      renderers: defaultRenderers, onInspect: (_bucket, c) => inspected.push(c),
    })));
    act(() => container.querySelector<HTMLElement>(".qt-metric-inspectable")!.click());
    expect(inspected).toEqual([host]);
    act(() => root.unmount());
    container.remove();
  });
});
describe("metric population notes", () => {
  it("states how many groups minCount hid", () => {
    const markup = renderToStaticMarkup(
      createElement(MetricCard, {
        clause: { ...clause, minCount: 3 },
        buckets,
        fields,
        renderers: defaultRenderers,
        result: { buckets, groupCount: 2, hiddenGroups: 4 },
      }),
    );
    expect(markup).toContain("4 groups hidden (fewer than 3 rows)");
    const none = renderToStaticMarkup(
      createElement(MetricCard, {
        clause: { ...clause, minCount: 3 },
        buckets,
        fields,
        renderers: defaultRenderers,
        result: { buckets, groupCount: 2, hiddenGroups: 0 },
      }),
    );
    expect(none).not.toContain("hidden (fewer");
    const measured = (minCount: NonNullable<AggregationClause["minCount"]>) =>
      renderToStaticMarkup(
        createElement(MetricCard, {
          clause: { ...clause, minCount },
          buckets,
          fields: [...fields, { name: "calls", label: "Calls", type: "number", source: { kind: "backend" } }],
          renderers: defaultRenderers,
          result: { buckets, groupCount: 2, hiddenGroups: 1 },
        }),
      );
    expect(measured({ min: 10, sum: "calls" })).toContain("1 group hidden (fewer than 10 total Calls)");
    expect(measured({ min: 5, distinct: "conversation_id" })).toContain("(fewer than 5 distinct conversation_id values)");
  });
});

it("says what one point of a windowed or share metric is", () => {
  const dated: RenderingClause = {
    ...clause, groupBy: ["group", "kind"], dateGrouping: { field: "group", interval: "day", includeEmpty: true, range: "observed" },
  };
  expect(render({ ...dated, window: { periods: 7 } })).toContain(
    "Total over the trailing 7 days; shorter windows at the start have no value.",
  );
  expect(render({ ...dated, window: { periods: "all", reduce: "mean" }, share: "group0" })).toContain(
    "Mean per day from the first day; as a share of each day&#x27;s total.",
  );
  expect(render({ ...clause, share: "total" })).toContain("Share of the total.");
  expect(render(clause)).not.toContain("trailing");
});
