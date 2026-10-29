// OR of conjunctions in `where`: { any: [{ all: [clause, clause] }, ...] }.
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  MAX_WHERE_CLAUSES,
  applyQuery,
  branchesOf,
  decodeQueryStrict,
  encodeQuery,
  evaluateMetrics,
  inspectBucketQuery,
  isOrGroup,
  isOrOfAndsGroup,
  isWhereGroup,
  normalizeQueryState,
  predicatesOf,
  removePatch,
  stripSetFilter,
  toServerQuery,
  type AggregationClause,
  type FieldSchema,
  type GroupingState,
  type QueryState,
  type WhereClause,
  type WhereTerm,
} from "../src/index";
import { appendWhereTerms, whereTermKey } from "../src/queryPatch";

type Row = { id: number; provider: string | null; model: string | null; tokens: number };
const schema: FieldSchema<Row> = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "provider", label: "Provider", type: "enum", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "model", label: "Model", type: "text", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "tokens", label: "Tokens", type: "number", source: { kind: "backend" } },
  ],
};
const providers = ["anthropic", "openai", "google", "mistral", "meta", "xai"];
const models = ["opus", "sonnet", "haiku", "gpt-5", "mini"];
const rows: Row[] = [];
for (const [p, provider] of providers.entries()) {
  for (const [m, model] of models.entries())
    for (let k = 0; k <= (p + m) % 3; k++) rows.push({ id: rows.length, provider, model, tokens: 10 * p + m + k });
  rows.push({ id: rows.length, provider, model: null, tokens: 1 });
}
rows.push({ id: rows.length, provider: null, model: "opus", tokens: 1 });

const pairs: [string, string][] = [
  ["anthropic", "opus"], ["anthropic", "haiku"], ["openai", "gpt-5"], ["openai", "mini"], ["google", "sonnet"],
  ["mistral", "opus"], ["meta", "haiku"], ["xai", "gpt-5"], ["xai", "mini"], ["nobody", "opus"],
];
const eq = (field: string, value: string): WhereClause => ({ field, op: "=", value });
const pairTerm = (list: [string, string][]): WhereTerm =>
  ({ any: list.map(([provider, model]) => ({ all: [eq("provider", provider), eq("model", model)] })) });
const term = pairTerm(pairs);
const all = (q: Partial<QueryState>) => applyQuery(rows, { ...EMPTY_QUERY, limit: 10_000, ...q }, schema);
const ids = (q: Partial<QueryState>) => all(q).rows.map((row) => row.id).sort((a, b) => a - b);

/** The union of the pairs' own records, and each present pair's count. */
function oracle() {
  const union = new Set<number>();
  const counts = new Map<string, number>();
  for (const [provider, model] of pairs) {
    const own = ids({ where: [eq("provider", provider), eq("model", model)] });
    own.forEach((id) => union.add(id));
    if (own.length) counts.set(`${provider}/${model}`, own.length);
  }
  return { union: [...union].sort((a, b) => a - b), counts };
}

