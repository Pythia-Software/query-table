import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyQuery,
  evaluateMetrics,
  formulaRuntime,
  type AggregationClause,
  type AggregationResultEntry,
  type FieldSchema,
  type FormulaNode,
  type QueryState,
} from "../src/index";

type Row = Record<string, unknown>;
interface Case {
  name: string;
  orderBy?: QueryState["orderBy"];
  metric: AggregationClause;
  refusedBy?: string[];
  expected: { groupCount: number; buckets: { keys: unknown[]; count: number; value: unknown; y?: unknown; error?: true }[] };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/text-functions.json", import.meta.url), "utf8"),
) as {
  now: string;
  schema: FieldSchema<Row>;
  rows: Row[];
  cases: Case[];
  groupedSummaries: { where: QueryState["where"]; grouping: { keys: string[]; summaries: { id: string; op: string; expression?: string }[] }; orderBy: QueryState["orderBy"]; expected: Row[] };
};
const now = Date.parse(fixture.now);

/** The cross-engine contract: only the fields the shared fixture states. */
function projectTextMetric(entry: AggregationResultEntry, expected: Case["expected"]) {
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

describe("shared text function fixture (local engine)", () => {
  for (const c of fixture.cases)
    it(c.name, () => {
      const query: QueryState = { ...EMPTY_QUERY, orderBy: c.orderBy ?? [], limit: 100, aggregations: [c.metric] };
      // Regex metrics run in a terminable worker in the browser; evaluate them inline here.
      const result = evaluateMetrics(fixture.rows, query, fixture.schema, {
        now,
        evaluateInput: (node, row) => formulaRuntime(node, row as never),
      }).metrics[0]!;
      expect(result.error).toBeUndefined();
      expect(projectTextMetric(result, c.expected)).toEqual(c.expected);
    });
  it("grouped formula summaries", () => {
    const g = fixture.groupedSummaries;
    const query = {
      ...EMPTY_QUERY,
      select: [...g.grouping.keys, ...g.grouping.summaries.map((s) => s.id)].map((field) => ({ field })),
      orderBy: g.orderBy,
      limit: 100,
      grouping: { ...g.grouping, representative: null, source: { ...EMPTY_QUERY, where: g.where } },
    } as QueryState;
    const rows = applyQuery(fixture.rows, query, fixture.schema, { now }).rows as Row[];
    expect(rows.map((row) => Object.fromEntries(Object.keys(g.expected[0]!).map((key) => [key, row[key]])))).toEqual(g.expected);
  });
});

describe("shared formula regex fixture (browser semantics)", () => {
  const regex = JSON.parse(
    readFileSync(new URL("../../../schema/fixtures/formula-regex.json", import.meta.url), "utf8"),
  ) as {
    inputs: string[];
    cases: {
      pattern: string;
      flags: string;
      replacement: string;
      group: number;
      invalid: boolean;
      results?: { test: boolean; extract: string | null; replace: string | null | { error: true } }[];
    }[];
  };
  const lit = (value: string | number): FormulaNode => ({ kind: "literal", value, from: 0, to: 0 });
  const call = (name: string, ...args: (string | number)[]): FormulaNode => ({ kind: "call", name, args: args.map(lit), from: 0, to: 0 });
  for (const c of regex.cases)
    it(`/${c.pattern}/${c.flags}`, () => {
      const test = (input: string) => formulaRuntime(call("REGEX_TEST", input, c.pattern, c.flags), {});
      if (c.invalid) {
        expect(test("").error).toBeDefined();
        return;
      }
      expect(
        regex.inputs.map((input) => {
          const replace = formulaRuntime(call("REGEX_REPLACE", input, c.pattern, c.replacement, c.flags), {});
          return {
            test: test(input).value,
            extract: formulaRuntime(call("REGEX_EXTRACT", input, c.pattern, c.group, c.flags), {}).value,
            replace: replace.error ? { error: true } : replace.value,
          };
        }),
      ).toEqual(c.results);
    });
});
