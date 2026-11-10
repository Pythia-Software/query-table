import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection as NativeConnection } from "@duckdb/node-api";
import {
  EMPTY_QUERY,
  normalizeQueryState,
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
  await native.run('CREATE TABLE calls (id VARCHAR, kind VARCHAR, status VARCHAR, ms DOUBLE, "at" TIMESTAMPTZ, session VARCHAR, calls BIGINT)');
  for (const row of fixture.rows)
    await native.run("INSERT INTO calls VALUES ($1,$2,$3,$4,CAST($5 AS TIMESTAMPTZ),$6,$7)", [
      row.id as string, row.kind as string, row.status as string, row.ms as number, row.at as string,
      row.session as string, row.calls as number,
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
      // Refused cases (an ungrouped minCount, an invalid formula) are
      // client-side QueryErrors as well; build their request without
      // minCount and with a plain count, then put them back, so the backend's
      // own validation is exercised. Every other case goes through the client.
      const query = queryFor(c);
      const refused = "error" in c.expected;
      const request = toQueryRequestV3(refused ? { ...query, aggregations: query.aggregations!.map(({ minCount: _minCount, expression: _expression, ...clause }) => clause) } : query,
        fixture.schema, backend.capabilities, undefined, { now, rows: false });
      const { minCount, expression } = query.aggregations![0]!;
      const result = await backend.execute(refused ? { ...request, metrics: [{ ...request.metrics[0]!, ...(minCount !== undefined ? { minCount } : {}), ...(expression !== undefined ? { expression } : {}) }] } : request);
      const entry = result.metrics[0]!;
      expect(project(entry, c.expected), entry.error).toEqual(c.expected);
    });
});

describe("DuckDB metric population transport", () => {
  it("advertises both controls on the v3 handshake, and only the v3 executor", () => {
    const transport = backend.transport();
    expect(transport.queryCapabilities).toMatchObject({ metricFilters: true, metricMinCount: true, metricMinCountMeasures: true });
    expect(Object.keys(transport).sort()).toEqual(["fetchQueryV3", "queryCapabilities"]);
  });
});
