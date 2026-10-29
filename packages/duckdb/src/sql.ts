import {
  branchesOf,
  coerceValue,
  compileFormula,
  compileMetric,
  isFilterable,
  isSortable,
  isSelectable,
  opsForField,
  type FieldDef,
  type FieldSchema,
  type FormulaNode,
  type FormulaPlan,
  type WhereClause,
  type WhereTerm,
  type OrderByClause,
  type ServerQuery,
} from "@pythia-software/query-table-core";

export interface DuckDBStatement {
  sql: string;
  args: unknown[];
}
/** Identifiers come only from the host catalogue, and are always quoted. */
export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw Error("Invalid DuckDB identifier.");
  return `"${value.replace(/"/g, '""')}"`;
}
export function quoteRelation(value: string): string {
  return value.split(".").map(quoteIdentifier).join(".");
}
const aggregates = new Set([
  "COUNT",
  "COUNT_DISTINCT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "MEDIAN",
]);
const safeNumber = (value: string) =>
  `(CASE WHEN ${value} IS NULL OR (isfinite(${value}) AND abs(${value}) <= 9007199254740991) THEN ${value} ELSE error('Query Table numeric precision exceeded') END)`;

export class SQLBuilder {
  readonly args: unknown[] = [];
  constructor(
    readonly schema: FieldSchema,
    readonly now = Date.now(),
    readonly bindings: Record<string, string> = {},
  ) {}
  bind(value: unknown): string {
    this.args.push(value);
    return `$${this.args.length}`;
  }
  statement(sql: string): DuckDBStatement {
    if (sql.length > 262144 || this.args.length > 10000)
      throw Error("DuckDB statement budget exceeded.");
    return { sql, args: [...this.args] };
  }
  definition(name: string): FieldDef {
    const field = this.schema.fields.find((field) => field.name === name);
    if (!field || field.source.kind !== "backend")
      throw Error(`Unavailable DuckDB field: ${name}.`);
    return field;
  }
  field(name: string, normalize = true): string {
    const field = this.definition(name),
      value =
        (Object.prototype.hasOwnProperty.call(this.bindings, name)
          ? this.bindings[name]
          : undefined) ??
        quoteIdentifier(
          field.source.kind === "backend" ? (field.source.path ?? name) : name,
        );
    if (!normalize) return value;
    if (field.type === "text" || field.type === "enum")
      return `NULLIF(CAST(${value} AS VARCHAR), '')`;
    if (field.type === "datetime") return `CAST(${value} AS TIMESTAMPTZ)`;
    return value;
  }
  where(terms: WhereTerm[]): string {
    if (terms.length > 100)
      throw Error("At most 100 filter terms are allowed.");
    let count = 0;
    return terms.length
      ? terms
          .map((term) => {
            // A term is an OR of branches, each an AND of literals (a single
            // literal, an OR group, or an OR of conjunctions).
            const branches = branchesOf(term);
            const size = branches.reduce((n, branch) => n + branch.length, 0);
            if (!branches.length || branches.some((branch) => !branch.length) || (count += size) > 100)
              throw Error("Invalid filter predicate budget.");
            const compile = (clause: WhereClause): string => {
              const field = this.definition(clause.field),
                raw = this.field(field.name),
                op = clause.op;
              if (!isFilterable(field) || !opsForField(field).includes(op))
                throw Error(`Unsupported filter on ${field.name}: ${op}.`);
              const value =
                field.type === "textarray"
                  ? `CASE WHEN len(${raw}) > 0 THEN ${raw} END`
                  : raw;
              let sql: string;
              if (op === "is_null" || op === "is_not_null")
                sql = `${value} IS ${op === "is_null" ? "" : "NOT "}NULL`;
              else {
                const typed = coerceValue(field.type, clause.value, this.now);
                if (typeof typed === "number" && !Number.isFinite(typed))
                  throw Error("Filter operands must be finite.");
                const param = this.bind(
                  field.type === "datetime"
                    ? new Date(typed as number).toISOString()
                    : typed,
                );
                const rhs =
                  field.type === "datetime"
                    ? `CAST(${param} AS TIMESTAMPTZ)`
                    : param;
                if (["=", "!=", ">", ">=", "<", "<="].includes(op))
                  sql = `${value} ${op} ${rhs}`;
                else if (
                  ["contains", "starts_with", "ends_with"].includes(op)
                )
                  sql = `${op}(lower(${value}), lower(${param}))`;
                else if (op === "includes")
                  sql = field.filter?.arrayCaseSensitive
                    ? `list_contains(${value}, ${param})`
                    : `list_contains(list_transform(${value}, x -> lower(x)), lower(${param}))`;
                else if (op.startsWith("length_"))
                  sql = `length(${value}) ${op === "length_gt" ? ">" : op === "length_lt" ? "<" : "="} CAST(${param} AS DOUBLE)`;
                else if (
                  op === "matches_regex" ||
                  op === "not_matches_regex"
                ) {
                  if (clause.value.length > 2000)
                    throw Error("Regex exceeds 2,000 characters.");
                  sql = `${op === "not_matches_regex" ? "NOT " : ""}regexp_matches(${value}, ${param})`;
                } else throw Error(`Unsupported DuckDB operator: ${op}.`);
              }
              return clause.negated ? `NOT (${sql})` : sql;
            };
            return `(${branches
              .map((branch) => branch.length === 1 ? compile(branch[0]!) : `(${branch.map(compile).join(" AND ")})`)
              .join(" OR ")})`;
          })
          .join(" AND ")
      : "TRUE";
  }
  order(terms: OrderByClause[], identity = true): string {
    if (terms.length > 20) throw Error("At most 20 sort fields are allowed.");
    const output = terms.map((term) => {
      const field = this.definition(term.field);
      if (!isSortable(field) && field.name !== this.schema.idField)
        throw Error(`Field ${field.name} is not sortable.`);
      if (
        !["asc", "desc"].includes(term.dir) ||
        (term.nulls && !["first", "last"].includes(term.nulls))
      )
        throw Error("Invalid ordering.");
      let value = this.field(field.name);
      if (term.extract) {
        if (field.type !== "text" || term.extract.regex.length > 2000)
          throw Error("Invalid regex extraction.");
        const pattern = this.bind(term.extract.regex);
        // DuckDB/RE2 extraction uses the first capture, or the full match.
        const capture = /(^|[^\\])\((?!\?)/.test(term.extract.regex) ? 1 : 0;
        value = `CASE WHEN regexp_matches(${value}, ${pattern}) THEN regexp_extract(${value}, ${pattern}, ${capture}) END`;
      }
      return `${value} ${term.dir.toUpperCase()} NULLS ${(term.nulls ?? "last").toUpperCase()}`;
    });
    if (identity && !terms.some((term) => term.field === this.schema.idField))
      output.push(`${this.field(this.schema.idField)} ASC NULLS LAST`);
    return output.length ? `ORDER BY ${output.join(", ")}` : "";
  }
  expression(
    source: string,
    aggregate = false,
  ): { sql: string; plan: FormulaPlan } {
    const plan = aggregate
      ? compileMetric(source, this.schema)
      : compileFormula(source, this.schema.fields);
    return { sql: this.node(plan.ast), plan };
  }
  node(node: FormulaNode): string {
    const sql = this.nodeSQL(node);
    if (sql.length > 131072)
      throw Error("DuckDB expression SQL budget exceeded.");
    return sql;
  }
  private nodeSQL(node: FormulaNode): string {
    if (node.kind === "literal")
      return node.value === null ? "NULL" : this.bind(node.value);
    if (node.kind === "field") return this.field(node.name, false);
    const name = node.name,
      vs = node.args.map((arg) => this.node(arg)),
      a = vs[0]!,
      b = vs[1]!,
      c = vs[2]!;
    if (aggregates.has(name)) {
      if (name === "COUNT") return `CAST(COUNT(${a ?? "*"}) AS DOUBLE)`;
      if (name === "COUNT_DISTINCT")
        return `CAST(COUNT(DISTINCT ${a}) AS DOUBLE)`;
      const sql = `${name}(${a})`;
      return ["SUM", "AVG", "MEDIAN"].includes(name)
        ? safeNumber(
            `CAST(${name === "SUM" ? `COALESCE(${sql}, 0)` : sql} AS DOUBLE)`,
          )
        : sql;
    }
    if (name.startsWith("op:")) {
      const op = name.slice(3);
      if (op === "IN") return `(${a} IN (${vs.slice(1).join(", ")}))`;
      if (op === "BETWEEN") return `(${a} BETWEEN ${b} AND ${c})`;
      if (["/", "%"].includes(op))
        return safeNumber(
          `(CASE WHEN ${b} = 0 THEN error('Division by zero') ELSE ${a} ${op} ${b} END)`,
        );
      return ["+", "-", "*"].includes(op)
        ? safeNumber(`(${a} ${op} ${b})`)
        : `(${a} ${op} ${b})`;
    }
    if (name.startsWith("unary:")) return `(${name.slice(6)} ${a})`;
    if (name === "IF") return `CASE WHEN ${a} THEN ${b} ELSE ${c} END`;
    if (name === "IFS")
      return `CASE ${vs
        .slice(0, -1)
        .filter((_, i) => i % 2 === 0)
        .map((v, i) => `WHEN ${v} THEN ${vs[2 * i + 1]}`)
        .join(" ")} ELSE ${vs[vs.length - 1]} END`;
    if (name === "SWITCH")
      return `CASE ${vs
        .slice(1, -1)
        .filter((_, i) => i % 2 === 0)
        .map(
          (v, i) => `WHEN ${a} IS NOT DISTINCT FROM ${v} THEN ${vs[2 * i + 2]}`,
        )
        .join(" ")} ELSE ${vs[vs.length - 1]} END`;
    if (name === "IS_NULL") return `(${a} IS NULL)`;
    if (name === "IS_EMPTY") {
      const input = node.args[0]!;
      const array =
        (input.kind === "field" && input.valueType === "textarray") ||
        (input.kind === "call" &&
          ["SPLIT", "ARRAY_UNIQUE", "ARRAY_SORT"].includes(input.name));
      return `(${a} IS NULL OR len(${array ? a : `CAST(${a} AS VARCHAR)`}) = 0)`;
    }
    if (name === "COALESCE" || name === "NULLIF")
      return `${name}(${vs.join(", ")})`;
    if (name === "IFERROR")
      throw Error("IFERROR is not available in the qt-duckdb-v1 SQL profile.");
    if (name === "ROUND") {
      const scale = `power(10, ${b ?? "0"})`;
      return safeNumber(`(floor(${a} * ${scale} + 0.5) / ${scale})`);
    }
    if (name === "CLAMP")
      return `CASE WHEN ${a} IS NULL OR ${b} IS NULL OR ${c} IS NULL THEN NULL ELSE greatest(${b}, least(${c}, ${a})) END`;
    if (name === "LEAST" || name === "GREATEST" || name === "CONCAT")
      return `CASE WHEN ${vs.map((v) => `${v} IS NULL`).join(" OR ")} THEN NULL ELSE ${name}(${vs.join(", ")}) END`;
    if (name === "CONCAT_WS")
      return `CASE WHEN ${a} IS NULL THEN NULL ELSE concat_ws(${vs.join(", ")}) END`;
    if (["CONTAINS", "STARTS_WITH", "ENDS_WITH"].includes(name))
      return `${name.toLowerCase()}(CASE WHEN ${c ?? "FALSE"} THEN lower(${a}) ELSE ${a} END, CASE WHEN ${c ?? "FALSE"} THEN lower(${b}) ELSE ${b} END)`;
    if (name === "TO_NUMBER") return safeNumber(`CAST(${a} AS DOUBLE)`);
    if (name === "TO_TEXT") return `CAST(${a} AS VARCHAR)`;
    if (name === "URL_ENCODE") return `url_encode(${a})`;
    if (name === "TO_BOOLEAN") return `CAST(${a} AS BOOLEAN)`;
    if (name === "TO_DATETIME") return `CAST(${a} AS TIMESTAMPTZ)`;
    if (name === "SPLIT") return `string_split(${a}, ${b})`;
    if (name === "JOIN") return `array_to_string(${a}, ${b})`;
    if (name === "ARRAY_LENGTH") return `len(${a})`;
    if (name === "ARRAY_CONTAINS") return `list_contains(${a}, ${b})`;
    if (name === "ARRAY_GET")
      return `CASE WHEN ${b} < 0 THEN error('Array index must be nonnegative') ELSE list_extract(${a}, CAST(${b} + 1 AS BIGINT)) END`;
    if (name === "ARRAY_SORT") return `list_sort(${a})`;
    if (name === "ARRAY_UNIQUE")
      return `list_filter(${a}, (x, i) -> list_position(${a}, x) = i)`;
    if (name === "WEEKDAY")
      return `extract(isodow FROM CAST(${a} AS TIMESTAMPTZ))`;
    if (["YEAR", "MONTH", "DAY", "HOUR"].includes(name))
      return `extract(${name.toLowerCase()} FROM CAST(${a} AS TIMESTAMPTZ))`;
    if (name === "DATE_TRUNC")
      return `date_trunc(${a}, CAST(${b} AS TIMESTAMPTZ))`;
    if (
      name === "DATE_DIFF" ||
      name === "DATE_ADD" ||
      name === "FORMAT_DATE" ||
      name.startsWith("REGEX_")
    )
      throw Error(`${name} is not available in the qt-duckdb-v1 SQL profile.`);
    if (
      ["LEFT", "RIGHT", "SUBSTRING", "LPAD", "RPAD", "SPLIT_PART"].includes(
        name,
      )
    ) {
      const args = [...vs];
      const indices =
        name === "SUBSTRING" ? [1, 2] : name === "SPLIT_PART" ? [2] : [1];
      for (const index of indices)
        if (args[index] !== undefined)
          args[index] = `CAST(${args[index]} AS BIGINT)`;
      return `${name}(${args.join(", ")})`;
    }
    if (
      [
        "LENGTH",
        "LOWER",
        "UPPER",
        "TRIM",
        "LTRIM",
        "RTRIM",
        "REPLACE",
        "ABS",
        "FLOOR",
        "CEIL",
        "TRUNC",
        "POWER",
        "SQRT",
      ].includes(name)
    )
      return `${name}(${vs.join(", ")})`;
    throw Error(`Unsupported DuckDB function: ${name}.`);
  }
}

export function compileDuckDBRows(
  query: ServerQuery,
  schema: FieldSchema,
  relation: string,
  now = Date.now(),
): DuckDBStatement {
  const sql = new SQLBuilder(schema, now);
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 10000 ||
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0
  )
    throw Error("Invalid result window.");
  const select = [...new Set([schema.idField, ...query.select])].map((name) => {
    const field = sql.definition(name);
    if (!isSelectable(field) && name !== schema.idField)
      throw Error(`Field ${name} is not selectable.`);
    return `${sql.field(name, false)} AS ${quoteIdentifier(name)}`;
  });
  const where = sql.where(query.where),
    order = sql.order(query.orderBy);
  return sql.statement(
    `SELECT ${select.join(", ")} FROM ${quoteRelation(relation)} WHERE ${where} ${order} LIMIT ${sql.bind(query.limit)} OFFSET ${sql.bind(query.offset)}`,
  );
}
