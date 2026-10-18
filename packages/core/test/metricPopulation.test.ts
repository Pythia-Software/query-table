import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  decodeQuery,
  decodeQueryStrict,
  encodeQuery,
  evaluateMetrics,
  metricComputationKey,
  metricPopulationError,
  normalizeQueryState,
  toAggregationQuery,
  toMetricQuery,
  validateMetric,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
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