describe("OR of conjunctions", () => {
  it("normalizes to a canonical shape and is distinguished from plain OR groups", () => {
    const q = normalizeQueryState({ where: [term] });
    expect(q.where).toEqual([term]);
    expect(isOrOfAndsGroup(q.where[0]!) && isWhereGroup(q.where[0]!) && !isOrGroup(q.where[0]!)).toBe(true);
    expect(predicatesOf(term)).toHaveLength(20);
    expect(branchesOf(term)).toHaveLength(10);
    expect(branchesOf({ any: [eq("a", "1"), eq("a", "2")] })).toEqual([[eq("a", "1")], [eq("a", "2")]]);

    const raw = [
      { any: [{ all: [eq("a", "1")] }, { all: [eq("a", "2")] }] }, // → plain OR group
      { any: [{ all: [eq("b", "1"), eq("c", "1")] }] }, // → top-level literals
      { any: [eq("d", "1"), { all: [eq("e", "1"), { field: "e", op: "nope", value: "x" }] }] }, // malformed literal dropped
    ];
    expect(normalizeQueryState({ where: raw as never }).where).toEqual([
      { any: [eq("a", "1"), eq("a", "2")] },
      eq("b", "1"),
      eq("c", "1"),
      { any: [eq("d", "1"), eq("e", "1")] },
    ]);
    // Nested branches and empty conjunctions are not terms.
    expect(normalizeQueryState({ where: [{ any: [{ all: [] }, { all: [{ all: [eq("a", "1")] }] }] }] as never }).where).toEqual([]);
    // Every literal counts against the shared predicate budget.
    const big: WhereTerm = { any: Array.from({ length: 60 }, (_, i) => ({ all: [eq("a", String(i)), eq("b", String(i))] })) };
    expect(predicatesOf(normalizeQueryState({ where: [big] }).where[0]!)).toHaveLength(MAX_WHERE_CLAUSES);
  });

  it("selects exactly the union of ten (provider, model) pairs", () => {
    const { union } = oracle();
    expect(union.length).toBeGreaterThan(15);
    expect(ids({ where: [term] })).toEqual(union);
    // AND with another term, and next to a plain OR group.
    const heavy = ids({ where: [term, { field: "tokens", op: ">=", value: "20" }] });
    expect(heavy).toEqual(union.filter((id) => rows[id]!.tokens >= 20));
    const mixed: WhereTerm = { any: [{ all: [eq("provider", "xai"), eq("model", "mini")] }, eq("model", "opus")] };
    expect(ids({ where: [mixed] })).toEqual(rows.filter((r) => (r.provider === "xai" && r.model === "mini") || r.model === "opus").map((r) => r.id));
  });

  it("keeps negation null-exclusive and blank literals as no-ops inside a branch", () => {
    const negated: WhereTerm = { any: [{ all: [eq("provider", "openai"), { field: "model", op: "contains", value: "gpt", negated: true }] }, eq("provider", "xai")] };
    const got = all({ where: [negated] }).rows;
    expect(got.some((r) => r.provider === "openai" && r.model === null)).toBe(false);
    expect(got.filter((r) => r.provider === "openai").every((r) => r.model && !r.model.includes("gpt"))).toBe(true);
    const blank: WhereTerm = { any: [{ all: [eq("provider", "meta"), { field: "model", op: "contains", value: "" }] }, eq("provider", "xai")] };
    expect(ids({ where: [blank] })).toEqual(rows.filter((r) => r.provider === "meta" || r.provider === "xai").map((r) => r.id));
  });

  it("filters grouped rows as a group filter and as a source filter", () => {
    const { counts } = oracle();
    const grouping: GroupingState = {
      keys: ["provider", "model"],
      summaries: [{ id: "num", op: "count" }],
      representative: null,
      source: normalizeQueryState({}),
    };
    const grouped = (q: Partial<QueryState>) => new Map(applyQuery(rows, normalizeQueryState({ select: [{ field: "provider" }, { field: "model" }, { field: "num" }], limit: 1000, ...q }), schema)
      .rows.map((row) => [`${(row as Record<string, unknown>).provider}/${(row as Record<string, unknown>).model}`, (row as Record<string, unknown>).num]));
    expect(grouped({ grouping, where: [term] })).toEqual(counts);
    expect(grouped({ grouping: { ...grouping, source: normalizeQueryState({ where: [term] }) } })).toEqual(counts);
  });

  it("narrows metrics as a metric filter and as the population", () => {
    const { union, counts } = oracle();
    const metric = (over: Partial<AggregationClause>): AggregationClause => ({ id: "m", op: "count", groupBy: [], ...over });
    const scoped = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [metric({ where: [term] }), metric({ id: "pairs", groupBy: ["provider", "model"], where: [term] })] }, schema);
    expect(scoped.metrics[0]!.buckets[0]!.count).toBe(union.length);
    expect(new Map(scoped.metrics[1]!.buckets.map((b) => [b.keys.join("/"), b.count]))).toEqual(counts);
    const population = evaluateMetrics(rows, { ...EMPTY_QUERY, where: [term], aggregations: [metric({})] }, schema);
    expect(population.metrics[0]!.buckets[0]!.count).toBe(union.length);
  });

  it("round-trips through query links", () => {
    const state = normalizeQueryState({ where: [term, eq("tokens", "3")], aggregations: [{ id: "m", op: "count", groupBy: [], where: [term] }] });
    expect(decodeQueryStrict(encodeQuery(state))).toEqual(state);
    const decoded = decodeQueryStrict(encodeQuery({ ...EMPTY_QUERY, where: [term] }));
    expect(decoded.where).toEqual([term]);
  });

  it("is structural in patches, drill-down and transport", () => {
    // Branch order and literal order within a branch do not change identity.
    const reordered: WhereTerm = pairTerm([...pairs].reverse().map(([p, m]) => [p, m]));
    const swapped: WhereTerm = { any: pairs.map(([p, m]) => ({ all: [eq("model", m), eq("provider", p)] })) };
    expect(whereTermKey(reordered)).toBe(whereTermKey(term));
    expect(whereTermKey(swapped)).toBe(whereTermKey(term));
    expect(whereTermKey(term)).not.toBe(whereTermKey({ any: predicatesOf(term) }));
    expect(appendWhereTerms([term], [swapped])).toEqual([term]);
    const patch = { id: "legend", owns: ["filters" as const], query: { where: [term] } };
    expect(removePatch({ ...EMPTY_QUERY, where: [swapped, eq("tokens", "3")] }, patch).where).toEqual([eq("tokens", "3")]);

    const clause: AggregationClause = { id: "m", op: "count", groupBy: ["provider"], where: [term] };
    const inspected = inspectBucketQuery(EMPTY_QUERY, { keys: ["xai"], value: 1, count: 1 }, clause, schema)!;
    expect(inspected.where).toEqual([term, eq("provider", "xai")]);

    const marked = { ...term, setFilter: { id: "s", mode: "any" as const, values: [] } } as WhereTerm;
    expect(stripSetFilter(marked)).toEqual(term);
    expect(toServerQuery({ ...EMPTY_QUERY, where: [term] }, schema).where).toEqual([term]);
  });
});
