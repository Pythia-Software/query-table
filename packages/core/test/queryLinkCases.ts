// Cases for schema/fixtures/query-links.json, the query link parity fixtures
// shared with the Go module (backends/go/query_links_test.go). The fixture
// test turns them into expected tokens, states and error codes.
//
// - `state` cases are QueryStates passed to encodeQuery. They stay within what
//   Go's LinkQuery can hold (integer limits and widths, no lone surrogates),
//   because the Go test builds a LinkQuery from each one.
// - `token` cases are hand-made links that exercise legacy shapes and
//   normalization of state a current encoder never writes.
// - `invalid` cases are links decodeQueryStrict rejects, and `encodeInvalid`
//   cases are states encodeQuery rejects.
//
// Very large inputs are written as generators, expanded the same way in both
// languages: {"$repeat": text, "count": n} is text repeated n times, and
// {"$random": seed, "length": n} is n characters from a fixed xorshift32
// sequence over the base64url alphabet (incompressible, so it defeats DEFLATE).
// A generated token is {"prefix": p, "repeat": text, "count": n}.
import { deflateSync } from "fflate";
import { createSetFilter, EMPTY_QUERY, type QueryState } from "../src/index";

export interface StateCase { name: string; state: QueryState }
export interface TokenCase { name: string; token: string }
export type GeneratedToken = { prefix: string; repeat: string; count: number };
export interface InvalidCase { name: string; token: string | GeneratedToken; code: "invalid" | "too_large" | "unsupported_version" }
export interface EncodeInvalidCase { name: string; state: unknown; code: "too_large" }

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
/** A "2j." token over exact JSON text (or a value to stringify). */
const plain = (value: unknown) => "2j." + base64url(text(value));
/** A "2d." token over exact JSON text or bytes. */
const deflated = (value: unknown) => "2d." + base64url(deflateSync(value instanceof Uint8Array ? value : Buffer.from(text(value))));
/** A legacy token: unprefixed base64url JSON. */
const legacy = (value: unknown) => base64url(text(value));

const view = (label: string) => ({
  version: 1,
  properties: [
    { id: "p0", field: "model", label },
    { id: "p1", field: "cost", format: { kind: "currency", currency: "USD", decimals: 2 } },
  ],
  labelWidth: 40,
});

