import { loadSchema } from "@pythia-software/query-table-core";

export interface GoGenerationOptions {
  packageName: string;
  importPath?: string;
}

const DEFAULT_GO_IMPORT = "github.com/Pythia-Software/query-table/backends/go";

const GO_KINDS: Record<string, string> = {
  text: "FieldText",
  number: "FieldNumber",
  datetime: "FieldDatetime",
  bool: "FieldBool",
  enum: "FieldEnum",
  textarray: "FieldTextArray",
};

const GO_KEYWORDS = new Set([
  "break",
  "default",
  "func",
  "interface",
  "select",
  "case",
  "defer",
  "go",
  "map",
  "struct",
  "chan",
  "else",
  "goto",
  "package",
  "switch",
  "const",
  "fallthrough",
  "if",
  "range",
  "type",
  "continue",
  "for",
  "import",
  "return",
  "var",
]);

type JsonObject = Record<string, unknown>;

interface GoField {
  name: string;
  kind: string;
  expr: string;
  synthetic: boolean;
  serverFilter: boolean;
  sortable: boolean;
  sortExpr: string;
}

interface OrderTerm {
  field: string;
  dir: "asc" | "desc";
  nulls?: "first" | "last";
}

function asObject(value: unknown, label: string): JsonObject {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function goString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function exportedName(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const base = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Generated";
  return `${/^\d/.test(base) ? `Schema${base}` : base}Schema`;
}

function validateGoPackage(packageName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(packageName) || GO_KEYWORDS.has(packageName)) {
    throw new Error(`invalid Go package name ${JSON.stringify(packageName)}`);
  }
}

function orderTerms(value: unknown, label: string, fieldNames: Set<string>): OrderTerm[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const raw = asObject(item, `${label}[${index}]`);
    const field = requiredString(raw.field, `${label}[${index}].field`);
    if (!fieldNames.has(field)) throw new Error(`${label}[${index}] references unknown field ${JSON.stringify(field)}`);
    if (raw.dir !== "asc" && raw.dir !== "desc") throw new Error(`${label}[${index}].dir must be "asc" or "desc"`);
    const term: OrderTerm = { field, dir: raw.dir };
    if (raw.nulls != null) {
      if (raw.nulls !== "first" && raw.nulls !== "last") {
        throw new Error(`${label}[${index}].nulls must be "first" or "last"`);
      }
      term.nulls = raw.nulls;
    }
    return term;
  });
}

function renderOrderTerms(terms: OrderTerm[]): string {
  if (terms.length === 0) return "nil";
  const members = terms.map((term) => {
    const nulls = term.nulls ? `, Nulls: ${goString(term.nulls)}` : "";
    return `{Field: ${goString(term.field)}, Dir: ${goString(term.dir)}${nulls}}`;
  });
  return `[]querytable.OrderBy{${members.join(", ")}}`;
}

function projectGoFields(doc: JsonObject): GoField[] {
  if (!Array.isArray(doc.fields)) throw new Error("schema.fields must be an array");
  const rawFields = doc.fields.map((field, index) => asObject(field, `schema.fields[${index}]`));
  const exprByName = new Map<string, string>();

  for (const [index, field] of rawFields.entries()) {
    const name = requiredString(field.name, `schema.fields[${index}].name`);
    if (field.bindings == null) continue;
    const bindings = asObject(field.bindings, `schema.fields[${index}].bindings`);
    if (bindings.postgres == null) continue;
    const postgres = asObject(bindings.postgres, `schema.fields[${index}].bindings.postgres`);
    exprByName.set(name, requiredString(postgres.expr, `schema.fields[${index}].bindings.postgres.expr`));
  }

  const fields: GoField[] = [];
  for (const [index, field] of rawFields.entries()) {
    const name = requiredString(field.name, `schema.fields[${index}].name`);
    const expr = exprByName.get(name);
    if (!expr) continue;
    const bindings = asObject(field.bindings, `schema.fields[${index}].bindings`);
    const postgres = asObject(bindings.postgres, `schema.fields[${index}].bindings.postgres`);
    const kindName = typeof postgres.kind === "string" ? postgres.kind : requiredString(field.type, `schema.fields[${index}].type`);
    const kind = GO_KINDS[kindName];
    if (!kind) throw new Error(`field ${JSON.stringify(name)} has unknown postgres kind ${JSON.stringify(kindName)}`);

    let serverFilter = true;
    if (field.filter != null) {
      const filter = asObject(field.filter, `schema.fields[${index}].filter`);
      if (typeof filter.enabled === "boolean") serverFilter = filter.enabled;
      if (typeof filter.pushdown === "boolean") serverFilter = serverFilter && filter.pushdown;
    }

    let sortable = true;
    let sortExpr = expr;
    if (field.sort != null) {
      const sort = asObject(field.sort, `schema.fields[${index}].sort`);
      if (typeof sort.enabled === "boolean") sortable = sort.enabled;
      if (typeof sort.field === "string") {
        const referencedExpr = exprByName.get(sort.field);
        if (!referencedExpr) {
          throw new Error(`field ${JSON.stringify(name)} sort target ${JSON.stringify(sort.field)} has no postgres binding`);
        }
        sortExpr = referencedExpr;
      }
    }

    fields.push({
      name,
      kind,
      expr,
      synthetic: postgres.synthetic === true,
      serverFilter,
      sortable,
      sortExpr,
    });
  }
  return fields;
}

