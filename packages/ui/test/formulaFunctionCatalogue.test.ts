import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTIONS } from "@pythia-software/query-table-core";
import { findFormulaFunctions } from "../src/formulaFunctionCatalogue";
const names = (
  search: string,
  ...filters: Parameters<typeof findFormulaFunctions> extends [
    string,
    ...infer Rest,
  ]
    ? Rest
    : never
) => findFormulaFunctions(search, ...filters).map((fn) => fn.name);

describe("function discovery", () => {
  it("finds functions by intent, case-insensitive names, and multi-word searches", () => {
    expect(names("minimum")).toEqual(["LEAST"]);
    expect(names("prefix")).toEqual(["LEFT"]);
    expect(names("square root")).toEqual(["SQRT"]);
    expect(names("regex extract")).toEqual(["REGEX_EXTRACT"]);
    expect(names("lowercase")).toEqual(["LOWER"]);
    expect(names("left")[0]).toBe("LEFT");
  });
  it("keeps concept and return-type filtering independent", () => {
    expect(names("", "strings", "number")).toEqual(["LENGTH"]);
    expect(names("count", "arrays", "number")).toEqual(["ARRAY_LENGTH"]);
    expect(names("", "dates", "text")).toEqual(["FORMAT_DATE"]);
    expect(names("", "logic", "branch")).toContain("COALESCE");
    expect(names("minimum", "strings")).toEqual([]);
  });
  it("supports browsing statistics without implying dataset aggregates", () => {
    expect(names("statistical")).toEqual(
      expect.arrayContaining(["LEAST", "GREATEST", "ROUND"]),
    );
    expect(names("", "numbers")).not.toContain("YEAR");
  });
  it("keeps every supported function available for browsing", () => {
    expect(names("").sort()).toEqual(
      FORMULA_FUNCTIONS.map((fn) => fn.name).sort(),
    );
    expect(names("function that does not exist")).toEqual([]);
  });
});
