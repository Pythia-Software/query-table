import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  applyQuery,
  createGroupingModel,
  createQueryLinkService,
  decodeQuery,
  encodeQuery,
  groupLinkQuery,
  isGroupLinkValue,
  memoryQuerySnapshotCache,
  memoryStorageAdapter,
  normalizeQueryState,
  prepareGrouping,
  readFieldValue,
  resolveGroupLink,
  sourceDependencies,
  toQueryRequestV3,
  toServerQuery,
  withGroupingKeys,
  withoutGrouping,
  type FieldSchema,
  type GroupLinkValue,
  type LinkSpec,
  type QueryCapabilitiesV3,
  type QueryPatch,
  type QuerySnapshot,
  type QueryState,
  type SummaryColumn,
} from "../src/index";

type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "tool", label: "Tool", type: "text", source: { kind: "backend" } },
    { name: "repo", label: "Repository", type: "text", source: { kind: "backend" } },
    { name: "failed", label: "Failed", type: "bool", source: { kind: "backend" } },
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, aggregate: { groupable: true } },
    { name: "secret", label: "Secret", type: "text", source: { kind: "backend" }, filter: { enabled: false } },
  ],
};
const rows: Row[] = [
  { id: 1, tool: "apply_patch", repo: "pharos", failed: true, at: "2026-03-07T06:30:00Z", tags: ["a"], secret: "x" },
  { id: 2, tool: "apply_patch", repo: "pharos", failed: false, at: "2026-03-07T06:30:00Z", tags: [], secret: "x" },
  { id: 3, tool: "bash", repo: null, failed: true, at: "2026-03-08T07:00:00Z", tags: ["b"], secret: "y" },
  { id: 4, tool: null, repo: "qt", failed: false, at: "2026-03-08T07:00:00+02:00", tags: ["a"], secret: "y" },
];
const source: QueryState = {
  ...EMPTY_QUERY,
  select: [{ field: "id" }, { field: "tool" }],
  where: [{ field: "id", op: "<", value: "100" }],
  orderBy: [{ field: "id", dir: "desc" }],
  offset: 20,
};
const failing: QueryPatch = { id: "failing", owns: ["filters"], query: { where: [{ field: "failed", op: "=", value: "true" }] } };
const link = (id: string, spec: LinkSpec, label?: string): SummaryColumn => ({ id, op: "link", link: spec, ...(label ? { label } : {}) });
const toTriage = link("triage", { label: { column: "tool" }, to: { kind: "query", target: "triage", patch: failing, params: { lens: "triage" } } }, "Open");

function grouped(keys: string[], summaries: SummaryColumn[], select = [...keys, ...summaries.map((s) => s.id)]): QueryState {
  return {
    ...withGroupingKeys(source, keys),
    select: select.map((field) => ({ field })),
    grouping: { keys, summaries, representative: null, source },
  };
}
function linkValues(query: QueryState, column: string): GroupLinkValue[] {
  const prepared = prepareGrouping(rows, schema, query.grouping!);
  const field = prepared.schema.fields.find((f) => f.name === column)!;
  return prepared.rows.map((row) => readFieldValue(field, row) as GroupLinkValue);
}
const capabilities: QueryCapabilitiesV3 = {
  version: 3, groupedRows: true, calendarGrouping: true, computedSourceFilters: false, regex: false,
  maxRows: 10000, maxGroups: 2000, maxPopulation: 250000, profile: "qt-sqlite-v1",
};

