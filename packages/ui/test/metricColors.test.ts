import { describe, it, expect } from "vitest";
import {
  createMetricColorResolver,
  typedMetricKey,
  metricTupleKey,
  type MetricTheme,
} from "../src/metricColors";
describe("instance-scoped metric colors", () => {
  it("keeps typed values and tuple boundaries distinct", () => {
    expect(
      new Set([1, "1", null, "null", true, "true"].map(typedMetricKey)).size,
    ).toBe(6);
    expect(metricTupleKey(["a\0b", "c"])).not.toBe(
      metricTupleKey(["a", "b\0c"]),
    );
  });
  it("resolves override then stable domain and reserved semantic tokens", () => {
    const theme: MetricTheme = {
      layers: [{ id: "os", colors: ["red", "blue", "green"] }],
      dimensions: {
        platform: {
          layer: "os",
          domain: [1, "1", "Other"],
          overrides: [{ value: 1, color: "var(--one)" }],
        },
      },
      tokens: { other: "gray", null: "silver" },
    };
    const c = createMetricColorResolver(theme);
    expect(c.color("platform", 1)).toBe("var(--one)");
    expect(c.color("platform", "1")).toBe("blue");
    expect(c.color("platform", "Other")).toBe("green");
    expect(c.token("other")).toBe("gray");
    expect(c.color("platform", null)).toBe("silver");
    const first = c.color("platform", "unknown");
    c.color("platform", "later");
    expect(c.color("platform", "unknown")).toBe(first);
    expect(createMetricColorResolver(theme).color("platform", "unknown")).toBe(
      first,
    );
  });
  it("isolates callers and handles invalid layers/colors deterministically", () => {
    const a = createMetricColorResolver({
        dimensions: { os: { layer: "missing" } },
      }),
      b = createMetricColorResolver({
        layers: [{ id: "one", colors: ["pink"] }],
        dimensions: { os: { layer: "one" } },
      });
    const before = a.color("os", "linux");
    expect(b.color("os", "linux")).toBe("pink");
    expect(a.color("os", "linux")).toBe(before);
    expect(
      createMetricColorResolver({
        layers: [{ id: "bad", colors: ["url(evil)", "red; color:blue", ""] }],
      }).color("os", "linux"),
    ).toBe(before);
  });
});
