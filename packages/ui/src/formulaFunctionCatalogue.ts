import {
  FORMULA_FUNCTIONS,
  type FormulaFunction,
  type FormulaType,
} from "@pythia-software/query-table-core";

export const FUNCTION_CATEGORIES = [
  {
    id: "strings",
    label: "String functions",
    description: "Slice, combine, format, and clean text.",
    keywords: "string text characters whitespace case concatenate",
  },
  {
    id: "matching",
    label: "Matching & regex",
    description: "Find text, test patterns, and extract matches.",
    keywords: "search matching regex regular expression pattern capture",
  },
  {
    id: "numbers",
    label: "Numbers & statistics",
    description: "Round, transform, and compare numbers within a row.",
    keywords: "math numeric arithmetic statistics statistical rounding",
  },
  {
    id: "logic",
    label: "Conditions & missing values",
    description: "Choose results, handle errors, and work with empty values.",
    keywords: "logic boolean conditional null missing empty fallback error",
  },
  {
    id: "conversion",
    label: "Type conversion",
    description: "Convert values to text, numbers, booleans, or dates.",
    keywords: "convert conversion cast type parse",
  },
  {
    id: "arrays",
    label: "Array functions",
    description: "Split, join, count, and organize lists of text.",
    keywords: "array list collection elements unique deduplicate",
  },
  {
    id: "dates",
    label: "Dates & times",
    description:
      "Extract date parts, format timestamps, and calculate durations.",
    keywords: "date datetime time timestamp calendar duration UTC",
  },
] as const;
export type FunctionCategory = (typeof FUNCTION_CATEGORIES)[number]["id"];

export const FUNCTION_RESULT_TYPES: {
  value: FormulaFunction["result"];
  label: string;
}[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "bool", label: "Boolean" },
  { value: "datetime", label: "Date/time" },
  { value: "textarray", label: "Text array" },
  { value: "branch", label: "Depends on arguments" },
];
export function functionResultLabel(result: FormulaType | "branch"): string {
  return (
    FUNCTION_RESULT_TYPES.find((type) => type.value === result)?.label ?? result
  );
}

/** Concept is separate from return type: LENGTH is a string operation returning a number. */
export function functionCategory(fn: FormulaFunction): FunctionCategory {
  if (fn.name.startsWith("TO_")) return "conversion";
  if (
    fn.name.startsWith("REGEX_") ||
    ["CONTAINS", "STARTS_WITH", "ENDS_WITH"].includes(fn.name)
  )
    return "matching";
  if (fn.name.startsWith("ARRAY_") || ["SPLIT", "JOIN"].includes(fn.name))
    return "arrays";
  if (
    fn.name.includes("DATE") ||
    (fn.args !== "any" && fn.args.includes("datetime"))
  )
    return "dates";
  if (fn.result === "branch" || fn.args === "any") return "logic";
  if (fn.args.includes("text")) return "strings";
  return "numbers";
}

const SEARCH_ALIASES: Record<string, string> = {
  LEFT: "prefix beginning first characters",
  RIGHT: "suffix ending last characters",
  SUBSTRING: "slice middle characters",
  LENGTH: "size count characters",
  LOWER: "lowercase",
  UPPER: "uppercase",
  CONCAT: "concatenate combine append",
  CONCAT_WS: "concatenate separator combine append",
  LEAST: "minimum smallest min",
  GREATEST: "maximum largest max",
  ABS: "absolute magnitude",
  SQRT: "square root",
  CEIL: "ceiling round up",
  FLOOR: "round down",
  IF: "if else decision",
  COALESCE: "default first non-null missing fallback",
  NULLIF: "equal missing null",
  IFERROR: "recover error default fallback",
  ARRAY_LENGTH: "size count elements",
  DATE_DIFF: "difference elapsed duration",
};
const normalize = (text: string) =>
  text.toLowerCase().replace(/[_-]/g, " ").trim();

export function findFormulaFunctions(
  search: string,
  category: FunctionCategory | "all" = "all",
  result: FormulaFunction["result"] | "all" = "all",
): FormulaFunction[] {
  const query = normalize(search);
  const terms = query.split(/\s+/).filter(Boolean);
  const functions = FORMULA_FUNCTIONS.filter((fn) => {
    const concept = functionCategory(fn);
    if (
      (category !== "all" && concept !== category) ||
      (result !== "all" && fn.result !== result)
    )
      return false;
    const metadata = FUNCTION_CATEGORIES.find((item) => item.id === concept)!;
    const haystack = normalize(
      `${fn.name} ${fn.signature} ${fn.description} ${metadata.label} ${metadata.keywords} ${SEARCH_ALIASES[fn.name] ?? ""} ${functionResultLabel(fn.result)}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
  // Exact/prefix name matches appear first; browsing stays alphabetical.
  const rank = (fn: FormulaFunction) =>
    !query
      ? 2
      : normalize(fn.name) === query
        ? 0
        : normalize(fn.name).startsWith(query)
          ? 1
          : 2;
  return functions.sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}