/** Generate the frontend projection. SQL bindings are deliberately omitted. */
export function generateTypeScript(input: unknown): string {
  const schema = loadSchema(input);
  const constant = exportedName(schema.name).replace(/Schema$/, "").toUpperCase() + "_SCHEMA";
  return [
    "// Code generated by query-table-codegen. DO NOT EDIT.",
    'import type { FieldSchema } from "@pythia-software/query-table-core";',
    "",
    `export const ${constant}: FieldSchema = ${JSON.stringify(schema, null, 2)};`,
    `export const ${constant.replace(/_SCHEMA$/, "_FIELDS")} = ${constant}.fields;`,
    "",
  ].join("\n");
}

/** Generate a direct Go Schema literal with no runtime JSON parsing. */
export function generateGo(input: unknown, options: GoGenerationOptions): string {
  validateGoPackage(options.packageName);
  loadSchema(input);
  const doc = asObject(input, "schema");
  const name = requiredString(doc.name, "schema.name");
  const idField = requiredString(doc.idField, "schema.idField");
  const fields = projectGoFields(doc);
  if (!fields.some((field) => field.name === idField)) {
    throw new Error(`id field ${JSON.stringify(idField)} has no postgres binding`);
  }
  const fieldNames = new Set((doc.fields as JsonObject[]).map((field) => requiredString(field.name, "schema field name")));
  const defaultSort = orderTerms(doc.defaultSort, "schema.defaultSort", fieldNames);
  const tiebreakSort = orderTerms(doc.tiebreakSort, "schema.tiebreakSort", fieldNames);
  const importPath = options.importPath ?? DEFAULT_GO_IMPORT;
  if (!importPath || /[\s\x00-\x1f\x7f"]/u.test(importPath)) throw new Error("invalid Go import path");

  const longestFieldKey = Math.max(0, ...fields.map((field) => goString(field.name).length));
  const fieldLines = fields.map(
    (field) => {
      const key = goString(field.name);
      const spacing = " ".repeat(longestFieldKey - key.length + 1);
      return `\t\t\t${key}:${spacing}{Name: ${goString(field.name)}, Kind: querytable.${field.kind}, Expr: ${goString(field.expr)}, Synthetic: ${field.synthetic}, ServerFilter: ${field.serverFilter}, Sortable: ${field.sortable}, SortExpr: ${goString(field.sortExpr)}},`;
    },
  );

  return [
    "// Code generated by query-table-codegen. DO NOT EDIT.",
    `package ${options.packageName}`,
    "",
    `import querytable ${goString(importPath)}`,
    "",
    `func ${exportedName(name)}() querytable.Schema {`,
    "\treturn querytable.Schema{",
    `\t\tName:    ${goString(name)},`,
    `\t\tIDField: ${goString(idField)},`,
    "\t\tFields: map[string]querytable.FieldSpec{",
    ...fieldLines,
    "\t\t},",
    `\t\tDefaultSort:  ${renderOrderTerms(defaultSort)},`,
    `\t\tTiebreakSort: ${renderOrderTerms(tiebreakSort)},`,
    "\t}",
    "}",
    "",
  ].join("\n");
}
