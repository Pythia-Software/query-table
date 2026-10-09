import {
  predicatesOf,
  normalizeQueryState,
  type QueryState,
  type RowId,
} from "./query";
import { toServerQuery, type ServerQuery } from "./encode";
import {
  isComputedField,
  type ComputedExecution,
  type RowComputedValues,
} from "./computed";
import { selectedFields, type FieldSchema } from "./schema";
import type { MetricDiagnostic } from "./metricTypes";
/** Versioned row projection keeps server-computed payload separate from host row fields. */
export interface ServerQueryV2 extends ServerQuery {
  version: 2;
  profile: string;
  expectedRevisions: Record<string, string>;
  planToken?: string;
  /** Host must enforce this binding against the row response. */
  snapshot?: string;
  diagnostics: MetricDiagnostic[];
}
export interface FetchRowsResultV2<Row> {
  version: 2;
  rows: Row[];
  total: number;
  computed: { id: RowId; values: RowComputedValues }[];
  execution: ComputedExecution;
}
/** Project with a previously resolved server capability envelope. This does not
 * authorize definitions or upload their source; the backend revalidates revisions. */
export function toServerQueryV2<Row>(
  q: QueryState,
  schema: FieldSchema<Row>,
  execution: ComputedExecution,
): ServerQueryV2 {
  const normalized = normalizeQueryState(q),
    legacy = toServerQuery(normalized, schema);
  const diagnostics: MetricDiagnostic[] = [];
  const expectedRevisions = Object.create(null) as Record<string, string>;
  const requireField = (
    name: string,
    operation: "select" | "sort",
  ): boolean => {
    const cap = execution.fields[name];
    const revision =
      execution.resolvedRevisions[name] ??
      execution.resolvedRevisions[name.slice("@computed/".length)];
    if (!cap?.[operation] || !revision) {
      diagnostics.push({
        code: "unsupported_computed",
        message: `Computed field ${name} is unavailable for ${operation}.`,
        from: 0,
        to: 1,
      });
      return false;
    }
    return true;
  };
  for (const [key, value] of Object.entries(execution.resolvedRevisions)) {
    if (
      key.length > 256 ||
      typeof value !== "string" ||
      !value ||
      value.length > 256
    )
      throw Error("Invalid computed revision envelope.");
    expectedRevisions[key] = value;
  }
  const select = [...legacy.select];
  for (const c of normalized.select.length
    ? normalized.select
    : selectedFields(schema, normalized).map((f) => ({ field: f.name })))
    if (
      isComputedField(c.field) &&
      execution.fields[c.field]?.select &&
      requireField(c.field, "select")
    )
      select.push(c.field);
  // Retain unsupported clauses in state; gate execution using the server envelope.
  const orderBy: ServerQuery["orderBy"] = [];
  for (const term of normalized.orderBy.length
    ? normalized.orderBy
    : (schema.defaultSort ?? [])) {
    if (isComputedField(term.field)) {
      if (requireField(term.field, "sort")) {
        if ((term.dir !== "asc" && term.dir !== "desc") || term.extract) {
          diagnostics.push({
            code: "unsupported_computed_sort",
            message: "Invalid computed sort or extraction.",
            from: 0,
            to: 1,
          });
          continue;
        }
        orderBy.push({
          field: term.field,
          dir: term.dir,
          ...(term.nulls === "first" || term.nulls === "last"
            ? { nulls: term.nulls }
            : {}),
        });
      }
    } else {
      const projected = toServerQuery(
        { ...normalized, orderBy: [term] },
        schema,
      ).orderBy;
      if (!projected.length)
        diagnostics.push({
          code: "unsupported_sort",
          message: `Unavailable server sort: ${term.field}.`,
          from: 0,
          to: 1,
        });
      orderBy.push(...projected);
    }
  }
  // The host appends its configured tie-break terms and stable identity. An
  // identity term here would take precedence over the host's ordering.
  if (
    legacy.where.length !== normalized.where.length ||
    q.where.reduce((n, t) => n + predicatesOf(t).length, 0) !==
      normalized.where.reduce((n, t) => n + predicatesOf(t).length, 0)
  )
    diagnostics.push({
      code: "residual_filter",
      message:
        "Global execution is unavailable with residual client-only filters.",
      from: 0,
      to: 1,
    });
  return {
    ...legacy,
    select: [...new Set(select)].sort(),
    orderBy,
    version: 2,
    profile: execution.profile,
    expectedRevisions,
    ...(execution.planToken ? { planToken: execution.planToken } : {}),
    ...(execution.snapshot !== undefined
      ? { snapshot: execution.snapshot }
      : {}),
    diagnostics,
  };
}