export const stateCases: StateCase[] = [
  { name: "empty query", state: EMPTY_QUERY },
  {
    name: "dashboard filter",
    state: { ...EMPTY_QUERY, where: [{ field: "provider", op: "=", value: "anthropic" }, { field: "model_family", op: "contains", value: "opus" }] },
  },
  { name: "paging", state: { ...EMPTY_QUERY, limit: 25, offset: 50 } },
  { name: "explicit default limit", state: { ...EMPTY_QUERY, limit: 100, offset: 0 } },
  {
    name: "columns with widths and displays",
    state: {
      ...EMPTY_QUERY,
      select: [
        { field: "time" },
        { field: "model", width: 180 },
        { field: "prompt", display: { kind: "text", lines: 3 } },
        { field: "status", width: 90, display: { kind: "chip", labels: { ok: "OK", "200": "Success", "10": "Ten" }, tones: { ok: "success" } } },
        { field: "narrow", width: 5 },
        { field: "wide", width: 5000 },
        { field: "broken", display: { kind: "sparkle" } as never },
      ],
    },
  },
  {
    name: "negated and grouped predicates",
    state: {
      ...EMPTY_QUERY,
      where: [
        { field: "model", op: "contains", value: "opus", negated: true },
        { any: [{ field: "provider", op: "=", value: "anthropic" }, { field: "provider", op: "=", value: "openai" }] },
        { field: "parent", op: "is_null", value: "" },
        { field: "provider", op: "!=", value: "x", negated: false },
      ],
    },
  },
  {
    name: "relative-time values",
    state: {
      ...EMPTY_QUERY,
      where: [
        { field: "time", op: ">=", value: "-7d" },
        { field: "time", op: "<", value: "+8d2h10m" },
        { field: "time", op: ">", value: "2026-10-01T00:00:00Z" },
      ],
    },
  },
  {
    name: "array set filters",
    state: {
      ...EMPTY_QUERY,
      where: [
        ...createSetFilter("tags", "any", ["a", "b", "a"], "s-any"),
        ...createSetFilter("tags", "any", ["solo"], "s-one"),
        ...createSetFilter("tags", "all", ["x", "y"], "s-all"),
        ...createSetFilter("tags", "none", ["p", "q"], "s-none"),
        ...createSetFilter("tags", "empty", [], "s-empty"),
        { field: "model", op: "contains", value: "opus" },
      ],
    },
  },
  {
    name: "scalar set filters",
    state: {
      ...EMPTY_QUERY,
      where: [
        ...createSetFilter("provider", "any", ["anthropic", "openai"], "p-any", "scalar"),
        ...createSetFilter("provider", "none", ["google"], "p-none", "scalar"),
      ],
    },
  },
  {
    name: "edited set filter stays unpacked",
    state: {
      ...EMPTY_QUERY,
      where: [
        ...createSetFilter("tags", "all", ["x", "y"], "s-all").slice(0, 1),
        ...createSetFilter("tags", "any", ["a", "b"], "s-any").map((term) => ({ ...term, setFilter: { ...term.setFilter!, values: ["a"] } })),
      ],
    },
  },
  {
    name: "sorts",
    state: {
      ...EMPTY_QUERY,
      orderBy: [
        { field: "cost", dir: "desc", nulls: "first" },
        { field: "name", dir: "asc", extract: { regex: "(\\d+)" } },
        { field: "time", dir: "asc", nulls: "last" },
      ],
    },
  },
  {
    name: "aggregations",
    state: {
      ...EMPTY_QUERY,
      aggregations: [
        {
          id: "tokens", op: "sum", field: "tokens", groupBy: ["model_family"], label: "Tokens",
          where: [{ field: "provider", op: "=", value: "anthropic" }], minCount: 2, groupLimit: 10,
          sort: [{ key: "value", dir: "desc" }],
          display: { kind: "bar-horizontal", valueLabel: "Tokens", list: { showBars: true }, format: { kind: "number", decimals: 0 } },
          layout: { widthRem: 30, heightRem: 12 } as never,
        },
        {
          id: "daily", op: "count", groupBy: [],
          dateGrouping: { field: "time", interval: "day", timeZone: "UTC", includeEmpty: true, range: "query", partialIntervals: "exclude" },
          window: { periods: 7, reduce: "mean" },
          display: { kind: "line", xScale: { mode: "linear" }, yScale: { mode: "log", min: 1 } },
        },
        { id: "share", op: "sum", field: "cost", groupBy: ["provider", "model"], share: "group0", display: { kind: "table", pivot: { swap: true } } },
        { id: "spread", op: "count", groupBy: [], distribution: { kind: "histogram", input: "latency", bins: 20 }, expression: "COUNT()", scope: "shownRows" },
        { id: "future", op: "median" as never, field: "latency", groupBy: [] },
      ],
    },
  },
  {
    name: "item details with pooled views",
    state: {
      ...EMPTY_QUERY,
      itemDetails: {
        modes: ["hover", "modal", "page", "hover"],
        page: { urlTemplate: "/item/{id}", target: "_self" },
        views: {
          hover: view("Model") as never,
          modal: view("Model") as never,
          expand: { version: 1, properties: [{ id: "t", field: "time", format: { kind: "relative", sourceUnit: "iso" } }] },
        },
        active: { id: "row-1", mode: "modal" },
      },
    },
  },
  { name: "legacy single item view", state: { ...EMPTY_QUERY, itemDetails: { modes: ["expand"], view: view("Name") as never, active: { id: 42, mode: "expand" } } } },
  { name: "fit to screen", state: { ...EMPTY_QUERY, fitToScreen: true, select: [{ field: "a", width: 100 }] } },
  {
    name: "grouping with links",
    state: {
      ...EMPTY_QUERY,
      where: [{ field: "rows", op: ">", value: "1" }],
      orderBy: [{ field: "cost", dir: "desc" }],
      grouping: {
        keys: ["provider"],
        summaries: [
          { id: "rows", op: "count" },
          { id: "cost", op: "sum", field: "cost", label: "Cost", display: { kind: "number", decimals: 2 } },
          { id: "p50", op: "formula", expression: "MEDIAN([latency])" },
          { id: "latest", op: "row", field: "model" },
          {
            id: "open", op: "link", label: "Open",
            link: {
              label: { column: "provider" },
              to: {
                kind: "query", target: "tokens", base: "source", keyFilters: true,
                patch: { id: "opus", owns: ["filters", "order", "filters"], query: { where: [{ field: "model", op: "contains", value: "opus" }], orderBy: [{ field: "cost", dir: "desc" }] } },
                params: { view: "tokens", "2": "two" },
              },
            },
          },
          { id: "docs", op: "link", link: { label: "Docs", to: { kind: "template", template: "https://example.com/{provider}" } } },
        ],
        representative: { orderBy: [{ field: "time", dir: "desc" }] },
        source: { ...EMPTY_QUERY, where: [{ field: "provider", op: "=", value: "anthropic" }], aggregations: [{ id: "n", op: "count", groupBy: [] }] },
      } as never,
    },
  },
  {
    name: "invalid grouping keeps diagnostics",
    state: { ...EMPTY_QUERY, grouping: { keys: [], summaries: [{ id: "m", op: "Median" }], representative: null, source: { ...EMPTY_QUERY } } as never },
  },
  {
    name: "unicode and escapes",
    state: {
      ...EMPTY_QUERY,
      where: [
        { field: "note", op: "=", value: "emoji 😀, line separator, \"quotes\", back\\slash, tab\t, nul\u0000, del\u007f" },
        { field: "naïve", op: "contains", value: "日本語" },
      ],
    },
  },
  {
    name: "compressible state",
    state: { ...EMPTY_QUERY, select: Array.from({ length: 60 }, (_, i) => ({ field: `column_number_${i}`, width: 120 })) },
  },
  {
    name: "predicate budget",
    state: { ...EMPTY_QUERY, where: Array.from({ length: 100 }, (_, i) => ({ field: "n", op: "!=" as const, value: String(i) })) },
  },
];

