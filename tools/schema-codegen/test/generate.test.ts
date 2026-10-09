import Ajv2020 from "ajv/dist/2020";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateGo, generateTypeScript } from "../src/index";

const documentPath = fileURLToPath(
  new URL("../../../schema/examples/runs.schema.json", import.meta.url),
);
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
    const withRegexSort = structuredClone(document);
    withRegexSort.defaultSort = [
      { field: "job_name", dir: "asc", extract: { regex: "build-(\\d+)" } },
    ];
    withRegexSort.fields.find(
      (field: { name: string }) => field.name === "job_name",
    ).filter = { ops: ["="], arrayCaseSensitive: true };
    const output = generateGo(withRegexSort, { packageName: "catalog" });
    expect(output).toContain("func RunsSchema() querytable.Schema");
    expect(output).toContain('"error_codes": {');
    expect(output).toContain("ServerFilter: false");
    expect(output).toContain("Synthetic: true");
    expect(output).toContain("ArrayCaseSensitive: true");
    expect(output).toContain('FilterOps: []string{"="}');
    expect(output).toContain(
      'Extract: &querytable.RegexExtract{Regex: "build-(\\\\d+)"}',
    );
    expect(output).not.toContain('"details": {');

    const formatted = spawnSync("gofmt", { input: output, encoding: "utf8" });
    expect(formatted.error).toBeUndefined();
    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toBe(output);
  });

  it("preserves metric policy and trusted numeric expression bindings", () => {
    const configured = structuredClone(document);
    const numeric = configured.fields.find(
      (field: { name: string }) => field.name === "total_ms",
    );
    numeric.bindings.postgres.expressionNumeric = true;
    numeric.aggregate = { groupable: true, ops: ["avg", "max"] };
    configured.fields.find(
      (field: { name: string }) => field.name === "platform",
    ).aggregate = { measure: false, groupable: false };
    const metaSchema = JSON.parse(
      readFileSync(
        new URL("../../../schema/query-table.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(metaSchema);
    expect(validate(configured), JSON.stringify(validate.errors)).toBe(true);
    numeric.bindings.postgres.expressionNumeric = "untrusted";
    expect(validate(configured)).toBe(false);
    numeric.bindings.postgres.expressionNumeric = true;
    const output = generateGo(configured, { packageName: "catalog" });
    expect(output).toContain("ExpressionNumeric: true");
    expect(output).toContain('AggregateOps: []string{"avg", "max"}');
    expect(output).toContain("AggregateOps: []string{}");
    expect(output).toContain(
      "Groupable: func() *bool { v := true; return &v }()",
    );
    expect(output).toContain(
      "Groupable: func() *bool { v := false; return &v }()",
    );
    const formatted = spawnSync("gofmt", { input: output, encoding: "utf8" });
    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toBe(output);
    expect(generateTypeScript(configured)).not.toContain("expressionNumeric");
  });

  it("rejects invalid Go package names", () => {
    expect(() => generateGo(document, { packageName: "bad-name" })).toThrow(
      /invalid Go package name/,
    );
    expect(() => generateGo(document, { packageName: "package" })).toThrow(
      /invalid Go package name/,
    );
  });

  it("rejects backend references that cannot produce a valid Go schema", () => {
    const missingIdBinding = structuredClone(document);
    delete missingIdBinding.fields.find(
      (field: { name: string }) => field.name === missingIdBinding.idField,
    ).bindings;
    expect(() =>
      generateGo(missingIdBinding, { packageName: "catalog" }),
    ).toThrow(/id field .* has no postgres binding/);

    const missingSortBinding = structuredClone(document);
    missingSortBinding.fields.find(
      (field: { name: string }) => field.name === "job_name",
    ).sort = { field: "details" };
    expect(() =>
      generateGo(missingSortBinding, { packageName: "catalog" }),
    ).toThrow(/sort target .* has no postgres binding/);
    expect(() =>
      generateGo(document, { packageName: "catalog", importPath: "bad\npath" }),
    ).toThrow(/invalid Go import path/);
  });
});
