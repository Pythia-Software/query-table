import { describe, expect, it } from "vitest";
import { EMPTY_QUERY, createPropertyView, decodeQuery, encodeQuery, normalizeQueryState, queriesEqual, toServerQuery, renderItemPageTemplate, validateItemPageTemplate, type FieldSchema, type QueryState } from "../src/index";
const schema: FieldSchema = { name: "items", idField: "id", fields: [
  { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
] };
describe("item detail query presentation", () => {
  it("round-trips Page settings without affecting backend query semantics", () => {
    const query: QueryState = { ...EMPTY_QUERY, itemDetails: { modes: ["page"], page: { urlTemplate: "/items/{id}?name={field:name}&q={query}", target: "_self" } } };
    expect(decodeQuery(encodeQuery(query))).toEqual(query);
    expect(toServerQuery(query, schema)).toEqual(toServerQuery(EMPTY_QUERY, schema));
    expect(normalizeQueryState({ itemDetails: { modes: ["page"], page: { urlTemplate: "/items/{id}", target: "danger" } } }).itemDetails?.page?.target).toBe("_blank");
  });
  it("encodes URL substitutions and rejects missing values, unknown fields, and executable schemes", () => {
    expect(renderItemPageTemplate("/items/{id}?name={field:name}&q={query}", schema, { name: "é/a? &" }, 0, "abc+/=")).toBe("/items/0?name=%C3%A9%2Fa%3F%20%26&q=abc%2B%2F%3D");
    expect(renderItemPageTemplate("/items/{field:name}", schema, {}, "a", "")).toBeNull();
    expect(validateItemPageTemplate("/items/{field:missing}", schema)).toMatch(/Unknown/);
    expect(validateItemPageTemplate("/items/{unknown}", schema)).toMatch(/placeholder/);
    for (const template of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,test", "{field:name}:alert(1)"]) {
      expect(renderItemPageTemplate(template, schema, { name: "javascript" }, "a", "")).toBeNull();
    }
    expect(validateItemPageTemplate("", schema)).toBeNull();
  });
  it("shares query filters, typed identity, modality, and independent property appearances", () => {
    for (const mode of ["modal", "expand"] as const) for (const id of [0, "0", "é/a?"]) {
      const query: QueryState = { ...EMPTY_QUERY,
        where: [{ field: "name", op: "contains", value: "alpha" }],
        itemDetails: { modes: ["hover", "modal", "expand"], active: { id, mode }, view: createPropertyView(schema, ["name", "name"]) },
      };
      expect(decodeQuery(encodeQuery(query))).toEqual(query);
      expect(toServerQuery(query, schema)).toEqual(toServerQuery({ ...EMPTY_QUERY, where: query.where }, schema));
    }
  });
  it("round-trips isolated modality layouts and sanitizes unknown or malformed views", () => {
    const view = { ...createPropertyView(schema), labelWidth: 50 };
    const query: QueryState = { ...EMPTY_QUERY, itemDetails: { modes: ["hover", "modal", "expand"], views: {
      modal: view, hover: createPropertyView(schema, []), expand: createPropertyView(schema, ["name", "name"]),
    } } };
    expect(decodeQuery(encodeQuery(query))).toEqual(query);
    expect(normalizeQueryState({ itemDetails: { modes: ["modal"], views: { modal: view, hover: { version: 2, properties: [] }, unknown: view } } }).itemDetails?.views).toEqual({ modal: view });
  });
  it("retains disabled buttons and an explicitly empty view across serialization", () => {
    const query: QueryState = { ...EMPTY_QUERY, itemDetails: { modes: [], view: { version: 1, properties: [] } } };
    expect(decodeQuery(encodeQuery(query))).toEqual(query);
    expect(queriesEqual(query, EMPTY_QUERY)).toBe(false);
  });
  it("bounds and whitelists detail state at URL/storage boundaries", () => {
    expect(normalizeQueryState({ itemDetails: {
      modes: ["modal", "modal", { toString: () => "expand" }, "bad"],
      active: { id: 0, mode: "modal", execute: "ignored" },
      view: { version: 2, properties: [] }, execute: "ignored",
    } }).itemDetails).toEqual({ modes: ["modal"], active: { id: 0, mode: "modal" } });
    for (const id of [null, {}, [], Infinity, "", "x".repeat(1001)]) {
      expect(normalizeQueryState({ itemDetails: { modes: ["modal"], active: { id, mode: "modal" } } }).itemDetails).toEqual({ modes: ["modal"] });
    }
    expect(normalizeQueryState({ itemDetails: { modes: ["hover"], active: { id: "a", mode: "modal" } } }).itemDetails).toEqual({ modes: ["hover"] });
  });
});
