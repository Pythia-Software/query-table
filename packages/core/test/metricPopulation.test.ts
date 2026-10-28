import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  decodeQuery,
  decodeQueryStrict,
  encodeQuery,
  applyQuery,
  evaluateMetrics,
  inspectBucketQuery,
  metricComputationKey,
  metricPopulationError,
  normalizeQueryState,
  toAggregationQuery,
  toMetricQuery,
  toQueryRequestV3,
  validateMetric,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type QueryCapabilitiesV3,
  type QueryState,
} from "../src/index";

type Row = Record<string, unknown>;
interface ExpectedBucket {
  keys: unknown[];
  count: number;
  value?: unknown;
  box?: Record<string, number>;
  histogram?: { edges: number[]; counts: number[]; n: number };
}
interface Case {
  name: string;
  where?: QueryState["where"];
  orderBy?: QueryState["orderBy"];
  limit?: number;
  grouping?: { keys: string[]; summaries: { id: string; op: "count" }[] };
  metric: AggregationClause;
  expected:
    | { error: true }
    | { groupCount: number; hiddenGroups?: number; processedRows?: number; buckets: ExpectedBucket[] };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/metric-population.json", import.meta.url), "utf8"),
) as { now: string; schema: FieldSchema<Row>; rows: Row[]; cases: Case[] };
const now = Date.parse(fixture.now);

/** The cross-engine contract: only the fields the shared fixture states. */
function projectMetric(entry: AggregationResultEntry, expected: Case["expected"]) {
  if ("error" in expected) return { error: !!entry.error };
  return {
    groupCount: entry.groupCount,
    hiddenGroups: entry.hiddenGroups,
    ...(expected.processedRows !== undefined ? { processedRows: entry.processedRows } : {}),
    buckets: entry.buckets.map((bucket, i) => {
      const want = expected.buckets[i];
      const box = bucket.distribution?.kind === "box" ? bucket.distribution.summary : undefined;
      const histogram = bucket.distribution?.kind === "histogram" ? bucket.distribution : undefined;
      return {
        keys: bucket.keys,
        count: bucket.count,
        ...(want && "value" in want ? { value: bucket.value } : {}),
        ...(want?.box && box ? { box: { n: box.n, min: box.min, q1: box.q1, median: box.median, q3: box.q3, max: box.max } } : {}),
        ...(want?.histogram && histogram ? { histogram: { edges: histogram.edges, counts: histogram.counts, n: histogram.n } } : {}),
      };
    }),
  };
}
function queryFor(c: Case): QueryState {
  const table = {
    ...EMPTY_QUERY,
    where: c.grouping ? [] : (c.where ?? []),
    orderBy: c.orderBy ?? [],
    limit: c.limit ?? 100,
  };
  return {
    ...table,
    aggregations: [c.metric],
    ...(c.grouping
      ? { grouping: { ...c.grouping, representative: null, source: { ...EMPTY_QUERY, where: c.where ?? [] } } }
      : {}),
  };
}

describe("shared metric population fixture (local engine)", () => {
  for (const c of fixture.cases)
    it(c.name, () => {
      const result = evaluateMetrics(fixture.rows, queryFor(c), fixture.schema, { now }).metrics[0]!;
      // toEqual treats an absent expected hiddenGroups as "must be absent".
      expect(projectMetric(result, c.expected), result.error).toEqual(c.expected);
    });
});

