import { describe, expect, it } from "vitest";
import { boxSummary } from "@pythia-software/query-table-core";
import { distributionProblem } from "../src/metricPresentation";

describe("distribution presentation validation", () => {
  it("accepts bounded means from actual constant-population reductions", () => {
    for (const value of [0.1, 0.3, 2.1, -2.1, Number.MIN_VALUE]) {
      for (const n of [6, 13, 10000]) {
        const summary = boxSummary(Array<number>(n).fill(value));
        expect(summary?.mean).toBe(value);
        expect(
          distributionProblem({ kind: "box", summary }),
          JSON.stringify({ value, n, summary }),
        ).toBeUndefined();
      }
    }
  });
  it("tolerates insignificant mean roundoff but rejects corrupt statistics", () => {
    const summary = boxSummary([1, 1, 1])!;
    expect(
      distributionProblem({
        kind: "box",
        summary: { ...summary, mean: 1 - Number.EPSILON },
      }),
    ).toBeUndefined();
    expect(
      distributionProblem({ kind: "box", summary: { ...summary, mean: 50 } }),
    ).toContain("Invalid distribution");
  });
});
