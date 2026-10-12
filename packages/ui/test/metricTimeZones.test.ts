// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricCard } from "../src/MetricsPanel";
import { metricGroupLabel } from "../src/metricChartHelpers";
import type { MetricBucket, RenderingClause } from "../src/metricTypes";

const clause: RenderingClause = {
  id: "local-days",
  op: "count",
  groupBy: ["at"],
  dateGrouping: {
    field: "at",
    interval: "day",
    timeZone: "Asia/Kathmandu",
    includeEmpty: true,
    range: "observed",
  },
};
const buckets: MetricBucket[] = [
  { keys: ["2026-09-30T18:15:00.000Z"], value: 3, count: 3 },
  { keys: ["2026-10-01T18:15:00.000Z"], value: 0, count: 0 },
];
const render = (c: RenderingClause, b = buckets) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(MetricCard, {
      clause: c,
      buckets: b,
      fields: [],
      locale: "en-US",
    }),
  );
  return host;
};

describe("calendar group presentation", () => {
  it("uses local dates for chart, list, flat table, and swapped pivot keys even with a retained UTC format", () => {
    for (const kind of [
      "line",
      "bar-vertical",
      "bar-horizontal",
      "list",
      "table",
      "pie",
      "donut",
    ] as const) {
      const c: RenderingClause = {
        ...clause,
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
      const host = render(c);
      expect(host.textContent).toContain("Oct 01");
      expect(host.textContent).not.toContain("Sep 30");
      if (!["pie", "donut"].includes(kind))
        expect(host.textContent).toContain("Oct 02");
      for (const swap of [false, true]) {
        const pivot = render(
          {
            ...c,
            groupBy: ["at", "region"],
            display: { ...c.display!, kind: "table", pivot: { swap } },
          },
          buckets.map((b) => ({ ...b, keys: [...b.keys, "Nepal"] })),
        );
        expect(pivot.textContent).toContain("Oct 01");
        expect(pivot.textContent).toContain("Oct 02");
        expect(pivot.textContent).toContain("Nepal");
        expect(pivot.textContent).not.toContain("Sep 30");
      }
    }
    expect(buckets[0]!.keys[0]).toBe("2026-09-30T18:15:00.000Z");
  });
  it("distinguishes repeated local hours with offsets on axes and accessible tooltips", () => {
    const c: RenderingClause = {
      ...clause,
      dateGrouping: {
        ...clause.dateGrouping!,
        interval: "hour",
        timeZone: "America/Denver",
      },
      display: { kind: "line", legendPosition: "bottom" },
    };
    const host = render(c, [
      { keys: ["2026-11-01T07:00:00.000Z"], value: 1, count: 1 },
      { keys: ["2026-11-01T08:00:00.000Z"], value: 2, count: 2 },
    ]);
    expect(host.textContent).toContain("Nov 01 01:00 -06:00");
    expect(host.textContent).toContain("Nov 01 01:00 -07:00");
    const labels = [...host.querySelectorAll(".qt-metric-mark")].map((m) =>
      m.getAttribute("aria-label"),
    );
    expect(labels[0]).toContain("2026-11-01 01:00 -06:00");
    expect(labels[1]).toContain("2026-11-01 01:00 -07:00");
  });
  it("formats only the date axis and preserves secondary series names and scatter measure formats", () => {
    const c: RenderingClause = {
      ...clause,
      groupBy: ["at", "region"],
      display: { kind: "line", legendPosition: "bottom" },
    };
    const paired = buckets.map((b) => ({ ...b, keys: [...b.keys, "Nepal"] }));
    expect(
      render(c, paired).querySelector(".qt-metric-legend")?.textContent,
    ).toContain("Nepal");
    expect(metricGroupLabel(paired[0]!, c, "en-US")).toBe("Oct 01 / Nepal");
    const scatter = render(
      {
        ...c,
        display: {
          kind: "scatter",
          xFormat: { kind: "duration" },
          yFormat: { kind: "percent", decimals: 1 },
        },
      },
      [{ keys: paired[0]!.keys, value: 1200, y: 0.25, count: 3 }],
    );
    expect(
      scatter.querySelector(".qt-metric-mark")?.getAttribute("aria-label"),
    ).toContain("1.2s / 25.0%");
  });
  it("defaults calendar labels to UTC and preserves exact grouping labels without dateGrouping", () => {
    const utc = { ...clause, dateGrouping: { ...clause.dateGrouping! } };
    delete utc.dateGrouping.timeZone;
    expect(metricGroupLabel(buckets[0]!, utc, "en-US")).toBe("Sep 30");
    const exact = { ...clause };
    delete exact.dateGrouping;
    expect(metricGroupLabel(buckets[0]!, exact)).toBe(
      "2026-09-30T18:15:00.000Z",
    );
  });
});
