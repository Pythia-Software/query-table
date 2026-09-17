import { describe, expect, it } from "vitest";
import type { PreviewGroup } from "@pythia-software/query-table-core";
import { orderPreviewGroups } from "../src/previewOrdering";

const groups: PreviewGroup[] = [
  { inputs: [], result: { value: "zebra" }, count: 12 },
  { inputs: [], result: { value: "alpha" }, count: 1 },
  { inputs: [], result: { value: "middle" }, count: 6 },
];

const values = (ordered: PreviewGroup[]) =>
  ordered.map((group) => group.result.value);

describe("preview ordering", () => {
  it("uses a stable mixed order until a header selects a sort", () => {
    const first = orderPreviewGroups(groups, null);
    expect(orderPreviewGroups(groups, null)).toEqual(first);
    expect(values(first)).not.toEqual(["alpha", "middle", "zebra"]);
    expect(values(first)).not.toEqual(["zebra", "middle", "alpha"]);
  });

  it("sorts values alphabetically and counts numerically on request", () => {
    expect(values(orderPreviewGroups(groups, { key: { kind: "result" }, direction: "asc" }))).toEqual([
      "alpha",
      "middle",
      "zebra",
    ]);
    expect(values(orderPreviewGroups(groups, { key: { kind: "count" }, direction: "desc" }))).toEqual([
      "zebra",
      "middle",
      "alpha",
    ]);
  });
});
