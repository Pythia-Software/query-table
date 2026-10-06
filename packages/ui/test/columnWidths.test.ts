import { describe, expect, it } from "vitest";
import { equalWidths, fitContentWidths, fitScreenWidths, PRESET_MIN_WIDTH } from "../src/columnWidths";

const sum = (widths: number[]) => widths.reduce((total, w) => total + w, 0);

describe("column width presets", () => {
  it("fits content with a floor and whole pixels", () => {
    expect(fitContentWidths([10.2, 120.4, 300])).toEqual([PRESET_MIN_WIDTH, 121, 300]);
  });

  it("splits the available width evenly and exactly", () => {
    const widths = equalWidths(3, 1000);
    expect(sum(widths)).toBe(1000);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(equalWidths(4, 100)).toEqual([48, 48, 48, 48]);
    expect(equalWidths(0, 100)).toEqual([]);
  });

  it("grows narrow content proportionally to fill the screen", () => {
    const widths = fitScreenWidths([100, 300], 800);
    expect(widths).toEqual([200, 600]);
  });

  it("caps only the widest columns when content overflows", () => {
    const widths = fitScreenWidths([80, 100, 600, 900], 900);
    expect(widths.slice(0, 2)).toEqual([80, 100]);
    expect(widths[2]).toBe(360);
    expect(widths[3]).toBe(360);
    expect(sum(widths)).toBe(900);
  });

  it("never sums past the available width after rounding", () => {
    const widths = fitScreenWidths([77.3, 91.7, 140.1, 400.9, 512.2], 733.5);
    expect(sum(widths)).toBe(733);
  });

  it("falls back to the minimum width when the screen is too narrow", () => {
    expect(fitScreenWidths([200, 300], 50)).toEqual([48, 48]);
  });
});
