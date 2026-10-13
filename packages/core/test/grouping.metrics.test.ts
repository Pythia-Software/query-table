import { describe, expect, it } from "vitest";
import {
  applyAggregations,
  applyQuery,
  decodeQuery,
  encodeQuery,
  evaluateMetrics,
  normalizeQueryState,
  type AggregationClause,
  type FieldSchema,
  type GroupedRow,
  type QueryState,
} from "../src/index";

const schema: FieldSchema<GroupedRow> = {
  name: "grouped-metrics",
  idField: "id",
  fields: [
    { name: "customer", label: "Customer", type: "text", source: { kind: "backend", path: "owner.name" } },
    { name: "region", label: "Region", type: "text", source: { kind: "backend" } },
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
    { name: "active", label: "Active", type: "bool", source: { kind: "backend" } },
    { name: "created", label: "Created", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
  ],
};
const rows: GroupedRow[] = [
  ["A", "west", 10], ["A", "west", 30], ["A", "west", null],
  ["B", "east", 100], ["C", "west", null], ["D", "east", 5], ["D", "east", 15],
].map(([customer, region, amount], i) => ({
  id: i + 1, owner: { name: customer }, region, amount, active: true,
  created: `2026-10-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
}));
rows.push({ id: 99, owner: { name: "A" }, region: "west", amount: 1000, active: false, created: "2026-10-10T12:00:00Z" });

function metric(id: string, expression: string, extra: Partial<AggregationClause> = {}): AggregationClause {
  return { id, op: "count", groupBy: [], expression, ...extra };
}
function query(extra: Partial<QueryState> = {}): QueryState {
  return normalizeQueryState({
    grouping: {
      source: normalizeQueryState({
        where: [{ field: "active", op: "=", value: "true" }],
        // Neither the old row page nor its metrics may affect grouped results.
        limit: 1, offset: 99, orderBy: [{ field: "amount", dir: "desc" }],
        aggregations: [metric("source", "SUM([amount])")],
      }),
      keys: ["customer", "region"],
      summaries: [
        { id: "n", op: "count" },
        { id: "present", op: "formula", expression: "COUNT([amount])" },
        { id: "total", op: "sum", field: "amount" },
        { id: "average", op: "avg", field: "amount" },
        { id: "median", op: "formula", expression: "MEDIAN([amount])" },
        { id: "latest", op: "row", field: "amount" },
        { id: "latest_date", op: "max", field: "created" },
      ],
      representative: { orderBy: [{ field: "created", dir: "desc", nulls: "last" }] },
    },
    select: [{ field: "customer" }], // Metrics also need non-displayed summaries.
    orderBy: [{ field: "n", dir: "desc" }, { field: "customer", dir: "asc" }],
    limit: 1,
    ...extra,
  });
}

for (const [name, evaluate] of Object.entries({ applyAggregations, evaluateMetrics })) {
  describe(`${name}: metrics on grouped rows`, () => {
    it.each([
      { having: 1, offset: 0, all: 4, shown: 1, total: 160, page: 40 },
      { having: 1, offset: 1, all: 4, shown: 1, total: 160, page: 20 },
      { having: 1, offset: 3, all: 4, shown: 1, total: 160, page: null },
      { having: 1, offset: 4, all: 4, shown: 0, total: 160, page: null },
      { having: 2, offset: 0, all: 2, shown: 1, total: 60, page: 40 },
      { having: 2, offset: 1, all: 2, shown: 1, total: 60, page: 20 },
      { having: 2, offset: 2, all: 2, shown: 0, total: 60, page: null },
      { having: 4, offset: 0, all: 0, shown: 0, total: null, page: null },
    ])("honors WHERE → grouping → HAVING → page ($having, $offset)", ({ having, offset, all, shown, total, page }) => {
      const q = query({
        where: [{ field: "n", op: ">=", value: String(having) }], offset,
        aggregations: [
          { id: "legacy-count", op: "count", groupBy: [] },
          { id: "legacy-sum", op: "sum", field: "total", groupBy: [] },
          metric("all", "COUNT()"), metric("total", "SUM([total])"),
          metric("page-count", "COUNT()", { scope: "shownRows" }),
          metric("page-sum", "SUM([total])", { scope: "shownRows" }),
        ],
      });
      const result = evaluate(rows, decodeQuery(encodeQuery(q))!, schema);
      expect(result.metrics.map(m => m.error)).toEqual(Array(6).fill(undefined));
      expect(result.metrics.map(m => m.buckets[0]?.error)).toEqual(Array(6).fill(undefined));
      expect(result.metrics.map(m => m.buckets[0]?.value)).toEqual([all, total, all, total, shown, page]);
      expect(applyQuery(rows, q, schema).total).toBe(all);
    });

    it("distinguishes group averages, weighted averages, median, and representative values", () => {
      const q = query({ aggregations: [
        metric("group-average", "AVG([average])"),
        metric("weighted", "SUM([total]) / SUM([present])"),
        metric("median-of-medians", "MEDIAN([median])"),
        metric("source-count", "SUM([n])"),
        metric("representative", "SUM([latest])"),
        metric("representatives-present", "COUNT([latest])"),
      ] });
      const values = evaluate(rows, q, schema).metrics.map(m => m.buckets[0]!.value);
      expect(values[0]).toBeCloseTo(130 / 3);
      expect(values.slice(1)).toEqual([32, 20, 7, 115, 2]);
    });

    it("supports metric grouping/ranking independently of the table's group page", () => {
      const q = query({ offset: 99, aggregations: [
        metric("regions", "SUM([total])", { groupBy: ["region"], sort: [{ key: "value", dir: "desc" }], groupLimit: 1 }),
        metric("page", "SUM([total])", { groupBy: ["region"], scope: "shownRows" }),
      ] });
      const [regions, page] = evaluate(rows, q, schema).metrics;
      expect(regions!.buckets).toEqual([{ keys: ["east"], count: 2, value: 120 }]);
      expect(page!.buckets).toEqual([]);
    });

    it("uses group values for histograms, boxes, scatter and calendar metrics", () => {
      const q = query({ aggregations: [
        metric("box", "COUNT()", { distribution: { kind: "box", input: "[average]" }, display: { kind: "box" } }),
        metric("histogram", "COUNT()", { distribution: { kind: "histogram", input: "[average]", bins: 2 }, display: { kind: "histogram" } }),
        metric("scatter", "SUM([total])", { expressionY: "SUM([n])", groupBy: ["region"], display: { kind: "scatter" } }),
        metric("dates", "COUNT()", { groupBy: ["latest_date"], dateGrouping: { field: "latest_date", interval: "day", timeZone: "UTC", includeEmpty: false, range: "observed" } }),
      ] });
      const [box, histogram, scatter, dates] = evaluate(rows, q, schema).metrics;
      expect(box!.buckets[0]!.distribution).toMatchObject({ kind: "box", summary: { min: 10, median: 20, max: 100, n: 3 } });
      expect(histogram!.buckets[0]!.distribution).toMatchObject({ kind: "histogram", edges: [10, 55, 100], counts: [2, 1] });
      expect(scatter!.buckets).toEqual(expect.arrayContaining([
        expect.objectContaining({ keys: ["east"], value: 120, y: 3 }),
        expect.objectContaining({ keys: ["west"], value: 40, y: 4 }),
      ]));
      expect(dates!.buckets.map(b => b.value)).toEqual([1, 1, 1, 1]);
      expect(dates!.buckets.map(b => b.keys[0]).sort()).toEqual([3, 4, 5, 7].map(d => `2026-10-0${d}T00:00:00.000Z`));
    });

    it.each([{ orderBy: [] }, { orderBy: [{ field: "n", dir: "desc" as const }] }])("uses the exact displayed groups with absent/tied ordering $orderBy", ({ orderBy }) => {
      const q = query({ orderBy, limit: 2, aggregations: [metric("shown", "SUM([total])", { scope: "shownRows" })] });
      // ID order differs deliberately from group-key order, with tied counts.
      const input = [
        { ...rows[0], id: 1, owner: { name: "Z" }, amount: 30 },
        { ...rows[0], id: 2, owner: { name: "A" }, amount: 10 },
        { ...rows[0], id: 3, owner: { name: "M" }, amount: 20 },
      ];
      const displayed = applyQuery(input, q, schema).rows;
      const expected = displayed.reduce((sum, row) => sum + Number(row.total), 0);
      expect(evaluate(input, q, schema).metrics[0]!.buckets[0]!.value).toBe(expected);
      expect(evaluate(input, q, schema, { shownRows: displayed }).metrics[0]!.buckets[0]!.value).toBe(expected);
    });

    it("rejects metrics referring to source fields instead of projected group fields", () => {
      const result = evaluate(rows, query({ aggregations: [metric("invalid", "SUM([amount])"), metric("valid", "COUNT()")] }), schema);
      expect(result.metrics[0]!.error).toBeTruthy();
      expect(result.metrics[0]!.buckets).toEqual([]);
      expect(result.metrics[1]!.buckets[0]!.value).toBe(4);
    });
  });
}

it("summarizes 50,000 source rows across 500 groups without leaking either page window into all-matching metrics", () => {
  const input = Array.from({ length: 50_000 }, (_, id) => ({
    id, owner: { name: `c${id % 500}` }, region: "west", amount: id % 97,
    active: true, created: "2026-10-13T12:00:00Z",
  }));
  const q = query({ limit: 25, offset: 25, where: [{ field: "n", op: ">=", value: "100" }],
    aggregations: [metric("all", "COUNT()"), metric("runs", "SUM([n])"), metric("sum", "SUM([total])"),
      metric("page", "COUNT()", { scope: "shownRows" }), metric("page-runs", "SUM([n])", { scope: "shownRows" })],
  });
  expect(evaluateMetrics(input, q, schema).metrics.map(m => m.buckets[0]?.value)).toEqual([
    500, 50_000, input.reduce((sum, row) => sum + row.amount, 0), 25, 2500,
  ]);
});

it("matches an independent oracle across 100 generated filter/group/HAVING/page combinations", () => {
  let seed = 1729;
  const random = (max: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max);
  for (let trial = 0; trial < 100; trial++) {
    const input = Array.from({ length: random(60) }, (_, id) => ({
      id, owner: { name: `c${random(8)}` }, region: `r${random(3)}`,
      amount: random(4) === 0 ? null : random(101) - 50, active: random(3) !== 0,
      created: "2026-10-01T00:00:00Z",
    }));
    const minCount = 1 + random(4), offset = random(12), limit = 1 + random(5);
    const groups = new Map<string, typeof input>();
    for (const row of input.filter(r => r.active)) {
      const key = JSON.stringify([row.owner.name, row.region]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const expected = [...groups.values()].filter(g => g.length >= minCount).map(g => {
      const values = g.flatMap(r => r.amount === null ? [] : [r.amount]).sort((a, b) => a - b);
      return { customer: g[0]!.owner.name, region: g[0]!.region, n: g.length,
        total: values.length ? values.reduce((a, b) => a + b, 0) : null,
        median: values.length ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2 : null };
    }).sort((a, b) => b.n - a.n || a.customer.localeCompare(b.customer) || a.region.localeCompare(b.region));
    const page = expected.slice(offset, offset + limit);
    const sum = (items: typeof expected, field: "total" | "n") => {
      const numbers = items.flatMap(r => r[field] === null ? [] : [r[field]!]);
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) : null;
    };
    const q = query({ where: [{ field: "n", op: ">=", value: String(minCount) }], limit, offset,
      orderBy: [{ field: "n", dir: "desc" }, { field: "customer", dir: "asc" }, { field: "region", dir: "asc" }],
      aggregations: [metric("all", "COUNT()"), metric("sum", "SUM([total])"), metric("count", "SUM([n])"),
        metric("page", "COUNT()", { scope: "shownRows" }), metric("page-sum", "SUM([total])", { scope: "shownRows" })],
    });
    const actual = applyQuery(input, q, schema);
    expect(actual.total, `trial ${trial}`).toBe(expected.length);
    expect(actual.rows.map(({ customer, region, n, total, median }) => ({ customer, region, n, total, median }))).toEqual(page);
    for (const evaluate of [evaluateMetrics, applyAggregations])
      expect(evaluate(input, q, schema).metrics.map(m => m.buckets[0]?.value), `trial ${trial}`).toEqual([expected.length, sum(expected, "total"), sum(expected, "n"), page.length, sum(page, "total")]);
  }
});
