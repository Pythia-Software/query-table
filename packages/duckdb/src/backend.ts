import {
  compileFormula,
  createGroupingModel,
  GROUP_ID_FIELD,
  metricExpression,
  metricMinCount,
  metricMinCountKeeps,
  metricMinCountMeasure,
  validateMetric,
  isSelectable,
  isFilterable,
  boxSummary,
  histogramEdges,
  histogramCounts,
  compareMetricValues,
  metricDateFloor,
  isMetricCycle,
  metricCycleSlot,
  metricCycleSlots,
  metricDateTime,
  metricDateNext,
  metricDateRange,
  groupKeyFields,
  isCalendarGroupKey,
  type AggregationClause,
  type AggregationResult,
  type AggregationResultEntry,
  type ComputedColumn,
  type ComputedExecution,
  type FieldSchema,
  type FormulaPlan,
  type MetricQuery,
  type QueryCapabilitiesV3,
  type QueryRequestV3,
  type QueryResultV3,
  type ServerQuery,
  type Transport,
  type MetricDateGrouping,
  type MetricSort,
  type MetricValue,
  type QueryState,
} from "@pythia-software/query-table-core";
import {
  SQLBuilder,
  quoteIdentifier as id,
  quoteRelation,
  type DuckDBStatement,
} from "./sql";

export const DUCKDB_PROFILE = "qt-duckdb-v1";
export type DuckDBRow = Record<string, unknown>;
/** One exclusive connection, with bound parameters; no driver runtime dependency. */
export interface DuckDBConnection {
  query(sql: string, args: unknown[]): Promise<DuckDBRow[]>;
  interrupt?(): void | Promise<void>;
}
export interface DuckDBOptions {
  connection: DuckDBConnection;
  schema: FieldSchema;
  relation: string;
  /** Trusted SQL expressions, keyed by the host's field names. Never request SQL. */
  bindings?: Record<string, string>;
  computedColumns?: readonly ComputedColumn[];
  snapshot?: string;
  maxRows?: number;
  maxGroups?: number;
  maxPopulation?: number;
  maxSamples?: number;
  maxStagingBytes?: number;
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("DuckDB query cancelled.", "AbortError");
}
/** Normalize both Arrow and Node values at the transport boundary. */
export function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric))
      throw Error("DuckDB integer exceeds JavaScript safe precision.");
    return numeric;
  }
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw Error("DuckDB number exceeds finite safe precision.");
  if (Array.isArray(value)) return value.map(normalizeDuckDBValue);
  if (value && typeof value === "object") {
    // Arrow vectors expose toArray(); StructRow exposes toJSON().
    if ("toArray" in value && typeof value.toArray === "function")
      return Array.from(value.toArray()).map(normalizeDuckDBValue);
    if ("toJSON" in value && typeof value.toJSON === "function")
      return normalizeDuckDBValue(value.toJSON());
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeDuckDBValue(item),
      ]),
    );
  }
  return value;
}
function positive(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const out = value ?? fallback;
  if (!Number.isSafeInteger(out) || out < 1 || out > maximum)
    throw Error("Invalid DuckDB resource budget.");
  return out;
}

