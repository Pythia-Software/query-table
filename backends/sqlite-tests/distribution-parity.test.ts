import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { boxSummary, histogramCounts, histogramEdges } from "../../packages/core/src/metricDistributions";
import type { AggregationBucket } from "../../packages/core/src/encode";

type Fixture = {
  samples: number[];
  kind: "box" | "histogram";
  whiskers: "minmax" | "tukey";
  bins: number;
  bucket: AggregationBucket;
};
it("matches the core distribution contract using real SQLite execution", () => {
  const output = execFileSync("go", ["test", "-run", "^TestSQLiteDistributionFrontendParity$", "-count=1", "-v"], {
    cwd: new URL("./", import.meta.url), encoding: "utf8", timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = output.split("\n").find((line) => line.includes("DISTRIBUTION_FIXTURES "));
  expect(line).toBeDefined();
  const fixtures = JSON.parse(line!.split("DISTRIBUTION_FIXTURES ")[1]!) as Fixture[];
  expect(fixtures.length).toBeGreaterThan(20);
  for (const { samples, kind, whiskers, bins, bucket } of fixtures) {
    expect(bucket.count).toBe(samples.length);
    expect(bucket.nullCount).toBe(0);
    expect(bucket.inputErrorCount).toBe(0);
    if (kind === "box") {
      const expected = boxSummary(samples, whiskers);
      expect(bucket.error).toBeUndefined();
      expect(bucket.distribution?.kind).toBe("box");
      if (bucket.distribution?.kind !== "box") throw Error("Missing box result");
      const actual = bucket.distribution.summary;
      if (expected === null) { expect(actual).toBeNull(); expect(bucket.value).toBeNull(); continue; }
      expect(actual).not.toBeNull();
      // SQLite uses its exact decimal AVG contract; browser mean accumulates
      // sorted doubles. Quartiles, fences, endpoints and tail sampling agree exactly.
      const { mean: expectedMean, ...expectedRest } = expected;
      const { mean: actualMean, ...actualRest } = actual!;
      expect(actualRest).toEqual(expectedRest);
      expect(Math.abs(actualMean - expectedMean)).toBeLessThanOrEqual(
        Math.max(...samples.map(Math.abs), Math.abs(expectedMean)) * 1e-14 || Number.MIN_VALUE,
      );
      expect(bucket.value).toBe(expected.median);
    } else {
      let edges: number[];
      try { edges = histogramEdges(samples, bins); }
      catch { expect(bucket.error).toBe("histogram_precision"); expect(bucket.distribution).toBeUndefined(); expect(bucket.value).toBeNull(); continue; }
      expect(bucket.error).toBeUndefined();
      expect(bucket.distribution).toEqual({ kind: "histogram", edges, counts: histogramCounts(samples, edges), n: samples.length });
      expect(bucket.value).toBe(samples.length);
    }
  }
}, 120000);
