#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateGo, generateTypeScript } from "./generate";

const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};
if (typeof packageManifest.version !== "string" || !packageManifest.version) {
  throw new Error("package.json does not contain a valid version");
}
const VERSION = packageManifest.version;

interface CliOptions {
  input: string;
  ts?: string;
  go?: string;
  goPackage?: string;
  goImport?: string;
}

const HELP = `query-table-codegen ${VERSION}

Usage:
  query-table-codegen <schema.json> --ts <output.ts>
  query-table-codegen <schema.json> --go <output.go> --go-package <name> [--go-import <path>]

Both --ts and --go may be supplied in one invocation.
`;

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version") || args.includes("-v")) return "version";
  const input = args[0];
  if (!input || input.startsWith("--")) throw new Error("a schema JSON path is required");
  const options: CliOptions = { input };

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    switch (flag) {
      case "--ts":
        options.ts = optionValue(args, index, flag);
        index += 1;
        break;
      case "--go":
        options.go = optionValue(args, index, flag);
        index += 1;
        break;
      case "--go-package":
        options.goPackage = optionValue(args, index, flag);
        index += 1;
        break;
      case "--go-import":
        options.goImport = optionValue(args, index, flag);
        index += 1;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }

  if (!options.ts && !options.go) throw new Error("at least one of --ts or --go is required");
  if (options.go && !options.goPackage) throw new Error("--go-package is required with --go");
  if (!options.go && (options.goPackage || options.goImport)) throw new Error("--go-package/--go-import require --go");
  return options;
}

async function writeGenerated(path: string, contents: string): Promise<void> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (options === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const source = await readFile(resolve(options.input), "utf8");
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${options.input}: ${(error as Error).message}`);
  }

  const inputPath = resolve(options.input);
  const tsPath = options.ts ? resolve(options.ts) : undefined;
  const goPath = options.go ? resolve(options.go) : undefined;
  if (tsPath === inputPath || goPath === inputPath) throw new Error("an output path must not overwrite the input schema");
  if (tsPath && goPath && tsPath === goPath) throw new Error("--ts and --go must use different output paths");

  const tsOutput = options.ts ? generateTypeScript(document) : undefined;
  const goOptions = options.go
    ? options.goImport
      ? { packageName: options.goPackage!, importPath: options.goImport }
      : { packageName: options.goPackage! }
    : undefined;
  const goOutput = goOptions ? generateGo(document, goOptions) : undefined;

  await Promise.all([
    ...(options.ts && tsOutput ? [writeGenerated(options.ts, tsOutput)] : []),
    ...(options.go && goOutput ? [writeGenerated(options.go, goOutput)] : []),
  ]);
}

void main().catch((error: unknown) => {
  process.stderr.write(`query-table-codegen: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
