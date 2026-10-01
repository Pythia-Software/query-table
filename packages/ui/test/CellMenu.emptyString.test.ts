import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldDef } from "@pythia-software/query-table-core";
import { CellMenu } from "../src/CellMenu";

const field: FieldDef = {
  name: "name",
  label: "Name",
  type: "text",
  source: { kind: "backend" },
};

describe("CellMenu empty string filters", () => {
  it("offers empty-string actions separately from NULL filtering", () => {
    const markup = renderToStaticMarkup(createElement(CellMenu, {
      field,
      value: "",
      x: 0,
      y: 0,
      onAddFilter: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain("include empty strings");
    expect(markup).toContain("exclude empty strings");
    expect(markup).not.toContain("length equals");
    expect(markup).not.toContain("<code>0</code>");
    expect(markup).toContain("is null");
  });
});
