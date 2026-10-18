import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeQuery,
  decodeQueryStrict,
  encodeQuery,
  localStorageAdapter,
  normalizeQueryState,
  queriesEqual,
  toServerQuery,
  type QueryState,
} from "../src/index";
import { parseCellDisplay } from "../src/cellDisplay";
import { inflateSync } from "fflate";
import { runsSchema } from "./fixtures";

function tokenJson(token: string): Record<string, unknown> {
  const bytes = Buffer.from(token.slice(3), "base64url");
  return JSON.parse(token.startsWith("2d.") ? new TextDecoder().decode(inflateSync(bytes)) : bytes.toString());
}

// Tokens produced by the 0.7.1 encoder (origin/main before SelectColumn.display).
// They must keep decoding to exactly these states and re-encode byte-for-byte.
const V071 = {
  plain: "2d.VY07CoAwEETP4tRbiGIT8CQhxWIiCPmI8VNI7u4asLCbx8xjbmQorRE5OBjSmFIIHC2o79qX8877kWEM4ZLljXlx3kJ9BSGtQs0o6WR_OAGbokMRI_2M-kGwyybAeaoTDzW05QE",
  grouped: "2d.RU4xDoMwEPuL5wwpUpeMfUJXxBDggKghQUkAIZS_91JadbPPPtsnIlRdI9BovEMjGOpEELdKNo2AharuAi3UiRcdxfz3Iq7zrIOhcj5heig4CPiFQedXl5DF936lXpLeRoaDIVuU2PlQJKtb4jo8izNzeqAlUCSXdDIbQbnVWu70a-iY8XKy1KVP9S_L6blE7aZPEy-XsuTsE3GBqhn60FN4HBexZjb8fpOShWGIxETmnN8",
  // Pre-versioned token with a legacy string[] select.
  legacy: "eyJzIjpbIm5hbWUiLFsiY29tbWFuZCIsMzAwXV0sImwiOjEwfQ",
};
const plainState: QueryState = normalizeQueryState({
  select: [{ field: "name" }, { field: "command", width: 320 }, { field: "status" }],
  where: [{ field: "status", op: "!=", value: "done" }],
  orderBy: [{ field: "name", dir: "asc" }],
  limit: 50,
});
const groupedState: QueryState = normalizeQueryState({
  select: [{ field: "region" }, { field: "rate", width: 120 }],
  limit: 25,
  grouping: {
    keys: ["region"],
    summaries: [{ id: "n", op: "count" }, { id: "rate", op: "avg", field: "score", label: "Rate" }],
    representative: null,
    source: normalizeQueryState({ select: [{ field: "name", width: 200 }] }),
  },
});

describe("backward compatibility of select columns", () => {
  it("decodes 0.7.1 links unchanged", () => {
    expect(decodeQueryStrict(V071.plain)).toEqual(plainState);
    expect(decodeQueryStrict(V071.grouped)).toEqual(groupedState);
    expect(decodeQueryStrict(V071.legacy)).toEqual(normalizeQueryState({ select: [{ field: "name" }, { field: "command", width: 300 }], limit: 10 }));
  });

  it("encodes queries without column displays exactly as 0.7.1 did", () => {
    expect(encodeQuery(plainState)).toBe(V071.plain);
    expect(encodeQuery(groupedState)).toBe(V071.grouped);
  });

  afterEach(() => vi.unstubAllGlobals());
  it("loads saved queries written by 0.7.1 unchanged", async () => {
    const saved = [{ id: "1-1", name: "Old", savedAt: 1, query: plainState }];
    const values = new Map([["query-table:saved:runs", JSON.stringify(saved)], ["query-table:last:runs", JSON.stringify(groupedState)]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => {} });
    const storage = localStorageAdapter();
    expect((await storage.listSaved("runs"))[0]!.query).toEqual(plainState);
    expect(await storage.loadLast("runs")).toEqual(groupedState);
  });
});

describe("SelectColumn.display", () => {
  const clamped: QueryState = normalizeQueryState({
    ...plainState,
    select: [
      { field: "name" },
      { field: "command", width: 320, display: { kind: "text", lines: 3 } },
      { field: "status", display: { kind: "chip", tones: { done: "success" } } },
    ],
  });

  it("round-trips through links, equality and saved queries", async () => {
    const copy = decodeQueryStrict(encodeQuery(clamped));
    expect(copy).toEqual(clamped);
    expect(queriesEqual(copy, clamped)).toBe(true);
    expect(queriesEqual(copy, plainState)).toBe(false);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => {} });
    try {
      const storage = localStorageAdapter();
      await storage.saveNamed("runs", "Reading", clamped, 2);
      expect((await storage.listSaved("runs"))[0]!.query).toEqual(clamped);
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses a third tuple member that older decoders ignore", () => {
    expect(tokenJson(encodeQuery({ ...clamped, select: clamped.select.slice(1) })).s).toEqual([
      ["command", 320, { kind: "text", lines: 3 }],
      ["status", null, { kind: "chip", tones: { done: "success" } }],
    ]);
    // A 0.7.1 decoder keeps [field] / [field, width] and drops the extra member.
    const old = (item: unknown[]) => typeof item[1] === "number" ? { field: item[0], width: item[1] } : { field: item[0] };
    expect([["command", 320, {}], ["status", null, {}]].map(old)).toEqual([{ field: "command", width: 320 }, { field: "status" }]);
  });

  it("drops a malformed display but keeps the column", () => {
    const q = normalizeQueryState({ select: [
      { field: "command", width: 300, display: { kind: "text", lines: 0 } },
      { field: "status", display: "chip" },
    ] });
    expect(q.select).toEqual([{ field: "command", width: 300 }, { field: "status" }]);
  });

  it("never reaches the server request", () => {
    expect(toServerQuery(clamped, runsSchema)).toEqual(toServerQuery(plainState, runsSchema));
  });

  it("validates text line clamping", () => {
    expect(parseCellDisplay({ kind: "text", lines: 20 })).toEqual({ kind: "text", lines: 20 });
    expect(() => parseCellDisplay({ kind: "text", lines: 21 })).toThrow(/lines must be an integer from 1 to 20/);
    expect(() => parseCellDisplay({ kind: "text", lines: 1.5 })).toThrow(/lines/);
  });
});