export const tokenCases: TokenCase[] = [
  { name: "legacy names and single order", token: legacy({ c: ["a", "b"], o: { field: "a", dir: "desc" }, l: 20, w: [{ field: "a", op: "=", value: "1" }] }) },
  { name: "legacy string select", token: legacy({ s: ["x", "y"], f: 10 }) },
  { name: "legacy width tuples", token: legacy({ s: [["x", 200], ["y"]] }) },
  { name: "legacy tokens do not unpack", token: legacy({ d: { modes: ["hover"], views: { pool: [view("A")], refs: { hover: 0 } } } }) },
  { name: "empty token", token: "" },
  {
    name: "unnormalized members",
    token: plain({
      s: [["a", 10.4], ["b", "wide"], ["c", null, { kind: "text", lines: 99 }], ["d", 33.5, { kind: "number", decimals: 2 }], [5], "e"],
      w: [
        { field: "a", op: "=", value: "1", negated: false, extra: true },
        { any: [{ field: "b", op: "=", value: "2" }], setFilter: { id: "lonely", mode: "any", values: ["2"] } },
        { any: [] },
      ],
      o: [{ field: "a", dir: "up" }, { field: "b", dir: "asc", nulls: "middle", extract: { regex: 1 } }, "c"],
      l: 12.5, f: -3, fs: "yes", b: null, z: "ignored",
    }),
  },
  { name: "limit bounds", token: plain({ l: 1e300, f: 2e6 }) },
  { name: "infinite numbers", token: plain('{"s":[["f",1e400]],"l":-1e400,"f":1e400}') },
  { name: "rounding", token: plain({ l: 2.5, f: 0.49999999999999994 }) },
  { name: "null select falls back to legacy names", token: plain({ s: null, c: ["n"], o: null }) },
  {
    name: "unnormalized metrics",
    token: plain({
      g: [
        { id: "a", op: "sum", field: "", groupBy: "x", scope: "everything", layout: { widthRem: 3, minWidthRem: 9 }, sort: [{ key: "value", dir: "up" }, { key: "group7", dir: ["desc"] }, 3], diagnostics: ["kept", 4, "kept"] },
        { id: "b", op: "avg", groupBy: ["g1", 7], window: "weekly", dateGrouping: { field: "t" }, display: { kind: 3, xScale: 1 }, distribution: [], where: [{ field: "x", op: "nope", value: "1" }] },
        { id: "c", op: "max", unsupportedOp: "p99", groupBy: [], display: { maxGroups: 0, legendPosition: "left", format: { kind: "percent", pattern: "x".repeat(10001) } }, window: { periods: "all", partial: "omit" } },
      ],
    }),
  },
  {
    name: "unnormalized grouping",
    token: plain({
      b: {
        keys: ["k", "k", 3],
        summaries: [null, { id: "" }, { id: "x", op: "MEDIAN" }, { id: "k", op: "count" }, { id: "x", op: "row", label: 7, display: { kind: "json", depth: 1 } },
          { id: "l", op: "link", link: { label: "Go", to: { kind: "query", target: "t", patch: { id: "p", owns: ["filters"], query: { where: [{ field: "a", op: "bad", value: "" }] } } } } },
          { id: "f", op: "formula" }, { id: "op", op: ["sum"] }, { id: "s", op: "😀".repeat(30) }],
        representative: { orderBy: [{ field: "t", dir: ["asc"] }, { field: "u", dir: "sideways" }] },
        source: { grouping: { keys: ["nested"] }, where: [{ field: "a", op: "=", value: "1" }, { field: "b" }] },
        diagnostics: ["Earlier problem.", "", 5, "Earlier problem."],
      },
    }),
  },
  {
    name: "unnormalized item details",
    token: plain({
      d: {
        modes: ["modal", "modal", "page", "sideways", 3],
        page: { urlTemplate: "/x", target: "_top" },
        views: { pool: [{ version: 2, properties: [] }, { version: 1, properties: [{ id: "a", field: "f", format: { kind: ["text"] } }, { id: "b", field: "g", format: { kind: "date", sourceUnit: ["iso"], style: "human", timeZone: "UTC" } }], labelWidth: 99.6 }], refs: { hover: 0, modal: 1 } },
        active: { id: "r", mode: "expand" },
      },
    }),
  },
  {
    name: "set tuples",
    token: plain({
      w: [
        ["set", "tags", "all", ["a", "a", "b"], "dedupe"],
        ["set", "tags", "any", [], "nothing"],
        ["set", "tags", "none", ["z"], "i".repeat(300)],
        ["set", "tags", "empty", ["ignored"], "e"],
      ],
    }),
  },
  { name: "duplicate and index keys", token: plain('{"w":[{"field":"a","op":"=","value":"1","field":"b"}],"s":[["c",null,{"kind":"chip","labels":{"z":"Z","10":"ten","2":"two","02":"oh-two","4294967295":"big"}}]],"l":5,"l":7}') },
  { name: "escaped surrogates", token: plain('{"w":[{"field":"pair","op":"=","value":"\\ud83d\\ude00"},{"field":"lone","op":"=","value":"x\\udc00y\\ud800"}]}') },
  { name: "invalid UTF-8 is replaced in plain tokens", token: "2j." + base64url(Buffer.concat([Buffer.from('{"w":[{"field":"a","op":"=","value":"'), Buffer.from([0xed, 0xa0, 0x80, 0xf0, 0x9f, 0xe0, 0x80, 0xc0, 0xaf]), Buffer.from('"}]}')])) },
  { name: "byte order mark in a compressed token", token: deflated("﻿" + JSON.stringify({ l: 9 })) },
  { name: "whitespace in compressed JSON", token: deflated(' { "l" : 9 , "w" : [ ] } \n') },
  { name: "trailing bytes after the compressed stream", token: "2d." + base64url(Buffer.concat([Buffer.from(deflateSync(Buffer.from('{"l":3}'))), Buffer.from([1, 2, 3])])) },
  { name: "deep nesting in ignored members", token: plain('{"z":' + "[".repeat(5000) + "]".repeat(5000) + ',"l":4}') },
];

