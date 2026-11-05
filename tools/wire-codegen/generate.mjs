#!/usr/bin/env node
// Regenerates the v3 wire types from schema/query-wire.schema.json:
//   node tools/wire-codegen/generate.mjs
// `npm run wire:check` regenerates and fails on any diff.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "./model.mjs";
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
for (const [file, text] of Object.entries(outputs)) writeFileSync(path.join(root, file), text);
console.log(`Wrote ${Object.keys(outputs).join(", ")}`);
