import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SelectionApi } from "@pythia-software/query-table-react";
import { SelectionToolbar } from "../src/SelectionToolbar";

const selection: SelectionApi = {
  selected: new Set([1, 2]),
  isSelected: (id) => id === 1 || id === 2,
  toggle: () => undefined,
  setPage: () => undefined,
  replace: () => undefined,
  retain: () => undefined,
  pageState: () => "all",
  clear: () => undefined,
  count: 2,
};

describe("SelectionToolbar actions", () => {
  it("keeps one-argument action callbacks backward compatible", () => {
    const actions = vi.fn((ids: Array<string | number>) => createElement("b", null, ids.join(",")));
    const markup = renderToStaticMarkup(createElement(SelectionToolbar, { selection, actions }));

    expect(markup).toContain("<b>1,2</b>");
    expect(actions).toHaveBeenCalledWith([1, 2], selection);
  });

  it("provides the selection API to consumer-rendered actions", () => {
    let received: SelectionApi | undefined;
    renderToStaticMarkup(
      createElement(SelectionToolbar, {
        selection,
        actions: (_ids, api) => {
          received = api;
          return null;
        },
      }),
    );

    expect(received).toBe(selection);
  });
});
