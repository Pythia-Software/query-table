import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection as NativeConnection } from "@duckdb/node-api";
import {
  EMPTY_QUERY,
  normalizeQueryState,
  toMetricQuery,
  toQueryRequestV3,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type QueryState,
} from "@pythia-software/query-table-core";
import { DuckDBBackend } from "../src/index";

type Row = Record<string, unknown>;
interface Case {
  name: string;
  where?: QueryState["where"];
  orderBy?: QueryState["orderBy"];
  limit?: number;
  grouping?: { keys: string[]; summaries: { id: string; op: "count" }[] };
  metric: AggregationClause;
  expected: { error: true } | { groupCount: number; hiddenGroups?: number; processedRows?: number; buckets: Record<string, unknown>[] };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/metric-population.json", import.meta.url), "utf8"),
) as { now: string; schema: FieldSchema; rows: Row[]; cases: Case[] };
const now = Date.parse(fixture.now);

/** Same projection as the core fixture test. DuckDB does not report
 * processedRows, so that optional assertion is skipped when absent. */
function project(entry: AggregationResultEntry, expected: Case["expected"]) {
  if ("error" in expected) return { error: !!entry.error };
  return {
    groupCount: entry.groupCount,
    hiddenGroups: entry.hiddenGroups,
    ...(expected.processedRows !== undefined ? { processedRows: entry.processedRows ?? expected.processedRows } : {}),
    buckets: entry.buckets.map((bucket, i) => {
      const want = expected.buckets[i] ?? {};
      const box = bucket.distribution?.kind === "box" ? bucket.distribution.summary : undefined;
      const histogram = bucket.distribution?.kind === "histogram" ? bucket.distribution : undefined;
      return {
        keys: bucket.keys,
        count: Number(bucket.count),
        ...("value" in want ? { value: bucket.value } : {}),
        ...(want.box && box ? { box: { n: box.n, min: box.min, q1: box.q1, median: box.median, q3: box.q3, max: box.max } } : {}),
        ...(want.histogram && histogram ? { histogram: { edges: histogram.edges, counts: histogram.counts, n: histogram.n } } : {}),
      };
    }),
  };
}
function queryFor(c: Case): QueryState {
  return normalizeQueryState({
    ...EMPTY_QUERY,
    where: c.grouping ? [] : (c.where ?? []),
    orderBy: c.orderBy ?? [],
    limit: c.limit ?? 100,
    aggregations: [c.metric],
    ...(c.grouping ? { grouping: { ...c.grouping, representative: null, source: { ...EMPTY_QUERY, where: c.where ?? [] } } } : {}),
  });
}

let native: NativeConnection, backend: DuckDBBackend;
beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  native = await instance.connect();
  await native.run("SET TimeZone='UTC'");
  await native.run('CREATE TABLE calls (id VARCHAR, kind VARCHAR, status VARCHAR, ms DOUBLE, "at" TIMESTAMPTZ)');
  for (const row of fixture.rows)
    await native.run("INSERT INTO calls VALUES ($1,$2,$3,$4,CAST($5 AS TIMESTAMPTZ))", [
      row.id as string, row.kind as string, row.status as string, row.ms as number, row.at as string,
    ] as any[]);
  backend = new DuckDBBackend({
    relation: "calls",
    schema: fixture.schema,
    connection: { query: async (sql, args) => (await native.runAndReadAll(sql, args as any[])).getRowObjectsJS() },
  });
});
afterAll(() => native?.closeSync());

describe("shared metric population fixture (DuckDB)", () => {
  for (const c of fixture.cases)
    it(c.name, async () => {
      const request = toQueryRequestV3(queryFor(c), fixture.schema, backend.capabilities, undefined, { now, rows: false });
      // The ungrouped minCount refusal is a client-side diagnostic as well;
      // send the clause anyway so the backend's own validation is exercised.
      const result = await backend.execute({ ...request, diagnostics: [] });
      const entry = result.metrics[0]!;
      expect(project(entry, c.expected), entry.error).toEqual(c.expected);
    });
});

describe("DuckDB metric population transport", () => {
  it("advertises both controls on the v2 and v3 handshakes", () => {
    const transport = backend.transport();
    expect(transport.metricCapabilities).toMatchObject({ filters: true, minCount: true });
    expect(transport.queryCapabilities).toMatchObject({ metricFilters: true, metricMinCount: true });
  });
  it("matches the fixture through the v2 metric transport", async () => {
    const transport = backend.transport();
    for (const c of fixture.cases.filter((c) => !c.grouping && !c.metric.dateGrouping && !("error" in c.expected))) {
      const request = toMetricQuery(queryFor(c), fixture.schema);
      expect(request.diagnostics, c.name).toEqual([]);
      const entry = (await transport.fetchMetrics!(request)).metrics[0]!;
      // The v2 transport evaluates relative filters against its own clock.
      if (c.metric.where?.some((term) => "value" in term && term.value.startsWith("-"))) continue;
      expect(project(entry, c.expected), c.name).toEqual(c.expected);
    }
  });
});