const schema = fixture.schema;
const base: AggregationClause = { id: "m", op: "count", groupBy: ["kind"] };
describe("metric population semantics", () => {
  it("never folds hidden groups into the additive Other remainder", () => {
    const result = evaluateMetrics(
      fixture.rows,
      { ...EMPTY_QUERY, aggregations: [{ ...base, op: "sum", field: "ms", minCount: 2, groupLimit: 1 }] },
      schema,
      { now },
    ).metrics[0]!;
    // timeout 1000 is shown; auth 165 and disk 48 form Other; dns 999 and the
    // NULL kind (60) are hidden and excluded from Other.
    expect(result.buckets.map((b) => [b.keys[0], b.value])).toEqual([["timeout", 1000]]);
    expect(result.other).toEqual({ keys: [], value: 213, count: 6 });
    expect(result).toMatchObject({ groupCount: 3, hiddenGroups: 2 });
  });
  it("leaves processedRows as the scope population before the metric filter", () => {
    const result = evaluateMetrics(
      fixture.rows,
      { ...EMPTY_QUERY, aggregations: [{ ...base, where: [{ field: "status", op: "=", value: "ok" }] }] },
      schema,
      { now },
    ).metrics[0]!;
    expect(result.processedRows).toBe(14);
    expect(result.buckets.reduce((n, b) => n + b.count, 0)).toBe(4);
  });
  it("reports zero hidden groups whenever minCount is set", () => {
    const result = evaluateMetrics(fixture.rows, { ...EMPTY_QUERY, aggregations: [{ ...base, minCount: 1 }] }, schema, { now }).metrics[0]!;
    expect(result.hiddenGroups).toBe(0);
    expect(result.groupCount).toBe(5);
  });
  it("validates metric filters like the table WHERE", () => {
    const message = (clause: Partial<AggregationClause>) => validateMetric({ ...base, ...clause }, schema)[0]?.message;
    expect(message({ where: [{ field: "missing", op: "=", value: "x" }] })).toMatch(/cannot filter/);
    expect(message({ where: [{ field: "ms", op: "contains", value: "1" }] })).toMatch(/does not support/);
    expect(message({ where: [{ field: "kind", op: "matches_regex", value: "t.*" }] })).toMatch(/Regex/);
    expect(message({ minCount: 0 })).toMatch(/1–1,000,000/);
    expect(message({ minCount: 2.5 })).toMatch(/1–1,000,000/);
    expect(message({ groupBy: [], minCount: 2 })).toMatch(/grouping field/);
    expect(message({ where: [{ field: "kind", op: "=", value: "dns" }], minCount: 3 })).toBeUndefined();
    const tooMany = Array.from({ length: 101 }, () => ({ field: "kind", op: "=" as const, value: "x" }));
    expect(message({ where: tooMany })).toMatch(/at most 100/);
  });
  it("changes the computation key when the population changes", () => {
    const key = metricComputationKey([base]);
    expect(metricComputationKey([{ ...base, minCount: 2 }])).not.toBe(key);
    expect(metricComputationKey([{ ...base, where: [{ field: "kind", op: "=", value: "dns" }] }])).not.toBe(key);
  });
  it("names unsupported population controls per clause", () => {
    expect(metricPopulationError({ where: [{ field: "kind", op: "=", value: "dns" }] }, {})).toMatch(/metric filters/);
    expect(metricPopulationError({ minCount: 2 }, { filters: true })).toMatch(/minimum rows/);
    expect(metricPopulationError({ where: [], minCount: 2 }, { minCount: true })).toBeUndefined();
  });
  it("sends where and minCount to v2 servers and refuses residual filters", () => {
    const remote: FieldSchema<Row> = {
      ...schema,
      fields: [...schema.fields, { name: "note", label: "Note", type: "text", source: { kind: "derived", dependencies: [] }, filter: { enabled: true } }],
    };
    const ok = toMetricQuery(
      { ...EMPTY_QUERY, aggregations: [{ ...base, minCount: 2, where: [{ field: "status", op: "=", value: "error", setFilter: { id: "s", mode: "any", values: ["error"] } }] }] },
      remote,
    );
    expect(ok.diagnostics).toEqual([]);
    expect(ok.metrics[0]).toMatchObject({ minCount: 2, where: [{ field: "status", op: "=", value: "error" }] });
    expect(ok.metrics[0]!.where![0]).not.toHaveProperty("setFilter");
    const residual = toMetricQuery({ ...EMPTY_QUERY, aggregations: [{ ...base, where: [{ field: "note", op: "=", value: "x" }] }] }, remote);
    expect(residual.diagnostics.map((d) => d.code)).toContain("residual_metric_filter");
    expect(() => toAggregationQuery({ ...EMPTY_QUERY, aggregations: [{ ...base, minCount: 2 }] }, schema)).toThrow(/version 2/);
    expect(() => toAggregationQuery({ ...EMPTY_QUERY, aggregations: [{ ...base, where: [{ field: "kind", op: "=", value: "x" }] }] }, schema)).toThrow(/version 2/);
  });
});

