import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection as NativeConnection } from "@duckdb/node-api";
import {
  EMPTY_QUERY,
  normalizeQueryState,
  planMetricSeries,
  toQueryRequestV3,
  type AggregationResultEntry,
  type AggregationBucket,
  type AggregationClause,
  type FieldSchema,
} from "@pythia-software/query-table-core";
import { DuckDBBackend } from "../src/index";

type Row = Record<string, unknown>;
interface Case {
  name: string;
  planned?: boolean;
  metric: AggregationClause;
  expected: { error?: true; groupCount?: number; hiddenGroups?: number; buckets?: Record<string, unknown>[]; other?: Record<string, unknown> };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/metric-intervals.json", import.meta.url), "utf8"),
) as { now: string; tolerance: number; schema: FieldSchema; rows: Row[]; cases: Case[] };

/** The fixture's fields; numbers within its relative tolerance. */
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

let native: NativeConnection, backend: DuckDBBackend;
beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  native = await instance.connect();
  await native.run("SET TimeZone='UTC'");
  await native.run('CREATE TABLE turns (id VARCHAR, band VARCHAR, turn VARCHAR, events BIGINT, messages BIGINT, "at" TIMESTAMPTZ)');
  for (const row of fixture.rows)
    await native.run("INSERT INTO turns VALUES ($1,$2,$3,$4,$5,CAST($6 AS TIMESTAMPTZ))", [
      row.id as string, row.band as string, row.turn as string, row.events as number, row.messages as number, row.at as string,
    ] as any[]);
  backend = new DuckDBBackend({
    relation: "turns",
    schema: fixture.schema,
    connection: { query: async (sql, args) => (await native.runAndReadAll(sql, args as any[])).getRowObjectsJS() },
  });
});
afterAll(() => native?.closeSync());

describe("shared metric interval fixture (DuckDB)", () => {
  it("advertises intervals and Other remainders", () => {
    expect(backend.capabilities.metricIntervals).toBe(true);
    expect(backend.capabilities.metricOther).toBe(true);
  });
  for (const c of fixture.cases) {
    // DuckDB fails a whole metric on a division by zero rather than one
    // bucket, with or without an interval.
    const divides = [...(c.expected.buckets ?? []), ...(c.expected.other ? [c.expected.other] : [])].some((bucket) => "error" in bucket);
    it.skipIf(divides)(c.name, async () => {
      const now = Date.parse(fixture.now);
      const run = async (query: typeof planned) => {
        const request = toQueryRequestV3(query, fixture.schema, backend.capabilities, undefined, { now, rows: false });
        return (await backend.execute(request)).metrics;
      };
      // A planned case runs its plain metrics here and combines them on the
      // client, as executeMetrics does.
      const planned = normalizeQueryState({ ...EMPTY_QUERY, limit: 100, aggregations: [c.metric] });
      const series = planMetricSeries(planned, fixture.schema, { now });
      let entry: AggregationResultEntry;
      if (series) {
        const metrics: AggregationResultEntry[] = [];
        for (const query of series.queries) metrics.push(...(await run(query)));
        entry = series.combine(metrics)[0]!;
      } else {
        // Send invalid intervals too, so the backend's own validation runs.
        const { interval, ...plain } = c.metric;
        const query = normalizeQueryState({ ...EMPTY_QUERY, limit: 100, aggregations: [plain] });
        const request = toQueryRequestV3(query, fixture.schema, backend.capabilities, undefined, { now, rows: false });
        const result = await backend.execute({ ...request, metrics: [{ ...request.metrics[0]!, ...(interval ? { interval } : {}) }] });
        entry = result.metrics[0]!;
      }
      if (c.expected.error) return expect(entry.errorCode, entry.error).toBe("metric_interval");
      expect(entry.error).toBeUndefined();
      expect(entry.groupCount).toBe(c.expected.groupCount);
      expect(entry.hiddenGroups).toBe(c.expected.hiddenGroups);
      expect(c.expected.buckets!.map((bucket) => ("error" in bucket ? { ...bucket, error: true } : bucket))).toEqual(entry.buckets.map(project));
      if (c.expected.other) expect(c.expected.other).toEqual(project(entry.other!));
      else expect(entry.other).toBeUndefined();
    });
  }
});