describe("query link columns", () => {
  const query = grouped(["tool"], [{ id: "calls", op: "count" }, toTriage]);
  const targets = { triage: vi.fn((q: QueryState, params: Record<string, string>) => `/triage?lens=${params.lens}&q=${encodeQuery(q)}`) };

  it("starts from the source, adds key filters and applies the patch", () => {
    const values = linkValues(query, "triage");
    expect(values.map((value) => value.label).sort()).toEqual(["", "apply_patch", "bash"]);
    for (const value of values) {
      expect(isGroupLinkValue(value)).toBe(true);
      const destination = groupLinkQuery(query, value)!;
      expect(destination.grouping).toBeUndefined();
      expect(destination).toMatchObject({ select: source.select, orderBy: source.orderBy, offset: 0 });
      expect(destination.where[0]).toEqual(source.where[0]);
      expect(destination.where.at(-1)).toEqual({ field: "failed", op: "=", value: "true" });
      const expected = rows.filter((row) => row.tool === (value.label || null) && row.failed).length;
      expect(applyQuery(rows, { ...destination, limit: 1000 }, schema).total).toBe(expected);
    }
  });

  it("filters null keys with is_null and datetime keys with ISO instants", () => {
    const nullTool = linkValues(query, "triage").find((value) => value.label === "")!;
    expect(groupLinkQuery(query, nullTool)!.where).toContainEqual({ field: "tool", op: "is_null", value: "" });
    const byTime = grouped(["at"], [link("open", { label: { column: "at" }, to: { kind: "query", target: "triage" } })]);
    const values = linkValues(byTime, "open");
    expect(values.map((value) => value.label).sort()).toEqual(["2026-03-07T06:30:00.000Z", "2026-03-08T05:00:00.000Z", "2026-03-08T07:00:00.000Z"]);
    for (const value of values)
      expect(groupLinkQuery(byTime, value)!.where.at(-1)).toEqual({ field: "at", op: "=", value: value.label });
  });

  it("supports an empty base, no key filters and host params", () => {
    const empty = grouped(["tool"], [link("all", { label: "All", to: { kind: "query", target: "triage", base: "empty", keyFilters: false } })]);
    const [value] = linkValues(empty, "all");
    expect(groupLinkQuery(empty, value!)).toEqual({ ...EMPTY_QUERY, offset: 0 });
    const keyed = grouped(["tool"], [link("one", { label: "One", to: { kind: "query", target: "triage", base: "empty" } })]);
    const bash = linkValues(keyed, "one").find((v) => v.terms?.[0]?.value === "bash")!;
    expect(groupLinkQuery(keyed, bash)).toEqual({ ...EMPTY_QUERY, where: [{ field: "tool", op: "=", value: "bash" }], offset: 0 });
    const resolved = resolveGroupLink(query, linkValues(query, "triage").find((v) => v.label === "bash")!, targets);
    expect(resolved.href).toMatch(/^\/triage\?lens=triage&q=/);
    const routed = targets.triage.mock.lastCall!;
    expect(routed[1]).toEqual({ lens: "triage" });
    expect(routed[0].where).toContainEqual({ field: "tool", op: "=", value: "bash" });
  });

  it("reports unregistered, failing and empty host targets instead of throwing", () => {
    const [value] = linkValues(query, "triage");
    expect(resolveGroupLink(query, value!, {})).toMatchObject({ href: null, problem: 'Link target "triage" is not registered.' });
    expect(resolveGroupLink(query, value!, { toString: () => "/x" } as never).href).toBeNull();
    expect(resolveGroupLink(query, value!, { triage: () => { throw Error("boom"); } })).toMatchObject({ href: null, problem: 'Link target "triage" failed: boom' });
    expect(resolveGroupLink(query, value!, { triage: () => "" }).href).toBeNull();
    expect(groupLinkQuery(withoutGrouping(query), value!)).toBeNull();
  });

  it("refuses keys that cannot be matched exactly", () => {
    const byTags = grouped(["tags"], [link("open", { label: "Open", to: { kind: "query", target: "triage" } })]);
    const model = createGroupingModel(schema);
    expect(model.linkDiagnostics(byTags.grouping!)).toEqual(["Open: Key filters cannot match the textarray key Tags."]);
    expect(() => model.validate(byTags.grouping!)).not.toThrow();
    // Server executors may group array keys; local grouping rejects them.
    const field = model.resultSchema(["tags"], byTags.grouping!.summaries).fields.find((f) => f.name === "open")!;
    const value = readFieldValue(field, { tags: ["a"] }) as GroupLinkValue;
    expect(value.problem).toMatch(/textarray/);
    expect(resolveGroupLink(byTags, value, targets).href).toBeNull();
    const bySecret = grouped(["secret"], [link("open", { label: "Open", to: { kind: "query", target: "triage", keyFilters: false } })]);
    expect(model.linkDiagnostics(bySecret.grouping!)).toEqual([]);
  });
});

