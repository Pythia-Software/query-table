// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldDef } from "@pythia-software/query-table-core";
import { MetricChart } from "../src/MetricChart";
import { MetricCard } from "../src/MetricsPanel";
import {
  metricBandPath,
  metricBucketInterval,
  metricIntervalSpan,
  metricIntervalText,
  metricValueAxisValues,
} from "../src/metricChartHelpers";
import { formatMetricOutput } from "../src/metricFormat";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";

const percent = { kind: "percent" as const, decimals: 1 };
const rate: RenderingClause = {
  id: "rate",
  op: "count",
  expression: "SUM([hits])/NULLIF(COUNT(),0)",
  groupBy: ["bucket"],
  interval: { kind: "proportion" },
  display: { kind: "bar-vertical", format: percent },
};
// Pharos's prompt-length evidence: Wilson bounds around each share.
const buckets: MetricBucket[] = [
  { keys: ["31-100"], value: 0.047, count: 128, lower: 0.022, upper: 0.098 },
  { keys: ["101-300"], value: 0.154, count: 52, lower: 0.08, upper: 0.275 },
  { keys: ["300+"], value: 0.4, count: 15, lower: 0.198, upper: 0.643 },
  { keys: ["none"], value: 0.1, count: 3 },
];
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const chart = (clause: RenderingClause, b: MetricBucket[] = buckets) =>
  parse(renderToStaticMarkup(createElement(MetricChart, { clause, buckets: b, locale: "en-US" })));
const plot = (doc: Document) => {
  const rect = doc.querySelector("clipPath rect")!;
  const n = (name: string) => Number(rect.getAttribute(name));
  return { left: n("x"), top: n("y"), right: n("x") + n("width"), bottom: n("y") + n("height") };
};
const lines = (doc: Document, selector = ".qt-metric-interval") =>
  [...doc.querySelectorAll(selector)].map((g) =>
    [...g.querySelectorAll("line")].map((l) =>
      ["x1", "y1", "x2", "y2"].map((a) => Number(l.getAttribute(a))),
    ),
  );

describe("interval helpers", () => {
  it("reads only finite, ordered bounds without an error", () => {
    expect(metricBucketInterval(buckets[0]!)).toEqual({ lower: 0.022, upper: 0.098 });
    expect(metricBucketInterval(buckets[3]!)).toBeUndefined();
    expect(metricBucketInterval({ ...buckets[0]!, error: "boom" })).toBeUndefined();
    expect(metricBucketInterval({ ...buckets[0]!, lower: 0.5 })).toBeUndefined();
    expect(metricBucketInterval({ ...buckets[0]!, upper: Infinity })).toBeUndefined();
  });

  it("extends the value axis to drawn bounds only", () => {
    expect(metricValueAxisValues(rate, buckets)).toEqual([0.047, 0.022, 0.098, 0.154, 0.08, 0.275, 0.4, 0.198, 0.643, 0.1]);
    const hidden = { ...rate, display: { ...rate.display!, showIntervals: false } };
    expect(metricValueAxisValues(hidden, buckets)).toEqual([0.047, 0.154, 0.4, 0.1]);
    // An errored or missing value contributes nothing, bounds included.
    expect(metricValueAxisValues(rate, [{ ...buckets[0]!, value: null }, { ...buckets[1]!, error: "x" }])).toEqual([]);
  });

  it("keeps nonpositive bounds off a log axis instead of counting them as omitted", () => {
    const b: MetricBucket[] = [
      { keys: ["a"], value: 2, count: 1, lower: 0, upper: 5 },
      { keys: ["b"], value: 0, count: 1, lower: 0, upper: 1 },
    ];
    expect(metricValueAxisValues(rate, b, true)).toEqual([2, 5, 0]);
  });

  it("clamps a whisker to the axis domain and drops caps at clamped ends", () => {
    expect(metricIntervalSpan({ lower: 2, upper: 5 }, 0, 10)).toEqual({ low: 2, high: 5, lowCap: true, highCap: true });
    expect(metricIntervalSpan({ lower: -1, upper: 12 }, 0, 10)).toEqual({ low: 0, high: 10, lowCap: false, highCap: false });
    // A log axis starts above zero: a zero lower bound runs to the axis edge.
    expect(metricIntervalSpan({ lower: 0, upper: 5 }, 0.5, 10)).toEqual({ low: 0.5, high: 5, lowCap: false, highCap: true });
    expect(metricIntervalSpan({ lower: 11, upper: 12 }, 0, 10)).toBeUndefined();
    expect(metricIntervalSpan({ lower: -2, upper: -1 }, 0, 10)).toBeUndefined();
  });

  it("names the level and formats bounds like the value", () => {
    const fmt = (v: number) => formatMetricOutput(v, percent, "en-US").text;
    expect(metricIntervalText(rate, buckets[0]!, fmt, "en-US")).toBe("95% interval 2.2%–9.8%");
    expect(metricIntervalText({ ...rate, interval: { kind: "rate", level: 0.9 } }, buckets[0]!, fmt, "en-US")).toBe("90% interval 2.2%–9.8%");
    expect(metricIntervalText({ ...rate, interval: { kind: "rate", level: 0.995 } }, buckets[0]!, fmt, "en-US")).toBe("99.5% interval 2.2%–9.8%");
    expect(metricIntervalText(rate, buckets[3]!, fmt, "en-US")).toBeUndefined();
  });

  it("breaks a band at points without bounds and returns lone points", () => {
    const p = (x: number) => ({ x, high: x, low: x + 10 });
    const band = metricBandPath([p(0), p(1), null, p(3), null, p(5), p(6), p(7)]);
    expect(band.d).toBe("M0,0 L1,1 L1,11 L0,10 Z M5,5 L6,6 L7,7 L7,17 L6,16 L5,15 Z");
    expect(band.singles).toEqual([p(3)]);
    expect(metricBandPath([null, null])).toEqual({ d: "", singles: [] });
  });
});

