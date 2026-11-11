// Type-checks every TypeScript project against package source (see
// tsconfig.source-paths.json), so it needs no package build and never writes
// dist. Projects run in parallel; only failing projects print compiler output.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  "packages/core/tsconfig.test.json",
  "packages/react/tsconfig.test.json",
  "packages/ui/tsconfig.test.json",
  "packages/duckdb/tsconfig.test.json",
  "tools/schema-codegen/tsconfig.test.json",
  "examples/tsconfig.json",
  "demo/tsconfig.json",
  "backends/sqlite-tests/tsconfig.json",
  "backends/postgres-tests/tsconfig.json",
];
const filters = process.argv.slice(2);
const selected = filters.length
  ? projects.filter((project) => filters.some((filter) => project.includes(filter)))
  : projects;
if (!selected.length) {
  console.error(`No project matches ${filters.join(", ")}. Projects:\n  ${projects.join("\n  ")}`);
  process.exit(2);
}

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const check = (project) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", project], { cwd: root });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => done({ project, code, output }));
  });

const started = Date.now();
const queue = [...selected];
const results = [];
const worker = async () => {
  for (let project = queue.shift(); project; project = queue.shift()) results.push(await check(project));
};
await Promise.all(Array.from({ length: Math.min(selected.length, Math.max(2, availableParallelism() >> 1)) }, worker));

const failed = results.filter((result) => result.code !== 0);
for (const { project, output } of failed) console.error(`\n${project}\n${output.trimEnd()}`);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  failed.length
    ? `\ntypecheck: ${failed.length} of ${selected.length} projects failed (${seconds}s)`
    : `typecheck: ${selected.length} projects passed (${seconds}s)`,
);
process.exit(failed.length ? 1 : 0);
