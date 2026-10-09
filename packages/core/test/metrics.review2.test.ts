import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  boxSummary,
  compileMetric,
  evaluateMetricReductions,
  evaluateMetrics,
  histogramCounts,
  histogramEdges,
  metricDependencies,
  percentile,
  reduceMetricValues,
  type AggregationClause,
  type FieldSchema,
  type MetricEvaluationOptions,
} from "../src/index";

const schema: FieldSchema = {
  name: "review2",
  idField: "id",
  fields: [
    {
      name: "id",
      label: "ID",
      type: "number",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
    { name: "x", label: "X", type: "number", source: { kind: "backend" } },
    {
      name: "g",
      aliases: ["old_g"],
      label: "Group",
      type: "text",
      source: { kind: "backend" },
    },
  ],
};
const clause = (
  expression = "COUNT()",
  extra: Partial<AggregationClause> = {},
): AggregationClause => ({
  id: "m",
  op: "count",
  expression,
  groupBy: [],
  ...extra,
});
const evaluate = (
  rows: Record<string, unknown>[],
  c = clause(),
  options: MetricEvaluationOptions<Record<string, unknown>> = {},
) =>
  evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [c] }, schema, options)
    .metrics[0]!;

describe("second-review grouping allocation bounds", () => {
  it.each([undefined, 100000])(
    "bounds shared payload amplification with default/custom bytes %s",
    (maxGroupBytes) => {
      const shared = "x".repeat(10000);
      const rows = Array.from({ length: 1000 }, (_, id) => ({ id, g: shared }));
      const stringify = JSON.stringify;
      let chars = 0,
        calls = 0;
      const spy = vi.spyOn(JSON, "stringify").mockImplementation(((
        value: unknown,
        ...args: unknown[]
      ) => {
        const result = (stringify as (...args: unknown[]) => string)(
          value,
          ...args,
        );
        if (Array.isArray(value) && value[0] === shared) {
          chars += result.length;
          calls++;
        }
        return result;
      }) as typeof JSON.stringify);
      try {
        expect(
          evaluate(
            rows,
            clause("COUNT()", { groupBy: ["g", "id"] }),
            maxGroupBytes === undefined ? {} : { maxGroupBytes },
          ),
        ).toMatchObject({
          buckets: [],
          error: expect.stringContaining("retained-memory budget"),
        });
        expect(calls).toBeLessThan(1000);
        expect(chars * 2).toBeLessThan(maxGroupBytes ?? 16000000);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it("rejects oversized keys and candidate allocations before stringify", () => {
    const stringify = JSON.stringify;
    for (const [g, options] of [
      ["x".repeat(100000), {}],
      ["x".repeat(1000), { maxGroupKeyLength: 100 }],
      ["\u0000".repeat(100), { maxGroupKeyLength: 500 }],
      ["\ud800".repeat(100), { maxGroupKeyLength: 500 }],
      ["x".repeat(1000), { maxGroupBytes: 100 }],
    ] as const) {
      let keyCalls = 0;
      const spy = vi.spyOn(JSON, "stringify").mockImplementation(((
        value: unknown,
        ...args: unknown[]
      ) => {
        if (Array.isArray(value) && value[0] === g) keyCalls++;
        return (stringify as (...args: unknown[]) => string)(value, ...args);
      }) as typeof JSON.stringify);
      try {
        expect(
          evaluate([{ g }], clause("COUNT()", { groupBy: ["g"] }), options)
            .error,
        ).toContain("budget");
        expect(keyCalls).toBe(0);
      } finally {
        spy.mockRestore();
      }
    }
  });
  it("retains longish values, escaped Unicode and typed tuple distinctions", () => {
    const values = [
      null,
      "",
      false,
      "false",
      1,
      "1",
      "x".repeat(50000),
      '\u0000"\\\ud800😀',
    ];
    const result = evaluate(
      values.map((g) => ({ g })),
      clause("COUNT()", { groupBy: ["g"] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.buckets).toHaveLength(values.length);
    expect(new Set(result.buckets.map((b) => b.keys[0]))).toEqual(
      new Set(values),
    );
    expect(
      evaluate([{ g: "😀" }], clause("COUNT()", { groupBy: ["g"] }), {
        maxGroupKeyLength: 6,
      }).error,
    ).toBeUndefined();
    expect(
      evaluate([{ g: "😀" }], clause("COUNT()", { groupBy: ["g"] }), {
        maxGroupKeyLength: 5,
      }).error,
    ).toContain("key length");
  });
  it("accounts row references even for duplicate and ungrouped rows", () => {
    const rows = Array.from({ length: 100 }, () => ({ g: "same" }));
    for (const groupBy of [[], ["g"]])
      expect(
        evaluate(rows, clause("COUNT()", { groupBy }), { maxGroupBytes: 1000 })
          .error,
      ).toContain("retained-memory");
    const shared = "x".repeat(10000);
    expect(
      evaluate(
        Array.from({ length: 100 }, () => ({ g: shared })),
        clause("COUNT()", { groupBy: ["g"] }),
        { maxGroupBytes: 120000 },
      ).buckets[0]?.value,
    ).toBe(100);
  });
  it.each([-1, NaN, Infinity, 1.5])(
    "rejects invalid grouping budgets %s",
    (value) => {
      for (const options of [
        { maxGroupBytes: value },
        { maxGroupKeyLength: value },
      ])
        expect(evaluate([], clause(), options).error).toContain(
          "Invalid grouping budget",
        );
    },
  );
});

describe("second-review numeric boundaries", () => {
  it.each(["SUM", "AVG", "MIN", "MAX", "COUNT_DISTINCT"])(
    "%s rejects unsafe samples even if the result could be safe",
    (op) => {
      for (const x of [2 ** 53, -(2 ** 53)]) {
        const expression = `${op}([x])`;
        const node = compileMetric(expression, schema).aggregates[0]!;
        expect(
          reduceMetricValues(node, [{ value: x }, { value: 1 }]),
        ).toMatchObject({
          value: null,
          error: expect.stringContaining("safe numeric precision"),
        });
        expect(
          evaluate([{ x }, { x: 1 }], clause(expression)).buckets[0],
        ).toMatchObject({
          value: null,
          error: expect.stringContaining("safe numeric precision"),
        });
      }
    },
  );
  it.each(["SUM", "AVG", "MIN", "MAX"])(
    "%s preserves safe integers, fractions and nulls",
    (op) => {
      for (const x of [
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
        0.1,
        Number.MIN_VALUE,
      ])
        expect(
          evaluate([{ x }], clause(`${op}([x])`)).buckets[0],
        ).toMatchObject({ value: x });
      for (const rows of [[], [{ x: null }]])
        expect(evaluate(rows, clause(`${op}([x])`)).buckets[0]).toEqual({
          keys: [],
          count: rows.length,
          value: null,
        });
    },
  );
  it("checks SUM intermediates and final expression results, including worker reductions", () => {
    expect(
      evaluate(
        [{ x: Number.MAX_SAFE_INTEGER }, { x: 1 }, { x: -1 }],
        clause("SUM([x])"),
      ).buckets[0]?.error,
    ).toContain("safe numeric precision");
    for (const expression of ["MAX([x]) + 1", "AVG([x]) * 2"]) {
      expect(
        evaluate([{ x: Number.MAX_SAFE_INTEGER }], clause(expression))
          .buckets[0],
      ).toMatchObject({ value: null, error: expect.any(String) });
      expect(
        evaluateMetricReductions(compileMetric(expression, schema), [
          { value: Number.MAX_SAFE_INTEGER },
        ]),
      ).toMatchObject({ value: null, error: expect.any(String) });
    }
  });
  it("rejects an unsafe rounded AVG or box mean from individually safe samples", () => {
    const values = Array(3).fill(Number.MAX_SAFE_INTEGER) as number[];
    const node = compileMetric("AVG([x])", schema).aggregates[0]!;
    expect(
      reduceMetricValues(
        node,
        values.map((value) => ({ value })),
      ),
    ).toMatchObject({
      value: null,
      error: expect.stringContaining("safe numeric precision"),
    });
    expect(
      evaluate(
        values.map((x) => ({ x })),
        clause("AVG([x])"),
      ).buckets[0],
    ).toMatchObject({ value: null, error: expect.any(String) });
    expect(() => boxSummary(values)).toThrow("safe numeric precision");
  });
  it("checks consumed worker reductions but preserves lazy branches and explicit error recovery", () => {
    for (const expression of [
      "IF(FALSE, MAX([x]), 7)",
      "COALESCE(7, MAX([x]))",
      "IFERROR(MAX([x]), 7)",
    ]) {
      expect(
        evaluate([{ x: 2 ** 53 }], clause(expression)).buckets[0]?.value,
      ).toBe(7);
      expect(
        evaluateMetricReductions(compileMetric(expression, schema), [
          { value: 2 ** 53 },
        ]),
      ).toEqual({ value: 7 });
    }
    expect(
      evaluateMetricReductions(compileMetric("MAX([x])", schema), [
        { value: 2 ** 53 },
      ]),
    ).toMatchObject({ value: null, error: expect.any(String) });
    expect(
      evaluate([{ x: 2 ** 53 }], clause("COUNT([x])")).buckets[0]?.value,
    ).toBe(1);
  });
  it("enforces numeric distribution samples and public helpers", () => {
    for (const x of [2 ** 53, -(2 ** 53)]) {
      expect(() => percentile([x], 0.5)).toThrow("safe numeric precision");
      expect(() => boxSummary([x])).toThrow("safe numeric precision");
      expect(() => histogramEdges([x], 2)).toThrow("safe numeric precision");
      expect(() =>
        histogramCounts([x], [Math.min(0, x), Math.max(0, x)]),
      ).toThrow("safe numeric precision");
      expect(() =>
        histogramCounts([0], [Math.min(0, x), Math.max(0, x)]),
      ).toThrow("safe numeric precision");
      const box = evaluate(
        [{ x }, { x: null }],
        clause("COUNT()", { distribution: { kind: "box", input: "[x]" } }),
      );
      expect(box.buckets[0]).toMatchObject({
        value: null,
        nullCount: 1,
        inputErrorCount: 1,
        error: expect.any(String),
      });
      expect(box.buckets[0]?.distribution).toBeUndefined();
      expect(
        evaluate(
          [{ x }],
          clause("COUNT()", {
            distribution: { kind: "histogram", input: "[x]", bins: 2 },
          }),
        ).error,
      ).toContain("shared extent");
    }
    expect(boxSummary([0.1, 0.2])?.mean).toBeCloseTo(0.15);
  });
});

describe("canonical grouping dependencies", () => {
  it("returns canonical hidden projection fields without mutating saved aliases or display", () => {
    const c = clause("SUM([x])", {
      groupBy: ["old_g", "g"],
      scope: "shownRows",
      display: { kind: "table" },
      label: "Keep me",
    });
    const before = structuredClone(c);
    expect(metricDependencies(c, schema)).toEqual(["g", "x"]);
    const projected = Object.fromEntries(
      metricDependencies(c, schema).map((name) => [
        name,
        ({ g: "loaded", x: 2 } as Record<string, unknown>)[name],
      ]),
    );
    expect(evaluate([projected], c).buckets[0]).toMatchObject({
      keys: ["loaded", "loaded"],
      value: 2,
    });
    expect(c).toEqual(before);
  });
});
