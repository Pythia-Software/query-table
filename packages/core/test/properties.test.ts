import { describe, expect, it } from "vitest";
import {
  createPropertyView,
  discoverFieldRelationships,
  memoryPropertyViewStorage,
  normalizePropertyView,
  objectReferenceKey,
  readObjectReference,
  type FieldDef,
  type FieldSchema,
  type ForeignKey,
} from "../src/index";

const fields: FieldDef[] = [
  {
    name: "workspace",
    label: "Work",
    type: "text",
    source: { kind: "backend", path: "workspace_id" },
    origin: { table: "calls", column: "workspace_id" },
  },
  {
    name: "tenant",
    label: "Tenant",
    type: "text",
    source: { kind: "backend" },
    origin: { table: "calls", column: "tenant_id" },
  },
];
const schema: FieldSchema = { name: "calls", idField: "id", fields };
const view = createPropertyView(schema);

describe("property views", () => {
  it("validates, bounds and preserves property label widths", () => {
    expect(normalizePropertyView({ ...view, labelWidth: 44.5 }).labelWidth).toBe(45);
    expect(normalizePropertyView({ ...view, labelWidth: 0 }).labelWidth).toBe(15);
    expect(normalizePropertyView({ ...view, labelWidth: 100 }).labelWidth).toBe(75);
    expect(normalizePropertyView({ ...view, labelWidth: Infinity }).labelWidth).toBeUndefined();
  });
  it("preserves duplicate field appearances, order, missing fields and an explicitly empty view", () => {
    const value = normalizePropertyView({
      version: 1,
      properties: [
        { id: "relative", field: "stamp", format: { kind: "relative" } },
        {
          id: "exact",
          field: "stamp",
          format: { kind: "datetime", timeZone: "UTC" },
        },
        { id: "removed", field: "old-field" },
      ],
    });
    expect(value.properties.map((p) => p.field)).toEqual([
      "stamp",
      "stamp",
      "old-field",
    ]);
    expect(
      normalizePropertyView({ version: 1, properties: [] }).properties,
    ).toEqual([]);
    expect(() => normalizePropertyView({ ...value, version: 2 })).toThrow(
      "version 1",
    );
    expect(() =>
      normalizePropertyView({
        version: 1,
        properties: [
          { id: "a", field: "x" },
          { id: "a", field: "y" },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      normalizePropertyView({
        version: 1,
        properties: [
          {
            id: "a",
            field: "x",
            format: { kind: "duration", sourceUnit: "guess" },
          },
        ],
      }),
    ).toThrow("Invalid format");
  });
  it("uses object defaults independently of table selection", () => {
    expect(createPropertyView(schema).properties).toHaveLength(2);
    const selected = createPropertyView({
      ...schema,
      fields: fields.map((field) => ({
        ...field,
        property: { default: field.name === "tenant" },
      })),
      defaultSelect: [{ field: "workspace" }],
    });
    expect(selected.properties.map((p) => p.field)).toEqual(["tenant"]);
  });
  it("isolates persistence by object type and clones saved definitions", async () => {
    const storage = memoryPropertyViewStorage();
    const saved = await storage.saveNamed("calls", "Overview", view, 42);
    await storage.saveLast("calls", view);
    await storage.setDefaultSaved("calls", saved.id);
    saved.view.properties.reverse();
    expect((await storage.loadDefaultSaved("calls"))?.view).toEqual(view);
    expect(await storage.loadLast("other")).toBeNull();
    await expect(
      storage.saveNamed("calls", "Overview", view, 42),
    ).rejects.toThrow("already exists");
    const second = await storage.saveNamed("calls", "Debug", view, 42);
    expect(second.id).not.toBe(saved.id);
    await storage.deleteSaved("calls", saved.id);
    expect(await storage.loadDefaultSaved("calls")).toBeNull();
    expect(await storage.loadLast("calls")).toEqual(view);
  });
});

describe("foreign key projection", () => {
  const fk: ForeignKey = {
    sourceTable: "calls",
    sourceColumns: ["tenant_id", "workspace_id"],
    targetTable: "workspaces",
    targetColumns: ["tenant", "id"],
  };
  const types = [
    { name: "work", table: "workspaces", keyFields: ["tenant", "id"] },
  ];
  it("maps composite keys through field origins and canonical accessors", () => {
    const linked = discoverFieldRelationships(fields, [fk], types);
    const reference = readObjectReference(linked[0]!, linked, {
      workspace_id: "w1",
      tenant: "t1",
    });
    expect(reference).toEqual({
      objectType: "work",
      key: { tenant: "t1", id: "w1" },
    });
    expect(objectReferenceKey(reference!)).toBe(
      objectReferenceKey({
        objectType: "work",
        key: { id: "w1", tenant: "t1" },
      }),
    );
    expect(
      readObjectReference(linked[0]!, linked, {
        workspace_id: "w1",
        tenant: null,
      }),
    ).toBeNull();
  });
  it("does not guess ambiguous, partial, or undeclared relationships", () => {
    expect(
      discoverFieldRelationships(fields.slice(0, 1), [fk], types)[0]
        ?.relationship,
    ).toBeUndefined();
    expect(
      discoverFieldRelationships(
        fields,
        [fk],
        [...types, { ...types[0]!, name: "another" }],
      )[0]?.relationship,
    ).toBeUndefined();
    const explicit = {
      ...fields[0]!,
      relationship: { objectType: "custom", key: { id: "workspace" } },
    };
    expect(
      discoverFieldRelationships([explicit, fields[1]!], [fk], types)[0],
    ).toBe(explicit);
  });
});

describe("shared JSON and chip property formats", () => {
  it("retains JSON decoding settings through normalization, storage and query encoding", async () => {
    const { encodeQuery, decodeQuery, EMPTY_QUERY } = await import("../src/index");
    const json = { kind: "json", encoding: "escaped", maxDecodeDepth: 6, expandDepth: 2 };
    const view = normalizePropertyView({ version: 1, properties: [{ id: "payload", field: "payload", format: json }] });
    expect(view.properties[0]?.format).toEqual(json);
    const query = { ...EMPTY_QUERY, itemDetails: { modes: ["modal" as const], views: { modal: view } } };
    expect(decodeQuery(encodeQuery(query))?.itemDetails?.views?.modal).toEqual(view);
    const storage = memoryPropertyViewStorage();
    await storage.saveNamed("responses", "JSON", view, 123);
    expect((await storage.listSaved("responses"))[0]?.view).toEqual(view);
  });
  it("rejects invalid decode settings and clones chip label maps", () => {
    expect(() => normalizePropertyView({ version: 1, properties: [{ id: "payload", field: "payload", format: { kind: "json", maxDecodeDepth: 99 } }] })).toThrow("Invalid format");
    const labels = { ready: "Ready" };
    const view = normalizePropertyView({ version: 1, properties: [{ id: "status", field: "status", format: { kind: "chip", labels } }] });
    labels.ready = "Changed";
    expect(view.properties[0]?.format).toEqual({ kind: "chip", labels: { ready: "Ready" } });
  });
});
