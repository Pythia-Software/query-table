import { describe, expect, it } from "vitest";
import { inspectJsonValue, searchJsonEntries, JSON_MAX_CHARACTERS, JSON_MAX_ENTRIES } from "../src/jsonValue";

const payload = { customer: { "display.name": 'Ada "A"', path: "C:\\tmp\\file", note: "line\nnext" }, items: [false, 0, null, ""], "a[0]": "literal" };

describe("JSON cell inspection", () => {
  it.each([
    payload,
    JSON.stringify(payload),
    JSON.stringify(JSON.stringify(payload)),
    JSON.stringify(JSON.stringify(JSON.stringify(payload))),
    JSON.stringify(JSON.stringify(payload)).slice(1, -1),
  ])("decodes native, serialized, encoded and escaped JSON without losing escapes", (value) => {
    const result = inspectJsonValue(value);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(payload);
    expect(JSON.parse(result.formatted)).toEqual(payload);
    expect(result.raw).toBe(typeof value === "string" ? value : JSON.stringify(value));
    expect(result.entries.find((entry) => entry.path === '$["customer"]["display.name"]')?.value).toBe('Ada "A"');
    expect(result.entries.find((entry) => entry.path === '$["items"][0]')?.type).toBe("boolean");
  });

  it.each(["null", "false", "0", '"hello"', "{}", "[]"])('retains JSON primitives and empty containers: %s', (value) => {
    const result = inspectJsonValue(value);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(JSON.parse(value));
    expect(result.entries).toHaveLength(1);
  });

  it("honors literal and single-parse modes for ambiguous strings", () => {
    expect(inspectJsonValue('{"id":42}', { kind: "json", encoding: "value" }).value).toBe('{"id":42}');
    expect(inspectJsonValue(JSON.stringify('{"id":42}'), { kind: "json", encoding: "json" }).value).toBe('{"id":42}');
  });

  it("preserves malformed input and reports decoding limits", () => {
    const value = '{"bad":}';
    expect(inspectJsonValue(value)).toMatchObject({ raw: value, error: expect.stringContaining("Invalid JSON"), entries: [] });
    expect(inspectJsonValue(JSON.stringify(JSON.stringify(payload)), { kind: "json", maxDecodeDepth: 1 }).error).toContain("decoding limit");
  });

  it("keeps unsafe integer source text available without offering a rounded JSON copy", () => {
    const raw = '{"id":9007199254740993}';
    expect(inspectJsonValue(raw)).toMatchObject({ raw, error: expect.stringContaining("safe integer precision"), entries: [] });
  });

  it.each(['1e300', '1e21', '-1e21', '9007199254740993.0', '{"x":1e300}', '{"id":"9007199254740993"}', '{"9007199254740993":0}'])
  ("accepts floating-point notation and quoted integer-like text: %s", (raw) => {
    const result = inspectJsonValue(raw);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.formatted)).toEqual(JSON.parse(raw));
  });

  it.each([1e300, 1e21, Number.MAX_SAFE_INTEGER + 1, { x: 1e300, id: Number.MAX_SAFE_INTEGER + 1 }])
  ("accepts native numbers without claiming to preserve source precision: %j", (value) => {
    const result = inspectJsonValue(value);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.formatted)).toEqual(value);
  });

  it.each(['9007199254740993', '-9007199254740993', '{"id":9007199254740993}', '[9007199254740993]'])
  ("guards unsafe integer literals through encoded and escaped input: %s", (raw) => {
    for (const input of [raw, JSON.stringify(raw), JSON.stringify(raw).slice(1, -1)]) {
      expect(inspectJsonValue(input)).toMatchObject({ raw: input, error: expect.stringContaining("safe integer precision"), entries: [] });
    }
  });

  it("excludes invisible container summaries from key/path/value search", () => {
    const entries = inspectJsonValue({ tags: ["a", "b"], items: [1] }).entries;
    expect(searchJsonEntries(entries, "items").map(entry => entry.path)).toEqual(['$["items"]', '$["items"][0]']);
    expect(searchJsonEntries(entries, "keys")).toEqual([]);
    expect(searchJsonEntries(entries, "2")).toEqual([]);
    expect(searchJsonEntries(inspectJsonValue({ keys: {} }).entries, "keys").map(entry => entry.path)).toEqual(['$["keys"]']);
  });

  it("finds collapsed descendant keys, values, types and paths literally", () => {
    const entries = inspectJsonValue(payload).entries;
    expect(searchJsonEntries(entries, "DISPLAY.NAME").map((entry) => entry.path)).toEqual(['$["customer"]["display.name"]']);
    expect(searchJsonEntries(entries, "ada")).toHaveLength(1);
    expect(searchJsonEntries(entries, '["items"][2]').map((entry) => entry.value)).toEqual([null]);
    expect(searchJsonEntries(entries, ".*")).toEqual([]);
  });

  it("bounds large, deep and unserializable values and discloses incomplete search", () => {
    const wide = Array.from({ length: 6000 }, (_, i) => i);
    const result = inspectJsonValue(wide);
    expect(result.entries).toHaveLength(JSON_MAX_ENTRIES);
    expect(result.limited).toBe(true);
    expect(JSON.parse(result.formatted)).toHaveLength(6000);
    let deep: unknown = 42;
    for (let i = 0; i < 100; i++) deep = { nested: deep };
    expect(inspectJsonValue(deep).limited).toBe(true);
    expect(inspectJsonValue('"' + "x".repeat(JSON_MAX_CHARACTERS) + '"').error).toContain("limit");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(inspectJsonValue(cyclic).error).toBeDefined();
    expect(inspectJsonValue({ amount: NaN }).error).toContain("cannot be represented");
    expect(inspectJsonValue({ amount: 1n }).error).toContain("cannot be represented");
  });

  it("takes a snapshot of native values and defers tree work for closed cells", () => {
    const native = { values: [1, 2] };
    const result = inspectJsonValue(native);
    native.values.push(3);
    expect(result.entries.find((entry) => entry.key === "values")?.value).toEqual([1, 2]);
    expect(inspectJsonValue(native, { kind: "json" }, false)).toMatchObject({ entries: [], limited: false });
  });
});
