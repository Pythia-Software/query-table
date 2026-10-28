// drilldown.ts — the query behind one metric bucket or one grouped row.
//
// Both helpers return a QueryState that selects exactly the records behind
// what the user clicked, or null when no exact query exists. They never return
// an approximate query: shown-row scopes and synthetic remainders are null.

import { compileFormula } from "./formula";
import { createGroupingModel, exitGrouping, GROUP_ID_FIELD, type GroupedRow } from "./grouping";
import {
  isMetricCycle,
  metricCalendarUnit,
  metricCycleSlot,
  metricCycleSlots,
  metricDateFloor,
  metricDateNext,
  metricDateTime,
} from "./metricDates";
import { MAX_METRIC_WINDOW_PERIODS, metricDateBounds, wholeIntervalSpan } from "./metricSeries";
import { isFilterable, resolveField, type FieldSchema } from "./schema";
import { groupKeyTerms, keyClause } from "./groupKeys";
import type { AggregationBucket } from "./encode";
import { MAX_WHERE_CLAUSES, predicatesOf, type AggregationClause, type QueryState, type WhereTerm } from "./query";
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
 * - An hour-of-day or day-of-week slot selects its occurrences inside the
 *   date field's bounds (whole ones with `occurrence` or whole intervals):
 *   `>= first`, `< last end` and, for each gap between occurrences, an OR
 *   group `< gap start` or `>= gap end`. Without a lower and an upper bound on
 *   the date field, or when the filter would exceed the query's predicate
 *   budget (about 48 occurrences), the result is null.
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
    if (clause.dateGrouping && index === 0 && key !== null && isMetricCycle(clause.dateGrouping.interval)) {
      if (!field || field.type !== "datetime" || !isFilterable(field)) return null;
      const slot = cycleSlotTerms(query, clause, fields, field.name, key);
      if (!slot) return null;
      terms.push(...slot);
      continue;
    }
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
  const where = appendWhereTerms(query.where, terms);
  // A slot's occurrence ranges must fit the query's predicate budget.
  if (isMetricCycle(clause.dateGrouping?.interval) &&
    where.reduce((n, term) => n + predicatesOf(term).length, 0) > MAX_WHERE_CLAUSES) return null;
  return { ...query, where, offset: 0 };
}

/** The records of one cyclic slot as CNF over the date field: the slot's
 * occurrences, clipped to the field's bounds, are disjoint ranges r1…rk, and
 * their union is `>= r1.start`, `< rk.end` and, for each gap, `< ri.end` OR
 * `>= ri+1.start`. Null when unbounded or too many occurrences. */
function cycleSlotTerms(
  query: QueryState,
  clause: AggregationClause,
  schema: FieldSchema,
  field: string,
  key: unknown,
): WhereTerm[] | null {
  const config = clause.dateGrouping!,
    cycle = config.interval;
  if (!isMetricCycle(cycle) || typeof key !== "number" || !metricCycleSlots(cycle).includes(key)) return null;
  const now = Date.now();
  let { lower, upper } = metricDateBounds(clause, query, schema, now);
  // The metric read whole occurrences (or whole intervals) only.
  const whole = config.occurrence
    ? { ...clause, dateGrouping: { ...config, interval: config.occurrence.interval } }
    : config.partialIntervals === "exclude" ? clause : undefined;
  if (whole) {
    const span = wholeIntervalSpan(whole, query, schema, now);
    lower = span.start ?? -Infinity;
    upper = span.end;
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  // Gaps cost two predicates each; leave room for the query's own.
  const budget = Math.floor(MAX_WHERE_CLAUSES / 2);
  const ranges: [number, number][] = [];
  const unit = metricCalendarUnit(cycle);
  for (let start = metricDateFloor(lower, unit, config.timeZone); start < upper; ) {
    const next = metricDateNext(start, unit, config.timeZone);
    if (!Number.isFinite(next) || next <= start) return null;
    if (metricCycleSlot(start, cycle, config.timeZone) === key) {
      const from = Math.max(start, lower), to = Math.min(next, upper);
      const last = ranges[ranges.length - 1];
      if (from < to) {
        // Adjacent intervals of one slot (a repeated DST hour) merge.
        if (last && last[1] === from) last[1] = to;
        else if (ranges.push([from, to]) > budget) return null;
      }
    }
    start = next;
  }
  const iso = (time: number) => new Date(time).toISOString();
  if (!ranges.length)
    return [
      { field, op: ">=", value: iso(lower) },
      { field, op: "<", value: iso(lower) },
    ];
  const terms: WhereTerm[] = [
    { field, op: ">=", value: iso(ranges[0]![0]) },
    { field, op: "<", value: iso(ranges[ranges.length - 1]![1]) },
  ];
  for (let i = 0; i + 1 < ranges.length; i++)
    terms.push({ any: [
      { field, op: "<", value: iso(ranges[i]![1]) },
      { field, op: ">=", value: iso(ranges[i + 1]![0]) },
    ] });
  return terms;
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