export class DuckDBBackend {
  readonly schema: FieldSchema;
  readonly execution: ComputedExecution;
  readonly capabilities: QueryCapabilitiesV3;
  readonly maxSamples: number;
  readonly maxStagingBytes: number;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private readonly computed = new Map<string, FormulaPlan>();
  constructor(readonly options: DuckDBOptions) {
    const fields = options.schema.fields
      .filter((field) => field.source.kind === "backend")
      .map((field) => ({
        ...field,
        source: { ...field.source, kind: "backend" as const, path: field.name },
      }));
    if (
      !fields.some((field) => field.name === options.schema.idField) ||
      new Set(fields.map((field) => field.name)).size !== fields.length
    )
      throw Error(
        "DuckDB needs a unique field catalogue and a bound identity.",
      );
    quoteRelation(options.relation);
    this.schema = { ...options.schema, fields };
    const definitions = new Map(
      (options.computedColumns ?? []).map((column) => [
        `@computed/${column.id}`,
        column,
      ]),
    );
    const visiting = new Set<string>();
    const resolve = (name: string): FormulaPlan | undefined => {
      if (this.computed.has(name)) return this.computed.get(name);
      const definition = definitions.get(name);
      if (!definition) return undefined;
      if (visiting.has(name)) throw Error("Computed definition cycle.");
      visiting.add(name);
      const plan = compileFormula(
        definition.expression.source,
        fields,
        resolve,
      );
      // Reject unsupported SQL at negotiation, before advertising capabilities.
      new SQLBuilder(this.schema).node(plan.ast);
      visiting.delete(name);
      this.computed.set(name, plan);
      return plan;
    };
    for (const name of definitions.keys()) {
      const plan = resolve(name)!;
      fields.push({
        name,
        label: definitions.get(name)!.label,
        type: plan.type === "null" ? "text" : plan.type,
        source: { kind: "backend", path: name },
        filter: { enabled: true },
        sort: { enabled: true },
        aggregate: { measure: true, groupable: plan.type !== "textarray" },
      });
    }
    this.execution = {
      profile: DUCKDB_PROFILE,
      planToken: `duckdb:${JSON.stringify([...definitions.values()].map((column) => [column.id, column.revision]))}`,
      resolvedRevisions: Object.fromEntries(
        [...definitions.values()].map((column) => [column.id, column.revision]),
      ),
      fields: Object.fromEntries(
        fields
          .filter((field) => definitions.has(field.name))
          .map((field) => [
            field.name,
            {
              type: field.type,
              select: true,
              filter: true,
              sort: true,
              measure: true,
              group: field.type !== "textarray",
            },
          ]),
      ),
      ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    };
    this.capabilities = {
      version: 3,
      profile: DUCKDB_PROFILE,
      groupedRows: true,
      calendarGrouping: true,
      calendarCycles: true,
      calendarGroupKeys: true,
      computedSourceFilters: definitions.size > 0,
      regex: true,
      regexSourceFilters: true,
      regexAggregateExpressions: false,
      metricFilters: true,
      metricMinCount: true,
      metricMinCountMeasures: true,
      maxRows: positive(options.maxRows, 10000, 10000),
      maxGroups: positive(options.maxGroups, 10000, 10000),
      maxPopulation: positive(options.maxPopulation, 250000, 10000000),
    };
    this.maxSamples = positive(options.maxSamples, 100000, 1000000);
    this.maxStagingBytes = positive(
      options.maxStagingBytes,
      64 * 1024 * 1024,
      1024 * 1024 * 1024,
    );
  }
  private serial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.queue.then(() => {
      abort(signal);
      return work();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  /** Wait before closing an owned driver connection. */
  async drain(): Promise<void> {
    await this.queue;
  }
  private async run(
    statement: DuckDBStatement,
    signal?: AbortSignal,
  ): Promise<DuckDBRow[]> {
    abort(signal);
    const cancel = () => {
      void this.options.connection.interrupt?.();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const rows = await this.options.connection.query(
        statement.sql,
        statement.args,
      );
      abort(signal);
      return rows.map((row) => normalizeDuckDBValue(row) as DuckDBRow);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  private sql(statement: string, args: unknown[] = [], signal?: AbortSignal) {
    return this.run({ sql: statement, args }, signal);
  }
  private window(query: ServerQuery): void {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > this.capabilities.maxRows ||
      !Number.isSafeInteger(query.offset) ||
      query.offset < 0
    )
      throw Error("Invalid DuckDB result window.");
  }
  private builder(schema = this.schema, now = Date.now()) {
    return new SQLBuilder(schema, now);
  }
  private projectedSource(now: number): DuckDBStatement {
    const bindings = Object.fromEntries(
      this.schema.fields
        .filter((field) => !this.computed.has(field.name))
        .map((field) => [
          field.name,
          (this.options.bindings &&
          Object.prototype.hasOwnProperty.call(
            this.options.bindings,
            field.name,
          )
            ? this.options.bindings[field.name]
            : undefined) ??
            id(
              (() => {
                const original = this.options.schema.fields.find(
                  (item) => item.name === field.name,
                );
                return original?.source.kind === "backend"
                  ? (original.source.path ?? field.name)
                  : field.name;
              })(),
            ),
        ]),
    );
    const builder = new SQLBuilder(this.schema, now, bindings);
    const projections = this.schema.fields.map((field) => {
      const plan = this.computed.get(field.name),
        raw = plan ? builder.node(plan.ast) : bindings[field.name]!;
      return `${raw} AS ${id(field.name)}`;
    });
    return builder.statement(
      `SELECT ${projections.join(", ")} FROM ${quoteRelation(this.options.relation)} AS r`,
    );
  }
  private async transaction<T>(
    work: (tables: string[]) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.serial(async () => {
      await this.sql("BEGIN TRANSACTION", [], signal);
      const tables: string[] = [];
      try {
        const result = await work(tables);
        for (const table of tables.reverse())
          await this.sql(`DROP TABLE ${id(table)}`, [], signal);
        await this.sql("COMMIT", [], signal);
        return result;
      } catch (error) {
        await this.sql("ROLLBACK").catch(() => {});
        // Metrics commit staged relations before isolating each clause, so a
        // rollback alone may not remove them.
        for (const table of tables.reverse())
          await this.sql(`DROP TABLE IF EXISTS ${id(table)}`).catch(() => {});
        abort(signal);
        throw error;
      }
    }, signal);
  }
  private temp(tables: string[]): string {
    const name = `qt_duckdb_${++this.sequence}`;
    tables.push(name);
    return name;
  }
  private async stage(
    source: ServerQuery,
    now: number,
    tables: string[],
    signal?: AbortSignal,
  ): Promise<{ name: string; count: number }> {
    const projection = this.projectedSource(now),
      builder = this.builder(this.schema, now);
    builder.args.push(...projection.args);
    const where = builder.where(source.where),
      name = this.temp(tables);
    const population = `(${projection.sql}) r WHERE ${where}`;
    const [{ n, bytes }] = (await this.run(
      builder.statement(
        `SELECT COUNT(*) AS n, COALESCE(SUM(octet_length(encode(CAST(to_json(r) AS VARCHAR)))),0) AS bytes FROM ${population}`,
      ),
      signal,
    )) as [{ n: number; bytes: number }];
    if (n > this.capabilities.maxPopulation || bytes > this.maxStagingBytes)
      throw Error("DuckDB source population or staging byte budget exceeded.");
    await this.run(
      builder.statement(
        `CREATE TEMP TABLE ${id(name)} AS SELECT * FROM ${population}`,
      ),
      signal,
    );
    const [{ invalid }] = (await this.sql(
      `SELECT COUNT(*) - COUNT(DISTINCT ${id(this.schema.idField)}) AS invalid FROM ${id(name)}`,
      [],
      signal,
    )) as [{ invalid: number }];
    if (invalid !== 0)
      throw Error("DuckDB source identity must be unique and non-null.");
    return { name, count: n };
  }
  private async page(
    relation: string,
    schema: FieldSchema,
    query: ServerQuery,
    now: number,
    signal?: AbortSignal,
  ) {
    this.window(query);
    const builder = this.builder(schema, now),
      where = builder.where(query.where);
    const [{ total }] = (await this.run(
      builder.statement(
        `SELECT COUNT(*) AS total FROM ${id(relation)} WHERE ${where}`,
      ),
      signal,
    )) as [{ total: number }];
    const order = builder.order(query.orderBy),
      names = [...new Set([schema.idField, ...query.select])];
    names.forEach((name) => {
      if (!isSelectable(builder.definition(name)) && name !== schema.idField)
        throw Error(`Field ${name} is not selectable.`);
    });
    const rows = await this.run(
      builder.statement(
        `SELECT ${names.map(id).join(", ")} FROM ${id(relation)} WHERE ${where} ${order} LIMIT ${builder.bind(query.limit)} OFFSET ${builder.bind(query.offset)}`,
      ),
      signal,
    );
    return { rows: rows.map((row) => this.formatRow(row, schema)), total };
  }
  private formatRow(row: DuckDBRow, schema: FieldSchema): DuckDBRow {
    return Object.fromEntries(
      Object.entries(row).map(([name, value]) => {
        const field = schema.fields.find((field) => field.name === name);
        if (value != null && field?.type === "datetime") {
          // DuckDB's textual native TIMESTAMP has no suffix; our session profile
          // interprets that storage as UTC, independently of the JS host timezone.
          const text = String(value);
          const canonical =
            /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
              ? `${text.replace(" ", "T")}Z`
              : text;
          const date =
            typeof value === "number" ? new Date(value) : new Date(canonical);
          if (!Number.isFinite(date.getTime()))
            throw Error(`Invalid datetime returned for ${name}.`);
          value = date.toISOString();
        }
        return [name, value];
      }),
    );
  }
  private validateRequest(request: QueryRequestV3): void {
    if (
      request.version !== 3 ||
      request.profile !== DUCKDB_PROFILE ||
      request.diagnostics.length
    )
      throw Error("Invalid DuckDB execution request or profile.");
    if (
      !Number.isSafeInteger(request.now) ||
      Math.abs(request.now) > 8640000000000000
    )
      throw Error("Invalid query clock.");
    if (
      (request.planToken ?? "") !==
        (Object.keys(this.execution.fields).length
          ? this.execution.planToken
          : "") &&
      request.planToken !== this.execution.planToken
    )
      throw Error("DuckDB execution handshake changed.");
    if ((request.snapshot ?? "") !== (this.options.snapshot ?? ""))
      throw Error("DuckDB snapshot changed.");
    for (const [key, revision] of Object.entries(request.expectedRevisions))
      if (this.execution.resolvedRevisions[key] !== revision)
        throw Error("Computed definitions changed; refresh the handshake.");
    if (request.metrics.length > 20)
      throw Error("At most 20 metrics are allowed.");
    this.window(request.result);
    const model = createGroupingModel(this.schema);
    if (request.grouping) model.validate(request.grouping);
    const resultSchema = request.grouping
      ? model.resultSchema(request.grouping.keys, request.grouping.summaries)
      : this.schema;
    this.builder(this.schema, request.now).where(request.source.where);
    const result = this.builder(resultSchema, request.now);
    result.where(request.result.where);
    result.order(request.result.orderBy);
    request.result.select.forEach((name) => result.definition(name));
  }
  async execute(
    request: QueryRequestV3,
    signal?: AbortSignal,
  ): Promise<QueryResultV3> {
    this.validateRequest(request);
    return this.transaction(async (tables) => {
      const source = await this.stage(
        request.source,
        request.now,
        tables,
        signal,
      );
      let relation = source.name,
        schema = this.schema;
      if (request.grouping) {
        const grouping = request.grouping,
          model = createGroupingModel(schema),
          builder = this.builder(schema, request.now);
        // A calendar key reads the interval start mapped from its field.
        let from = id(source.name);
        const keys: string[] = [];
        for (const [index, key] of grouping.keys.entries()) {
          if (!isCalendarGroupKey(key)) {
            keys.push(builder.field(key, false));
            continue;
          }
          const mapping = await this.calendarMapping(
            id(source.name),
            builder,
            schema,
            key,
            tables,
            signal,
          );
          const value = id(`qt_calendar_value${index}`),
            bucket = id(`qt_calendar_key${index}`);
          from += ` LEFT JOIN (SELECT value AS ${value}, bucket AS ${bucket} FROM ${id(mapping)}) AS ${id(`qt_calendar_map${index}`)} ON ${value} = CAST(${builder.field(key.field, false)} AS TIMESTAMPTZ)`;
          keys.push(bucket);
        }
        const names = groupKeyFields(grouping.keys).map(id);
        const representative = builder
          .order(
            grouping.representative?.orderBy ?? [
              { field: schema.idField, dir: "desc" },
            ],
            false,
          )
          .replace(/^ORDER BY /, "");
        const tie = grouping.representative?.orderBy.some(
          (term) => term.field === schema.idField,
        )
          ? ""
          : `, ${builder.field(schema.idField)} DESC NULLS LAST`;
        const summaries = grouping.summaries.map(
          (summary) =>
            `${
              summary.op === "row"
                ? `first(${builder.field(summary.field!, false)} ORDER BY ${representative}${tie})`
                : builder.expression(model.summaryExpression(summary), true).sql
            } AS ${id(summary.id)}`,
        );
        relation = this.temp(tables);
        const identity = `CAST(to_json(struct_pack(${keys.map((key, i) => `k${i} := ${key}`).join(", ")})) AS VARCHAR)`;
        await this.run(
          builder.statement(
            `CREATE TEMP TABLE ${id(relation)} AS SELECT ${identity} AS ${id(GROUP_ID_FIELD)}, ${keys.map((key, i) => `${key} AS ${names[i]}`).join(", ")}${summaries.length ? `, ${summaries.join(", ")}` : ""} FROM ${from} GROUP BY ${keys.join(", ")}`,
          ),
          signal,
        );
        const [{ n }] = (await this.sql(
          `SELECT COUNT(*) AS n FROM ${id(relation)}`,
          [],
          signal,
        )) as [{ n: number }];
        if (n > this.capabilities.maxGroups)
          throw Error("DuckDB grouped row budget exceeded.");
        schema = model.resultSchema(grouping.keys, grouping.summaries);
      }
      const page = await this.page(
        relation,
        schema,
        request.result,
        request.now,
        signal,
      );
      const metrics = await this.metrics(
        relation,
        schema,
        request.result,
        request.metrics,
        request.now,
        tables,
        signal,
      );
      return {
        version: 3,
        now: request.now,
        sourceTotal: source.count,
        rows: request.rows ? page.rows : [],
        total: page.total,
        schema: {
          name: schema.name,
          idField: schema.idField,
          fields: schema.fields.map((field) => ({
            name: field.name,
            type: field.type,
          })),
        },
        metrics,
        execution: { ...this.execution, planToken: request.planToken ?? "" },
      };
    }, signal);
  }
  private async metrics(
    relation: string,
    schema: FieldSchema,
    query: ServerQuery,
    clauses: AggregationClause[],
    now: number,
    tables: string[],
    signal?: AbortSignal,
  ): Promise<AggregationResultEntry[]> {
    const output: AggregationResultEntry[] = [];
    // A failed DuckDB statement aborts its transaction, and DuckDB has no
    // savepoints. Clauses read only staged temporary relations, so commit
    // them and give each clause its own transaction.
    await this.sql("COMMIT", [], signal);
    for (const clause of clauses) {
      abort(signal);
      const created = tables.length;
      await this.sql("BEGIN TRANSACTION", [], signal);
      try {
        const entry = await this.metric(
          relation,
          schema,
          query,
          clause,
          now,
          tables,
          signal,
        );
        await this.sql("COMMIT", [], signal);
        output.push(entry);
      } catch (error) {
        await this.sql("ROLLBACK").catch(() => {});
        // The rollback discarded this clause's scratch relations.
        tables.splice(created);
        abort(signal);
        output.push({
          id: clause.id,
          buckets: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.sql("BEGIN TRANSACTION", [], signal);
    return output;
  }
  /** A temporary (value, bucket) table mapping each distinct non-null value
   * of `config.field` in `population` to the start of its calendar interval,
   * or to its cyclic slot, computed with the core calendar. */
  private async calendarMapping(
    population: string,
    builder: SQLBuilder,
    schema: FieldSchema,
    config: Pick<MetricDateGrouping, "field" | "interval" | "timeZone">,
    tables: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const source = builder.field(config.field, false),
      cycle = isMetricCycle(config.interval) ? config.interval : undefined;
    const dates = await this.run(
      builder.statement(
        `SELECT DISTINCT CAST(${source} AS VARCHAR) AS value FROM ${population} r WHERE ${source} IS NOT NULL`,
      ),
      signal,
    );
    const mapping = this.temp(tables);
    await this.sql(
      `CREATE TEMP TABLE ${id(mapping)} (value TIMESTAMPTZ, bucket ${cycle ? "INTEGER" : "TIMESTAMPTZ"})`,
      [],
      signal,
    );
    for (let i = 0; i < dates.length; i += 250) {
      const args: unknown[] = [];
      const values = dates.slice(i, i + 250).map((row) => {
        const value = /^\d{4}-\d{2}-\d{2}$/.test(String(row.value))
          ? String(row.value)
          : (this.formatRow({ [config.field]: row.value }, schema)[
              config.field
            ] as string);
        const floor = metricDateFloor(
          metricDateTime(value, config.timeZone),
          config.interval,
          config.timeZone,
        );
        // A cyclic slot is the local hour or weekday of the record's interval.
        args.push(
          value,
          cycle
            ? metricCycleSlot(floor, cycle, config.timeZone)
            : new Date(floor).toISOString(),
        );
        return `(CAST($${args.length - 1} AS TIMESTAMPTZ), CAST($${args.length} AS ${cycle ? "INTEGER" : "TIMESTAMPTZ"}))`;
      });
      if (values.length)
        await this.sql(
          `INSERT INTO ${id(mapping)} VALUES ${values.join(", ")}`,
          args,
          signal,
        );
    }
    return mapping;
  }
  private async metric(
    relation: string,
    schema: FieldSchema,
    query: ServerQuery,
    clause: AggregationClause,
    now: number,
    tables: string[],
    signal?: AbortSignal,
  ): Promise<AggregationResultEntry> {
    // Wire metrics carry active distributions without presentation settings.
    if (clause.distribution && !clause.display)
      clause = { ...clause, display: { kind: clause.distribution.kind } };
    const issues = validateMetric(clause, schema);
    if (issues.length)
      throw Error(issues.map((issue) => issue.message).join(" "));
    const builder = this.builder(schema, now),
      where = builder.where(query.where);
    const window =
      clause.scope === "shownRows"
        ? `${builder.order(query.orderBy)} LIMIT ${builder.bind(query.limit)} OFFSET ${builder.bind(query.offset)}`
        : "";
    let population = `(SELECT * FROM ${id(relation)} WHERE ${where} ${window})`;
    // The metric's own predicate narrows the scoped rows (inside the page for
    // shown-row scope) and never changes the table rows.
    if (clause.where?.length)
      population = `(SELECT * FROM ${population} r WHERE ${builder.where(clause.where)})`;
    if (clause.dateGrouping) {
      const config = clause.dateGrouping;
      const dateMapping = await this.calendarMapping(
        population,
        builder,
        schema,
        config,
        tables,
        signal,
      );
      population = `(SELECT r.* EXCLUDE (${id(config.field)}), m.bucket AS ${id(config.field)} FROM ${population} r LEFT JOIN ${id(dateMapping)} m ON CAST(r.${id(config.field)} AS TIMESTAMPTZ) = m.value)`;
    }
    const keys = clause.groupBy.map((name) => builder.field(name, false)),
      groups = keys.length ? `GROUP BY ${keys.join(", ")}` : "";
    const distribution =
      clause.distribution &&
      ["box", "histogram"].includes(clause.display?.kind ?? "")
        ? clause.distribution
        : undefined;
    const expression = distribution
      ? builder.expression(distribution.input).sql
      : builder.expression(metricExpression(clause), true).sql;
    const projections = keys.map(
      (key, index) => `${key} AS ${id(`g${index}`)}`,
    );
    projections.push(
      "COUNT(*) AS count",
      distribution
        ? `list(${expression}) FILTER (WHERE ${expression} IS NOT NULL) AS samples`
        : `${expression} AS value`,
    );
    if (!distribution && clause.display?.kind === "scatter")
      projections.push(
        `${builder.expression(clause.expressionY ?? "COUNT()", true).sql} AS y`,
      );
    // An object minCount measures each group with its own aggregate.
    const minMeasure = metricMinCountMeasure(clause);
    if (minMeasure)
      projections.push(
        `${builder.expression(metricExpression({ id: "", groupBy: [], ...minMeasure }), true).sql} AS min_measure`,
      );
    const rows = await this.run(
      builder.statement(
        `SELECT ${projections.join(", ")} FROM ${population} r ${groups} LIMIT ${this.capabilities.maxGroups + 1}`,
      ),
      signal,
    );
    if (rows.length > this.capabilities.maxGroups)
      throw Error("DuckDB metric group budget exceeded.");
    if (
      distribution &&
      rows.some(
        (row) =>
          (row.samples as unknown[] | null)?.length &&
          (row.samples as unknown[]).length > this.maxSamples,
      )
    )
      throw Error(
        `The ${distribution.kind} distribution exceeded the ${this.maxSamples.toLocaleString("en-US")}-sample budget${clause.groupBy.length ? " for one or more groups" : ""}.`,
      );
    const edges =
      distribution?.kind === "histogram"
        ? histogramEdges(
            rows.flatMap((row) => (row.samples as number[]) ?? []),
            distribution.bins ?? 10,
          )
        : [];
    const measures = new Map<object, { value: unknown }>();
    const buckets: AggregationResultEntry["buckets"] = rows.map((row) => {
      const samples = (row.samples as number[]) ?? [];
      const bucket: AggregationResultEntry["buckets"][number] = {
        keys: clause.groupBy.map((name, index) => {
          const value = row[`g${index}`] ?? null;
          if (index === 0 && isMetricCycle(clause.dateGrouping?.interval))
            return value === null ? null : Number(value);
          return schema.fields.find((field) => field.name === name)?.type ===
            "datetime" && value !== null
            ? (this.formatRow({ [name]: value }, schema)[name] as string)
            : (value as MetricValue);
        }),
        count: row.count as number,
        value: distribution ? null : (row.value as MetricValue),
        ...(row.y !== undefined ? { y: row.y as MetricValue } : {}),
        ...(distribution
          ? {
              nullCount: (row.count as number) - samples.length,
              distribution:
                distribution.kind === "box"
                  ? {
                      kind: "box" as const,
                      summary: boxSummary(samples, distribution.whiskers),
                    }
                  : {
                      kind: "histogram" as const,
                      n: samples.length,
                      edges,
                      counts: histogramCounts(samples, edges),
                    },
            }
          : {}),
      };
      if (minMeasure) measures.set(bucket, { value: row.min_measure });
      return bucket;
    });
    if (clause.dateGrouping?.includeEmpty) {
      const config = clause.dateGrouping,
        cycle = isMetricCycle(config.interval) ? config.interval : undefined,
        observed = cycle
          ? []
          : buckets
              .filter((bucket) => bucket.keys[0] !== null)
              .map((bucket) => metricDateTime(bucket.keys[0]!));
      const range = cycle ? undefined : metricDateRange(
        config,
        {
          ...query,
          select: query.select.map((field) => ({ field })),
        } as QueryState,
        observed,
        now,
        (name) => name,
      );
      const series = new Map(
        buckets
          .filter((bucket) => bucket.keys[0] !== null)
          .map((bucket) => [
            JSON.stringify(bucket.keys.slice(1)),
            bucket.keys.slice(1),
          ]),
      );
      if (keys.length === 1 && !series.size) series.set("[]", []);
      const existing = new Set(
        buckets.map((bucket) => JSON.stringify(bucket.keys)),
      );
      // Every slot of a cycle exists, whatever the date range.
      const slots: MetricValue[] = cycle ? metricCycleSlots(cycle) : [];
      if (range)
        for (
          let time = range[0];
          time <= range[1];
          time = metricDateNext(time, config.interval, config.timeZone)
        )
          slots.push(new Date(time).toISOString());
      for (const slot of slots)
        for (const tuple of series.values()) {
          const values = [slot, ...tuple];
          if (!existing.has(JSON.stringify(values))) {
            if (buckets.length >= this.capabilities.maxGroups)
              throw Error("DuckDB calendar group budget exceeded.");
            buckets.push({
              keys: values,
              count: 0,
              value:
                (!clause.expression &&
                  ["count", "count_distinct", "sum"].includes(clause.op)) ||
                /^(COUNT|COUNT_DISTINCT|SUM)\([^)]*\)$/.test(
                  metricExpression(clause),
                )
                  ? 0
                  : null,
            });
          }
        }
    }
    // Calendar fill-ins (count 0) are never hidden; hidden groups leave the
    // ranking, the group limit and Other.
    let hiddenGroups: number | undefined;
    const min = metricMinCount(clause);
    if (min !== undefined) {
      const kept = buckets.filter((bucket) =>
        metricMinCountKeeps(min, bucket.count, measures.get(bucket)),
      );
      hiddenGroups = buckets.length - kept.length;
      buckets.splice(0, buckets.length, ...kept);
    }
    // Calendar metrics default to chronological order, like the other engines.
    const sort: MetricSort[] = clause.sort?.length
      ? clause.sort
      : clause.dateGrouping
        ? [{ key: "group0", dir: "asc", nulls: "last" }]
        : [{ key: "value", dir: "desc" }];
    buckets.sort((a, b) => {
      for (const term of sort) {
        const value = (bucket: typeof a): MetricValue =>
          term.key.startsWith("group")
            ? (bucket.keys[Number(term.key.slice(5))] ?? null)
            : term.key === "samples"
              ? bucket.distribution?.kind === "box"
                ? (bucket.distribution.summary?.n ?? 0)
                : (bucket.distribution?.n ?? 0)
              : ((bucket as unknown as Record<string, MetricValue>)[term.key] ??
                null);
        const av = value(a),
          bv = value(b);
        if (av === null || bv === null) {
          if (av !== bv)
            return (av === null ? 1 : -1) * (term.nulls === "first" ? -1 : 1);
        } else {
          const result = compareMetricValues(av, bv);
          if (result) return result * (term.dir === "asc" ? 1 : -1);
        }
      }
      return JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys));
    });
    const limit = clause.groupLimit ?? 10000;
    return {
      id: clause.id,
      buckets: buckets.slice(0, limit),
      groupCount: buckets.length,
      coverage: buckets.length > limit ? "partial" : "exact",
      ...(clause.scope ? { scope: clause.scope } : {}),
      ...(hiddenGroups !== undefined ? { hiddenGroups } : {}),
    };
  }
  transport(): Transport<DuckDBRow> {
    return {
      queryCapabilities: this.capabilities,
      metricCapabilities: {
        version: 2,
        expressions: true,
        shownRows: true,
        distributions: true,
        computedFields: this.computed.size > 0,
        filters: true,
        minCount: true,
        minCountMeasures: true,
        profile: DUCKDB_PROFILE,
        maxGroups: this.capabilities.maxGroups,
      },
      fetchQueryV3: (request, signal) => this.execute(request, signal),
      fetchRows: (query, signal) =>
        this.transaction(async (tables) => {
          this.window(query);
          const source = await this.stage(query, Date.now(), tables, signal);
          return this.page(
            source.name,
            this.schema,
            { ...query, where: [] },
            Date.now(),
            signal,
          );
        }, signal),
      fetchMetrics: (query: MetricQuery, signal) => {
        if (
          query.diagnostics.length ||
          (query.profile && query.profile !== DUCKDB_PROFILE) ||
          query.metrics.length > 20
        )
          return Promise.reject(Error("Invalid DuckDB metric request."));
        return this.transaction(async (tables) => {
          const now = Date.now(),
            server = { ...query, select: [] };
          const source = await this.stage(server, now, tables, signal);
          return {
            metrics: await this.metrics(
              source.name,
              this.schema,
              server,
              query.metrics,
              now,
              tables,
              signal,
            ),
          };
        }, signal);
      },
      fetchAggregations: (query, signal) =>
        this.transaction(async (tables) => {
          if (query.diagnostics?.length || query.aggregations.length > 20)
            throw Error("Invalid DuckDB aggregation request.");
          const server = {
              select: [],
              where: query.where,
              orderBy: [],
              limit: 100,
              offset: 0,
            },
            now = Date.now();
          const source = await this.stage(server, now, tables, signal);
          return {
            metrics: await this.metrics(
              source.name,
              this.schema,
              { ...server, where: [] },
              query.aggregations,
              now,
              tables,
              signal,
            ),
          };
        }, signal),
      fetchDistinctValues: (query, signal) =>
        this.serial(async () => {
          const builder = this.builder(),
            field = builder.definition(query.field),
            limit = positive(query.limit, 50, 500);
          if (!isFilterable(field))
            throw Error(`Field ${field.name} is not filterable.`);
          if (query.search.length > 2000)
            throw Error("Distinct search exceeds its budget.");
          const source = this.projectedSource(Date.now()),
            value = builder.field(query.field),
            array = field.type === "textarray";
          builder.args.push(...source.args);
          const param = builder.bind(query.search);
          const rows = await this.run(
            builder.statement(
              `SELECT CAST(value AS VARCHAR) AS value, COUNT(*) AS n FROM (SELECT ${array ? `unnest(${value})` : value} AS value FROM (${source.sql}) r) v WHERE value IS NOT NULL AND contains(lower(CAST(value AS VARCHAR)), lower(${param})) GROUP BY value ORDER BY n DESC, value ASC LIMIT ${limit + 1}`,
            ),
            signal,
          );
          const [{ n }] = (await this.sql(
            `SELECT COUNT(*) AS n FROM (${source.sql}) r WHERE ${array ? `COALESCE(len(${value}),0) = 0` : `${value} IS NULL`}`,
            source.args,
            signal,
          )) as [{ n: number }];
          return {
            values: rows.slice(0, limit).map((row) => String(row.value)),
            hasMore: rows.length > limit,
            hasNull: n > 0,
          };
        }, signal),
      fetchRow: (identity, signal) =>
        this.serial(async () => {
          const source = this.projectedSource(Date.now());
          const rows = await this.sql(
            `SELECT * FROM (${source.sql}) r WHERE ${id(this.schema.idField)} = $${source.args.length + 1} LIMIT 2`,
            [...source.args, identity],
            signal,
          );
          if (rows.length > 1) throw Error("DuckDB identity must be unique.");
          return rows[0] ? this.formatRow(rows[0], this.schema) : null;
        }, signal),
      fetchFieldStats: (fields, signal) =>
        this.serial(async () => {
          if (fields.length > 64)
            throw Error("At most 64 field stats can be requested.");
          const stats: Record<
            string,
            import("@pythia-software/query-table-core").FieldStats
          > = {};
          for (const name of fields) {
            const builder = this.builder(),
              field = builder.definition(name),
              source = this.projectedSource(Date.now()),
              value = builder.field(name);
            const rows = await this.sql(
              field.type === "textarray"
                ? `SELECT COUNT(DISTINCT value) AS "distinct" FROM (SELECT unnest(${value}) AS value FROM (${source.sql}) r)`
                : `SELECT COUNT(DISTINCT ${value}) AS "distinct", MIN(${value}) AS min, MAX(${value}) AS max FROM (${source.sql}) r`,
              source.args,
              signal,
            );
            const result = rows[0]!;
            stats[name] = {
              distinct: result.distinct as number,
              ...(typeof result.min === "number" ||
              typeof result.min === "string"
                ? { min: result.min }
                : {}),
              ...(typeof result.max === "number" ||
              typeof result.max === "string"
                ? { max: result.max }
                : {}),
            };
          }
          return stats;
        }, signal),
    };
  }
}

export function createDuckDBTransport(
  options: DuckDBOptions,
): Transport<DuckDBRow> {
  return new DuckDBBackend(options).transport();
}