// Requests 10 and 11 from Pharos: minimums over distinct values and summed fields.
describe("measured minimums", () => {
  const usage: FieldSchema<Row> = {
    name: "usage",
    idField: "id",
    fields: [
      { name: "id", label: "ID", type: "text", source: { kind: "backend" }, aggregate: { groupable: false } },
      { name: "model_family", label: "Model", type: "text", source: { kind: "backend" } },
      { name: "conversation_id", label: "Conversation", type: "text", source: { kind: "backend" } },
      { name: "tool_name", label: "Tool", type: "text", source: { kind: "backend" } },
      { name: "call_count", label: "Calls", type: "number", source: { kind: "backend" } },
      { name: "failures", label: "Failures", type: "number", source: { kind: "backend" } },
      { name: "cost", label: "Cost", type: "number", source: { kind: "backend" } },
    ],
  };
  // 40 records in 3 conversations, and 6 records in 6 conversations.
  const records: Row[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, model_family: "opus", conversation_id: `c${i % 3}`, cost: 1 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, model_family: "haiku", conversation_id: `h${i}`, cost: 2 })),
    { id: "x", model_family: "haiku", conversation_id: null, cost: 1 },
  ];
  // One row per tool per day: grep holds 9 calls in 4 rows, read 12 in 3.
  const tools: Row[] = [
    { id: "g1", tool_name: "grep", call_count: 3, failures: 1 },
    { id: "g2", tool_name: "grep", call_count: 3, failures: 0 },
    { id: "g3", tool_name: "grep", call_count: 3, failures: 1 },
    { id: "g4", tool_name: "grep", call_count: null, failures: 0 },
    { id: "r1", tool_name: "read", call_count: 4, failures: 1 },
    { id: "r2", tool_name: "read", call_count: 4, failures: 0 },
    { id: "r3", tool_name: "read", call_count: 4, failures: 2 },
  ];
  const evaluate = (data: Row[], clause: AggregationClause, s = usage) =>
    evaluateMetrics(data, { ...EMPTY_QUERY, aggregations: [clause] }, s, { now }).metrics[0]!;

  it("hides a model used in fewer distinct conversations, however many records it has", () => {
    const clause: AggregationClause = { id: "cost", op: "sum", field: "cost", groupBy: ["model_family"], minCount: { min: 5, distinct: "conversation_id" } };
    const result = evaluate(records, clause);
    expect(result).toMatchObject({ groupCount: 1, hiddenGroups: 1 });
    // The null conversation is not counted, but its record still adds cost.
    expect(result.buckets.map((b) => [b.keys[0], b.count, b.value])).toEqual([["haiku", 7, 13]]);
    // A row minimum of 5 keeps both.
    expect(evaluate(records, { ...clause, minCount: 5 })).toMatchObject({ groupCount: 2, hiddenGroups: 0 });
    // Seven distinct values would hide haiku (6 conversations plus a null).
    expect(evaluate(records, { ...clause, minCount: { min: 7, distinct: "conversation_id" } })).toMatchObject({ groupCount: 0, hiddenGroups: 2 });
  });

  it("hides a tool whose rows sum below the minimum and leaves kept values unchanged", () => {
    const rate: AggregationClause = { id: "rate", op: "count", expression: "SUM([failures]) / SUM([call_count])", groupBy: ["tool_name"] };
    const all = evaluate(tools, rate);
    const result = evaluate(tools, { ...rate, minCount: { min: 10, sum: "call_count" } });
    expect(result).toMatchObject({ groupCount: 1, hiddenGroups: 1 });
    expect(result.buckets).toEqual(all.buckets.filter((b) => b.keys[0] === "read"));
    expect(result.buckets[0]).toMatchObject({ keys: ["read"], count: 3, value: 0.25 });
    // By rows, grep (4 rows) would be kept and read (3) hidden.
    expect(evaluate(tools, { ...rate, minCount: 4 }).buckets.map((b) => b.keys[0])).toEqual(["grep"]);
  });

  it("applies before groupLimit and leaves hidden groups out of Other", () => {
    const result = evaluate(records, { id: "n", op: "count", groupBy: ["conversation_id"], minCount: { min: 2, sum: "cost" }, groupLimit: 1 });
    // c0..c2 hold 14, 13, 13; each haiku conversation holds 2 and the null 1.
    expect(result).toMatchObject({ groupCount: 9, hiddenGroups: 1 });
    expect(result.buckets.map((b) => b.keys[0])).toEqual(["c0"]);
    // Other counts the 26 records of c1 and c2 and the six haiku conversations.
    expect(result.other).toEqual({ keys: [], value: 32, count: 32 });
  });

  it("validates the shape, the field and the metric kind", () => {
    const message = (minCount: unknown, clause: Partial<AggregationClause> = {}) =>
      validateMetric({ id: "m", op: "count", groupBy: ["tool_name"], ...clause, minCount } as AggregationClause, usage)[0]?.message;
    expect(message({ min: 10, sum: "call_count" })).toBeUndefined();
    expect(message({ min: 5, distinct: "conversation_id" })).toBeUndefined();
    expect(message({ min: 0, sum: "call_count" })).toMatch(/1–1,000,000/);
    expect(message({ sum: "call_count" })).toMatch(/1–1,000,000/);
    expect(message({ min: 2, sum: "call_count", distinct: "conversation_id" })).toMatch(/exactly one/);
    expect(message({ min: 2 })).toMatch(/exactly one/);
    expect(message({ min: 2, sum: "call_count", extra: 1 })).toMatch(/exactly one/);
    expect(message({ min: 2, sum: "tool_name" })).toMatch(/numeric field/);
    expect(message({ min: 2, sum: "missing" })).toMatch(/cannot be summed/);
    expect(message({ min: 2, distinct: "missing" })).toMatch(/cannot count distinct/);
    expect(message({ min: 2, distinct: "conversation_id" }, { groupBy: [] })).toMatch(/grouping field/);
    expect(message({ min: 2, sum: "call_count" }, { distribution: { kind: "box", input: "[cost]" } })).toMatch(/distributions/);
    const restricted: FieldSchema<Row> = {
      ...usage,
      fields: usage.fields.map((f) => (f.name === "call_count" ? { ...f, aggregate: { ops: ["count"] } } : f)),
    };
    expect(validateMetric({ id: "m", op: "count", groupBy: ["tool_name"], minCount: { min: 2, sum: "call_count" } }, restricted)[0]?.message).toMatch(/cannot be summed/);
  });

  it("reports hosts and transports without support", () => {
    const measured = { minCount: { min: 5, distinct: "conversation_id" } };
    expect(metricPopulationError(measured, { minCount: true })).toMatch(/distinct values or a sum/);
    expect(metricPopulationError(measured, {})).toMatch(/minimum rows/);
    expect(metricPopulationError(measured, { minCount: true, minCountMeasures: true })).toBeUndefined();
    expect(metricPopulationError({ minCount: 5 }, { minCount: true })).toBeUndefined();
  });

  it("travels to v2 and v3 servers, links and the computation key", () => {
    const clause: AggregationClause = { id: "rate", op: "count", groupBy: ["tool_name"], minCount: { min: 10, sum: "call_count" } };
    const q: QueryState = { ...EMPTY_QUERY, aggregations: [clause] };
    expect(toMetricQuery(q, usage).metrics[0]).toMatchObject({ minCount: { min: 10, sum: "call_count" } });
    const capabilities: QueryCapabilitiesV3 = {
      version: 3, groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false,
      metricFilters: true, metricMinCount: true, metricMinCountMeasures: true, maxRows: 100, maxGroups: 100, maxPopulation: 1000, profile: "p",
    };
    const request = toQueryRequestV3(q, usage, capabilities, undefined, { now, rows: false });
    expect(request.diagnostics).toEqual([]);
    expect(request.metrics[0]).toMatchObject({ minCount: { min: 10, sum: "call_count" } });
    expect(decodeQueryStrict(encodeQuery(q)).aggregations).toEqual([clause]);
    expect(metricComputationKey([clause])).not.toBe(metricComputationKey([{ ...clause, minCount: 10 }]));
  });
});