describe("template link columns", () => {
  it("substitutes encoded keys and summaries", () => {
    const query = grouped(["repo", "at"], [
      { id: "calls", op: "count" },
      link("library", { label: { column: "repo" }, to: { kind: "template", template: "/library/{field:repo}?since={field:at}&n={field:calls}" } }),
    ]);
    const values = linkValues(query, "library");
    const pharos = values.find((value) => value.label === "pharos")!;
    expect(resolveGroupLink(query, pharos)).toEqual({ label: "pharos", href: "/library/pharos?since=2026-03-07T06%3A30%3A00.000Z&n=2" });
    expect(values.find((value) => value.label === "")!.problem).toBe("A value in this link is empty.");
  });

  it("percent-encodes values so they cannot change the URL scheme or path", () => {
    const query = grouped(["tool"], [link("x", { label: "x", to: { kind: "template", template: "{field:tool}" } })]);
    const model = createGroupingModel(schema);
    const resultSchema = model.resultSchema(query.grouping!.keys, query.grouping!.summaries);
    const field = resultSchema.fields.find((f) => f.name === "x")!;
    const value = readFieldValue(field, { tool: "javascript:alert(1)" }) as GroupLinkValue;
    expect(value.href).toBe("javascript%3Aalert(1)");
    expect(new URL(value.href!, "https://example.test/").protocol).toBe("https:");
    expect((readFieldValue(field, { tool: "//evil.example/x" }) as GroupLinkValue).href).toBe("%2F%2Fevil.example%2Fx");
  });

  it("reports invalid specs as diagnostics without blocking the grouped table", () => {
    const model = createGroupingModel(schema);
    const summaries: SummaryColumn[] = [
      { id: "calls", op: "count" },
      link("a", { label: { column: "nope" }, to: { kind: "template", template: "/x" } }),
      link("b", { label: "B", to: { kind: "template", template: "javascript:{field:tool}" } }),
      link("c", { label: "C", to: { kind: "template", template: "/x/{field:missing}" } }),
      link("d", { label: "D", to: { kind: "template", template: "/x/{oops}" } }),
      link("e", { label: { column: "a" }, to: { kind: "template", template: "/x" } }),
      link("f", { label: "F", to: { kind: "template", template: " " } }),
      { id: "g", op: "link" },
    ];
    const definition = { keys: ["tool"], summaries, representative: null };
    expect(model.linkDiagnostics(definition)).toEqual([
      "Link: Unknown link label column: nope.",
      "B: Use an HTTP, HTTPS, or relative page URL.",
      "C: Unknown URL field: missing.",
      "D: Use {field:field_name} placeholders.",
      "Link: Unknown link label column: a.",
      "F: Enter a link URL template.",
      "Link: Invalid link definition.",
    ]);
    expect(() => model.validate(definition)).not.toThrow();
    const prepared = prepareGrouping(rows, schema, { ...definition, source });
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      const field = prepared.schema.fields.find((f) => f.name === name)!;
      expect((readFieldValue(field, prepared.rows[0]!) as GroupLinkValue).problem, name).toBeTruthy();
    }
    expect(prepared.rows[0]!.calls).toBeTypeOf("number");
  });
});

describe("link columns in execution", () => {
  const query = grouped(["tool", "repo"], [
    { id: "calls", op: "count" },
    { id: "fails", op: "sum", field: "id" },
    link("library", { label: { column: "fails" }, to: { kind: "template", template: "/r/{field:repo}" } }),
    toTriage,
  ], ["library", "triage"]);

  it("are client-only result fields that cannot be filtered, sorted or measured", () => {
    const resultSchema = createGroupingModel(schema).resultSchema(query.grouping!.keys, query.grouping!.summaries);
    const field = resultSchema.fields.find((f) => f.name === "triage")!;
    expect(field).toMatchObject({ type: "text", source: { kind: "derived", dependencies: ["tool", "repo"] },
      filter: { enabled: false }, sort: { enabled: false }, aggregate: { measure: false, groupable: false } });
    expect(resultSchema.fields.find((f) => f.name === "library")!.source).toMatchObject({ dependencies: ["fails", "repo"] });
  });

  it("never reach the server, while the fields they read are requested", () => {
    const request = toQueryRequestV3(query, schema, capabilities, undefined, { now: 1 });
    expect(request.diagnostics).toEqual([]);
    expect(request.grouping!.summaries.map((s) => s.op)).toEqual(["count", "sum"]);
    expect(JSON.stringify(request)).not.toContain('"link"');
    expect(request.result.select).toEqual(expect.arrayContaining(["fails", "repo", "tool"]));
    expect(request.result.select).not.toContain("triage");
    expect(sourceDependencies(query, schema).fields).not.toContain("triage");
    const formatted = { ...query, grouping: { ...query.grouping!, summaries: query.grouping!.summaries.map((s) => s.id === "calls" ? { ...s, display: { kind: "percent" as const } } : s) } };
    expect(toQueryRequestV3(formatted, schema, capabilities, undefined, { now: 1 }).grouping!.summaries).toEqual([{ id: "calls", op: "count" }, { id: "fails", op: "sum", field: "id" }]);
    const resultSchema = createGroupingModel(schema).resultSchema(query.grouping!.keys, query.grouping!.summaries);
    expect(toServerQuery({ ...withoutGrouping(query), orderBy: [{ field: "triage", dir: "asc" }], where: [{ field: "triage", op: "=", value: "x" }] }, resultSchema))
      .toMatchObject({ orderBy: [], where: [] });
  });

  it("evaluate after local grouping, HAVING, sorting and paging", () => {
    const result = applyQuery(rows, { ...query, orderBy: [{ field: "calls", dir: "desc" }], limit: 1 }, schema);
    expect(result.rows).toHaveLength(1);
    const prepared = prepareGrouping(rows, schema, query.grouping!);
    const field = prepared.schema.fields.find((f) => f.name === "library")!;
    expect(readFieldValue(field, result.rows[0]!)).toMatchObject({ label: "3", href: "/r/pharos" });
  });
});

