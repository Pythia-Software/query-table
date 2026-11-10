// Runs schema/fixtures/metric-intervals.json through a Go executor as the
// TypeScript client sends it: toQueryRequestV3 builds each request, and a
// planned case (a share) runs the plain metrics planMetricSeries expands it
// into and combines their results on the client, as executeMetrics does. The
// Go side is TestMetricIntervalRequests in the suite's directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  EMPTY_QUERY,
  normalizeQueryState,
  planMetricSeries,
  toQueryRequestV3,
  type AggregationBucket,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type QueryCapabilitiesV3,
  type QueryResultV3,
} from "../../packages/core/src/index";

interface Case {
  name: string;
  planned?: boolean;
  metric: AggregationClause;
  expected: { error?: true; groupCount?: number; hiddenGroups?: number; buckets?: Record<string, unknown>[]; other?: Record<string, unknown> };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/metric-intervals.json", import.meta.url), "utf8"),
) as { now: string; tolerance: number; schema: FieldSchema; cases: Case[] };

function project(bucket: AggregationBucket) {
  const near = (value: unknown) =>
    typeof value === "number"
      ? expect.closeTo(value, -Math.log10(Math.max(Math.abs(value), 1) * fixture.tolerance))
      : value;
  return {
    keys: bucket.keys,
    count: Number(bucket.count),
    ...(bucket.error ? { error: true } : { value: near(bucket.value) }),
    ...(bucket.lower !== undefined ? { lower: near(bucket.lower) } : {}),
    ...(bucket.upper !== undefined ? { upper: near(bucket.upper) } : {}),
    ...(bucket.intervalError ? { intervalError: true } : {}),
  };
}

/** Every case a client can send (refused intervals never leave it). */
export function checkMetricFixtureThroughGo(suite: URL, profile: string, env: Record<string, string> = {}): void {
  const now = Date.parse(fixture.now);
  const capabilities: QueryCapabilitiesV3 = {
    version: 3, profile, groupedRows: true, calendarGrouping: true, calendarCycles: true, computedSourceFilters: false,
    regex: false, metricFilters: true, metricMinCount: true, metricMinCountMeasures: true, metricIntervals: true,
    metricOther: true, maxRows: 10000, maxGroups: 2000, maxPopulation: 250000,
  };
  const cases = fixture.cases.filter((c) => !c.expected.error);
  const plans = cases.map((c) => {
    const query = normalizeQueryState({ ...EMPTY_QUERY, limit: 100, aggregations: [c.metric] });
    const series = planMetricSeries(query, fixture.schema, { now });
    expect(!!series, c.name).toBe(!!c.planned);
    const queries = series?.queries ?? [query];
    return { series, requests: queries.map((q) => toQueryRequestV3(q, fixture.schema, capabilities, undefined, { now, rows: false })) };
  });
  const dir = mkdtempSync(join(tmpdir(), "qt-metric-fixture-"));
  try {
    const requests = join(dir, "requests.json"),
      results = join(dir, "results.json");
    writeFileSync(requests, JSON.stringify(plans.flatMap((plan) => plan.requests)));
    execFileSync("go", ["test", "-run", "^TestMetricIntervalRequests$", "-count=1", "."], {
      cwd: suite, encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...env, QT_METRIC_REQUESTS: requests, QT_METRIC_RESULTS: results },
    });
    const responses = JSON.parse(readFileSync(results, "utf8")) as QueryResultV3[];
    let next = 0;
    cases.forEach((c, i) => {
      const { series, requests: sent } = plans[i]!;
      const metrics: AggregationResultEntry[] = sent.flatMap(() => responses[next++]!.metrics);
      const entry = series ? series.combine(metrics)[0]! : metrics[0]!;
      expect(entry.error, c.name).toBeUndefined();
      expect(entry.groupCount, c.name).toBe(c.expected.groupCount);
      expect(entry.hiddenGroups, c.name).toBe(c.expected.hiddenGroups);
      expect(c.expected.buckets!.map((b) => ("error" in b ? { ...b, error: true } : b)), c.name).toEqual(entry.buckets.map(project));
      if (c.expected.other) expect(c.expected.other, c.name).toEqual(project(entry.other!));
      else expect(entry.other, c.name).toBeUndefined();
    });
    expect(next).toBe(responses.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