describe("metric population drilldown", () => {
  it("inspects exactly the records a filtered bucket counted", () => {
    const clause: AggregationClause = {
      ...base,
      where: [{ any: [{ field: "status", op: "=", value: "error" }, { field: "ms", op: ">", value: "500" }] }],
      minCount: 2,
    };
    const table = { ...EMPTY_QUERY, where: [{ field: "at", op: "is_not_null" as const, value: "" }] };
    const result = evaluateMetrics(fixture.rows, { ...table, aggregations: [clause] }, schema, { now }).metrics[0]!;
    for (const bucket of result.buckets) {
      const drill = inspectBucketQuery(table, bucket, clause, schema)!;
      expect(drill.where.slice(0, 2)).toEqual([...table.where, ...clause.where!]);
      expect(applyQuery(fixture.rows, drill, schema, { now }).total).toBe(bucket.count);
    }
  });
});

describe("v3 metric population requests", () => {
  const capabilities: QueryCapabilitiesV3 = {
    version: 3, groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false,
    metricFilters: true, metricMinCount: true, maxRows: 10000, maxGroups: 2000, maxPopulation: 250000, profile: "qt-sqlite-v1",
  };
  const remote: FieldSchema<Row> = {
    ...schema,
    fields: [
      ...schema.fields,
      { name: "note", label: "Note", type: "text", source: { kind: "derived", dependencies: [] }, filter: { enabled: true } },
      { name: "region", label: "Region", type: "text", source: { kind: "backend" }, filter: { enabled: true, pushdown: false } },
    ],
  };
  it("refuses metric filters on non-pushdown fields instead of dropping them", () => {
    for (const field of ["note", "region"]) {
      const request = toQueryRequestV3(
        { ...EMPTY_QUERY, aggregations: [{ ...base, where: [{ field, op: "=", value: "x" }] }] },
        remote, capabilities, undefined, { now },
      );
      expect(request.diagnostics, field).toContain("Metric filters must use server-filterable fields.");
    }
  });
  it("sends pushdown metric filters and calendar metrics without diagnostics", () => {
    const request = toQueryRequestV3(
      { ...EMPTY_QUERY, aggregations: [
        { ...base, where: [{ field: "status", op: "=", value: "error" }], minCount: 2 },
        { id: "days", op: "count", groupBy: ["at"], dateGrouping: { field: "at", interval: "day", includeEmpty: false, range: "observed" } },
      ] },
      remote, capabilities, undefined, { now },
    );
    expect(request.diagnostics).toEqual([]);
    expect(request.metrics[0]).toMatchObject({ where: [{ field: "status", op: "=", value: "error" }], minCount: 2 });
  });
});

