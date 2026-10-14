import {
  loadSchema,
  type FieldSchema,
} from "@pythia-software/query-table-core";

/** Read explicit DuckDB bindings; never reuse another engine's SQL. */
export function loadDuckDBSchema(document: unknown): {
  schema: FieldSchema;
  bindings: Record<string, string>;
} {
  const schema = loadSchema(document);
  const raw = document as {
    fields: { name: string; bindings?: { duckdb?: { expr?: unknown } } }[];
  };
  const bindings: Record<string, string> = Object.create(null);
  for (const field of schema.fields) {
    if (field.source.kind !== "backend") continue;
    const binding = raw.fields.find((item) => item.name === field.name)
      ?.bindings?.duckdb;
    if (
      !binding ||
      typeof binding.expr !== "string" ||
      !binding.expr.trim() ||
      binding.expr.includes("\0")
    )
      throw Error(
        `Field ${field.name} requires an explicit bindings.duckdb.expr.`,
      );
    bindings[field.name] = binding.expr;
  }
  return { schema, bindings };
}
