#!/usr/bin/env node
/** Actual TypeScript ↔ Swift wire conformance. Run after `swift build --product QueryTableChecks`. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "query-table-wire-"));
try {
  const bundle = path.join(scratch, "core.mjs");
  await build({
    stdin: {
      contents: 'export {encodeQuery,decodeQuery,toServerQuery} from "./packages/core/src/encode.ts"; export {normalizeQueryState} from "./packages/core/src/query.ts"; export {loadSchema} from "./packages/core/src/schema.ts";',
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
  const { encodeQuery, decodeQuery, toServerQuery, normalizeQueryState, loadSchema } = await import(pathToFileURL(bundle).href);
  const document = {
    name: "wire_cases",
    idField: "id",
    defaultLimit: 25,
    defaultSelect: [{ field: "name" }, { field: "amount" }],
    defaultSort: [{ field: "id", dir: "desc" }],
    tiebreakSort: [{ field: "id", dir: "asc" }],
    fields: [
      { name: "id", label: "ID", type: "number", source: "backend" },
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
      name: "normalization-bounds-and-computed",
      query: {
        select: [{ field: "name", width: 1 }, { field: "amount", width: 9000 }],
        where: [{ field: "@computed/x", op: "=", value: "x" }, { any: [{ field: "tags", op: "includes", value: "x" }] }],
        orderBy: [{ field: "name", dir: "asc", nulls: "invalid" }, { field: "@computed/x", dir: "asc" }],
        limit: -20,
        offset: 9000000,
        aggregations: [{ id: "bad", op: "sum", field: "@computed/x", groupBy: [] }],
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
  const cases = inputs.map((input) => {
    const query = input.token ? decodeQuery(input.token) : normalizeQueryState(input.query);
    return { name: input.name, token: input.token ?? encodeQuery(query), query, serverQuery: toServerQuery(query, schema) };
  });
  const inputPath = path.join(scratch, "input.json");
  const outputPath = path.join(scratch, "output.json");
  await writeFile(inputPath, JSON.stringify({ schema: document, cases }, null, 2));
  const executable = process.env.QUERY_TABLE_CHECKS ?? path.join(root, "native/macos/.build/debug/QueryTableChecks");
  execFileSync(executable, ["--wire-fixture", inputPath, outputPath], { stdio: "inherit" });
  const actual = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(actual.cases.length, cases.length, "Swift returned every conformance case");
  for (const expected of cases) {
    const result = actual.cases.find((item) => item.name === expected.name);
    assert.ok(result, `Missing Swift result: ${expected.name}`);
    assert.deepEqual(normalizeQueryState(decodeQuery(result.token)), normalizeQueryState(expected.query), `${expected.name}: Swift token must decode to the same TypeScript query`);
    assert.deepEqual(result.serverQuery, expected.serverQuery, `${expected.name}: Swift server projection must match TypeScript`);
    console.log(`PASS ${expected.name}`);
  }
  console.log(`Verified ${cases.length} TypeScript ↔ Swift wire cases.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
