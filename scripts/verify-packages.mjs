import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "query-table-packages-"));
const archiveDirectory = join(temporaryRoot, "archives");
const consumerDirectory = join(temporaryRoot, "consumer");

const packages = [
  { name: "@pythia-software/query-table-core", directory: "packages/core", required: ["dist/index.js", "dist/index.d.ts"] },
  { name: "@pythia-software/query-table-react", directory: "packages/react", required: ["dist/index.js", "dist/index.d.ts"] },
  {
    name: "@pythia-software/query-table-ui",
    directory: "packages/ui",
    required: ["dist/index.js", "dist/index.d.ts", "dist/theme.css"],
  },
  {
    name: "@pythia-software/query-table-codegen",
    directory: "tools/schema-codegen",
    required: ["dist/index.js", "dist/index.d.ts", "dist/cli.js"],
  },
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

try {
  mkdirSync(archiveDirectory, { recursive: true });
  const archives = [];

  for (const packageSpec of packages) {
    const result = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDirectory], {
        cwd: join(repositoryRoot, packageSpec.directory),
      }),
    )[0];
    if (!result || result.name !== packageSpec.name) throw new Error(`unexpected npm pack result for ${packageSpec.name}`);
    const paths = new Set(result.files.map((file) => file.path));
    for (const required of ["LICENSE", "README.md", ...packageSpec.required]) {
      if (!paths.has(required)) throw new Error(`${packageSpec.name} tarball is missing ${required}`);
    }
    if ([...paths].some((path) => path.startsWith("src/") || path.includes("/test/"))) {
      throw new Error(`${packageSpec.name} tarball contains source or test files`);
    }
    archives.push(join(archiveDirectory, result.filename));
  }

  mkdirSync(consumerDirectory, { recursive: true });
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "query-table-package-consumer", private: true, type: "module" }, null, 2),
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives, "react@18.3.1", "react-dom@18.3.1"], {
    cwd: consumerDirectory,
  });

  writeFileSync(
    join(consumerDirectory, "runtime.mjs"),
    `import * as core from "@pythia-software/query-table-core";
import * as react from "@pythia-software/query-table-react";
import * as ui from "@pythia-software/query-table-ui";
import * as codegen from "@pythia-software/query-table-codegen";

if (typeof core.normalizeQueryState !== "function") throw new Error("core runtime export missing");
if (typeof react.useQueryTable !== "function") throw new Error("react runtime export missing");
if (typeof ui.DataTable !== "function") throw new Error("ui runtime export missing");
if (typeof codegen.generateTypeScript !== "function") throw new Error("codegen runtime export missing");
if (!import.meta.resolve("@pythia-software/query-table-ui/theme.css").endsWith("/dist/theme.css")) throw new Error("theme export missing");
`,
  );
  run(process.execPath, [join(consumerDirectory, "runtime.mjs")], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, "types.ts"),
    `import type { QueryState } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { DataTableProps } from "@pythia-software/query-table-ui";
import type { GoGenerationOptions } from "@pythia-software/query-table-codegen";

declare const query: QueryState;
declare const table: QueryTableApi<{ id: number }>;
declare const props: DataTableProps<{ id: number }>;
declare const go: GoGenerationOptions;
void [query, table, props, go];
`,
  );
  run(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2020",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      join(consumerDirectory, "types.ts"),
    ],
    { cwd: consumerDirectory },
  );

  const generatedTs = join(temporaryRoot, "generated", "runs.ts");
  const generatedGo = join(temporaryRoot, "generated", "runs.go");
  const cli = join(consumerDirectory, "node_modules", ".bin", "query-table-codegen");
  const codegenManifest = JSON.parse(
    readFileSync(
      join(consumerDirectory, "node_modules", "@pythia-software", "query-table-codegen", "package.json"),
      "utf8",
    ),
  );
  if (run(cli, ["--version"], { cwd: consumerDirectory }).trim() !== codegenManifest.version) {
    throw new Error("CLI version does not match its package version");
  }
  run(
    cli,
    [
      join(repositoryRoot, "schema", "examples", "runs.schema.json"),
      "--ts",
      generatedTs,
      "--go",
      generatedGo,
      "--go-package",
      "catalog",
    ],
    { cwd: consumerDirectory },
  );
  if (!readFileSync(generatedTs, "utf8").includes("RUNS_SCHEMA")) throw new Error("CLI TypeScript output is invalid");
  const generatedGoSource = readFileSync(generatedGo, "utf8");
  if (!generatedGoSource.includes("func RunsSchema()")) throw new Error("CLI Go output is invalid");
  const formattedGo = run("gofmt", [], {
    cwd: consumerDirectory,
    input: generatedGoSource,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (formattedGo !== generatedGoSource) throw new Error("CLI Go output is not gofmt-clean");

  writeFileSync(
    join(dirname(generatedGo), "go.mod"),
    `module example.com/query-table-codegen-check

go 1.25

require github.com/Pythia-Software/query-table/backends/go v0.0.0

replace github.com/Pythia-Software/query-table/backends/go => ${join(repositoryRoot, "backends", "go")}
`,
  );
  run("go", ["test", "./..."], { cwd: dirname(generatedGo) });

  process.stdout.write(`Verified ${packages.length} package tarballs in a clean consumer install.\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
