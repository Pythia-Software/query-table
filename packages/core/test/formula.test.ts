import { describe, expect, it } from "vitest";
import {
  compileFormula,
  formulaRuntime,
  groupPreview,
  memoryComputedColumnStore,
  validateComputedColumn,
  normalizeQueryState,
  EMPTY_QUERY,
  encodeQuery,
  decodeQuery,
  toServerQuery,
  type FieldSchema,
  type FormulaValue,
} from "../src/index";
const fields = [
  { name: "name", type: "text" as const },
  { name: "amount", type: "number" as const },
  { name: "tags", type: "textarray" as const },
  { name: "at", type: "datetime" as const },
  { name: "a]b", type: "text" as const },
];
const inputs: Record<string, FormulaValue> = {
  name: "  Alex@example.com  ",
  amount: 123.456,
  tags: ["b", "a", "b"],
  at: "2024-02-29T12:34:56Z",
  "a]b": "ok",
};
function run(source: string, row = inputs) {
  return formulaRuntime(compileFormula(source, fields).ast, row);
}
describe("computed formula language", () => {
  it.each([
    ['LEFT("🦋abc", 2)', "🦋a"],
    ['RIGHT("abc",0)', ""],
    ['SUBSTRING("abcd",2,2)', "bc"],
    ['LENGTH("🦋a")', 2],
    ['LOWER("ABC")', "abc"],
    ['UPPER("abc")', "ABC"],
    ["TRIM([name])", "Alex@example.com"],
    ['LTRIM(" x ")', "x "],
    ['RTRIM(" x ")', " x"],
    ['REPLACE("aba","a","x")', "xbx"],
    ['LPAD("a",3,"🦋")', "🦋🦋a"],
    ['RPAD("abc",2)', "ab"],
    ['SPLIT_PART("a:b",":",2)', "b"],
    ['CONCAT("a","b")', "ab"],
    ['CONCAT_WS(" ","a",NULL,"b")', "a b"],
    ['CONTAINS("ABC","b",TRUE)', true],
    ['STARTS_WITH("abc","a")', true],
    ['ENDS_WITH("abc","C")', false],
    ['REGEX_TEST("ABC","^abc$","i")', true],
    ['REGEX_EXTRACT("a@example.com","@(.+)$",1)', "example.com"],
    ['REGEX_REPLACE("abc123","([0-9]+)","<$1>")', "abc<123>"],
    ["ABS(-2)", 2],
    ["FLOOR(1.7)", 1],
    ["CEIL(1.2)", 2],
    ["TRUNC(-1.8)", -1],
    ["SQRT(9)", 3],
    ["ROUND([amount],1)", 123.5],
    ["POWER(2,3)", 8],
    ["CLAMP(20,1,10)", 10],
    ["LEAST(5,1,9)", 1],
    ["GREATEST(5,1,9)", 9],
    ["IF(FALSE,1/0,2)", 2],
    ["IFS(FALSE,1,TRUE,2,3)", 2],
    ['SWITCH("x","a",1,"x",2,3)', 2],
    ["COALESCE(NULL,2,1/0)", 2],
    ["NULLIF(2,2)", null],
    ["IS_NULL(NULL)", true],
    ['IS_EMPTY("")', true],
    ["IFERROR(1/0,42)", 42],
    ["TO_TEXT(12)", "12"],
    ['TO_NUMBER("12.5")', 12.5],
    ['TO_BOOLEAN("false")', false],
    ['TO_DATETIME("2024-02-29")', "2024-02-29T00:00:00.000Z"],
    ['SPLIT("a:b",":")', ["a", "b"]],
    ['JOIN([tags],",")', "b,a,b"],
    ["ARRAY_LENGTH([tags])", 3],
    ['ARRAY_CONTAINS([tags],"a")', true],
    ["ARRAY_GET([tags],2)", "a"],
    ["ARRAY_UNIQUE([tags])", ["b", "a"]],
    ["ARRAY_SORT([tags])", ["a", "b", "b"]],
    ["YEAR([at])", 2024],
    ["MONTH([at])", 2],
    ["DAY([at])", 29],
    ["HOUR([at])", 12],
    ["WEEKDAY([at])", 4],
    ['DATE_TRUNC("month",[at])', "2024-02-01T00:00:00.000Z"],
    ['DATE_ADD("year",1,[at])', "2025-02-28T12:34:56.000Z"],
    ['DATE_DIFF("day",TO_DATETIME("2024-02-28"),[at])', 1],
    ['FORMAT_DATE([at],"YYYY/MM/DD HH:mm:ss")', "2024/02/29 12:34:56"],
    ["1 + 2 * 3", 7],
    ["NOT 1 = 2", true],
    ["2 IN (1,2,NULL)", true],
    ["3 IN (1,2,NULL)", null],
    ["2 BETWEEN 1 AND 3 AND TRUE", true],
    ["NULL = 2", null],
    ["FALSE AND NULL", false],
    ["TRUE OR NULL", true],
    ["TRUE AND NULL", null],
    ["[a]]b]", "ok"],
  ])("evaluates %s", (source, expected) =>
    expect(run(source as string)).toMatchObject({ value: expected }),
  );
  it("collects dependencies and reports precise type errors", () => {
    expect(
      compileFormula("CONCAT([name], TO_TEXT([amount]))", fields).dependencies,
    ).toEqual(["amount", "name"]);
    expect(() => compileFormula("[name] + 2", fields)).toThrow(
      "Expected number",
    );
    expect(() => compileFormula('IF(TRUE, 1, "x")', fields)).toThrow(
      "compatible types",
    );
    expect(() => compileFormula('globalThis.fetch("x")', fields)).toThrow();
    expect(() => compileFormula("[unknown]", fields)).toThrow("Unknown");
    expect(() => compileFormula('"unterminated', fields)).toThrow();
    expect(() =>
      compileFormula("(".repeat(100) + "1" + ")".repeat(100), fields),
    ).toThrow("nesting");
  });
  it("isolates errors and preserves nulls", () => {
    expect(run("1/0").error).toMatch(/zero/);
    expect(run('REGEX_EXTRACT("x","z")')).toEqual({ value: null });
    expect(() => compileFormula('REGEX_EXTRACT("x","[")', fields)).toThrow(
      "Invalid regex",
    );
    expect(run('TO_NUMBER("")').error).toBeTruthy();
    expect(run('TO_DATETIME("2024-02-30")').error).toBeTruthy();
    expect(run("LEFT(NULL,3)")).toEqual({ value: null });
  });
  it("inlines reusable dependencies without eval", () => {
    const p = compileFormula("[@computed/one]+1", fields, (name) =>
      name === "@computed/one"
        ? compileFormula("[amount]*2", fields)
        : undefined,
    );
    expect(p.type).toBe("number");
    expect(p.dependencies).toEqual(["amount"]);
    expect(formulaRuntime(p.ast, inputs)).toEqual({ value: 247.912 });
  });
  it("groups the complete tuple, preserving value types and errors", () => {
    const p = groupPreview(
      ["x"],
      [{ x: "1" }, { x: "1" }, { x: 1 }, { x: null }],
      [
        { value: 2 },
        { value: 2 },
        { value: 2 },
        { value: null, error: "oops" },
      ],
      100,
    );
    expect(p.groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(p.processed).toBe(4);
    expect(p.errors).toBe(1);
    expect(p.nulls).toBe(0);
    expect(
      groupPreview(
        [],
        [{ x: 1 }, { x: 2 }],
        [{ value: "a" }, { value: "a" }],
        2,
      ).groups,
    ).toHaveLength(1);
  });
});
describe("reusable computed definitions", () => {
  it.each(["opaque-etag", "NaN", "memory:1", "9007199254740992"])(
    "keeps concurrency checks valid after seeded revision %s",
    async (revision) => {
      const definition = {
        id: "seeded",
        label: "Seeded",
        revision,
        expression: {
          language: "qt-expr" as const,
          version: 1 as const,
          source: "1",
        },
      };
      const store = memoryComputedColumnStore({ data: [definition] });
      const first = await store.save("data", definition, revision);
      const second = await store.save("data", definition, first.revision);
      expect(new Set([revision, first.revision, second.revision]).size).toBe(3);
      await expect(store.save("data", definition, revision)).rejects.toThrow(
        "changed",
      );
      await expect(
        store.save("data", definition, first.revision),
      ).rejects.toThrow("changed");
      const third = await store.save("data", definition, second.revision);
      expect(
        new Set([revision, first.revision, second.revision, third.revision])
          .size,
      ).toBe(4);
    },
  );
  it.each([
    ["a".repeat(200), '"ok"', true],
    ["a".repeat(201), '"ok"', false],
    ["🦋".repeat(100), '"ok"', true],
    ["🦋".repeat(101), '"ok"', false],
    ["🦋".repeat(99) + "ab", '"ok"', true],
    ["🦋".repeat(99) + "abc", '"ok"', false],
    ["Source", '"' + "a".repeat(9998) + '"', true],
    ["Source", '"' + "a".repeat(9999) + '"', false],
    ["Source", '"' + "🦋".repeat(4999) + '"', true],
    ["Source", '"' + "🦋".repeat(4999) + 'a"', false],
  ])("enforces UTF-16 limits (case %#)", (label, source, valid) => {
    const validate = () =>
      validateComputedColumn({
        id: "unicode",
        label,
        revision: "1",
        expression: { language: "qt-expr", version: 1, source },
      });
    if (valid) expect(validate).not.toThrow();
    else expect(validate).toThrow("Invalid computed");
  });

  it("uses optimistic revisions and notifies all subscribers", async () => {
    const store = memoryComputedColumnStore();
    let notifications = 0;
    const off = store.subscribe!("data", () => notifications++);
    const draft = {
      id: "domain",
      label: "Domain",
      expression: {
        language: "qt-expr" as const,
        version: 1 as const,
        source: "LEFT([name],3)",
      },
    };
    const a = await store.save("data", draft, null);
    const b = await store.save(
      "data",
      { ...draft, label: "Prefix" },
      a.revision,
    );
    await expect(store.save("data", draft, a.revision)).rejects.toThrow(
      "changed",
    );
    expect((await store.list("data"))[0]?.revision).toBe(b.revision);
    expect(await store.list("other")).toEqual([]);
    expect(notifications).toBe(2);
    off();
  });
  it("round-trips IDs only and strips computed fields from data operations", () => {
    const query = normalizeQueryState({
      ...EMPTY_QUERY,
      select: [{ field: "@computed/domain", width: 180 }],
      where: [{ field: "@computed/domain", op: "=", value: "x" }],
      orderBy: [{ field: "@computed/domain", dir: "asc" }],
      aggregations: [{ id: "x", op: "count", groupBy: ["@computed/domain"] }],
    });
    expect(decodeQuery(encodeQuery(query))).toEqual(query);
    expect(query.where).toEqual([]);
    expect(query.orderBy).toEqual([]);
    expect(query.aggregations).toBeUndefined();
    const schema: FieldSchema = {
      name: "data",
      idField: "id",
      fields: [
        {
          name: "id",
          label: "ID",
          type: "number",
          source: { kind: "backend" },
        },
        {
          name: "name",
          label: "Name",
          type: "text",
          source: { kind: "backend" },
        },
        {
          name: "@computed/domain",
          label: "Domain",
          type: "text",
          source: {
            kind: "derived",
            computedId: "domain",
            dependencies: ["name"],
          },
        },
      ],
    };
    expect(toServerQuery(query, schema).select).toEqual(["id", "name"]);
  });
});