describe("interval whiskers on bars", () => {
  for (const kind of ["bar-vertical", "bar-horizontal"] as const) {
    it(`draws a capped whisker inside the plot for each ${kind} with bounds`, () => {
      const doc = chart({ ...rate, display: { ...rate.display!, kind } });
      const box = plot(doc);
      const whiskers = lines(doc);
      expect(whiskers).toHaveLength(3);
      for (const segments of whiskers) {
        expect(segments).toHaveLength(3);
        for (const [x1, y1, x2, y2] of segments) {
          for (const x of [x1!, x2!]) expect(x).toBeGreaterThanOrEqual(box.left - 6);
          for (const x of [x1!, x2!]) expect(x).toBeLessThanOrEqual(box.right + 6);
          for (const y of [y1!, y2!]) expect(y).toBeGreaterThanOrEqual(box.top - 0.001);
          for (const y of [y1!, y2!]) expect(y).toBeLessThanOrEqual(box.bottom + 0.001);
        }
      }
      // The highest upper bound sets the top of the axis, not the highest value.
      const [, y1, , y2] = whiskers[2]![0]!, [x1, , x2] = whiskers[2]![0]!;
      if (kind === "bar-vertical") expect(Math.min(y1!, y2!)).toBeCloseTo(box.top, 6);
      else expect(Math.max(x1!, x2!)).toBeCloseTo(box.right, 6);
      // Whiskers sit inside each bar's mark, which names the interval.
      const marks = [...doc.querySelectorAll(".qt-metric-mark")];
      expect(marks.map((m) => m.querySelector(".qt-metric-interval") !== null)).toEqual([true, true, true, false]);
      expect(marks[0]!.getAttribute("aria-label")).toBe("31-100\n4.7%\n95% interval 2.2%–9.8%\n128 rows");
      expect(marks[3]!.getAttribute("aria-label")).toBe("none\n10.0%\n3 rows");
      expect(doc.querySelector(".qt-sr-only")!.textContent).toContain("Whiskers show each value's 95% interval.");
    });
  }

  it("hides whiskers but keeps hover text when the display turns them off", () => {
    const doc = chart({ ...rate, display: { ...rate.display!, showIntervals: false } });
    expect(doc.querySelectorAll(".qt-metric-interval")).toHaveLength(0);
    expect(doc.querySelector(".qt-metric-mark")!.getAttribute("aria-label")).toContain("95% interval 2.2%–9.8%");
    expect(doc.querySelector(".qt-sr-only")!.textContent).not.toContain("Whiskers");
  });

  it("respects explicit bounds and clamps a zero lower bound on a log axis", () => {
    const clipped = chart({ ...rate, display: { ...rate.display!, yScale: { min: 0, max: 0.5 } } });
    // The 300+ upper bound is past the explicit max: no cap at that end.
    expect(lines(clipped).map((w) => w.length)).toEqual([3, 3, 2]);
    const [, low, , high] = lines(clipped)[2]![0]!;
    expect(Math.min(low!, high!)).toBeCloseTo(plot(clipped).top, 6);

    const log = chart(
      { ...rate, display: { ...rate.display!, yScale: { mode: "log" } } },
      [
        { keys: ["a"], value: 2, count: 1, lower: 0, upper: 5 },
        { keys: ["b"], value: 4, count: 1, lower: 1, upper: 8 },
      ],
    );
    expect(log.body.textContent).not.toContain("nonpositive");
    const box = plot(log), [first, second] = lines(log);
    expect(first).toHaveLength(2);
    expect(Math.max(first![0]![1]!, first![0]![3]!)).toBeCloseTo(box.bottom, 6);
    expect(second).toHaveLength(3);
  });
});

