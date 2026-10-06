import { describe, expect, it } from "vitest";
import { applyQuery, createSetFilter, decodeQuery, EMPTY_QUERY, encodeQuery, mapSetFilterValues, memoryStorageAdapter, normalizeQueryState, readSetFilter, stripSetFilter, toAggregationQuery, toServerQuery, type FieldSchema, type SetFilterMode } from "../src/index";

const schema: FieldSchema<{ tags: string[] | null }> = {
  name: "tags", idField: "tags", fields: [{ name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, filter: { editor: "set", arrayCaseSensitive: true } }],
};
const rows = [[], ["a"], ["b"], ["a", "b"], ["c"], ["A"], null].map((tags) => ({ tags }));

describe("explicit set filters", () => {
  it.each<[SetFilterMode, number[]]>([["any", [1, 2, 3]], ["all", [3]], ["none", [0, 4, 5, 6]], ["empty", [0, 6]]])("executes %s locally and preserves its transport predicates", (mode, indices) => {
    const where = createSetFilter("tags", mode, ["a", "b"], "editor-1");
    const query = { ...EMPTY_QUERY, where };
    expect(applyQuery(rows, query, schema).rows).toEqual(indices.map((index) => rows[index]));
    const server = toServerQuery(query, schema);
    expect(server.where).toEqual(where.map(stripSetFilter));
    expect(JSON.stringify(server)).not.toContain("setFilter");
    expect(toAggregationQuery(query, schema).where).toEqual(server.where);
    expect(readSetFilter(decodeQuery(encodeQuery(query)).where, 0)).toEqual({ field: "tags", metadata: { id: "editor-1", mode, values: mode === "empty" ? [] : ["a", "b"] }, count: where.length });
  });

  it.each<SetFilterMode>(["any", "all", "none", "empty"])("retains %s singleton mode and deleted keys", (mode) => {
    const query = { ...EMPTY_QUERY, where: createSetFilter("tags", mode, ["deleted"], "editor") };
    expect(readSetFilter(decodeQuery(encodeQuery(query)).where, 0)?.metadata.mode).toBe(mode);
    if (mode !== "empty") expect(readSetFilter(query.where, 0)?.metadata.values).toEqual(["deleted"]);
  });

  it("does not infer sets from legacy ORs or absorb unrelated predicates after partial edits", () => {
    const where = createSetFilter("tags", "all", ["a", "b"], "editor");
    expect(readSetFilter(where.map(stripSetFilter), 0)).toBeNull();
    expect(readSetFilter([where[0]!, stripSetFilter(where[1]!)], 0)).toBeNull();
    expect(readSetFilter([where[0]!], 0)).toBeNull();
    expect(readSetFilter([where[0]!, { ...where[1]!, value: "c" }], 0)).toBeNull();
    const legacy = { ...EMPTY_QUERY, where: [{ any: [{ field: "tags", op: "includes" as const, value: "a" }, { field: "tags", op: "includes" as const, value: "b" }] }] };
    expect(decodeQuery(encodeQuery(legacy))).toEqual(legacy);
  });

  it("clones and bounds metadata, deduplicating exact keys without changing case", () => {
    const where = createSetFilter("tags", "any", ["a", "a", "A"], "editor");
    expect(readSetFilter(where, 0)?.metadata.values).toEqual(["a", "A"]);
    const normalized = normalizeQueryState({ ...EMPTY_QUERY, where });
    normalized.where[0]!.setFilter!.values.push("other");
    expect(where[0]!.setFilter!.values).toEqual(["a", "A"]);
    expect(normalizeQueryState({ where: [{ ...where[0], setFilter: { id: "bad", mode: "invalid", values: [] } }] }).where[0]?.setFilter).toBeUndefined();
    expect(createSetFilter("tags", "none", [], "editor")).toEqual([]);
  });

  it.each<SetFilterMode>(["any", "all", "none", "empty"])("preserves %s through saved/last/default storage", async (mode) => {
    const storage = memoryStorageAdapter();
    const query = { ...EMPTY_QUERY, where: createSetFilter("tags", mode, ["a", "deleted"], "editor") };
    await storage.saveLast("tags", query);
    const saved = await storage.saveNamed("tags", "saved", query, 1);
    await storage.setDefaultSaved!("tags", saved.id);
    expect(await storage.loadLast("tags")).toEqual(query);
    expect((await storage.listSaved("tags"))[0]?.query).toEqual(query);
    expect((await storage.loadDefaultSaved!("tags"))?.query).toEqual(query);
  });

  it("canonicalizes aliases with exact deduplication, retaining unrelated filters", () => {
    const unrelated = { field: "tags", op: "includes" as const, value: "legacy" };
    const mapped = mapSetFilterValues([unrelated, ...createSetFilter("tags", "all", ["alias", "a", "A", "deleted"], "editor")], (_field, value) => value === "alias" ? "a" : value);
    expect(mapped[0]).toBe(unrelated);
    expect(readSetFilter(mapped, 1)?.metadata.values).toEqual(["a", "A", "deleted"]);
    expect(mapped).toHaveLength(4);
  });
});
