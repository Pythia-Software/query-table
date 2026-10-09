// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useColumnDrag, type ColumnDragApi } from "../src/useColumnDrag";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("maps insertion slots between chips and headers with a movable selection column", () => {
  let drag!: ColumnDragApi;
  function Probe() {
    drag = useColumnDrag();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  const fields = ["job", "platform", "total", "priority"];
  const headers = ["selection", ...fields];
  act(() => drag.start("total", 2, fields));
  expect(drag.preview(headers)).toEqual(headers);
  act(() => drag.over(1, fields));
  expect(drag.preview(fields)).toEqual([
    "job",
    "total",
    "platform",
    "priority",
  ]);
  expect(drag.preview(headers)).toEqual([
    "selection",
    "job",
    "total",
    "platform",
    "priority",
  ]);
  // Same numeric slot in a different surface must update the anchor order.
  act(() => drag.over(1, headers));
  expect(drag.preview(fields)).toEqual([
    "total",
    "job",
    "platform",
    "priority",
  ]);
  act(() => drag.over(4, headers));
  expect(drag.preview(fields)).toEqual([
    "job",
    "platform",
    "priority",
    "total",
  ]);
  const movedSelection = ["job", "selection", "platform", "total", "priority"];
  act(() => drag.over(2, fields));
  expect(drag.preview(movedSelection)).toEqual([
    "job",
    "selection",
    "platform",
    "total",
    "priority",
  ]);
  // Starting a chip drag must not jump across an auxiliary column before hover.
  act(() => drag.start("job", 0, fields));
  expect(drag.preview(movedSelection)).toEqual(movedSelection);
  act(() => drag.start("selection", 1, movedSelection));
  act(() => drag.over(4, movedSelection));
  expect(drag.preview(movedSelection)).toEqual([...fields, "selection"]);
  expect(drag.preview(fields)).toEqual(fields);
  const beforeCancel = drag.dropRevision!;
  act(() => drag.end());
  expect(drag.dropRevision).toBe(beforeCancel);
  expect(drag.preview(headers)).toEqual(headers);
  act(() => drag.start("job", 0, fields));
  act(() => drag.end(true));
  expect(drag.dropRevision).toBe(beforeCancel + 1);
  act(() => root.unmount());
});

it("preserves index-only callers", () => {
  let drag!: ColumnDragApi;
  function Probe() {
    drag = useColumnDrag();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => drag.start("a", 2));
  expect(drag.preview(["a", "b", "c"])).toEqual(["b", "c", "a"]);
  act(() => drag.over(2));
  expect(drag.preview(["a", "b", "c"])).toEqual(["b", "c", "a"]);
  act(() => root.unmount());
});