describe("metric population state round trips", () => {
  const clause: AggregationClause = {
    ...base,
    minCount: 3,
    where: [
      { field: "status", op: "=", value: "error" },
      { any: [{ field: "kind", op: "=", value: "dns" }, { field: "kind", op: "!=", value: "auth", negated: true }] },
    ],
  };
  it("normalizes, encodes and decodes both fields", () => {
    const state = normalizeQueryState({ ...EMPTY_QUERY, aggregations: [clause] });
    expect(state.aggregations![0]).toEqual(clause);
    expect(decodeQueryStrict(encodeQuery(state)).aggregations![0]).toEqual(clause);
    // Saved queries persist through the same normalization as links.
    expect(normalizeQueryState(JSON.parse(JSON.stringify(state))).aggregations![0]).toEqual(clause);
  });
  it("keeps malformed controls as clause diagnostics instead of widening the population", () => {
    const [a, b, c, d] = normalizeQueryState({
      aggregations: [
        { ...base, id: "a", where: [{ field: "kind", op: "nope", value: "x" }] },
        { ...base, id: "b", where: "status=error" },
        { ...base, id: "c", minCount: 0 },
        { ...base, id: "d", where: [] },
      ],
    }).aggregations!;
    expect(a).toMatchObject({ diagnostics: ["Invalid metric filter."] });
    expect(a).not.toHaveProperty("where");
    expect(b).toMatchObject({ diagnostics: ["Invalid metric filter."] });
    expect(c).toMatchObject({ diagnostics: ["Invalid metric minCount."] });
    expect(c).not.toHaveProperty("minCount");
    expect(d).toEqual({ id: "d", op: "count", groupBy: ["kind"] });
    expect(evaluateMetrics(fixture.rows, { ...EMPTY_QUERY, aggregations: [a!] }, schema).metrics[0]!.error).toMatch(/Invalid metric filter/);
  });
  // Tokens produced by the 0.7.1 encoder, before where/minCount existed.
  const legacy = [
    {
      token: "2d.q1ZKV7KKrlbKTFGyUspT0lHKLwAykvNL80qAnPSi_NICp0qgCqXszLwUpdja2FoA",
      decoded: { select: [], where: [], orderBy: [], limit: 100, offset: 0, aggregations: [{ id: "n", op: "count", groupBy: ["kind"] }] },
    },
    {
      token:
        "2d.jY_LDoIwEEV_xcy6Wzckbkzc-QeERaGVTCiU9IEa0n_3FgET3bibyX2cmZnuVJQz3VgbRQX5IEP0JMiO2E4YJmmixqyds45SJahdEpztHQ9qdzc2DgFL62wcz0-4Fp0QMbLWBpZLLjlsqcV45Z4DFUdB3joMqO40witYkGKHTWnfgJ7ESpZTu3Hf44cK3vZOnzGK_WgkFDTne7bqtJfV9vHHE789OZcWITiuY2A7fKmCeBgj3qKy9xWQVXoB",
      decoded: {
        select: [],
        where: [{ field: "status", op: "=", value: "error" }],
        orderBy: [],
        limit: 100,
        offset: 0,
        aggregations: [
          { id: "kinds", op: "count", groupBy: ["kind"], label: "Error kinds", groupLimit: 5, sort: [{ key: "value", dir: "desc" }] },
          { id: "avg", op: "avg", groupBy: [], field: "ms", display: { kind: "value" } },
          { id: "box", op: "count", groupBy: ["kind"], display: { kind: "box" }, distribution: { kind: "box", input: "[ms]" } },
        ],
      },
    },
  ];
  it("decodes 0.7.1 metric links unchanged and re-encodes them byte for byte", () => {
    for (const { token, decoded } of legacy) {
      expect(decodeQuery(token)).toEqual(decoded);
      expect(decodeQueryStrict(token)).toEqual(decoded);
      expect(encodeQuery(decodeQuery(token))).toBe(token);
    }
  });
});
