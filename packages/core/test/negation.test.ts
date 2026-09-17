import { describe, it, expect } from "vitest";
import {
  applyQuery,
  negateClause,
  isNegativePredicate,
  isOrGroup,
  predicatesOf,
  normalizeQueryState,
  EMPTY_QUERY,
  MAX_WHERE_CLAUSES,
} from "../src/index";
import type { QueryState, WhereClause } from "../src/index";
import { runsSchema, rows } from "./fixtures";

const base = (over: Partial<QueryState>): QueryState => ({ ...EMPTY_QUERY, ...over });
const ids = (q: QueryState) => applyQuery(rows, q, runsSchema).rows.map((r) => r.id);

describe("negateClause", () => {
  it("flips to the complementary operator when one exists", () => {
    const cases: Array<[WhereClause["op"], WhereClause["op"]]> = [
      ["=", "!="],
      ["!=", "="],
      [">", "<="],
      [">=", "<"],
      ["<", ">="],
      ["<=", ">"],
      ["is_null", "is_not_null"],
      ["is_not_null", "is_null"],
      ["matches_regex", "not_matches_regex"],
    ];
    for (const [op, complement] of cases) {
      const out = negateClause({ field: "f", op, value: "v" });
      expect(out).toEqual({ field: "f", op: complement, value: "v" });
      expect(out.negated).toBeUndefined();
    }
  });

  it("toggles the negated flag for ops with no complement", () => {
    for (const op of ["contains", "starts_with", "ends_with", "includes"] as const) {
      const once = negateClause({ field: "f", op, value: "v" });
      expect(once).toEqual({ field: "f", op, value: "v", negated: true });
      // Involution: negating twice returns to the positive predicate.
      expect(negateClause(once)).toEqual({ field: "f", op, value: "v" });
    }
  });

  it("falls back to the flag when the complement op is not allowed", () => {
    // A field whose allowlist lacks `<` must not be negated into a disabled op.
    const out = negateClause({ field: "f", op: ">=", value: "1" }, ["=", ">="]);
    expect(out).toEqual({ field: "f", op: ">=", value: "1", negated: true });
  });

  it("classifies negative predicates for the two-column CellMenu", () => {
    expect(isNegativePredicate({ op: "!=" })).toBe(true);
    expect(isNegativePredicate({ op: "is_not_null" })).toBe(true);
    expect(isNegativePredicate({ op: "not_matches_regex" })).toBe(true);
    expect(isNegativePredicate({ op: "contains", negated: true })).toBe(true);
    expect(isNegativePredicate({ op: "=" })).toBe(false);
    expect(isNegativePredicate({ op: "contains" })).toBe(false);
  });
});

describe("applyQuery — negated predicates (null-exclusive)", () => {
  it("negated `includes` excludes null AND empty arrays", () => {
    // error_codes: id1 null, id2 [parse,eval], id3 [eval], id4 [].
    // NOT includes "parse" keeps only rows with a non-empty array lacking "parse".
    expect(ids(base({ where: [{ field: "error_codes", op: "includes", value: "parse", negated: true }] }))).toEqual([3]);
  });

  it("negated `contains` is the complement over present values", () => {
    // case_name: alpha, bravo, charlie, delta — only alpha contains "ph".
    expect(ids(base({ where: [{ field: "case_name", op: "contains", value: "ph", negated: true }] }))).toEqual([2, 3, 4]);
  });

  it("a negated flag on a value op behaves like NOT over non-null rows", () => {
    // NOT (total_ms >= 120): id1=120,id2=999 satisfy >=120; id3 null excluded; id4=50 kept.
    expect(ids(base({ where: [{ field: "total_ms", op: ">=", value: "120", negated: true }] }))).toEqual([4]);
  });
});

describe("applyQuery — OR groups (CNF)", () => {
  it("evaluates an OR group as a disjunction", () => {
    expect(
      ids(base({ where: [{ any: [{ field: "overall", op: "=", value: "PASS" }, { field: "overall", op: "=", value: "FAIL" }] }] })),
    ).toEqual([1, 2, 3]);
  });

  it("ANDs an OR group with a sibling literal", () => {
    expect(
      ids(
        base({
          where: [
            { any: [{ field: "overall", op: "=", value: "PASS" }, { field: "overall", op: "=", value: "FAIL" }] },
            { field: "platform", op: "=", value: "windows" },
          ],
        }),
      ),
    ).toEqual([1, 3]);
  });

  it("supports a cross-field OR", () => {
    // macos rows (2,4) OR total_ms > 500 (2) → union.
    expect(
      ids(base({ where: [{ any: [{ field: "platform", op: "=", value: "macos" }, { field: "total_ms", op: ">", value: "500" }] }] })),
    ).toEqual([2, 4]);
  });

  it("an always-true (empty-value) disjunct makes the group match everything", () => {
    // "contains ''" is a no-op; ORed with anything it matches all rows.
    expect(
      ids(base({ where: [{ any: [{ field: "case_name", op: "contains", value: "" }, { field: "overall", op: "=", value: "PASS" }] }] })),
    ).toEqual([1, 2, 3, 4]);
  });
});

describe("normalizeQueryState — CNF canonicalization", () => {
  it("flattens a singleton OR group to a bare literal", () => {
    const q = normalizeQueryState({ where: [{ any: [{ field: "overall", op: "=", value: "PASS" }] }] });
    expect(q.where).toEqual([{ field: "overall", op: "=", value: "PASS" }]);
  });

  it("drops an empty OR group and invalid members", () => {
    const q = normalizeQueryState({
      where: [
        { any: [] },
        { any: [{ field: "overall", op: "=", value: "PASS" }, { field: "x", op: "NOPE", value: "y" }] },
      ],
    });
    // empty group removed; second group loses its invalid member and flattens.
    expect(q.where).toEqual([{ field: "overall", op: "=", value: "PASS" }]);
  });

  it("preserves the negated flag and a multi-member group", () => {
    const q = normalizeQueryState({
      where: [{ any: [{ field: "a", op: "contains", value: "x", negated: true }, { field: "b", op: "=", value: "y" }] }],
    });
    expect(q.where).toHaveLength(1);
    expect(isOrGroup(q.where[0]!)).toBe(true);
    expect(predicatesOf(q.where[0]!)).toEqual([
      { field: "a", op: "contains", value: "x", negated: true },
      { field: "b", op: "=", value: "y" },
    ]);
  });

  it("caps the TOTAL predicate count across terms", () => {
    const many = Array.from({ length: MAX_WHERE_CLAUSES + 10 }, (_, i) => ({ field: `f${i}`, op: "=", value: String(i) }));
    const q = normalizeQueryState({ where: [{ any: many }] });
    const total = q.where.reduce((n, term) => n + predicatesOf(term).length, 0);
    expect(total).toBe(MAX_WHERE_CLAUSES);
  });
});
