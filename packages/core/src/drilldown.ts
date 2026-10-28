// drilldown.ts — the query behind one metric bucket or one grouped row.
//
// Both helpers return a QueryState that selects exactly the records behind
// what the user clicked, or null when no exact query exists. They never return
// an approximate query: shown-row scopes and synthetic remainders are null.

import { compileFormula } from "./formula";
import { createGroupingModel, exitGrouping, GROUP_ID_FIELD, type GroupedRow } from "./grouping";
import { metricDateFloor, metricDateNext, metricDateTime } from "./metricDates";
import { MAX_METRIC_WINDOW_PERIODS, wholeIntervalSpan } from "./metricSeries";
import { isFilterable, resolveField, type FieldSchema } from "./schema";
import { groupKeyTerms, keyClause } from "./groupKeys";
import type { AggregationBucket } from "./encode";
import type { AggregationClause, QueryState, WhereTerm } from "./query";
import { appendWhereTerms } from "./queryPatch";

/** Metrics over a grouped query read the group schema. Accept either that
 * schema or the source schema it is derived from. */
function metricSchema(query: QueryState, schema: FieldSchema): FieldSchema {
  if (!query.grouping || schema.idField === GROUP_ID_FIELD) return schema;
  return createGroupingModel(schema).resultSchema(query.grouping.keys, query.grouping.summaries);
}

function distributionActive(clause: AggregationClause): boolean {
  return !!clause.distribution && (!clause.display || clause.display.kind === "box" || clause.display.kind === "histogram");
}

/** The query selecting the records behind one metric bucket, or null when no
 * exact query exists.
 *
 * - Each `clause.groupBy` key adds `=`; a null key adds `is_null` (legacy
 *   aggregates already place empty text in that bucket).
 * - A date-grouped key becomes `>= start` and `< next`, using the clause's
 *   interval and timezone. A windowed point starts at its window's first
 *   interval, or has no lower bound for a running value.
 * - A histogram bin (`bucket.bin`) adds `>= min` and `< max` (`<= max` for
 *   the final bin) on the distribution input, which must be a field reference.
 *   Box cohorts are their group keys.
 * - The clause's own `where` is added first, so the records match the metric's
 *   population. Groups hidden by `minCount` have no bucket to inspect.
 * - Over a grouped query the filters are HAVING terms on the group rows.
 * - `scope: "shownRows"`, a remainder bucket (keys that do not match the
 *   grouping) and keys on fields that cannot be filtered return null.
 *
 * Existing terms are kept, duplicates are not added and the offset resets. */
export function inspectBucketQuery(
  query: QueryState,
  bucket: AggregationBucket,
  clause: AggregationClause,
  schema: FieldSchema,
): QueryState | null {
  if (clause.scope === "shownRows" || bucket.keys.length !== clause.groupBy.length) return null;
  const fields = metricSchema(query, schema);
  const terms: WhereTerm[] = [...(clause.where ?? [])];
  for (const [index, name] of clause.groupBy.entries()) {
    const field = resolveField(fields, name);
    const key = bucket.keys[index] ?? null;
    if (clause.dateGrouping && index === 0 && key !== null) {
      if (!field || field.type !== "datetime" || !isFilterable(field)) return null;
      let start: number;
      try {
        start = metricDateTime(key);
      } catch {
        return null;
      }
      const { interval, timeZone, partialIntervals } = clause.dateGrouping;
      const next = metricDateNext(start, interval, timeZone);
      // A windowed point reads its trailing intervals; a running one, every
      // interval from the start of the range.
      let from: number | undefined = start;
      const periods = clause.window?.periods;
      if (periods === "all") from = undefined;
      else if (periods !== undefined) {
        if (!Number.isInteger(periods) || periods < 2 || periods > MAX_METRIC_WINDOW_PERIODS) return null;
        for (let i = 1; i < periods; i++) from = metricDateFloor(from! - 1, interval, timeZone);
      }
      if (partialIntervals === "exclude") {
        const whole = wholeIntervalSpan(clause, query, fields, Date.now()).start;
        if (whole !== undefined) from = Math.max(from ?? whole, whole);
      }
      if (from !== undefined) terms.push({ field: field.name, op: ">=", value: new Date(from).toISOString() });
      terms.push({ field: field.name, op: "<", value: new Date(next).toISOString() });
      continue;
    }
    const term = keyClause(field, key);
    if (!term) return null;
    terms.push(term);
  }
  if (bucket.bin) {
    const { min, max, inclusiveMax } = bucket.bin;
    if (!distributionActive(clause) || clause.distribution!.kind !== "histogram" || !Number.isFinite(min) || !Number.isFinite(max) || max < min)
      return null;
    let input;
    try {
      input = compileFormula(clause.distribution!.input, fields.fields).ast;
    } catch {
      return null;
    }
    const field = input.kind === "field" ? resolveField(fields, input.name) : undefined;
    if (!field || field.type !== "number" || !isFilterable(field)) return null;
    terms.push(
      { field: field.name, op: ">=", value: String(min) },
      { field: field.name, op: inclusiveMax ? "<=" : "<", value: String(max) },
    );
  }
  return { ...query, where: appendWhereTerms(query.where, terms), offset: 0 };
}

/** The record query behind one grouped row, or null when the query is not
 * grouped or a key cannot be matched exactly (textarray, unknown or
 * unfilterable fields, unparseable datetimes).
 *
 * Starts from the grouping source, as leaving the grouping stage does, so its
 * WHERE, columns, order and item details are kept. Each key adds `=` (or
 * `is_null` for a null key) and the offset resets. */
export function groupSourceQuery(query: QueryState, group: GroupedRow, schema: FieldSchema): QueryState | null {
  if (!query.grouping) return null;
  const terms = groupKeyTerms(query.grouping.keys, group, schema);
  if (!terms) return null;
  const source = exitGrouping(query);
  return { ...source, where: appendWhereTerms(source.where, terms), offset: 0 };
}