const bomb = deflateSync(new Uint8Array(4 * 1024 * 1024 + 1).fill(0x20));
const tooManyPredicates = Array.from({ length: 101 }, (_, i) => ({ field: "n", op: "!=", value: String(i) }));

export const invalidCases: InvalidCase[] = [
  { name: "unknown version", token: "3j.e30", code: "unsupported_version" },
  { name: "dotted legacy token", token: "e30.e30", code: "unsupported_version" },
  { name: "bare dot", token: ".", code: "unsupported_version" },
  { name: "empty payload", token: "2j.", code: "invalid" },
  { name: "padding", token: "2j.e30=", code: "invalid" },
  { name: "impossible length", token: "2j.e30Ae", code: "invalid" },
  { name: "foreign characters", token: "2j.e3*0", code: "invalid" },
  { name: "legacy foreign characters", token: "e30%", code: "invalid" },
  { name: "malformed JSON", token: plain("{"), code: "invalid" },
  { name: "trailing JSON", token: plain("{} {}"), code: "invalid" },
  { name: "array state", token: plain("[]"), code: "invalid" },
  { name: "null state", token: plain("null"), code: "invalid" },
  { name: "string state", token: legacy('"x"'), code: "invalid" },
  { name: "object where", token: plain({ w: {} }), code: "invalid" },
  { name: "null metrics", token: plain({ g: null }), code: "invalid" },
  { name: "string where", token: legacy({ w: "a" }), code: "invalid" },
  { name: "byte order mark in a plain token", token: plain("﻿{}"), code: "invalid" },
  { name: "corrupt compression", token: "2d.____", code: "invalid" },
  { name: "truncated compression", token: "2d." + base64url(deflateSync(Buffer.from(JSON.stringify({ s: [["a"], ["b"], ["c"]] }))).subarray(0, 6)), code: "invalid" },
  { name: "invalid UTF-8 in compressed JSON", token: deflated(new Uint8Array([0x7b, 0x7d, 0xff])), code: "invalid" },
  { name: "short set tuple", token: plain({ w: [["set", "tags", "any", ["a"]]] }), code: "invalid" },
  { name: "unknown set mode", token: plain({ w: [["set", "tags", "some", ["a"], "id"]] }), code: "invalid" },
  { name: "numeric set value", token: plain({ w: [["set", "tags", "any", [1], "id"]] }), code: "invalid" },
  { name: "long set value", token: plain({ w: [["set", "tags", "any", ["v".repeat(10001)], "id"]] }), code: "invalid" },
  { name: "too many set values", token: plain({ w: [["set", "tags", "any", Array.from({ length: 101 }, (_, i) => `v${i}`), "id"]] }), code: "invalid" },
  { name: "numeric set id", token: plain({ w: [["set", "tags", "any", ["a"], 1]] }), code: "invalid" },
  { name: "other array term", token: plain({ w: [["get", "tags", "any", ["a"], "id"]] }), code: "invalid" },
  { name: "legacy array term", token: legacy({ w: [["set", "tags", "any", ["a"], "id"]] }), code: "invalid" },
  { name: "set tuple without a field", token: plain({ w: [["set", "", "any", ["a"], "id"]] }), code: "invalid" },
  { name: "view pool is not a list", token: plain({ d: { modes: [], views: { pool: {}, refs: {} } } }), code: "invalid" },
  { name: "view pool too long", token: plain({ d: { modes: [], views: { pool: [1, 2, 3, 4], refs: {} } } }), code: "invalid" },
  { name: "view refs missing", token: plain({ d: { modes: [], views: { pool: [] } } }), code: "invalid" },
  { name: "view refs list", token: plain({ d: { modes: [], views: { pool: [], refs: [] } } }), code: "invalid" },
  { name: "view ref mode", token: plain({ d: { modes: [], views: { pool: [view("A")], refs: { page: 0 } } } }), code: "invalid" },
  { name: "view ref out of range", token: plain({ d: { modes: [], views: { pool: [view("A")], refs: { hover: 1 } } } }), code: "invalid" },
  { name: "fractional view ref", token: plain({ d: { modes: [], views: { pool: [view("A"), view("B")], refs: { hover: 0.5 } } } }), code: "invalid" },
  { name: "null view pool", token: plain({ d: { modes: [], views: { pool: null, refs: {} } } }), code: "invalid" },
  { name: "null term", token: plain({ w: [null] }), code: "invalid" },
  { name: "string term", token: plain({ w: ["a"] }), code: "invalid" },
  { name: "null group member", token: plain({ w: [{ any: [{ field: "a", op: "=", value: "1" }, null] }] }), code: "invalid" },
  { name: "string negation", token: plain({ w: [{ field: "a", op: "contains", value: "1", negated: "yes" }] }), code: "invalid" },
  { name: "null negation", token: plain({ w: [{ field: "a", op: "contains", value: "1", negated: null }] }), code: "invalid" },
  { name: "unknown operator", token: plain({ w: [{ field: "a", op: "like", value: "1" }] }), code: "invalid" },
  { name: "missing value", token: plain({ w: [{ field: "a", op: "is_null" }] }), code: "invalid" },
  { name: "long field name", token: plain({ w: [{ field: "f".repeat(257), op: "=", value: "1" }] }), code: "invalid" },
  { name: "predicate budget exceeded", token: plain({ w: tooManyPredicates }), code: "invalid" },
  { name: "group over the budget", token: plain({ w: [{ any: tooManyPredicates }] }), code: "invalid" },
  { name: "set filters over the budget", token: plain({ w: [["set", "tags", "all", Array.from({ length: 60 }, (_, i) => `a${i}`), "a"], ["set", "tags", "all", Array.from({ length: 41 }, (_, i) => `b${i}`), "b"]] }), code: "invalid" },
  { name: "empty metrics", token: plain({ g: [] }), code: "invalid" },
  { name: "metric without an id", token: plain({ g: [{ op: "sum", groupBy: [] }] }), code: "invalid" },
  { name: "metric over the limit", token: plain({ g: Array.from({ length: 21 }, (_, i) => ({ id: `m${i}`, op: "count", groupBy: [] })) }), code: "invalid" },
  { name: "token over the length limit", token: { prefix: "2j.", repeat: "A", count: 2 * 1024 * 1024 - 2 }, code: "too_large" },
  { name: "replacement characters over the state limit", token: { prefix: "2j.", repeat: "____", count: 500_000 }, code: "too_large" },
  { name: "compressed state over the limit", token: "2d." + base64url(bomb), code: "too_large" },
];

export const encodeInvalidCases: EncodeInvalidCase[] = [
  {
    name: "state over the byte limit",
    state: { ...EMPTY_QUERY, select: [{ field: "a", display: { kind: "chip", labels: { a: { $repeat: "x", count: 4 * 1024 * 1024 } } } }] },
    code: "too_large",
  },
  {
    name: "encoded token over the length limit",
    state: { ...EMPTY_QUERY, select: [{ field: "a", display: { kind: "chip", labels: { a: { $random: 1, length: 2_200_000 } } } }] },
    code: "too_large",
  },
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Expands {"$repeat"} and {"$random"} generator nodes. */
export function expandGenerators(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandGenerators);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$repeat === "string") return record.$repeat.repeat(record.count as number);
  if (typeof record.$random === "number") {
    let x = record.$random >>> 0 || 1;
    let out = "";
    for (let i = 0; i < (record.length as number); i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      out += ALPHABET[x & 63];
    }
    return out;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expandGenerators(item)]));
}

export function expandToken(token: string | GeneratedToken): string {
  return typeof token === "string" ? token : token.prefix + token.repeat.repeat(token.count);
}
