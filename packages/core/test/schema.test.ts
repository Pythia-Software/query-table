import { describe, it, expect } from "vitest";
import {
  loadSchema,
  selectedFields,
  readFieldValue,
  isFilterable,
  isPushdownFilter,
  isSortable,
  isSelectable,
  opsForField,
  OPS_BY_TYPE,
} from "../src/index";
import { runsSchema, rows } from "./fixtures";

describe("per-source capability defaults", () => {
  const f = (name: string) => runsSchema.fields.find((x) => x.name === name)!;

  it("backend fields filter/sort by default; derived do not", () => {
    expect(isFilterable(f("overall"))).toBe(true);
    expect(isSortable(f("overall"))).toBe(true);
    expect(isFilterable(f("deviations"))).toBe(false); // derived
    expect(isSortable(f("deviations"))).toBe(false);
  });

  it("pushdown:false keeps the field filterable but client-side", () => {
    expect(isFilterable(f("failed_steps"))).toBe(true);
    expect(isPushdownFilter(f("failed_steps"))).toBe(false);
  });

  it("selectable defaults true", () => {
    expect(isSelectable(f("id"))).toBe(true);
  });
});

describe("ops matrix — nullity on every type, incl. bool", () => {
  it.each(["text", "number", "enum", "datetime", "bool", "textarray"] as const)("%s allows is_null/is_not_null", (t) => {
    expect(OPS_BY_TYPE[t]).toContain("is_null");
    expect(OPS_BY_TYPE[t]).toContain("is_not_null");
  });

  it("field op override wins", () => {
    expect(opsForField({ type: "text", filter: { ops: ["="] } })).toEqual(["="]);
  });
});

describe("selectedFields", () => {
  it("uses defaults when query.select is empty", () => {
    expect(selectedFields(runsSchema, { select: [] }).map((f) => f.name)).toEqual(["case_name", "overall", "total_ms"]);
  });
  it("honors explicit order and drops unknown/unselectable", () => {
    const got = selectedFields(runsSchema, {
      select: [{ field: "overall" }, { field: "nope" }, { field: "case_name" }],
    });
    expect(got.map((f) => f.name)).toEqual(["overall", "case_name"]);
  });
});

describe("readFieldValue", () => {
  it("reads a backend column by name", () => {
    expect(readFieldValue(runsSchema.fields.find((f) => f.name === "case_name")!, rows[1]!)).toBe("bravo");
  });
});

describe("loadSchema", () => {
  it("projects a JSON doc and infers source from bindings", () => {
    const doc = {
      name: "wb",
      idField: "id",
      fields: [
        { name: "id", label: "ID", type: "number", bindings: { postgres: { expr: "w.id" } } },
        { name: "deviations", label: "D", type: "text", source: "derived", render: "artifact_link" },
      ],
    };
    const s = loadSchema(doc);
    expect(s.fields[0]!.source.kind).toBe("backend"); // inferred from bindings
    expect(s.fields[1]!.source.kind).toBe("derived");
    expect(s.fields[1]!.render).toBe("artifact_link");
  });

  it("throws a readable error on a malformed doc", () => {
    expect(() => loadSchema({ name: "x" })).toThrow(/idField/);
  });
});
