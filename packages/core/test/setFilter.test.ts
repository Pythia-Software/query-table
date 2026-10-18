import { describe, expect, it } from "vitest";
import { applyQuery, createSetFilter, decodeQuery, EMPTY_QUERY, encodeQuery, mapSetFilterValues, memoryStorageAdapter, normalizeQueryState, readSetFilter, setFilterTarget, stripSetFilter, toAggregationQuery, toServerQuery, type FieldDef, type FieldSchema, type SetFilterMode } from "../src/index";

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
    expect(readSetFilter(decodeQuery(encodeQuery(query)).where, 0)).toEqual({ field: "tags", metadata: { id: "editor-1", mode, values: mode === "empty" ? [] : ["a", "b"] }, count: where.length, target: "array" });
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

describe("scalar set filters", () => {
  type Run = { id: number; status: string | null };
  const runSchema: FieldSchema<Run> = {
    name: "runs", idField: "id", fields: [
      { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
      { name: "status", label: "Status", type: "enum", source: { kind: "backend" }, filter: { editor: "set" } },
    ],
  };
  const runs: Run[] = ["queued", "running", "done", "failed", null, "Done"].map((status, id) => ({ id, status }));
  const statuses = (where: ReturnType<typeof createSetFilter>) => applyQuery(runs, { ...EMPTY_QUERY, where }, runSchema).rows.map((row) => row.status);

  it("compiles ANY to an OR group of = and a singleton to one =", () => {
    expect(createSetFilter("status", "any", ["done", "failed"], "s", "scalar").map(stripSetFilter)).toEqual([
      { any: [{ field: "status", op: "=", value: "done" }, { field: "status", op: "=", value: "failed" }] },
    ]);
    expect(createSetFilter("status", "any", ["done"], "s", "scalar").map(stripSetFilter)).toEqual([{ field: "status", op: "=", value: "done" }]);
    expect(statuses(createSetFilter("status", "any", ["done", "failed"], "s", "scalar"))).toEqual(["done", "failed"]);
  });

  it("compiles NONE to one (is_null OR !=) group per value, keeping NULL rows", () => {
    const where = createSetFilter("status", "none", ["done", "failed", "queued"], "s", "scalar");
    expect(where.map(stripSetFilter)).toEqual(["done", "failed", "queued"].map((value) => ({
      any: [{ field: "status", op: "is_null", value: "" }, { field: "status", op: "!=", value }],
    })));
    // The explicit is_null branch keeps NULL rows on every executor; a bare
    // != is null-exclusive in SQL backends.
    expect(statuses(where)).toEqual(["running", null, "Done"]);
  });

  it("rejects ALL and EMPTY, which only describe arrays", () => {
    expect(() => createSetFilter("status", "all", ["done"], "s", "scalar")).toThrow(/textarray/);
    expect(() => createSetFilter("status", "empty", [], "s", "scalar")).toThrow(/textarray/);
  });

  it.each<SetFilterMode>(["any", "none"])("reads %s back with its target and survives links, storage and alias mapping", async (mode) => {
    for (const values of [["done"], ["done", "failed"]]) {
      const where = createSetFilter("status", mode, values, "s", "scalar");
      const query = { ...EMPTY_QUERY, where };
      expect(readSetFilter(where, 0)).toEqual({ field: "status", metadata: { id: "s", mode, values }, count: where.length, target: "scalar" });
      const token = encodeQuery(query);
      expect(decodeQuery(token)).toEqual(query);
      expect(readSetFilter(decodeQuery(token).where, 0)?.target).toBe("scalar");
      const storage = memoryStorageAdapter();
      await storage.saveNamed("runs", "Scalar", query, 1);
      expect((await storage.listSaved("runs"))[0]!.query).toEqual(query);
      expect(mapSetFilterValues(where, (_field, value) => value === "done" ? "succeeded" : value))
        .toEqual(createSetFilter("status", mode, values.map((value) => value === "done" ? "succeeded" : value), "s", "scalar"));
      const server = toServerQuery(query, runSchema);
      expect(JSON.stringify(server)).not.toContain("setFilter");
      expect(server.where).toEqual(where.map(stripSetFilter));
    }
  });

  it("is never confused with array output for the same metadata", () => {
    const scalar = createSetFilter("status", "any", ["done", "failed"], "s", "scalar");
    const array = createSetFilter("status", "any", ["done", "failed"], "s");
    expect(readSetFilter(scalar, 0)?.target).toBe("scalar");
    expect(readSetFilter(array, 0)?.target).toBe("array");
    expect(readSetFilter([{ ...scalar[0]!, any: [...(scalar[0] as { any: [] }).any.slice(0, 1), { field: "status", op: "includes", value: "failed" }] }], 0)).toBeNull();
  });

  it("detects the editor a field opted into", () => {
    const field = (patch: Partial<FieldDef>): FieldDef => ({ name: "f", label: "F", type: "text", source: { kind: "backend" }, ...patch });
    expect(setFilterTarget(field({ type: "textarray", filter: { editor: "set" } }))).toBe("array");
    expect(setFilterTarget(field({ type: "enum", filter: { editor: "set" } }))).toBe("scalar");
    expect(setFilterTarget(field({ type: "text", filter: { editor: "set", values: { source: "static", options: ["a"] } } }))).toBe("scalar");
    expect(setFilterTarget(field({ type: "text", filter: { editor: "set" } }))).toBeNull();
    expect(setFilterTarget(field({ type: "enum" }))).toBeNull();
    expect(setFilterTarget(field({ type: "number", filter: { editor: "set" } }))).toBeNull();
  });
});
