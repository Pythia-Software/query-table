// Query link parity with the Go module. This test owns
// schema/fixtures/query-links.json, rebuilt from ./queryLinkCases, and
// metric-options.json, the METRIC_OPTION_SPECS tables the Go port must match.
// It fails when either checked-in file is stale. Regenerate with
//
//   UPDATE_QUERY_LINK_FIXTURES=1 npx vitest run packages/core/test/queryLinkFixtures.test.ts
//
// `token` is what encodeQuery writes for `state` (or a hand-made link) and
// `packed` is the JSON encodeQuery writes for the decoded state. They can
// differ: normalizeQueryState is not idempotent for invalid metrics (an
// unsupported op moves `diagnostics` ahead of `unsupportedOp`, and a sort term
// without a valid direction is dropped only on the second pass).
//
// The Go tests (backends/go/query_links_test.go) decode every token, re-encode
// it and check each rejection. They write the tokens Go's EncodeQueryLink
// produces to schema/fixtures/query-links-go.json, which this test decodes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodeQueryStrict, encodeQuery, QueryDecodeError, type QueryState } from "../src/index";
import { METRIC_OPTION_SPECS } from "../src/metricNormalize";
import { encodeInvalidCases, expandGenerators, expandToken, invalidCases, stateCases, tokenCases } from "./queryLinkCases";

const fixturePath = new URL("../../../schema/fixtures/query-links.json", import.meta.url);
const goTokensPath = new URL("../../../schema/fixtures/query-links-go.json", import.meta.url);
const metricOptionsPath = new URL("../../../schema/fixtures/metric-options.json", import.meta.url);

/** The JSON text a token carries, before compression. */
function payloadJSON(token: string): string {
  const bytes = Buffer.from(token.slice(3), "base64url");
  return token.startsWith("2d.") ? Buffer.from(inflateSync(bytes)).toString("utf8") : bytes.toString("utf8");
}

function decodeError(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof QueryDecodeError) return error.code;
    throw error;
  }
  throw new Error("expected a QueryDecodeError");
}

function buildFixture() {
  const valid = [
    ...stateCases.map(({ name, state }) => {
      const token = encodeQuery(state);
      const normalized = decodeQueryStrict(token);
      return { name, state, token, normalized, packed: payloadJSON(encodeQuery(normalized)) };
    }),
    ...tokenCases.map(({ name, token }) => {
      const normalized = decodeQueryStrict(token);
      return { name, token, normalized, packed: payloadJSON(encodeQuery(normalized)) };
    }),
  ];
  const invalid = invalidCases.map(({ name, token, code }) => {
    expect(decodeError(() => decodeQueryStrict(expandToken(token))), name).toBe(code);
    return { name, token, code };
  });
  const encodeInvalid = encodeInvalidCases.map(({ name, state, code }) => {
    expect(decodeError(() => encodeQuery(expandGenerators(state) as QueryState)), name).toBe(code);
    return { name, state, code };
  });
  return { valid, invalid, encodeInvalid };
}

/** Every option name normalizeMetricOptions reads: the keys of its option
 * tables and of inline `copy` specs, the members it reads from `raw` and the
 * keys of its loops. */
function metricOptionKeys(): string[] {
  const source = readFileSync(new URL("../src/metricNormalize.ts", import.meta.url), "utf8");
  const keys = new Set<string>(Object.values(METRIC_OPTION_SPECS).flatMap((spec) => Object.keys(spec)));
  for (const [, spec] of source.matchAll(/copy\([^,]+,\s*\{([^}]*)\}/g))
    for (const [, key] of spec!.matchAll(/(\w+)\s*:/g)) keys.add(key!);
  for (const [, path, call] of source.matchAll(/\braw((?:\.\w+)+)(\s*\()?/g)) {
    const members = path!.split(".").filter(Boolean);
    for (const key of call ? members.slice(0, -1) : members) keys.add(key); // not raw.sort.slice(…)
  }
  for (const [, list] of source.matchAll(/for \(const k of \[([^\]]*)\]\)/g))
    for (const [, key] of list!.matchAll(/"(\w+)"/g)) keys.add(key!);
  return [...keys].sort();
}

/** Keys of every metric in a normalized state, including nested queries. */
function metricKeysIn(value: unknown, inMetric = false, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) metricKeysIn(item, inMetric, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (inMetric) out.add(key);
      metricKeysIn(item, inMetric || key === "aggregations", out);
    }
  return out;
}

describe("query link fixtures", () => {
  const fixture = buildFixture();

  it("are current", () => {
    const expected = JSON.stringify(fixture, null, 2) + "\n";
    if (process.env.UPDATE_QUERY_LINK_FIXTURES === "1") writeFileSync(fixturePath, expected);
    const actual = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : "";
    expect(actual === expected, "schema/fixtures/query-links.json is stale; rerun with UPDATE_QUERY_LINK_FIXTURES=1").toBe(true);
  });

  // The Go tests compare their option tables with this file, so a new option,
  // value or type fails there until Go copies it.
  it("publish the metric option tables", () => {
    const expected = JSON.stringify(METRIC_OPTION_SPECS, null, 2) + "\n";
    if (process.env.UPDATE_QUERY_LINK_FIXTURES === "1") writeFileSync(metricOptionsPath, expected);
    const actual = existsSync(metricOptionsPath) ? readFileSync(metricOptionsPath, "utf8") : "";
    expect(actual === expected, "schema/fixtures/metric-options.json is stale; rerun with UPDATE_QUERY_LINK_FIXTURES=1").toBe(true);
  });

  // Go ports normalizeMetricOptions key by key. A new option must reach the
  // fixtures (normalized, so with a valid value), or Go would drop it unseen.
  it("cover every metric option", () => {
    const covered = metricKeysIn(fixture.valid.map((c) => c.normalized));
    const options = metricOptionKeys();
    expect(options.length).toBeGreaterThan(50);
    expect(options.filter((key) => !covered.has(key)), "add these metric options to queryLinkCases.ts").toEqual([]);
  });

  it("have unique names", () => {
    const names = [...fixture.valid, ...fixture.invalid, ...fixture.encodeInvalid].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Hand-made links with invalid metrics normalize differently a second time.
  it("decode a re-encoded state to the same state", () => {
    for (const c of fixture.valid) if ("state" in c) expect(decodeQueryStrict(encodeQuery(c.normalized)), c.name).toEqual(c.normalized);
  });

  it("decode every token Go encodes to the same state", () => {
    const { tokens } = JSON.parse(readFileSync(goTokensPath, "utf8")) as { tokens: Record<string, string> };
    expect(Object.keys(tokens).sort(), "rerun the Go tests with UPDATE_QUERY_LINK_FIXTURES=1").toEqual(fixture.valid.map((c) => c.name).sort());
    for (const c of fixture.valid) {
      const token = tokens[c.name]!;
      expect(payloadJSON(token), c.name).toBe(c.packed);
      expect(JSON.stringify(decodeQueryStrict(token)), c.name).toBe(JSON.stringify(decodeQueryStrict(encodeQuery(c.normalized))));
      if ("state" in c) expect(JSON.stringify(decodeQueryStrict(token)), c.name).toBe(JSON.stringify(c.normalized));
    }
  });
});
