import { describe, expect, it } from "vitest";
import {
  decodeQueryStrict,
  encodeQuery,
  EMPTY_QUERY,
  exitGrouping,
  groupLinkQuery,
  normalizeQueryState,
  parseHostQueryState,
  queriesEqual,
  withGroupingKeys,
  type QueryState,
} from "../src/index";

const keyword = { version: 1, params: { record_tool_calls: ["command", "(cache OR buffer) NOT obsolete"] } };

describe("host query state", () => {
  it("canonicalizes parameter order and keeps values in order", () => {
    expect(JSON.stringify(parseHostQueryState({ params: { z: ["b", "a"], a: [] }, version: 2 })))
      .toBe('{"version":2,"params":{"a":[],"z":["b","a"]}}');
  });

  it("rejects malformed and oversized payloads", () => {
    for (const bad of [
      null, [], { version: 1 }, { version: 0, params: {} }, { version: 1.5, params: {} },
      { version: 1, params: { a: "x" } }, { version: 1, params: { a: [1] } }, { version: 1, params: { "bad name": [] } },
      { version: 1, params: {}, extra: true },
      { version: 1, params: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, []])) },
      { version: 1, params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, ["x".repeat(3999), "x".repeat(3999)]])) },
    ]) expect(() => parseHostQueryState(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow(/Invalid host query state/);
  });

  it("keeps unreadable state as version 0 instead of dropping it", () => {
    expect(normalizeQueryState({ hostState: { version: 1, params: { a: "x" } } }).hostState).toEqual({ version: 0, params: {} });
    expect(normalizeQueryState({}).hostState).toBeUndefined();
  });

  it("round-trips through links and rejects bad links strictly", () => {
    const query: QueryState = { ...EMPTY_QUERY, hostState: keyword };
    expect(decodeQueryStrict(encodeQuery(query)).hostState).toEqual(keyword);
    expect(queriesEqual(query, { ...EMPTY_QUERY, hostState: { version: 1, params: { record_tool_calls: ["command", "other"] } } })).toBe(false);
    expect(queriesEqual(query, normalizeQueryState(query))).toBe(true);
  });

  it("stays on the grouped query and returns with the source", () => {
    const source: QueryState = { ...EMPTY_QUERY, where: [{ field: "status", op: "=", value: "error" }], hostState: keyword };
    const grouped = withGroupingKeys(source, ["tool"]);
    expect(grouped.hostState).toEqual(keyword);
    expect(grouped.grouping!.source.hostState).toBeUndefined();
    const changed = { ...grouped, hostState: { version: 1, params: { record_tool_calls: ["command", "cache"] } } };
    expect(exitGrouping(changed)).toEqual({ ...source, hostState: changed.hostState });
    // A source drill-down keeps the host's restriction.
    const destination = groupLinkQuery(changed, {
      kind: "group-link", label: "Records", to: { kind: "query", target: "calls" }, terms: [{ field: "tool", op: "=", value: "Bash" }],
    });
    expect(destination!.hostState).toEqual(changed.hostState);
    expect(destination!.where).toEqual([...source.where, { field: "tool", op: "=", value: "Bash" }]);
    // Normalization never leaves host state on a grouping source.
    expect(normalizeQueryState({ ...grouped, grouping: { ...grouped.grouping!, source: { ...source } } }).grouping!.source.hostState).toBeUndefined();
  });
});
