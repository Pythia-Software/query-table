// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_QUERY, type FieldDef } from "@pythia-software/query-table-core";
import { useSelection, type SelectionApi } from "@pythia-software/query-table-react";
import { DataTable } from "../src/DataTable";
import { defaultRenderers } from "../src/renderers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));
const field: FieldDef<{ id: number }> = {
  name: "id", label: "ID", type: "number", source: { kind: "backend" },
};
let root: Root | undefined;
let container: HTMLDivElement;
let selection: SelectionApi;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

function renderTable() {
  // Give the virtualizer a client viewport so jsdom renders row checkboxes.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  function Harness() {
    selection = useSelection(rows.map((row) => row.id));
    return createElement(DataTable<{ id: number }>, {
      fields: [field], rows, query: EMPTY_QUERY, onQueryChange: () => undefined,
      renderers: defaultRenderers, rowId: (row: { id: number }) => row.id, selection,
    });
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));
}

function checkbox(id: number): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="select row ${id}"]`)!;
}

function click(id: number, modifiers: MouseEventInit = {}) {
  act(() => checkbox(id).dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers })));
}

function expectChecked(ids: number[]) {
  expect(selection.selected).toEqual(new Set(ids));
  for (const row of rows) expect(checkbox(row.id).checked).toBe(ids.includes(row.id));
}

describe("DataTable editable checkbox ranges", () => {
  it("resizes ranges and preserves earlier selections through real checkbox clicks", () => {
    renderTable();
    click(2);
    click(6, { shiftKey: true });
    click(4, { shiftKey: true });
    expectChecked([2, 3, 4]);
    click(6);
    click(8, { shiftKey: true });
    click(7, { shiftKey: true });
    expectChecked([2, 3, 4, 6, 7]);
  });

  it.each(["ctrlKey", "metaKey"] as const)("adds ranges using %s + Shift", (modifier) => {
    renderTable();
    click(2);
    click(6, { shiftKey: true });
    click(4, { shiftKey: true, [modifier]: true });
    expectChecked([2, 3, 4, 5, 6]);
    click(8, { [modifier]: true });
    expectChecked([2, 3, 4, 5, 6, 8]);
    click(7, { shiftKey: true });
    expectChecked([2, 3, 4, 5, 6, 7, 8]);
  });

  it("unchecks a range and restores checks as the range shrinks", () => {
    renderTable();
    click(2);
    click(6, { shiftKey: true });
    click(3);
    click(5, { shiftKey: true });
    expectChecked([2, 6]);
    click(4, { shiftKey: true });
    expectChecked([2, 5, 6]);
  });

  it("handles Shift+Space directly and prevents a second native toggle", () => {
    renderTable();
    click(2, { detail: 0 });
    const pressSpace = (id: number, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: " ", bubbles: true, cancelable: true, shiftKey: true, ...options,
      });
      act(() => checkbox(id).dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    pressSpace(6);
    expectChecked([2, 3, 4, 5, 6]);
    pressSpace(4);
    expectChecked([2, 3, 4]);
    pressSpace(8, { repeat: true });
    expectChecked([2, 3, 4]);
    pressSpace(6, { metaKey: true });
    pressSpace(3);
    expectChecked([2, 3, 4]);
  });
});
