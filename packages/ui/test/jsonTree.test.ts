import { describe, expect, it } from "vitest";
import { inspectJsonValue, searchJsonEntries } from "../src/jsonValue";
import { jsonBucketId, jsonLines, jsonSearchMatches } from "../src/jsonTree";

const entries = inspectJsonValue(Array.from({ length: 65 }, (_, i) => i)).entries;

describe("JSON tree ranges and search", () => {
  it("shows the first 20 array items and disjoint expandable ranges for the remainder", () => {
    const result = jsonLines(entries, null, new Set(), new Set(), 200);
    expect(result.lines.filter(line => line.kind === "value").map(line => line.entry.value)).toEqual([entries[0]!.value, ...Array.from({ length: 20 }, (_, i) => i)]);
    expect(result.lines.filter(line => line.bucket).map(line => [line.bucket!.start, line.bucket!.end])).toEqual([[20, 39], [40, 59], [60, 64]]);
    expect(result.lines.at(-1)?.kind).toBe("close");
    const opened = jsonLines(entries, null, new Set(), new Set([jsonBucketId("$", 61)]), 200);
    const values = opened.lines.filter(line => line.kind === "value").map(line => line.entry.value);
    expect(values).toContain(60);
    expect(values).toContain(64);
    expect(values).not.toContain(20);
    expect(values).not.toContain(40);
  });

  it("filters matches beyond closed ranges without including unrelated list entries", () => {
    const matches = searchJsonEntries(entries, "[61]");
    const lines = jsonLines(entries, matches, new Set(), new Set(), 200).lines;
    expect(lines.map(line => line.kind)).toEqual(["value", "value", "close"]);
    expect(lines[1]?.entry.value).toBe(61);
  });

  it("navigates repeated key/value occurrences and falls back to paths for index searches", () => {
    const document = inspectJsonValue({ "Ada Ada": "ada ada", "1": "Ada", list: ["ada"] }).entries;
    expect(jsonSearchMatches(document, "ada").map(match => [match.path, match.part, match.start])).toEqual([
      ['$["1"]', "value", 1],
      ['$["Ada Ada"]', "key", 1], ['$["Ada Ada"]', "key", 5],
      ['$["Ada Ada"]', "value", 1], ['$["Ada Ada"]', "value", 5],
      ['$["list"][0]', "value", 1],
    ]);
    expect(jsonSearchMatches(document, "[0]")).toEqual([{ path: '$["list"][0]', part: "path", start: 0 }]);
    expect(jsonSearchMatches(document, "absent")).toEqual([]);
  });

  it("keeps braces balanced when paging nested arrays and containers", () => {
    const nested = inspectJsonValue({ list: Array.from({ length: 100 }, (_, i) => ({ value: i })) }).entries;
    const paged = jsonLines(nested, null, new Set(), new Set([jsonBucketId('$["list"]', 20)]), 30);
    expect(paged.remaining).toBeGreaterThan(0);
    expect(paged.lines.filter(line => line.kind === "close")).toHaveLength(paged.lines.filter(line => line.kind === "value" && line.entry.children > 0 && !line.collapsed).length);
  });
});
