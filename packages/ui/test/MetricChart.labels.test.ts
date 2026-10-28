// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boxSummary } from "@pythia-software/query-table-core";
import { MetricChart } from "../src/MetricChart";
import { metricLabelWidth, truncateMetricLabel } from "../src/metricChartHelpers";
import { createMetricColorResolver, type MetricTheme } from "../src/metricColors";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";

const long = (i: number) => `claude / claude-opus-4-repository-${i}`;
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const chart = (clause: RenderingClause, buckets: MetricBucket[], theme?: MetricTheme) =>
  parse(renderToStaticMarkup(createElement(MetricChart, { clause, buckets, theme })));
const box = (values: number[]) => ({ kind: "box" as const, summary: boxSummary(values)! });

describe("chart group labels", () => {
  it("truncates at the end and fits the measured width", () => {
    const label = "root_model_family-0 and a long suffix";
    const short = truncateMetricLabel(label, 80);
    expect(short.startsWith("root_mod")).toBe(true);
    expect(short.endsWith("…")).toBe(true);
    expect(metricLabelWidth(short)).toBeLessThanOrEqual(80);
    expect(truncateMetricLabel("short", 80)).toBe("short");
  });

  for (const kind of ["box", "bar-horizontal"] as const) {
    it(`keeps the start of long ${kind} labels inside the chart`, () => {
      const buckets: MetricBucket[] = [0, 1, 2].map((i) => ({
        keys: [long(i)],
        value: i + 1,
        count: 3,
        distribution: box([1, 2, 3 + i]),
      }));
      const doc = chart({ id: "m", op: "sum", field: "n", groupBy: ["repo"], display: { kind } }, buckets);
      const gutter = Number(doc.querySelector("clipPath rect")!.getAttribute("x"));
      // Default 400px plot: the gutter grows past 78px but stays within 40%.
      expect(gutter).toBeGreaterThan(78);
      expect(gutter).toBeLessThanOrEqual(160);
      const labels = [...doc.querySelectorAll("text")].filter((t) => t.querySelector("title"));
      expect(labels).toHaveLength(3);
      labels.forEach((text, i) => {
        const full = text.querySelector("title")!.textContent!;
        const shown = text.textContent!.slice(full.length);
        expect(full).toBe(long(i));
        expect(shown.endsWith("…")).toBe(true);
        expect(full.startsWith(shown.slice(0, -1))).toBe(true);
        // Right-aligned at its x, the label's estimated extent starts inside the SVG.
        expect(Number(text.getAttribute("x")) - metricLabelWidth(shown)).toBeGreaterThanOrEqual(0);
      });
    });
  }

  it("keeps today's layout for short labels", () => {
    const buckets: MetricBucket[] = [{ keys: ["a"], value: 1, count: 1 }, { keys: ["b"], value: 2, count: 1 }];
    const doc = chart({ id: "m", op: "sum", field: "n", groupBy: ["g"], display: { kind: "bar-horizontal" } }, buckets);
    expect(doc.querySelector("clipPath rect")!.getAttribute("x")).toBe("78");
    expect([...doc.querySelectorAll("text")].some((t) => t.querySelector("title"))).toBe(false);
  });
});

describe("multi-key group colours", () => {
  const pairs: MetricBucket[] = [
    { keys: ["claude", "opus"], value: 3, count: 3 },
    { keys: ["claude", "sonnet"], value: 2, count: 2 },
    { keys: ["codex", "gpt-5"], value: 1, count: 1 },
  ];
  const colours = (doc: Document) =>
    [...doc.querySelectorAll("[data-qt-metric-color]")].map((g) => g.getAttribute("data-qt-metric-color"));
  const clause = (kind: "pie" | "bar-vertical"): RenderingClause => ({
    id: "m", op: "count", groupBy: ["provider", "model_family"], display: { kind },
  });

  it("gives each whole key its own colour in pies and bars", () => {
    const pie = colours(chart(clause("pie"), pairs));
    expect(new Set(pie).size).toBe(3);
    // Stable across renders and across charts sharing a theme.
    expect(colours(chart(clause("pie"), pairs))).toEqual(pie);
    expect(colours(chart(clause("bar-vertical"), [...pairs].reverse()))).toEqual([...pie].reverse());
  });

  it("lists each whole key once in the legend", () => {
    const doc = chart(clause("pie"), pairs);
    expect([...doc.querySelectorAll(".qt-metric-legend-label")].map((l) => l.textContent!.split(" · ")[0])).toEqual([
      "claude / opus", "claude / sonnet", "codex / gpt-5",
    ]);
  });

  it("leaves single-key charts and scatter series unchanged", () => {
    const resolver = createMetricColorResolver();
    const single: MetricBucket[] = [{ keys: ["claude"], value: 1, count: 1 }, { keys: ["codex"], value: 2, count: 1 }];
    expect(colours(chart({ id: "m", op: "count", groupBy: ["provider"], display: { kind: "pie" } }, single))).toEqual(
      ["claude", "codex"].map((v) => resolver.color("provider", v)),
    );
    const scatter = colours(chart(
      { id: "m", op: "count", groupBy: ["provider", "model_family"], display: { kind: "scatter" } },
      pairs.map((b) => ({ ...b, y: b.value })),
    ));
    expect(scatter).toEqual(pairs.map((b) => resolver.color("provider", b.keys[0]!)));
  });

  it("keeps themed tuples apart while the palette has room", () => {
    const theme: MetricTheme = { layers: [{ id: "two", colors: ["red", "blue"] }], dimensions: { provider: { layer: "two" } } };
    const resolve = createMetricColorResolver(theme).tupleColors(["provider", "model"], pairs.slice(0, 2).map((b) => b.keys));
    expect(new Set(pairs.slice(0, 2).map((b) => resolve(b.keys))).size).toBe(2);
    expect(resolve([null, null])).toContain("--qt-metric-null");
  });
});
