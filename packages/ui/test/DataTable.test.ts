import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_QUERY, type FieldDef } from "@pythia-software/query-table-core";
import { DataTable } from "../src/DataTable";
import { defaultRenderers } from "../src/renderers";

interface Row {
  id: number;
}

const idField: FieldDef<Row> = {
  name: "id",
  label: "ID",
  type: "number",
  source: { kind: "backend" },
};

describe("DataTable row virtualization", () => {
  it("renders only the viewport and overscan for a large row set", () => {
    const rows = Array.from({ length: 12_000 }, (_, id) => ({ id }));
    const markup = renderToStaticMarkup(
      createElement(DataTable<Row>, {
        fields: [idField],
        rows,
        query: { ...EMPTY_QUERY, limit: rows.length },
        onQueryChange: () => undefined,
        renderers: defaultRenderers,
        rowId: (row) => row.id,
        maxHeight: 370,
        estimateRowHeight: 37,
        overscan: 2,
      }),
    );

    const renderedRows = markup.match(/class="qt-row"/g)?.length ?? 0;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(20);
    expect(markup).toContain("qt-virtual-spacer");
    expect(markup).not.toContain(">11999<");
  });

  it("keeps the empty-state row when there is nothing to virtualize", () => {
    const markup = renderToStaticMarkup(
      createElement(DataTable<Row>, {
        fields: [idField],
        rows: [],
        query: EMPTY_QUERY,
        onQueryChange: () => undefined,
        renderers: defaultRenderers,
        rowId: (row) => row.id,
        emptyMessage: "Nothing here",
      }),
    );

    expect(markup).toContain("Nothing here");
    expect(markup).not.toContain("qt-virtual-spacer");
  });
});
