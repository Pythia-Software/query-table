import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateGo, generateTypeScript } from "../src/index";

const documentPath = fileURLToPath(new URL("../../../schema/examples/runs.schema.json", import.meta.url));
const document = JSON.parse(readFileSync(documentPath, "utf8"));

describe("schema code generation", () => {
  it("generates a frontend schema without backend SQL bindings", () => {
    const output = generateTypeScript(document);
    expect(output).toContain("export const RUNS_SCHEMA: FieldSchema");
    expect(output).toContain('"job_name"');
    expect(output).not.toContain("bindings");
    expect(output).not.toContain("r.job_name");
  });

  it("generates a direct Go schema with backend capabilities", () => {
    const output = generateGo(document, { packageName: "catalog" });
    expect(output).toContain("func RunsSchema() querytable.Schema");
    expect(output).toContain('"error_codes": {');
    expect(output).toContain("ServerFilter: false");
    expect(output).toContain("Synthetic: true");
    expect(output).not.toContain('"details": {');

    const formatted = spawnSync("gofmt", { input: output, encoding: "utf8" });
    expect(formatted.error).toBeUndefined();
    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toBe(output);
  });

  it("rejects invalid Go package names", () => {
    expect(() => generateGo(document, { packageName: "bad-name" })).toThrow(/invalid Go package name/);
    expect(() => generateGo(document, { packageName: "package" })).toThrow(/invalid Go package name/);
  });

  it("rejects backend references that cannot produce a valid Go schema", () => {
    const missingIdBinding = structuredClone(document);
    delete missingIdBinding.fields.find((field: { name: string }) => field.name === missingIdBinding.idField).bindings;
    expect(() => generateGo(missingIdBinding, { packageName: "catalog" })).toThrow(/id field .* has no postgres binding/);

    const missingSortBinding = structuredClone(document);
    missingSortBinding.fields.find((field: { name: string }) => field.name === "job_name").sort = { field: "details" };
    expect(() => generateGo(missingSortBinding, { packageName: "catalog" })).toThrow(/sort target .* has no postgres binding/);
    expect(() => generateGo(document, { packageName: "catalog", importPath: "bad\npath" })).toThrow(
      /invalid Go import path/,
    );
  });
});
