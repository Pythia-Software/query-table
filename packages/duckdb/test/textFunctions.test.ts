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
  orderBy?: QueryState["orderBy"];
  metric: AggregationClause;
  refusedBy?: string[];
  expected: { groupCount: number; buckets: Record<string, unknown>[] };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/text-functions.json", import.meta.url), "utf8"),
) as {
  now: string;
  schema: FieldSchema;
  rows: Row[];
  cases: Case[];
  groupedSummaries: { where: QueryState["where"]; grouping: { keys: string[]; summaries: { id: string; op: string; expression?: string }[] }; orderBy: QueryState["orderBy"]; expected: Row[] };
};
const now = Date.parse(fixture.now);
const BOM = String.fromCharCode(0xfeff);

/** The fixture's expectations, adjusted for two known DuckDB differences that
 * are not about text functions: an all-NULL SUM is 0 in DuckDB (see
 * backend.test.ts), and @duckdb/node-api decodes text that starts with U+FEFF
 * without it. */
function expectedFor(c: Case): Case["expected"] {
  return {
    ...c.expected,
    buckets: c.expected.buckets.map((bucket) => ({
      ...bucket,
      value:
        bucket.value === null && c.metric.expression?.startsWith("SUM(")
          ? 0
          : typeof bucket.value === "string" && bucket.value.startsWith(BOM)
            ? bucket.value.slice(1)
            : bucket.value,
    })),
  };
}
/** Same projection as the core fixture test. */
function project(entry: AggregationResultEntry, expected: Case["expected"]) {
  return {
    groupCount: entry.groupCount,
    buckets: entry.buckets.map((bucket, i) => ({
      keys: bucket.keys,
      count: Number(bucket.count),
      value: bucket.value,
      ...(expected.buckets[i] && "y" in expected.buckets[i]! ? { y: bucket.y } : {}),
      ...(bucket.error ? { error: true } : {}),
    })),
  };
}

let native: NativeConnection, backend: DuckDBBackend;
const run = async (sql: string, args: unknown[] = []) => (await native.runAndReadAll(sql, args as never[])).getRowObjectsJS();
beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  native = await instance.connect();
  await native.run("CREATE TABLE messages (id VARCHAR, conversation_id VARCHAR, role VARCHAR, text VARCHAR)");
  for (const row of fixture.rows)
    await native.run("INSERT INTO messages VALUES ($1,$2,$3,$4)", [row.id, row.conversation_id, row.role, row.text] as never[]);
  backend = new DuckDBBackend({ relation: "messages", schema: fixture.schema, connection: { query: async (sql, args) => run(sql, args) } });
});
afterAll(() => native?.closeSync());

describe("shared text function fixture (DuckDB)", () => {
  for (const c of fixture.cases)
    it(c.name, async () => {
      const query = normalizeQueryState({ ...EMPTY_QUERY, orderBy: c.orderBy ?? [], limit: 100, aggregations: [c.metric] });
      const request = toQueryRequestV3(query, fixture.schema, backend.capabilities, undefined, { now, rows: false });
      const entry = (await backend.execute(request)).metrics[0]!;
      if (c.refusedBy?.includes("duckdb")) {
        expect(entry.error).toMatch(/not available in the qt-duckdb-v1/);
        return;
      }
      expect(entry.error).toBeUndefined();
      expect(project(entry, c.expected)).toEqual(expectedFor(c));
    });
  it("grouped formula summaries", async () => {
    const g = fixture.groupedSummaries;
    const query = normalizeQueryState({
      ...EMPTY_QUERY,
      select: [...g.grouping.keys, ...g.grouping.summaries.map((s) => s.id)].map((field) => ({ field })),
      orderBy: g.orderBy,
      limit: 100,
      grouping: { ...g.grouping, representative: null, source: { ...EMPTY_QUERY, where: g.where } },
    } as QueryState);
    const result = await backend.execute(toQueryRequestV3(query, fixture.schema, backend.capabilities, undefined, { now }));
    expect(result.rows.map((row) => Object.fromEntries(Object.keys(g.expected[0]!).map((key) => [key, row[key]])))).toEqual(g.expected);
  });
});

describe("DuckDB text functions match the browser", () => {
  beforeAll(async () => {
    const rows: [string, string][] = [["spaces", " ".repeat(9999)], ["many", " ".repeat(10000)], ["emoji", String.fromCodePoint(0x1f600)], ["words", ("w\n" + String.fromCharCode(0x3000)).repeat(20000)]];
    for (const [id, text] of rows) await native.run("INSERT INTO messages VALUES ($1,'bounds','user',$2)", [id, text] as never[]);
  });
  const metric = async (expression: string, id?: string) => {
    const query = normalizeQueryState({
      ...EMPTY_QUERY,
      limit: 100,
      where: id ? [{ field: "id", op: "=", value: id }] : [],
      aggregations: [{ id: "m", op: "count", expression, groupBy: [] }],
    });
    const entry = (await backend.execute(toQueryRequestV3(query, fixture.schema, backend.capabilities, undefined, { now, rows: false }))).metrics[0]!;
    return entry.error ?? entry.buckets[0]?.value;
  };
  it("splits like String.prototype.split", async () => {
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT("aaa", "aa")))')).toBe(2);
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT("", "")))')).toBe(0);
    expect(await metric('MIN(IF(IS_EMPTY(SPLIT("", "")), 1, 0))')).toBe(1);
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT("", ",")))')).toBe(1);
    expect(await metric('MIN(IF(ARRAY_CONTAINS(SPLIT([text], ""), "t"), 1, 0))', "m03")).toBe(1);
  });
  it("bounds arrays at 10,000 elements", async () => {
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT([text], " ")))', "spaces")).toBe(10000);
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT([text], " ")))', "many")).toMatch(/Array result is too large/);
    expect(await metric('MIN(IF(IS_EMPTY(SPLIT([text], " ")), 1, 0))', "many")).toMatch(/Array result is too large/);
  });
  it("counts words without the array bound", async () => {
    expect(await metric("MIN(WORD_COUNT([text]))", "words")).toBe(20000);
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT([text], "\\n")))', "words")).toMatch(/Array result is too large/);
    expect(await metric("MIN(WORD_COUNT([text]))", "spaces")).toBe(0);
  });
  it("counts an empty-separator split in UTF-16 code units", async () => {
    expect(await metric('MIN(ARRAY_LENGTH(SPLIT([text], "")))', "emoji")).toBe(2);
    expect(await metric('MIN(IF(IS_EMPTY(SPLIT([text], "")), 1, 0))', "emoji")).toMatch(/supplementary character/);
  });
});
