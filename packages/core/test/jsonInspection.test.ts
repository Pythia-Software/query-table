import { describe, expect, it } from "vitest";
import { EMPTY_QUERY, decodeQueryStrict, encodeQuery, isJsonPath, jsonInspectionScopeKey, parseJsonInspectionState, parseJsonInspections, toServerQuery, createQueryLinkService, type QuerySnapshot, type QuerySnapshotStore, type JsonInspectionState } from "../src/index";

export const inspection: JsonInspectionState = { version: 1, open: false, search: "", searchMode: "find", raw: false,
  collapsedPaths: ['$["a.b"]["quote\\\"key"]', "$[0]", '$["items"]'], expandedBuckets: ['$["items"]:bucket:40', '$["items"]:bucket:20'], visibleEntryLimit: 400,
  selectedMatch: { path: '$["a.b"]["quote\\\"key"]', part: "value", start: 0 }, searchOverrides: [{ path: '$["items"]', expanded: false }] };
describe("portable JSON inspection state", () => {
  it("keeps explicit false, empty search, ordered sets and typed record identities in links", () => {
    const entries = [0, "0"].map(rowId => ({ dataset: "items", rowId, field: "payload", state: inspection }));
    const query = { ...EMPTY_QUERY, itemDetails: { modes: ["modal" as const], jsonInspections: entries } };
    expect(decodeQueryStrict(encodeQuery(query))).toEqual(query);
    expect(jsonInspectionScopeKey(entries[0]!)).not.toEqual(jsonInspectionScopeKey(entries[1]!));
    expect(toServerQuery(query, { name: "items", idField: "id", fields: [] })).toEqual(toServerQuery(EMPTY_QUERY, { name: "items", idField: "id", fields: [] }));
  });
  it("whitelists transient fields and returns independent arrays", () => {
    const parsed = parseJsonInspectionState({ ...inspection, hover: true, focus: "input", copyStatus: "copied", scrollTop: 400, draft: "unsubmitted" });
    expect(parsed).toEqual(inspection);
    expect(parsed.collapsedPaths).not.toBe(inspection.collapsedPaths);
  });
  it("rejects future versions, invalid paths, duplicate scopes and malformed states", () => {
    for (const patch of [{ version: 2 }, { raw: 0 }, { searchMode: "highlight" }, { visibleEntryLimit: 0 }, { collapsedPaths: ["$.ambiguous"] }, { expandedBuckets: ["$:bucket:21"] }, { collapsedPaths: ["$", "$"] }])
      expect(() => parseJsonInspectionState({ ...inspection, ...patch })).toThrow();
    const entry = { dataset: "items", rowId: 0, field: "payload", state: inspection };
    expect(() => parseJsonInspections([entry, entry])).toThrow();
    const token = "2j." + Buffer.from(JSON.stringify({ d: { modes: ["modal"], jsonInspections: [{ ...entry, state: { ...inspection, version: 99 } }] } })).toString("base64url");
    expect(() => decodeQueryStrict(token)).toThrow();
    expect(isJsonPath('$["a.b"]["quoted\\\"key"][0]')).toBe(true);
    expect(isJsonPath('$["\\u0000"]')).toBe(true);
    expect(isJsonPath("$[01]")).toBe(false);
  });
});

it("retains JSON definitions in immutable Save/Share snapshots with an empty consumer cache", async () => {
  const snapshots = new Map<string, QuerySnapshot>();
  const store: QuerySnapshotStore = { save: async (_key, snapshot) => { snapshots.set(snapshot.code, structuredClone(snapshot)); return snapshot; }, resolve: async (_key, code) => snapshots.get(code) ?? null };
  const query = { ...EMPTY_QUERY, itemDetails: { modes: ["modal" as const], jsonInspections: [{ dataset: "items", rowId: 0, field: "payload", state: inspection }] } };
  const first = createQueryLinkService("items", store, { maxUrlBytes: 100 });
  const saved = await first.snapshot(query);
  expect(saved).not.toBeNull();
  const share = await first.durable(query, "https://example.test/items");
  expect(share.kind).toBe("durable");
  const fresh = createQueryLinkService("items", store, { maxUrlBytes: 100 });
  expect(await fresh.resolve(share.url)).toEqual(query);
  expect(decodeQueryStrict(snapshots.get(saved!.code)!.token)).toEqual(query);
});
