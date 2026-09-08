// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { FieldDef, QueryState } from "@pythia-software/query-table-core";
import { DataTable } from "../src/DataTable";
import type { RenderRegistry } from "../src/renderers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name: string;
}

const field: FieldDef<Row> = {
  name: "name",
  label: "Name",
  type: "text",
  source: { kind: "backend" },
  render: "counting",
};

const query: QueryState = {
  select: [{ field: "name", width: 120 }],
  where: [],
  orderBy: [],
  limit: 100,
  offset: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("DataTable column resizing", () => {
  it("previews pointer moves without rerendering every cell", () => {
    let animationFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => ++animationFrameId));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const renderCell = vi.fn(({ value }: { value: unknown }) => String(value));
    const renderers = { counting: renderCell } as RenderRegistry<Row>;
    const onQueryChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(createElement(DataTable<Row>, {
        fields: [field],
        rows,
        query,
        onQueryChange,
        renderers,
        rowId: (row) => row.id,
      }));
    });
    expect(renderCell).toHaveBeenCalledTimes(rows.length);

    const handle = container.querySelector<HTMLElement>(".qt-resize-handle");
    expect(handle).not.toBeNull();
    act(() => handle!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 })));
    for (const clientX of [110, 120, 130, 140, 150]) {
      act(() => window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX })));
    }

    expect(renderCell).toHaveBeenCalledTimes(rows.length);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 150 })));
    expect(renderCell).toHaveBeenCalledTimes(rows.length);
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    const update = onQueryChange.mock.calls[0]![0] as (previous: QueryState) => QueryState;
    expect(update(query).select[0]?.width).toBe(170);
    expect(container.querySelector<HTMLTableColElement>('col[data-qt-column="name"]')?.style.width).toBe("170px");

    act(() => root.unmount());
    container.remove();
  });
});