describe("interval bands on lines", () => {
  const line: RenderingClause = { ...rate, groupBy: ["day"], display: { kind: "line", format: percent } };
  const days: MetricBucket[] = [
    { keys: ["2026-10-01"], value: 0.1, count: 10, lower: 0.05, upper: 0.2 },
    { keys: ["2026-10-02"], value: 0.2, count: 10, lower: 0.1, upper: 0.3 },
    { keys: ["2026-10-03"], value: 0.2, count: 10 },
    { keys: ["2026-10-04"], value: 0.3, count: 10, lower: 0.2, upper: 0.5 },
  ];

  it("shades a band beneath the line with a gap where a point has no bounds", () => {
    const doc = chart(line, days);
    const band = doc.querySelector(".qt-metric-interval-band")!;
    const area = band.querySelector("path")!;
    expect(area.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    expect(Number(area.getAttribute("fill-opacity"))).toBeLessThan(0.5);
    // The lone bounded point after the gap is drawn as a whisker.
    expect(band.querySelectorAll(":scope > g")).toHaveLength(1);
    // Bands precede (sit beneath) the series line.
    const svg = doc.querySelector("svg")!;
    const order = [...svg.querySelectorAll("path")].map((p) => p.closest(".qt-metric-interval-band") ? "band" : "line");
    expect(order).toEqual(["band", "line"]);
    // The top of the axis is the highest upper bound.
    const ys = area.getAttribute("d")!.match(/,-?[\d.]+/g)!.map((s) => Number(s.slice(1)));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(plot(doc).top - 0.001);
    expect(doc.querySelector(".qt-sr-only")!.textContent).toContain("Shaded bands show each point's 95% interval.");
    expect(doc.querySelector(".qt-metric-mark")!.getAttribute("aria-label")).toContain("95% interval 5.0%–20.0%");
  });

  it("draws no band when the display turns intervals off", () => {
    const doc = chart({ ...line, display: { ...line.display!, showIntervals: false } }, days);
    expect(doc.querySelector(".qt-metric-interval-band")).toBeNull();
  });
});

describe("interval hover text in tables and lists", () => {
  const fields: FieldDef<unknown>[] = [{ name: "bucket", label: "Bucket", type: "text", source: { kind: "backend" } }];
  const card = (clause: RenderingClause, b: MetricBucket[] = buckets) =>
    parse(renderToStaticMarkup(createElement(MetricCard, { clause, buckets: b, fields, locale: "en-US" })));

  it("titles list values, table cells and a single value with the interval", () => {
    const list = card({ ...rate, display: { kind: "list", format: percent } });
    expect([...list.querySelectorAll(".qt-metric-bar-value")].map((v) => v.getAttribute("title"))).toEqual([
      "95% interval 2.2%–9.8%",
      "95% interval 8.0%–27.5%",
      "95% interval 19.8%–64.3%",
      null,
    ]);
    const table = card({ ...rate, groupBy: ["bucket", "b", "c"], display: { kind: "table", format: percent } },
      [{ ...buckets[0]!, keys: ["x", "y", "z"] }]);
    expect(table.querySelector(".qt-metric-flat-value[title]")!.getAttribute("title")).toBe("95% interval 2.2%–9.8%");
    const value = card({ ...rate, groupBy: [], display: { kind: "value", format: percent } }, [{ ...buckets[0]!, keys: [] }]);
    expect(value.querySelector(".qt-metric-big-value")!.getAttribute("title")).toBe("95% interval 2.2%–9.8%");
  });

  it("formats bounds with the card's decimals when the metric has no format", () => {
    const list = card({ ...rate, display: { kind: "list" } });
    expect(list.querySelector(".qt-metric-bar-value")!.getAttribute("title")).toBe("95% interval 0.02200–0.09800");
  });
});
