import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  applyPatch,
  matchPatch,
  removePatch,
  withGroupingKeys,
  type QueryPatch,
  type QueryState,
  type WhereTerm,
} from "../src/index";

const user: WhereTerm = { field: "owner", op: "=", value: "ana" };
const base: QueryState = { ...EMPTY_QUERY, select: [{ field: "id" }], where: [user], offset: 75 };
const open: QueryPatch = {
  id: "open",
  owns: ["filters"],
  query: {
    where: [
      { field: "status", op: "=", value: "open" },
      { any: [{ field: "priority", op: "=", value: "high" }, { field: "due", op: "<", value: "+1d" }] },
      { field: "team", op: "!=", value: "ops" },
      { field: "team", op: "!=", value: "qa" },
    ],
  },
};
const layout: QueryPatch = {
  id: "layout",
  owns: ["columns", "order", "limit"],
  query: { select: [{ field: "title", width: 300 }, { field: "status" }], orderBy: [{ field: "due", dir: "asc" }], limit: 25 },
};

describe("applyPatch", () => {
  it("appends owned filters, keeps user filters and resets the offset", () => {
    const next = applyPatch(base, open);
    expect(next.where).toEqual([user, ...open.query.where!]);
    expect(next.offset).toBe(0);
    expect(next.select).toEqual(base.select);
    expect(applyPatch(next, open).where).toEqual(next.where);
  });

  it("does not duplicate structurally equal terms, including reordered OR groups", () => {
    const query = { ...base, where: [user, { any: [{ field: "due", op: "<" as const, value: "+1d" }, { field: "priority", op: "=" as const, value: "high" }] }] };
    expect(applyPatch(query, open).where).toHaveLength(5);
  });

  it("replaces owned non-filter facets and leaves the others", () => {
    const next = applyPatch({ ...base, orderBy: [{ field: "id", dir: "desc" }], limit: 100 }, layout);
    expect(next).toMatchObject({ select: layout.query.select, orderBy: layout.query.orderBy, limit: 25, where: [user], offset: 0 });
  });

  it("removes the replaced patch's filters and keeps the user's", () => {
    const closed: QueryPatch = { id: "closed", owns: ["filters"], query: { where: [{ field: "status", op: "=", value: "closed" }] } };
    const withOpen = applyPatch({ ...base, where: [...base.where, { field: "title", op: "contains", value: "bug" }] }, open);
    const next = applyPatch(withOpen, closed, { replacing: open });
    expect(next.where).toEqual([user, { field: "title", op: "contains", value: "bug" }, { field: "status", op: "=", value: "closed" }]);
  });

  it("treats a run of != terms as one unit when replacing", () => {
    const applied = applyPatch(base, open);
    // The user re-included "qa": the exclusion unit is no longer the patch's.
    const edited = { ...applied, where: applied.where.filter((term) => !("value" in term && term.value === "qa")) };
    const next = removePatch(edited, open);
    expect(next.where).toEqual([user, { field: "team", op: "!=", value: "ops" }]);
  });

  it("filters the grouping source while grouped and keeps HAVING", () => {
    const grouped = { ...withGroupingKeys(base, ["status"]), where: [{ field: "rows", op: ">" as const, value: "2" }] };
    const next = applyPatch(grouped, open);
    expect(next.where).toEqual(grouped.where);
    expect(next.grouping!.source.where).toEqual([user, ...open.query.where!]);
    expect(next.grouping!.source.offset).toBe(0);
  });

  it("enters grouping the way the grouping controls do", () => {
    const report: QueryPatch = {
      id: "report",
      owns: ["grouping", "columns"],
      query: {
        select: [{ field: "status" }, { field: "rows" }],
        where: [{ field: "rows", op: ">", value: "1" }],
        grouping: { keys: ["status"], summaries: [{ id: "rows", op: "count" }], representative: null, source: EMPTY_QUERY },
      },
    };
    const next = applyPatch(base, report);
    const entered = withGroupingKeys({ ...base, offset: 0 }, ["status"]);
    expect(next.grouping).toEqual({ ...entered.grouping, summaries: [{ id: "rows", op: "count" }], source: { ...base, offset: 0 } });
    expect(next).toMatchObject({ select: report.query.select, where: report.query.where, offset: 0 });
    expect(matchPatch(next, report).status).toBe("active");
    // Removing the patch leaves grouping and restores the record query.
    expect(removePatch(next, report)).toEqual({ ...base, offset: 0 });
  });

  it("re-keys a grouped query and drops columns on replaced aggregates", () => {
    const grouped: QueryState = {
      ...withGroupingKeys(base, ["status"]),
      select: [{ field: "status" }, { field: "old" }],
      orderBy: [{ field: "old", dir: "desc" }],
      aggregations: [{ id: "m", op: "count", groupBy: ["status"] }],
    };
    grouped.grouping = { ...grouped.grouping!, summaries: [{ id: "old", op: "count" }] };
    const patch: QueryPatch = {
      id: "g",
      owns: ["grouping"],
      query: { grouping: { keys: ["status"], summaries: [{ id: "new", op: "sum", field: "amount" }], representative: null, source: EMPTY_QUERY } },
    };
    const next = applyPatch(grouped, patch);
    expect(next.select).toEqual([{ field: "status" }]);
    expect(next.orderBy).toEqual([]);
    expect(next.aggregations).toBeUndefined();
    expect(next.grouping!.source).toEqual({ ...grouped.grouping!.source, offset: 0 });
  });

  it("applies record-stage columns to the grouping source", () => {
    const grouped = withGroupingKeys(base, ["status"]);
    const next = applyPatch(grouped, layout);
    expect(next.select).toEqual(grouped.select);
    expect(next.grouping!.source.select).toEqual(layout.query.select);
  });
});