describe("link column round-trips", () => {
  const query = normalizeQueryState(grouped(["tool"], [
    { id: "calls", op: "count" },
    toTriage,
    link("lib", { label: "Library", to: { kind: "template", template: "/lib/{field:tool}" } }),
    link("empty", { label: "x", to: { kind: "query", target: "t", base: "empty", keyFilters: false } }),
  ]));

  it("survives normalization, encoding and decoding unchanged", () => {
    expect(query.grouping!.diagnostics).toBeUndefined();
    expect(query.grouping!.summaries[1]).toEqual(toTriage);
    expect(normalizeQueryState(query)).toEqual(query);
    expect(decodeQuery(encodeQuery(query))).toEqual(query);
  });

  it("survives saved queries and snapshot links", async () => {
    const storage = memoryStorageAdapter();
    await storage.saveNamed("calls", "Tools", query, 1);
    expect((await storage.listSaved("calls"))[0]!.query).toEqual(query);
    const snapshots = new Map<string, QuerySnapshot>();
    const links = createQueryLinkService("calls", {
      save: async (key, snapshot) => { snapshots.set(key + snapshot.code, snapshot); return snapshot; },
      resolve: async (key, code) => snapshots.get(key + code) ?? null,
    }, { cache: memoryQuerySnapshotCache(), maxUrlBytes: 100_000 });
    const shared = await links.durable(query, "https://app.example/calls");
    expect(await createQueryLinkService("calls", {
      save: async (_key, snapshot) => snapshot,
      resolve: async (key, code) => snapshots.get(key + code) ?? null,
    }, { cache: memoryQuerySnapshotCache() }).resolve(shared.url)).toEqual(query);
  });

  it("isolates malformed specs to their column", () => {
    const raw = JSON.parse(JSON.stringify(query));
    raw.grouping.summaries[1].link.to.patch.owns = ["everything"];
    raw.grouping.summaries[2].link.to = { kind: "template", template: 42 };
    const normalized = normalizeQueryState(raw);
    expect(normalized.grouping!.diagnostics).toBeUndefined();
    expect(normalized.grouping!.summaries.map((s) => [s.op, Boolean(s.link)])).toEqual([["count", false], ["link", false], ["link", false], ["link", true]]);
    expect(createGroupingModel(schema).linkDiagnostics(normalized.grouping!)).toEqual([
      "Open: Invalid link definition.",
      "Link: Invalid link definition.",
    ]);
  });

  it("bounds nesting: a link's patch cannot contain link columns", () => {
    const nested = grouped(["tool"], [link("n", { label: "n", to: { kind: "query", target: "t", patch: {
      id: "deep", owns: ["grouping"], query: { grouping: { keys: ["tool"], summaries: [toTriage], representative: null, source } } as never,
    } } })]);
    expect(normalizeQueryState(nested).grouping!.summaries[0]!.link).toBeUndefined();
  });

  it("keeps only the facets a patch supplies", () => {
    const patched = normalizeQueryState(grouped(["tool"], [link("p", { label: "p", to: { kind: "query", target: "t",
      patch: { id: "layout", owns: ["columns", "limit"], query: { select: [{ field: "id", width: 5 }], limit: 7 } } } })]));
    expect(patched.grouping!.summaries[0]!.link!.to).toEqual({ kind: "query", target: "t",
      patch: { id: "layout", owns: ["columns", "limit"], query: { select: [{ field: "id", width: 24 }], limit: 7 } } });
  });
});
