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

  describe("theme colorBy", () => {
    const events: MetricBucket[] = [
      { keys: ["textkit", "Out-of-date docs"], value: 5, count: 5 },
      { keys: ["pharos", "Flaky failure"], value: 4, count: 4 },
      { keys: ["textkit", "Missing tool"], value: 3, count: 3 },
      { keys: ["pharos", "Missing tool"], value: 2, count: 2 },
      { keys: ["query-table", "Missing tool"], value: 1, count: 1 },
      { keys: ["query-table", "Unlisted kind"], value: 1, count: 1 },
      { keys: ["query-table", null], value: 1, count: 1 },
    ];
    const theme: MetricTheme = {
      layers: [{ id: "kinds", colors: ["red", "green", "blue"] }],
      dimensions: {
        family: {
          layer: "kinds",
          domain: ["Flaky failure", "Unlisted kind"],
          overrides: [{ value: "Missing tool", color: "var(--event-missing)" }, { value: "Out-of-date docs", color: "var(--event-docs)" }],
        },
      },
      colorBy: "family",
    };
    const fields = ["repository_name", "family"];

    it("colours each tuple by that key's override, domain and null colour", () => {
      const resolver = createMetricColorResolver(theme);
      const resolve = resolver.tupleColors(fields, events.map((b) => b.keys));
      expect(events.map((b) => resolve(b.keys))).toEqual([
        "var(--event-docs)", "red", "var(--event-missing)", "var(--event-missing)", "var(--event-missing)", "green",
        resolver.token("null"),
      ]);
      expect(events.map((b) => resolve(b.keys))).toEqual(events.map((b) => resolver.color("family", b.keys[1] ?? null)));
      // The key may come first, and a priority list picks the first present field.
      const swapped = createMetricColorResolver({ ...theme, colorBy: ["missing", "family", "repository_name"] })
        .tupleColors(["family", "repository_name"], events.map((b) => [b.keys[1]!, b.keys[0]!]));
      expect(swapped(["Missing tool", "pharos"])).toBe("var(--event-missing)");
      expect(swapped(["Flaky failure", "textkit"])).toBe("red");
    });

    it("keeps whole-key colours for groupings without the field and single keys", () => {
      const { colorBy: _, ...uncoloured } = theme;
      const plain = createMetricColorResolver(uncoloured).tupleColors(fields, events.map((b) => b.keys));
      const other = createMetricColorResolver({ ...theme, colorBy: "status" }).tupleColors(fields, events.map((b) => b.keys));
      expect(events.map((b) => other(b.keys))).toEqual(events.map((b) => plain(b.keys)));
      const single = createMetricColorResolver(theme).tupleColors(["family"], [["Missing tool"]]);
      expect(single(["Missing tool"])).toBe("var(--event-missing)");
    });

    it("draws bars and their legend in the key's colour", () => {
      const doc = chart({ id: "m", op: "count", groupBy: fields, display: { kind: "bar-vertical", legendPosition: "bottom" } }, events, theme);
      expect(colours(doc).slice(0, 5)).toEqual([
        "var(--event-docs)", "red", "var(--event-missing)", "var(--event-missing)", "var(--event-missing)",
      ]);
      const legend = [...doc.querySelectorAll(".qt-metric-legend-label")].map((l) => [
        l.textContent, (l.previousElementSibling as HTMLElement | null)?.style.background,
      ]);
      expect(legend.slice(0, 4)).toEqual([
        ["textkit / Out-of-date docs", "var(--event-docs)"],
        ["pharos / Flaky failure", "red"],
        ["textkit / Missing tool", "var(--event-missing)"],
        ["pharos / Missing tool", "var(--event-missing)"],
      ]);
    });

    it("lets a chart's saved colorBy win over the theme's", () => {
      const resolver = createMetricColorResolver(theme);
      const byRepository = resolver.tupleColors(fields, events.map((b) => b.keys), { colorBy: "repository_name" });
      expect(events.map((b) => byRepository(b.keys))).toEqual(events.map((b) => resolver.color("repository_name", b.keys[0] ?? null)));
      // Without a theme default, the chart's key alone decides.
      const { colorBy: _, ...uncoloured } = theme;
      const doc = chart({ id: "m", op: "count", groupBy: fields, display: { kind: "bar-vertical", colorBy: "family" } }, events, uncoloured);
      expect(colours(doc).slice(0, 5)).toEqual([
        "var(--event-docs)", "red", "var(--event-missing)", "var(--event-missing)", "var(--event-missing)",
      ]);
    });

    it("ignores a saved colorBy the chart no longer groups by", () => {
      const keys = events.map((b) => b.keys);
      // Falls back to the theme's key...
      const themed = createMetricColorResolver(theme);
      expect(keys.map(themed.tupleColors(fields, keys, { colorBy: "status" }))).toEqual(keys.map(themed.tupleColors(fields, keys)));
      // ...or, without one, to whole-tuple colours, rendered without error.
      const { colorBy: _, ...uncoloured } = theme;
      const plain = createMetricColorResolver(uncoloured);
      expect(keys.map(plain.tupleColors(fields, keys, { colorBy: "status" }))).toEqual(keys.map(plain.tupleColors(fields, keys)));
      const stale = chart({ id: "m", op: "count", groupBy: fields, display: { kind: "bar-vertical", colorBy: "status" } }, events, uncoloured);
      const fresh = chart({ id: "m", op: "count", groupBy: fields, display: { kind: "bar-vertical" } }, events, uncoloured);
      expect(colours(stale)).toEqual(colours(fresh));
      expect(stale.querySelector(".qt-metric-error, [role='alert']")).toBeNull();
    });

    it("gives unpinned values of the key distinct colours within a chart", () => {
      const palette: MetricTheme = { layers: [{ id: "six", colors: ["c0", "c1", "c2", "c3", "c4", "c5"] }], dimensions: { family: { layer: "six", domain: ["Pinned"] } }, colorBy: "family" };
      const families = ["Missing tool", "Flaky failure", "Out-of-date docs", "Permission denied", "Pinned"];
      const tuples = families.flatMap((family) => [["a", family], ["b", family]]);
      const resolve = createMetricColorResolver(palette).tupleColors(fields, tuples);
      const byFamily = families.map((family) => resolve(["a", family]));
      expect(new Set(byFamily).size).toBe(families.length);
      // Every repository shares its family's colour; domain slots stay reserved.
      expect(families.map((family) => resolve(["b", family]))).toEqual(byFamily);
      expect(resolve(["a", "Pinned"])).toBe("c0");
      // Arrival order does not matter.
      const reversed = createMetricColorResolver(palette).tupleColors(fields, [...tuples].reverse());
      expect(families.map((family) => reversed(["a", family]))).toEqual(byFamily);
    });

    it("honours the key's NULL override even when every key is NULL", () => {
      const nulls: MetricTheme = { ...theme, dimensions: { family: { layer: "kinds", overrides: [{ value: null, color: "pink" }] } } };
      const resolve = createMetricColorResolver(nulls).tupleColors(fields, [["a", null], [null, null]]);
      expect(resolve(["a", null])).toBe("pink");
      expect(resolve([null, null])).toBe("pink");
    });

    it("matches a key through its dimension identity", () => {
      const shared: MetricTheme = { ...theme, dimensions: { ...theme.dimensions, event_family: { layer: "kinds", identity: "family", overrides: [{ value: "Missing tool", color: "orange" }] } } };
      const resolve = createMetricColorResolver(shared).tupleColors(["repository_name", "event_family"], [["a", "Missing tool"], ["b", "Missing tool"]]);
      expect(resolve(["a", "Missing tool"])).toBe("orange");
      expect(resolve(["b", "Missing tool"])).toBe("orange");
    });

    // Histograms accept a single grouping key, so only pies and rings draw
    // several keys with colour as their only identifier.
    for (const kind of ["pie", "donut"] as const) {
      it(`keeps whole-key colours in ${kind} charts, told apart by colour alone`, () => {
        const buckets = events.slice(2, 5);
        const { colorBy: _, ...uncoloured } = theme;
        const keyed = colours(chart({ id: "m", op: "count", groupBy: fields, display: { kind, colorBy: "family" } }, buckets, theme));
        const whole = colours(chart({ id: "m", op: "count", groupBy: fields, display: { kind } }, buckets, uncoloured));
        expect(keyed).toEqual(whole);
        expect(keyed.length).toBeGreaterThan(0);
        expect(keyed).not.toContain("var(--event-missing)");
      });
    }
  });

  it("keeps themed tuples apart while the palette has room", () => {
    const theme: MetricTheme = { layers: [{ id: "two", colors: ["red", "blue"] }], dimensions: { provider: { layer: "two" } } };
    const resolve = createMetricColorResolver(theme).tupleColors(["provider", "model"], pairs.slice(0, 2).map((b) => b.keys));
    expect(new Set(pairs.slice(0, 2).map((b) => resolve(b.keys))).size).toBe(2);
    expect(resolve([null, null])).toContain("--qt-metric-null");
  });
});