describe("matchPatch", () => {
  it("ignores widths, fitToScreen, labels, metric display, layout and IDs", () => {
    const metrics: QueryPatch = {
      id: "metrics",
      owns: ["metrics", "columns"],
      query: { select: [{ field: "id", width: 80 }], aggregations: [{ id: "a", op: "count", groupBy: ["status"], label: "Rows" }] },
    };
    const query: QueryState = {
      ...base,
      fitToScreen: true,
      select: [{ field: "id", width: 200 }],
      aggregations: [{ id: "b", op: "count", groupBy: ["status"], display: { kind: "pie" }, layout: { widthRem: 9, heightRem: 9, minWidthRem: 1, minHeightRem: 1 } }],
    };
    expect(matchPatch(query, metrics)).toEqual({ status: "active", modified: [] });
  });

  it("is active with extra user filters", () => {
    expect(matchPatch(applyPatch(base, open), open)).toEqual({ status: "active", modified: [] });
  });

  it("reports modified facets while the patch is still recognizable", () => {
    const both: QueryPatch = { ...layout, id: "both", owns: ["filters", "columns", "order", "limit"], query: { ...layout.query, where: open.query.where! } };
    const applied = applyPatch(base, both);
    expect(matchPatch({ ...applied, limit: 50, where: [user] }, both)).toEqual({ status: "modified", modified: ["filters", "limit"] });
    // A filter-only patch is recognizable while one of its units remains.
    const partial = { ...applied, where: applied.where.filter((term) => !("value" in term && term.value === "open")) };
    expect(matchPatch(partial, open)).toEqual({ status: "modified", modified: ["filters"] });
  });

  it("is inactive when nothing owned still matches", () => {
    expect(matchPatch(base, open)).toEqual({ status: "inactive", modified: [] });
    expect(matchPatch(base, layout)).toEqual({ status: "inactive", modified: [] });
    // An empty owned filter facet is not a signature on its own.
    expect(matchPatch(base, { id: "x", owns: ["filters", "limit"], query: { limit: 5 } })).toEqual({ status: "inactive", modified: [] });
  });

  it("treats a partially removed != run as a missing unit", () => {
    const applied = applyPatch(base, open);
    const edited = { ...applied, where: applied.where.filter((term) => !("value" in term && term.value === "qa")) };
    expect(matchPatch(edited, open)).toEqual({ status: "modified", modified: ["filters"] });
  });

  it("compares HAVING and grouping as one facet", () => {
    const report: QueryPatch = {
      id: "report",
      owns: ["grouping"],
      query: { where: [{ field: "rows", op: ">", value: "1" }], grouping: { keys: ["status"], summaries: [{ id: "rows", op: "count", label: "Rows" }], representative: null, source: EMPTY_QUERY } },
    };
    const applied = applyPatch(base, report);
    expect(matchPatch(applied, report).status).toBe("active");
    expect(matchPatch({ ...applied, where: [] }, report)).toEqual({ status: "inactive", modified: [] });
    expect(matchPatch(base, report).status).toBe("inactive");
  });
});

describe("removePatch", () => {
  it("removes owned filters and resets matching facets", () => {
    const applied = applyPatch(base, { ...layout, owns: [...layout.owns, "filters"], query: { ...layout.query, where: open.query.where! } });
    const removed = removePatch(applied, { ...layout, owns: [...layout.owns, "filters"], query: { ...layout.query, where: open.query.where! } });
    expect(removed).toMatchObject({ where: [user], select: [], orderBy: [], limit: 25, offset: 0 });
  });

  it("leaves facets the user has since changed", () => {
    const applied = applyPatch(base, layout);
    const edited = { ...applied, select: [{ field: "id" }] };
    expect(removePatch(edited, layout)).toMatchObject({ select: [{ field: "id" }], orderBy: [] });
  });
});
