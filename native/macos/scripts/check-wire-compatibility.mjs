#!/usr/bin/env node
/** Actual TypeScript ↔ Swift wire conformance. Run after `swift build --product QueryTableChecks`. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "query-table-wire-"));
try {
  const bundle = path.join(scratch, "core.mjs");
  await build({
    stdin: {
      contents: 'export {encodeQuery,decodeQuery} from "./packages/core/src/encode.ts"; export {toQueryRequestV3} from "./packages/core/src/queryV3.ts"; export {normalizeQueryState} from "./packages/core/src/query.ts"; export {loadSchema} from "./packages/core/src/schema.ts";',
      resolveDir: root,
      sourcefile: "wire-conformance.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
  const { encodeQuery, decodeQuery, toQueryRequestV3, normalizeQueryState, loadSchema } = await import(pathToFileURL(bundle).href);
  // The Go handler (backends/go/query_v3_http.go) decodes with DisallowUnknownFields
  // and accepts only these stage keys, so Swift must never send anything else.
  const requestKeys = ["hostState", "version", "profile", "now", "expectedRevisions", "planToken", "snapshot", "source", "result", "grouping", "rows", "metrics", "distinct", "diagnostics"];
  const stageKeys = ["select", "where", "orderBy", "limit", "offset"];
  const metricKeys = ["dateGrouping", "diagnostics", "display", "expression", "expressionY", "scope", "sort", "groupLimit", "distribution", "id", "op", "field", "groupBy", "where", "minCount"];
  const capabilities = { version: 3, groupedRows: false, calendarGrouping: false, computedSourceFilters: false, regex: false, regexSourceFilters: false, maxRows: 10000, maxGroups: 2000, maxPopulation: 250000, profile: "qt-sqlite-v1" };
  const now = 1772964000123;
  const json = (value) => JSON.parse(JSON.stringify(value));
  const assertGoDecodable = (request, label) => {
    for (const key of Object.keys(request)) assert.ok(requestKeys.includes(key), `${label}: unknown request key ${key}`);
    for (const [key, value] of Object.entries(request)) assert.notEqual(value, null, `${label}: ${key} is null`);
    assert.equal(typeof request.now, "number", `${label}: now is required`);
    for (const stage of ["source", "result"]) for (const key of Object.keys(request[stage])) assert.ok(stageKeys.includes(key), `${label}: unsupported ${stage} key ${key}`);
    for (const metric of request.metrics) for (const key of Object.keys(metric)) assert.ok(metricKeys.includes(key), `${label}: unknown metric key ${key}`);
  };
  const document = {
    name: "wire_cases",
    idField: "id",
    defaultLimit: 25,
    defaultSelect: [{ field: "name" }, { field: "amount" }],
    defaultSort: [{ field: "id", dir: "desc" }],
    tiebreakSort: [{ field: "id", dir: "asc" }],
    fields: [
      { name: "id", label: "ID", type: "number", source: "backend" },
      { name: "at", label: "Time", type: "datetime", source: "backend" },
      { name: "name", label: "Name", type: "text", source: "backend", aliases: ["title"], select: { default: true } },
      { name: "amount", label: "Amount", type: "number", bindings: { postgres: { expr: "r.amount" } } },
      { name: "status", label: "Status", type: "enum", source: "backend", filter: { values: { source: "static", options: ["new", "done"] } } },
      { name: "tags", label: "Tags", type: "textarray", source: "backend" },
      { name: "rank", label: "Rank", type: "number", source: "backend", sort: { field: "amount" } },
      { name: "payload", label: "Payload", type: "text", source: "backend", filter: { pushdown: false } },
      { name: "display", label: "Display", type: "text", source: "derived", filter: { enabled: true } },
      { name: "hidden", label: "Hidden", type: "text", source: "backend", select: { enabled: false } },
    ],
  };
  const schema = loadSchema(document);
  const inputs = [
    { name: "relative datetime predicates", query: { where: [{ any: [{ field: "at", op: ">=", value: "-7d", negated: true }, { field: "at", op: "<=", value: "+8d2h10m" }] }] } },
    {
      name: "malformed-top-level-predicate-keeps-valid-siblings",
      token: Buffer.from(JSON.stringify({ w: [
        {field: "status", op: "=", value: "done"},
        {field: "name", op: "contains"}, null,
        {field: "amount", op: ">=", value: "10", negated: "invalid"},
      ] })).toString("base64url"),
    },
    {
      name: "malformed-or-member-keeps-valid-members-and-terms",
      token: Buffer.from(JSON.stringify({ w: [
        {field: "status", op: "=", value: "done"},
        {any: [{field: "name", op: "=", value: "first"}, false,
          {field: 42, op: "=", value: "bad"}, {field: "name", op: "=", value: "second"}]},
        {any: [null]},
      ] })).toString("base64url"),
    },
    {
      // Both clients drop invalid literals one by one and collapse what is left.
      name: "or-of-ands-normalize-alike",
      token: Buffer.from(JSON.stringify({ w: [
        {any: [{all: [{field: "status", op: "=", value: "done"}, {field: "name", op: "contains"}]},
          {all: [{field: 42, op: "=", value: "bad"}]}, {field: "name", op: "=", value: "x"}]},
        {any: [{all: [{field: "status", op: "=", value: "new"}, {field: "amount", op: ">", value: "1"}]},
          {field: "name", op: "bogus", value: "y"}]},
        {any: [{all: [{field: "name", op: "=", value: "p"}, {field: "amount", op: "<", value: "9"}]}, {field: "status", op: "=", value: "done"}]},
      ] })).toString("base64url"),
    },
    {
      name: "or-of-ands-predicate-budget",
      token: Buffer.from(JSON.stringify({ w: [0, 1].map((g) => ({ any: Array.from({ length: 20 }, (_, i) => ({ all: [
        {field: "name", op: "=", value: `${g}-${i}`}, {field: "amount", op: ">", value: String(i)}, {field: "status", op: "=", value: "done"}] })) })) })).toString("base64url"),
    },
    { name: "schema-defaults", query: {} },
    {
      name: "unicode-or-negation-metric",
      query: {
        select: [{ field: "title", width: 240 }, { field: "amount" }],
        where: [{ any: [{ field: "name", op: "contains", value: "café 日本", negated: true }, { field: "amount", op: ">=", value: "10.5" }] }],
        orderBy: [{ field: "name", dir: "desc", nulls: "first", extract: { regex: "([a-z]+)" } }],
        limit: 25,
        offset: 50,
        aggregations: [{ id: "sum", op: "sum", field: "amount", groupBy: ["status"], label: "Total Σ" }],
      },
    },
    {
      name: "projection-alias-remap-client-or",
      query: {
        select: [{ field: "title" }, { field: "hidden" }, { field: "unknown" }, { field: "display" }],
        where: [
          { any: [{ field: "name", op: "=", value: "a" }, { field: "payload", op: "contains", value: "b" }] },
          { field: "status", op: "!=", value: "done" },
        ],
        orderBy: [{ field: "rank", dir: "asc" }, { field: "display", dir: "desc" }],
      },
    },
    {
      // TypeScript keeps server-computed `@computed/` references; the native client
      // has no server-computed columns and drops them, so they are not compared here.
      name: "normalization-bounds",
      query: {
        select: [{ field: "name", width: 1 }, { field: "amount", width: 9000 }],
        where: [{ any: [{ field: "tags", op: "includes", value: "x" }] }],
        orderBy: [{ field: "name", dir: "asc", nulls: "invalid" }],
        limit: -20,
        offset: 9000000,
        aggregations: [{ id: "rows", op: "count", groupBy: [] }],
      },
    },
    {
      name: "total-predicate-budget",
      query: { where: [0, 1].map(() => ({ any: Array.from({ length: 70 }, (_, i) => ({ field: "name", op: "=", value: String(i) })) })) },
    },
    {
      name: "legacy-column-and-sort-shapes",
      token: Buffer.from(JSON.stringify({ c: ["name", "amount"], o: { field: "amount", dir: "desc" }, l: 15, f: 30 })).toString("base64url"),
    },
  ];
  // TypeScript links are versioned ("2j." JSON or "2d." deflate); the native decoder
  // reads the unversioned base64url JSON form, so hand it the same payload unwrapped.
  const legacyToken = (token) => {
    if (token.startsWith("2j.")) return token.slice(3);
    if (token.startsWith("2d.")) return inflateRawSync(Buffer.from(token.slice(3), "base64url")).toString("base64url");
    return token;
  };
  const cases = inputs.map((input) => {
    const query = input.token ? decodeQuery(input.token) : normalizeQueryState(input.query);
    return { name: input.name, token: input.token ?? legacyToken(encodeQuery(query)), query,
      request: json(toQueryRequestV3(query, schema, capabilities, undefined, { now })),
      metricsOnly: json(toQueryRequestV3(query, schema, capabilities, undefined, { now, rows: false })) };
  });
  const inputPath = path.join(scratch, "input.json");
  const outputPath = path.join(scratch, "output.json");
  await writeFile(inputPath, JSON.stringify({ schema: document, capabilities, now, cases }, null, 2));
  const executable = process.env.QUERY_TABLE_CHECKS ?? path.join(root, "native/macos/.build/debug/QueryTableChecks");
  execFileSync(executable, ["--wire-fixture", inputPath, outputPath], { stdio: "inherit" });
  const actual = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(actual.cases.length, cases.length, "Swift returned every conformance case");
  for (const expected of cases) {
    const result = actual.cases.find((item) => item.name === expected.name);
    assert.ok(result, `Missing Swift result: ${expected.name}`);
    assert.deepEqual(normalizeQueryState(decodeQuery(result.token)), normalizeQueryState(expected.query), `${expected.name}: Swift token must decode to the same TypeScript query`);
    assert.deepEqual(result.request, expected.request, `${expected.name}: Swift v3 request must match TypeScript toQueryRequestV3`);
    assert.deepEqual(result.metricsOnly, expected.metricsOnly, `${expected.name}: Swift metrics-only v3 request must match TypeScript`);
    assertGoDecodable(result.request, expected.name);
    assertGoDecodable(result.metricsOnly, `${expected.name} (metrics)`);
    // Autocomplete has no TypeScript builder in this check; verify the contract shape.
    assertGoDecodable(result.distinct, `${expected.name} (distinct)`);
    assert.deepEqual(result.distinct.distinct, { field: "name", search: "caf", limit: 30 });
    assert.equal(result.distinct.rows, false);
    assert.deepEqual(result.distinct.metrics, []);
    assert.deepEqual(result.distinct.source.where, []);
    assert.deepEqual(result.distinct.source, result.distinct.result);
    assert.equal(result.distinct.now, now);
    console.log(`PASS ${expected.name}`);
  }
  console.log(`Verified ${cases.length} TypeScript ↔ Swift v3 wire cases.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
