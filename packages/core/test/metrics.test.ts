import { describe, it, expect } from "vitest";
import {
  compileMetric,
  evaluateMetrics,
  applyAggregations,
  metricComputationKey,
  validateMetric,
  toMetricQuery,
  toAggregationQuery,
  encodeQuery,
  decodeQuery,
  normalizeQueryState,
  EMPTY_QUERY,
  boxSummary,
  histogramEdges,
  histogramCounts,
  percentile,
  type AggregationClause,
  type FieldSchema,
  type QueryState,
} from "../src/index";
import { rows, runsSchema } from "./fixtures";
const metric = (
  expression: string,
  extra: Partial<AggregationClause> = {},
): AggregationClause => ({
  id: "m",
  op: "count",
  groupBy: [],
  expression,
  ...extra,
});
const query = (
  c: AggregationClause,
  extra: Partial<QueryState> = {},
): QueryState => ({ ...EMPTY_QUERY, aggregations: [c], ...extra });
const result = (source: string, extra: Partial<AggregationClause> = {}) =>
  evaluateMetrics(rows, query(metric(source, extra)), runsSchema).metrics[0]!;
describe("production metric expressions", () => {
  it("reads only each scalar leaf's field in wide aggregate formulas", () => {
    const reads = Array<number>(12).fill(0);
    const schema: FieldSchema = {
      name: "wide",
      idField: "id",
      fields: [
        { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
        ...reads.map((_, i) => ({
          name: `n${i}`,
          label: `N${i}`,
          type: "number" as const,
          source: { kind: "backend" as const },
        })),
      ],
    };
    const data = [1, 2].map((id) =>
      Object.defineProperties(
        { id },
        Object.fromEntries(
          reads.map((_, i) => [
            `n${i}`,
            { get: () => {
              reads[i] = reads[i]! + 1;
              return id + i;
            } },
          ]),
        ),
      ),
    );
    const expression = reads.map((_, i) => `SUM([n${i}])`).join(" + ");
    const output = evaluateMetrics(
      data, query(metric(expression)), schema,
    );
    expect(output.metrics[0]!.error).toBeUndefined();
    expect(output.metrics[0]!.buckets).toEqual([{ keys: [], count: 2, value: 168 }]);
    expect(reads).toEqual(Array(12).fill(2));
  });
  it("preserves typed field validation, nulls, dates and paired reductions", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const schema: FieldSchema = {
      name: "typed",
      idField: "id",
      fields: [
        { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
        { name: "n", label: "Number", type: "number", source: { kind: "backend" } },
        { name: "s", label: "Text", type: "text", source: { kind: "backend" } },
        { name: "at", label: "Date", type: "datetime", source: { kind: "backend" } },
        { name: "b", label: "Boolean", type: "bool", source: { kind: "backend" } },
      ],
    };
    const data = [
      { id: 1, n: 2, s: "alpha", at: date, b: true },
      { id: 2, n: null, s: null, at: date.toISOString(), b: false },
      { id: 3, n: 4, s: "beta", at: null, b: null },
    ];
    for (const [expression, expected] of [
      ["SUM([n])", 6], ["AVG([n])", 3], ["MIN([s])", "alpha"],
      ["MAX([at])", date.toISOString()], ["COUNT_DISTINCT([b])", 2],
      ["SUM([n])+COUNT([s])", 8], ["SUM([n]+1)", 8],
      ["IF(TRUE,SUM([n]),SUM([n]/0))", 6],
    ] as const) {
      const output = evaluateMetrics(
        data, query(metric(expression)), schema,
      ).metrics[0]!;
      expect(output.error).toBeUndefined();
      expect(output.buckets[0]).toMatchObject({ value: expected });
      expect(output.buckets[0]!.error).toBeUndefined();
    }
    const paired = evaluateMetrics(data, query(metric("SUM([n])", {
      expressionY: "COUNT([b])", display: { kind: "scatter" },
    })), schema).metrics[0]!;
    expect(paired.buckets[0]).toMatchObject({ value: 6, y: 2 });
    for (const [field, value, expression] of [
      ["n", "2", "SUM([n])"], ["s", 2, "MIN([s])"],
      ["b", "true", "COUNT([b])"], ["at", "invalid", "MAX([at])"],
      ["n", Infinity, "SUM([n])"],
    ] as const) {
      const output = evaluateMetrics(
        [{ ...data[0]!, [field]: value }], query(metric(expression)), schema,
      ).metrics[0]!;
      expect(output.buckets[0]!.error).toBeTruthy();
      expect(output.buckets[0]!.inputErrorCount).toBe(1);
    }
    const unsafe = evaluateMetrics([
      { ...data[0]!, n: Number.MAX_SAFE_INTEGER + 1 },
      { ...data[0]!, n: -(Number.MAX_SAFE_INTEGER + 1) },
    ], query(metric("SUM([n])")), schema).metrics[0]!;
    expect(unsafe.buckets[0]!.value).toBeNull();
    expect(unsafe.buckets[0]!.error).toBeTruthy();
    expect(evaluateMetrics(data, query(metric("SUM([n])")), schema, {
      maxOperations: 12,
    }).metrics[0]!.error).toContain("operation budget");
    expect(evaluateMetrics(data, query(metric("SUM([n])")), schema, {
      maxOperations: 13,
    }).metrics[0]!.buckets[0]!.value).toBe(6);
  });
  it("includes null-only SUM groups in an exact Other remainder", () => {
    const data = [
      { ...rows[0]!, total_ms: 100, case_name: "top" },
      { ...rows[0]!, total_ms: 70, case_name: "rest" },
      { ...rows[0]!, total_ms: null, case_name: "empty" },
    ];
    const c = metric("SUM([total_ms])", {
      groupBy: ["case_name"],
      groupLimit: 1,
    });
    const r = evaluateMetrics(data, query(c), runsSchema).metrics[0]!;
    expect(r.other).toEqual({ keys: [], value: 70, count: 2 });
    const nullOnly = evaluateMetrics(
      data.filter((r) => r.case_name !== "rest"),
      query(c),
      runsSchema,
    ).metrics[0]!;
    expect(nullOnly.other).toEqual({ keys: [], value: 0, count: 1 });
  });
  it("gives every metric the same independent operation budget regardless of position", () => {
    const cheap = metric("SUM([total_ms])", { id: "cheap" });
    const expensive = metric("SUM([total_ms] + [total_ms] + [total_ms])", {
      id: "expensive",
    });
    const options = { maxOperations: 25 };
    const alone = evaluateMetrics(rows, query(cheap), runsSchema, options)
      .metrics[0]!;
    expect(alone.error).toBeUndefined();
    const clauses = [expensive, cheap, { ...cheap, id: "copy" }];
    const r = evaluateMetrics(
      rows,
      { ...EMPTY_QUERY, aggregations: clauses },
      runsSchema,
      options,
    );
    expect(r.metrics[0]!.error).toContain("operation budget");
    expect(r.metrics[1]).toEqual(alone);
    expect(r.metrics[2]).toEqual({ ...alone, id: "copy" });
    expect(
      evaluateMetrics(
        rows,
        { ...EMPTY_QUERY, aggregations: [...clauses].reverse() },
        runsSchema,
        options,
      ).metrics.reverse(),
    ).toEqual(r.metrics);
  });
  it("leaves host tie-break ordering out of both V2 row and shown-row metric projections", async () => {
    const { toServerQueryV2 } = await import("../src/index");
    const execution = {
      profile: "qt-postgres-v1",
      planToken: "test-plan",
      fields: {},
      resolvedRevisions: {},
    };
    const schema = { ...runsSchema, defaultSort: [] };
    for (const orderBy of [
      [{ field: "total_ms", dir: "asc" as const }],
      [
        { field: "total_ms", dir: "asc" as const },
        { field: "id", dir: "desc" as const },
      ],
      [],
    ]) {
      const q = query(metric("COUNT()", { scope: "shownRows" }), { orderBy });
      expect(toServerQueryV2(q, schema, execution).orderBy).toEqual(orderBy);
      expect(toMetricQuery(q, schema, execution).orderBy).toEqual(orderBy);
    }
  });
  it("rejects sorts for inactive outputs before sending them to the backend", () => {
    const distribution = { kind: "box" as const, input: "[total_ms]" };
    const samples = [{ key: "samples" as const, dir: "desc" as const }];
    for (const kind of ["auto", "value", "table", "scatter"] as const) {
      const c = metric("COUNT()", {
        distribution,
        display: { kind },
        sort: samples,
        expressionY: "COUNT()",
      });
      expect(validateMetric(c, runsSchema)[0]?.message).toContain(
        "Sample sorting",
      );
      expect(toMetricQuery(query(c), runsSchema).diagnostics[0]?.code).toBe(
        "invalid_metric",
      );
    }
    expect(
      validateMetric(
        metric("COUNT()", { distribution, sort: samples }),
        runsSchema,
      ),
    ).toEqual([]);
    expect(
      validateMetric(
        metric("COUNT()", { sort: [{ key: "y", dir: "asc" }] }),
        runsSchema,
      )[0]?.message,
    ).toContain("Y sorting");
  });
  it("uses the formula AST with row and group contexts and precise spans", () => {
    expect(compileMetric("SUM([total_ms]) / COUNT()", runsSchema).type).toBe(
      "number",
    );
    expect(
      compileMetric('SUM(IF([overall] = "PASS", 1, 0))', runsSchema)
        .dependencies,
    ).toEqual(["overall"]);
    expect(() => compileMetric("SUM(AVG([total_ms]))", runsSchema)).toThrow(
      "Nested",
    );
    expect(() => compileMetric("SUM([total_ms]) + [id]", runsSchema)).toThrow(
      "inside an aggregate",
    );
    expect(() => compileMetric("[id]", runsSchema)).toThrow();
    expect(() => compileMetric('SUM("AVG([id])")', runsSchema)).toThrow(
      "numeric",
    );
    expect(() => compileMetric("COUNT(1,2)", runsSchema)).toThrow(
      "zero or one",
    );
    expect(() => compileMetric("SUM([total_ms]", runsSchema)).toThrow(
      "Expected",
    );
  });
  it("honors field operation overrides in row expressions", () => {
    const restricted = {
      ...runsSchema,
      fields: runsSchema.fields.map((f) =>
        f.name === "total_ms"
          ? { ...f, aggregate: { ops: ["count" as const] } }
          : f,
      ),
    };
    expect(() => compileMetric("SUM([total_ms] + 1)", restricted)).toThrow(
      "does not allow",
    );
    expect(() => compileMetric("COUNT([total_ms])", restricted)).not.toThrow();
  });
  it("keeps strict types, nulls, row errors and lazy group branches", () => {
    expect(result("SUM([total_ms]) / COUNT()").buckets[0]?.value).toBe(
      1169 / 4,
    );
    expect(
      result("IF(COUNT() > 0, SUM([total_ms]), 1 / 0)").buckets[0]?.value,
    ).toBe(1169);
    expect(result("IFERROR(SUM(1 / ([id] - 1)), 7)").buckets[0]).toMatchObject({
      value: 7,
      inputErrorCount: 1,
    });
    expect(result("SUM(1 / ([id] - 1))").buckets[0]).toMatchObject({
      value: null,
      inputErrorCount: 1,
      error: expect.any(String),
    });
    expect(
      result("SUM([total_ms]) / NULLIF(COUNT(), 4)").buckets[0]?.value,
    ).toBeNull();
    expect(result("COALESCE(SUM([total_ms]), 1 / 0)").buckets[0]?.value).toBe(
      1169,
    );
  });
  it("handles empty ungrouped and grouped populations", () => {
    for (const [expression, value] of [
      ["COUNT()", 0],
      ["SUM([total_ms])", null],
    ] as const)
      expect(
        evaluateMetrics([], query(metric(expression)), runsSchema).metrics[0]
          ?.buckets,
      ).toEqual([{ keys: [], count: 0, value }]);
    expect(
      evaluateMetrics(
        [],
        query(metric("COUNT()", { groupBy: ["platform"] })),
        runsSchema,
      ).metrics[0]?.buckets,
    ).toEqual([]);
  });
  it("preserves typed tuple identities and numeric key ordering", () => {
    const schema: FieldSchema = {
      name: "x",
      idField: "id",
      fields: [
        {
          name: "id",
          label: "ID",
          type: "number",
          source: { kind: "backend" },
        },
        {
          name: "k",
          label: "Key",
          type: "text",
          source: { kind: "backend" },
          aggregate: { groupable: true },
        },
      ],
    };
    const rs = [null, "", 1, "1", false, "false", 2, 10].map((k, id) => ({
      id,
      k,
    }));
    const buckets = evaluateMetrics(
      rs,
      query(
        metric("COUNT()", {
          groupBy: ["k"],
          sort: [{ key: "group0", dir: "asc" }],
        }),
      ),
      schema,
    ).metrics[0]!.buckets;
    expect(buckets).toHaveLength(8);
    expect(
      buckets
        .filter((b) => typeof b.keys[0] === "number")
        .map((b) => b.keys[0]),
    ).toEqual([1, 2, 10]);
  });
  it("selects scope before grouping and limits after exact paired reduction", () => {
    const c = metric("SUM([total_ms])", {
      expressionY: "COUNT()",
      display: { kind: "scatter" },
      groupBy: ["platform"],
      groupLimit: 1,
      sort: [{ key: "value", dir: "desc" }],
    });
    expect(
      evaluateMetrics(rows, query(c), runsSchema).metrics[0],
    ).toMatchObject({
      groupCount: 2,
      buckets: [{ keys: ["macos"], value: 1049, y: 2, count: 2 }],
    });
    expect(
      evaluateMetrics(
        rows,
        query(
          { ...c, scope: "shownRows" },
          { limit: 1, offset: 1, orderBy: [{ field: "id", dir: "desc" }] },
        ),
        runsSchema,
      ).metrics[0],
    ).toMatchObject({
      processedRows: 1,
      buckets: [{ keys: ["windows"], value: null, y: 1 }],
    });
  });
  it("places errors last independently of null placement and direction", () => {
    const c = metric("SUM(1 / ([id] - 1))", {
      groupBy: ["platform"],
      sort: [{ key: "value", dir: "asc", nulls: "first" }],
    });
    expect(
      evaluateMetrics(rows, query(c), runsSchema).metrics[0]?.buckets.map(
        (b) => b.keys[0],
      ),
    ).toEqual(["macos", "windows"]);
  });
  it("fails visibly at budgets and rejects unisolated regex", () => {
    expect(
      evaluateMetrics(rows, query(metric("COUNT()")), runsSchema, {
        maxOperations: 1,
      }).metrics[0]?.error,
    ).toContain("budget");
    expect(
      evaluateMetrics(
        rows,
        query(metric("COUNT()", { groupBy: ["platform"] })),
        runsSchema,
        { maxGroups: 1 },
      ).metrics[0]?.error,
    ).toContain("budget");
    expect(result('SUM(IF(REGEX_TEST([case_name], "a"),1,0))').error).toContain(
      "Regex",
    );
    expect(
      result('SUM(IF(REGEX_TEST([case_name], "a"),1,0))', {
        scope: "shownRows",
      }).error,
    ).toContain("watchdog");
    expect(
      validateMetric(metric("COUNT()", { groupBy: ["details"] }), runsSchema),
    ).not.toEqual([]);
  });
});
describe("distribution reductions", () => {
  it("defines continuous percentiles and observed Tukey endpoints", () => {
    expect(boxSummary([0, 10, 20, 30])).toMatchObject({
      q1: 7.5,
      median: 15,
      q3: 22.5,
      mean: 15,
      method: "exact-linear",
    });
    expect(boxSummary([0, 1, 2, 3, 100], "tukey")).toMatchObject({
      low: 0,
      high: 3,
      outliers: [100],
      outlierCount: 1,
    });
    expect(boxSummary([])).toBeNull();
    expect(boxSummary([4])).toMatchObject({ min: 4, max: 4, mean: 4 });
    expect(() => percentile([1], 2)).toThrow();
  });
  it("uses shared edges before ranking, closes only final bin, preserves empty groups", () => {
    const c = metric("COUNT()", {
      groupBy: ["platform"],
      distribution: { kind: "histogram", input: "[total_ms]", bins: 2 },
      display: { kind: "histogram" },
    });
    const all = evaluateMetrics(rows, query(c), runsSchema).metrics[0]!;
    expect(
      all.buckets.every(
        (b) =>
          b.distribution?.kind === "histogram" &&
          JSON.stringify(b.distribution.edges) === "[50,524.5,999]",
      ),
    ).toBe(true);
    expect(
      all.buckets.map((b) =>
        b.distribution?.kind === "histogram" ? b.distribution.counts : [],
      ),
    ).toEqual([
      [1, 1],
      [1, 0],
    ]);
    const limited = evaluateMetrics(
      rows,
      query({ ...c, groupLimit: 1 }),
      runsSchema,
    ).metrics[0]!;
    expect(limited.buckets[0]?.distribution).toEqual(
      all.buckets[0]?.distribution,
    );
    expect(histogramCounts([0, 5, 10], [0, 5, 10])).toEqual([1, 2]);
    expect(histogramEdges([3, 3], 10)).toEqual([3, 3]);
    expect(histogramCounts([3, 3], [3, 3])).toEqual([2]);
  });
  it("fails shared histogram extent on input errors; box errors stay per group", () => {
    const c = metric("COUNT()", {
      groupBy: ["platform"],
      distribution: { kind: "histogram", input: "1 / ([id] - 1)", bins: 2 },
      display: { kind: "histogram" },
    });
    expect(
      evaluateMetrics(rows, query(c), runsSchema).metrics[0]?.error,
    ).toContain("shared extent");
    expect(
      evaluateMetrics(
        rows,
        query({
          ...c,
          distribution: { kind: "box", input: c.distribution!.input },
          display: { kind: "box" },
        }),
        runsSchema,
      ).metrics[0]?.buckets.filter((b) => b.error),
    ).toHaveLength(1);
  });
});
describe("metric boundaries and computation identity", () => {
  it("round-trips whitelisted modern state without object aliases", () => {
    const c = metric("SUM([total_ms])", {
      expressionY: "COUNT()",
      scope: "shownRows",
      sort: [{ key: "group0", dir: "asc", nulls: "first" }],
      groupBy: ["platform"],
      groupLimit: 3,
      display: {
        kind: "scatter",
        format: { kind: "percent", decimals: 2 },
        list: { showValues: true },
        xScale: { mode: "log", min: 0.001, max: 1000 },
        yScale: { mode: "linear", min: -100, max: 500 },
      },
      layout: { widthRem: 20, heightRem: 12, minWidthRem: 8, minHeightRem: 5 },
      distribution: { kind: "box", input: "[total_ms]", whiskers: "tukey" },
    });
    expect(decodeQuery(encodeQuery(query(c)))).toEqual(query(c));
    const normalized = normalizeQueryState(query(c));
    c.display!.format!.decimals = 9;
    expect(normalized.aggregations?.[0]?.display?.format?.decimals).toBe(2);
  });
  it("keeps unsupported definitions as diagnostics and refuses legacy loss", () => {
    const q = normalizeQueryState(
      query(metric("COUNT()", { display: { kind: "auto" } })),
    );
    expect(() => toAggregationQuery(q, runsSchema)).toThrow("version 2");
    const bad = normalizeQueryState({
      ...EMPTY_QUERY,
      aggregations: [
        {
          id: "bad",
          op: "alien",
          groupBy: [],
          expression: { sql: "DROP TABLE" },
        },
      ],
    });
    expect(bad.aggregations).toHaveLength(1);
    expect(
      applyAggregations(rows, bad, runsSchema).metrics[0]?.error,
    ).toBeTruthy();
  });
  it("reports residual CNF predicates and strips presentation from v2 wire", () => {
    const c = metric("COUNT()", {
      label: "Count",
      layout: { widthRem: 10, heightRem: 10, minWidthRem: 5, minHeightRem: 5 },
    });
    const projected = toMetricQuery(
      query(c, {
        where: [
          {
            any: [
              { field: "id", op: "=", value: "1" },
              { field: "error_codes", op: "includes", value: "eval" },
            ],
          },
        ],
      }),
      runsSchema,
    );
    expect(
      projected.diagnostics.some((d) => d.code === "residual_filter"),
    ).toBe(true);
    expect(projected.metrics[0]).not.toHaveProperty("label");
    expect(projected.metrics[0]).not.toHaveProperty("layout");
  });
  it("excludes presentation and card order but includes scope and active paired measures", () => {
    const c = metric("COUNT()"),
      other = { ...c, id: "other" };
    expect(metricComputationKey([c, other])).toBe(
      metricComputationKey([
        other,
        {
          ...c,
          label: "new",
          display: {
            kind: "bar-horizontal",
            format: { kind: "percent" },
            xScale: { mode: "log", min: 1, max: 100 },
          },
          layout: {
            widthRem: 20,
            heightRem: 20,
            minWidthRem: 5,
            minHeightRem: 5,
          },
        },
      ]),
    );
    expect(metricComputationKey([c])).not.toBe(
      metricComputationKey([{ ...c, scope: "shownRows" }]),
    );
    expect(metricComputationKey([c])).not.toBe(
      metricComputationKey([
        { ...c, expressionY: "COUNT()", display: { kind: "scatter" } },
      ]),
    );
  });
});

describe("worker and versioned computed execution bridges", () => {
  it("reduces exact worker outputs and preserves lazy branches after serialization", async () => {
    const {
      compileFormula,
      formulaRuntime,
      metricAggregatePlans,
      reduceMetricValues,
      evaluateMetricReductions,
    } = await import("../src/index");
    const plan = compileMetric(
      "IF(COUNT() > 0, AVG([total_ms]), SUM(1 / 0))",
      runsSchema,
    );
    const args = metricAggregatePlans(plan);
    const reductions = args.map((p, i) =>
      reduceMetricValues(
        plan.aggregates[i]!,
        rows.map((row) =>
          p
            ? formulaRuntime(
                p.ast,
                row as unknown as Record<
                  string,
                  number | string | boolean | null
                >,
              )
            : { value: 1 },
        ),
      ),
    );
    expect(
      evaluateMetricReductions(JSON.parse(JSON.stringify(plan)), reductions),
    ).toEqual({ value: 1169 / 3 });
    const nested = compileFormula("[total_ms] / 2", runsSchema.fields);
    expect(
      compileMetric("SUM([@computed/half])", runsSchema, (name) =>
        name === "@computed/half" ? nested : undefined,
      ).dependencies,
    ).toEqual(["total_ms"]);
  });
  it("gates computed requests by server capabilities and expected revisions", async () => {
    const { toServerQueryV2 } = await import("../src/index");
    const execution = {
      profile: "qt-pg-row-v1",
      planToken: "bound-plan",
      resolvedRevisions: { half: "r1" },
      fields: {
        "@computed/half": {
          type: "number" as const,
          select: true,
          sort: true,
          measure: true,
          group: false,
        },
      },
    };
    const q = query(metric("SUM([@computed/half])"), {
      select: [{ field: "@computed/half" }],
      orderBy: [{ field: "@computed/half", dir: "asc" }],
    });
    expect(normalizeQueryState(q).orderBy).toEqual(q.orderBy);
    const request = toMetricQuery(q, runsSchema, execution);
    expect(request.diagnostics).toEqual([]);
    expect(request.expectedRevisions).toEqual({ half: "r1" });
    expect(toMetricQuery(q, runsSchema).diagnostics.length).toBeGreaterThan(0);
    expect(
      toMetricQuery(q, runsSchema, {
        ...execution,
        resolvedRevisions: {},
      }).diagnostics.some((d) => d.code === "definition_revision"),
    ).toBe(true);
    const rowRequest = toServerQueryV2(q, runsSchema, execution);
    expect(rowRequest.select).toContain("@computed/half");
    expect(rowRequest.orderBy).toEqual([
      { field: "@computed/half", dir: "asc" },
    ]);
    expect(
      toServerQueryV2(q, runsSchema, { ...execution, fields: {} }).diagnostics
        .length,
    ).toBeGreaterThan(0);
  });
  it("supports an authoritative committed page and exact additive Other", () => {
    const c = metric("SUM([total_ms])", {
      groupBy: ["platform"],
      groupLimit: 1,
      display: { kind: "pie" },
    });
    expect(
      evaluateMetrics(rows, query(c), runsSchema).metrics[0]?.other,
    ).toEqual({ keys: [], value: 120, count: 2 });
    expect(
      evaluateMetrics(
        rows,
        query({ ...c, expression: "AVG([total_ms])" }),
        runsSchema,
      ).metrics[0]?.other,
    ).toBeUndefined();
    expect(
      evaluateMetrics(
        rows,
        query(metric("COUNT()", { scope: "shownRows" })),
        runsSchema,
        { shownRows: [rows[0]!] },
      ).metrics[0]?.buckets[0]?.value,
    ).toBe(1);
  });
});

describe("isolated input callback contract", () => {
  it("uses the callback only for regex row inputs and never runs group regex", () => {
    let calls = 0;
    const expression = 'SUM(IF(REGEX_TEST([case_name], "a"), 1, 0)) + COUNT()';
    const output = evaluateMetrics(
      rows,
      query(metric(expression, { scope: "shownRows" })),
      runsSchema,
      {
        evaluateInput: () => {
          calls++;
          return { value: 1 };
        },
      },
    );
    expect(output.metrics[0]?.buckets[0]?.value).toBe(8);
    expect(calls).toBe(4);
    expect(() =>
      compileMetric('REGEX_TEST(MIN([case_name]), "a")', runsSchema),
    ).toThrow("only inside aggregate");
    expect(
      evaluateMetrics(rows, query(metric(expression)), runsSchema, {
        evaluateInput: () => ({ value: 1 }),
      }).metrics[0]?.error,
    ).toContain("all-matching");
  });
  it("expands computed row definitions through the evaluator resolver", async () => {
    const { compileFormula } = await import("../src/index");
    const p = compileFormula("[total_ms] / 2", runsSchema.fields);
    expect(
      evaluateMetrics(
        rows,
        query(metric("SUM([@computed/half])")),
        runsSchema,
        { resolveComputed: () => p },
      ).metrics[0]?.buckets[0]?.value,
    ).toBe(1169 / 2);
  });
  it("does not allow IFERROR to conceal budget exhaustion", () => {
    expect(
      evaluateMetrics(rows, query(metric("IFERROR(SUM([id]),0)")), runsSchema, {
        maxOperations: 5,
      }).metrics[0]?.error,
    ).toContain("budget");
  });
});

describe("definition retention and planner execution guards", () => {
  it("retains malformed grouping definitions with blocking diagnostics", () => {
    for (const groupBy of [
      null,
      ["platform", {}, "overall"],
      Array(21).fill("platform"),
    ]) {
      const q = normalizeQueryState({
        ...EMPTY_QUERY,
        aggregations: [{ id: "m", op: "count", groupBy }],
      });
      expect(q.aggregations).toHaveLength(1);
      expect(q.aggregations?.[0]?.diagnostics?.length).toBeGreaterThan(0);
      expect(
        applyAggregations(rows, q, runsSchema).metrics[0]?.error,
      ).toBeTruthy();
    }
  });
  it("rejects all-matching regex before handing row plans to a worker", async () => {
    const { metricPlans } = await import("../src/index");
    expect(() =>
      metricPlans(
        metric('SUM(IF(REGEX_TEST([case_name], "a"),1,0))'),
        runsSchema,
      ),
    ).toThrow("all-matching");
  });
});

describe("nonfinite distribution and residual predicate boundaries", () => {
  it("rejects invalid public distribution input rather than mis-binning it", () => {
    expect(() => histogramEdges([NaN], 2)).toThrow("finite");
    expect(() => histogramCounts([Infinity], [0, 1])).toThrow("finite");
    expect(() => histogramCounts([1], [])).toThrow("edges");
    expect(() => histogramCounts([1], [0, 0, 2])).toThrow("ordered");
    expect(() => percentile([2, 1], 0.5)).toThrow("sorted");
  });
  it("does not erase a computed predicate before checking exact scope", () => {
    const q = query(metric("COUNT()"), {
      where: [{ field: "@computed/hidden", op: "=", value: "1" }],
    });
    expect(
      toMetricQuery(q, runsSchema).diagnostics.some(
        (d) => d.code === "residual_filter",
      ),
    ).toBe(true);
  });
});

describe("independent core review regressions", () => {
  it("rejects query regex before evaluation and honors pre-aborted signals", async () => {
    const { selectMetricShownRows } = await import("../src/index");
    const q = query(metric("COUNT()", { scope: "shownRows" }), {
      where: [{ field: "case_name", op: "matches_regex", value: "(a+)+$" }],
    });
    let reads = 0;
    const poisoned = [
      {
        ...rows[0]!,
        get case_name(): string {
          reads++;
          throw Error("regex input touched");
        },
      },
    ];
    const controller = new AbortController();
    controller.abort();
    expect(
      evaluateMetrics(poisoned, q, runsSchema, {
        signal: controller.signal,
        maxOperations: 0,
      }).metrics[0]?.error,
    ).toContain("cancelled");
    expect(
      evaluateMetrics(poisoned, q, runsSchema).metrics[0]?.error,
    ).toContain("Query regex");
    expect(() => selectMetricShownRows(poisoned, q, runsSchema)).toThrow(
      "Query regex",
    );
    expect(reads).toBe(0);
    const sorted = query(metric("COUNT()", { scope: "shownRows" }), {
      orderBy: [
        { field: "case_name", dir: "asc", extract: { regex: "(a+)+$" } },
      ],
    });
    expect(
      evaluateMetrics(poisoned, sorted, runsSchema).metrics[0]?.error,
    ).toContain("Query regex");
    expect(
      evaluateMetrics(rows, q, runsSchema, {
        shownRows: [rows[0]!],
        maxRows: 1,
      }).metrics[0]?.buckets[0]?.value,
    ).toBe(1);
    expect(
      evaluateMetrics(
        poisoned,
        { ...q, aggregations: [metric("COUNT()")] },
        runsSchema,
        { shownRows: [] },
      ).metrics[0]?.error,
    ).toContain("Query regex");
  });
  it("never enables inline regex via the old allowRegex flag", () => {
    expect(
      evaluateMetrics(
        rows,
        query(
          metric('COUNT(REGEX_TEST([case_name], "a"))', { scope: "shownRows" }),
        ),
        runsSchema,
        { allowRegex: true },
      ).metrics[0]?.error,
    ).toContain("watchdog");
  });
  it("deduplicates typed primitives incrementally with byte and cardinality budgets", async () => {
    const { reduceMetricValues } = await import("../src/index");
    const node = compileMetric("COUNT_DISTINCT([case_name])", runsSchema)
      .aggregates[0]!;
    const text = "x".repeat(10000),
      input = Array.from({ length: 1000 }, () => ({ value: text }));
    expect(
      reduceMetricValues(node, input, {
        maxDistinctBytes: 20100,
        maxDistinctValues: 1,
      }),
    ).toEqual({ value: 1 });
    expect(
      reduceMetricValues(node, input, { maxDistinctBytes: 20000 }).error,
    ).toContain("budget");
    expect(
      reduceMetricValues(node, [
        { value: 1 },
        { value: "1" },
        { value: false },
        { value: "false" },
        { value: null },
        { value: -0 },
        { value: 0 },
      ]),
    ).toEqual({ value: 5 });
    expect(
      reduceMetricValues(node, [{ value: "a" }, { value: "b" }], {
        maxDistinctValues: 1,
      }).error,
    ).toContain("budget");
    expect(reduceMetricValues(node, [{ value: NaN }]).error).toContain(
      "finite scalars",
    );
    const rs = input.map((r, id) => ({ ...rows[0]!, id, case_name: r.value }));
    const q = query(metric("COUNT_DISTINCT([case_name])"));
    expect(
      evaluateMetrics(rs, q, runsSchema, {
        maxDistinctBytes: 20100,
        maxDistinctValues: 1,
      }).metrics[0]?.buckets[0]?.value,
    ).toBe(1);
    expect(
      evaluateMetrics(rs, q, runsSchema, { maxDistinctBytes: 20000 }).metrics[0]
        ?.buckets[0]?.error,
    ).toContain("budget");
  });
  const computedSchema: FieldSchema = {
    ...runsSchema,
    fields: [
      ...runsSchema.fields,
      {
        name: "@computed/c",
        label: "C",
        type: "number",
        source: { kind: "derived", computedId: "c", accessor: () => 1 },
        aggregate: { measure: true, groupable: true },
        sort: { enabled: true },
      },
    ],
  };
  const execution = {
    profile: "qt-pg-row-v1",
    planToken: "p",
    snapshot: "s1",
    resolvedRevisions: { c: "r1" },
    fields: {
      "@computed/c": {
        type: "number" as const,
        select: true,
        sort: true,
        measure: true,
        group: true,
      },
    },
  };
  it("requires server authority independently of existing local computed schema flags", () => {
    const q = query(metric("SUM([@computed/c])"));
    expect(toMetricQuery(q, computedSchema).diagnostics.length).toBeGreaterThan(
      0,
    );
    expect(
      toMetricQuery(q, computedSchema, { ...execution, fields: {} }).diagnostics
        .length,
    ).toBeGreaterThan(0);
    expect(
      toMetricQuery(q, computedSchema, {
        ...execution,
        resolvedRevisions: {},
      }).diagnostics.some((d) => d.code === "definition_revision"),
    ).toBe(true);
    expect(toMetricQuery(q, computedSchema, execution)).toMatchObject({
      diagnostics: [],
      snapshot: "s1",
    });
    expect(toMetricQuery(q, runsSchema, execution).diagnostics).toEqual([]);
    expect(
      toMetricQuery(
        query(metric("COUNT()", { groupBy: ["@computed/c"] })),
        computedSchema,
        { ...execution, fields: {} },
      ).diagnostics.length,
    ).toBeGreaterThan(0);
  });
  it("shares default/computed ordering gates and revision checks with the row projector", async () => {
    const { toServerQueryV2 } = await import("../src/index");
    const q = query(metric("COUNT()", { scope: "shownRows" }));
    const localDefault: FieldSchema = {
      ...runsSchema,
      defaultSort: [{ field: "local", dir: "desc" }],
      fields: [
        ...runsSchema.fields,
        {
          name: "local",
          label: "Local",
          type: "number",
          source: { kind: "derived", accessor: () => 0 },
          sort: { enabled: true },
        },
      ],
    };
    expect(toMetricQuery(q, localDefault).diagnostics.length).toBeGreaterThan(
      0,
    );
    for (const [sort, env] of [
      [
        { field: "@computed/c", dir: "asc" as const },
        { ...execution, resolvedRevisions: {} },
      ],
      [
        {
          field: "@computed/c",
          dir: "asc" as const,
          extract: { regex: "(a+)+$" },
        },
        execution,
      ],
    ] as const) {
      const schema = { ...computedSchema, defaultSort: [sort] };
      expect(
        toMetricQuery(q, schema, env).diagnostics.map((d) => d.code),
      ).toEqual(
        toServerQueryV2(
          { ...q, select: [{ field: "id" }] },
          schema,
          env,
        ).diagnostics.map((d) => d.code),
      );
    }
    const schema = {
      ...runsSchema,
      defaultSort: [{ field: "total_ms", dir: "desc" as const }],
    };
    expect(toMetricQuery(q, schema).orderBy).toEqual([
      { field: "total_ms", dir: "desc" },
    ]);
    expect(
      evaluateMetrics(
        rows,
        query(metric("SUM([id])", { scope: "shownRows" }), { limit: 1 }),
        schema,
      ).metrics[0]?.buckets[0]?.value,
    ).toBe(2);
    const tied = [
      { ...rows[1]!, id: 9 },
      { ...rows[1]!, id: 2 },
    ];
    expect(
      evaluateMetrics(
        tied,
        query(metric("SUM([id])", { scope: "shownRows" }), { limit: 1 }),
        schema,
      ).metrics[0]?.buckets[0]?.value,
    ).toBe(2);
  });
  it("keeps legacy aliases working alongside modern siblings", () => {
    const schema: FieldSchema = {
      name: "x",
      idField: "id",
      fields: [
        {
          name: "id",
          label: "ID",
          type: "number",
          source: { kind: "backend" },
        },
        {
          name: "x",
          aliases: ["old_x"],
          label: "X",
          type: "number",
          source: { kind: "backend" },
        },
      ],
    };
    const legacy: AggregationClause = {
      id: "legacy",
      op: "sum",
      field: "old_x",
      groupBy: [],
    };
    const q = query(legacy),
      rs = [
        { id: 1, x: 10 },
        { id: 2, x: 20 },
      ];
    expect(applyAggregations(rs, q, schema).metrics[0]?.buckets[0]?.value).toBe(
      30,
    );
    expect(
      applyAggregations(
        rs,
        { ...q, aggregations: [legacy, metric("COUNT()")] },
        schema,
      ).metrics[0]?.buckets[0]?.value,
    ).toBe(30);
    expect(
      toMetricQuery({ ...q, aggregations: [legacy, metric("COUNT()")] }, schema)
        .diagnostics,
    ).toEqual([]);
  });
  it("does not silently drop malformed predicate, sort, or window state", () => {
    for (const patch of [
      { where: [{ field: "id", op: "bogus", value: "1" }] },
      { orderBy: [{ field: "id", dir: "bogus" }] },
      { limit: NaN },
    ]) {
      const q = {
        ...query(metric("COUNT()", { scope: "shownRows" })),
        ...patch,
      } as QueryState;
      expect(toMetricQuery(q, runsSchema).diagnostics.length).toBeGreaterThan(
        0,
      );
      expect(
        evaluateMetrics(rows, q, runsSchema).metrics[0]?.error,
      ).toBeTruthy();
    }
  });
});

it("normalizes Date grouping values to the same ISO key as datetime text", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const schema: FieldSchema<{ id: number; at: Date | string }> = {
    name: "dates",
    idField: "id",
    fields: [
      { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
      {
        name: "at",
        label: "At",
        type: "datetime",
        source: { kind: "backend" },
        aggregate: { groupable: true },
      },
    ],
  };
  const result = evaluateMetrics(
    [
      { id: 1, at: date },
      { id: 2, at: date.toISOString() },
    ],
    query(metric("COUNT()", { groupBy: ["at"] })),
    schema,
  ).metrics[0]!;
  expect(result.error).toBeUndefined();
  expect(result.buckets).toEqual([
    { keys: [date.toISOString()], count: 2, value: 2 },
  ]);
});
