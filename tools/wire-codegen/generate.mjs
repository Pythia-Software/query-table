#!/usr/bin/env node
// Regenerates the v3 wire types from schema/query-wire.schema.json:
//   node tools/wire-codegen/generate.mjs
// `npm run wire:check` regenerates and fails on any diff.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeEnum, loadSchema } from "./model.mjs";
import { emitTs } from "./ts.mjs";
import { emitGo } from "./go.mjs";
import { emitSwift } from "./swift.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { defs } = loadSchema(path.join(root, "schema/query-wire.schema.json"));
export const outputs = {
  "packages/core/src/wire.generated.ts": emitTs(defs),
  "backends/go/wire_generated.go": emitGo(defs),
  "native/macos/Sources/QueryTableCore/Wire.generated.swift": emitSwift(defs),
};
// docs/errors.md keeps its prose; the code table between the markers is generated.
const errorsDoc = path.join(root, "docs/errors.md"), start = "<!-- error-codes:start -->", end = "<!-- error-codes:end -->";
const doc = readFileSync(errorsDoc, "utf8");
if (!doc.includes(start) || !doc.includes(end)) throw Error("docs/errors.md needs the error-codes markers.");
const retry = { yes: "yes", no: "no", refresh: "after refresh" };
const table = "| Code | HTTP | Retry | Meaning |\n| --- | --- | --- | --- |\n" + codeEnum(defs.ErrorCode).map(({ code, status, retry: r, description }) =>
  `| \`${code}\` | ${status ?? "client"} | ${retry[r]} | ${description.replace(/\|/g, "\\|")} |\n`).join("");
outputs["docs/errors.md"] = doc.slice(0, doc.indexOf(start) + start.length) + "\n" + table + doc.slice(doc.indexOf(end));
for (const [file, text] of Object.entries(outputs)) writeFileSync(path.join(root, file), text);
console.log(`Wrote ${Object.keys(outputs).join(", ")}`);
