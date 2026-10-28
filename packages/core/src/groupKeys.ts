// groupKeys.ts — grouping keys and the exact predicates selecting one group.
//
// Shared by `groupSourceQuery` (drilldown) and query-kind link columns, so a
// link's key filters are exactly the filters drilling into the group adds.

import { isFilterable, resolveField, type FieldDef, type FieldSchema } from "./schema";
import type { WhereClause } from "./query";
import type { MetricCalendarInterval } from "./metricTypes";
import { metricDateFloor, metricDateNext, metricDateTime } from "./metricDates";

/** Calendar intervals a grouping key can bucket a datetime field by. */
export const GROUP_KEY_INTERVALS: readonly MetricCalendarInterval[] = ["hour", "day", "week", "month", "year"];

/** A grouping key that buckets a datetime field by calendar interval: one
 * group per interval, keyed by the interval's start as an ISO instant. The
 * result column is named after the field. Intervals follow the metric
 * calendar (`dateGrouping`), including daylight-saving changes; weeks start
 * on Monday. */
export interface CalendarGroupKey {
  field: string;
  interval: MetricCalendarInterval;
  /** IANA timezone identifier; omitted means UTC. */
  timeZone?: string;
}
/** A field name (group by its exact value) or a calendar key. */
export type GroupKey = string | CalendarGroupKey;

export function isCalendarGroupKey(key: GroupKey): key is CalendarGroupKey {
  return typeof key === "object" && key !== null;
}

/** The source field a key reads; also the name of its result column. */
export function groupKeyField(key: GroupKey): string {
  return isCalendarGroupKey(key) ? key.field : key;
}

/** Result column names, in key order. */
export function groupKeyFields(keys: readonly GroupKey[]): string[] {
  return keys.map(groupKeyField);
}

/** The calendar key on `field`, if that key buckets by interval. */
export function calendarGroupKey(keys: readonly GroupKey[], field: string): CalendarGroupKey | undefined {
  return keys.find((key): key is CalendarGroupKey => isCalendarGroupKey(key) && key.field === field);
}

/** Read a calendar key's value: the start of the interval a source value falls
 * in, as an ISO instant, or null for a null value. Reuses the last interval,
 * so dense timestamps do not repeat timezone work. */
export function calendarKeyReader(key: CalendarGroupKey): (value: unknown) => string | null {
  let start = Infinity, end = -Infinity, iso = "";
  return (value) => {
    if (value == null) return null;
    const input = value instanceof Date ? value.toISOString() : value;
    if (typeof input !== "string")
      throw Error(`Calendar group key ${key.field} needs ISO dates or timestamps with a timezone.`);
    const time = metricDateTime(input, key.timeZone);
    if (time < start || time >= end) {
      start = metricDateFloor(time, key.interval, key.timeZone);
      end = metricDateNext(start, key.interval, key.timeZone);
      iso = new Date(start).toISOString();
    }
    return iso;
  };
}

/** Filters accept datetimes as ISO instants with an explicit offset. */
export function datetimeValue(value: unknown): string | null {
  const time =
    value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
    : typeof value === "string" && value !== "" ? Date.parse(value)
    : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** One equality (or `is_null`) predicate selecting a group key, or null when
 * the field cannot express it exactly. */
export function keyClause(field: FieldDef | undefined, value: unknown): WhereClause | null {
  if (!field || field.type === "textarray" || !isFilterable(field)) return null;
  if (value == null) return { field: field.name, op: "is_null", value: "" };
  if (field.type === "datetime") {
    const iso = datetimeValue(value);
    return iso === null ? null : { field: field.name, op: "=", value: iso };
  }
  if (typeof value === "number" ? !Number.isFinite(value) : typeof value !== "string" && typeof value !== "boolean")
    return null;
  return { field: field.name, op: "=", value: String(value) };
}

/** `>= start` and `< end` selecting one calendar key's interval (or `is_null`
 * for its null group), or null when the field cannot express it exactly. */
export function calendarKeyClauses(field: FieldDef | undefined, key: CalendarGroupKey, value: unknown): WhereClause[] | null {
  if (!field || field.type !== "datetime" || !isFilterable(field)) return null;
  if (value == null) return [{ field: field.name, op: "is_null", value: "" }];
  const iso = datetimeValue(value);
  if (iso === null) return null;
  const start = Date.parse(iso), end = metricDateNext(start, key.interval, key.timeZone);
  if (!Number.isFinite(end) || end <= start) return null;
  return [
    { field: field.name, op: ">=", value: iso },
    { field: field.name, op: "<", value: new Date(end).toISOString() },
  ];
}

/** `=` (or `is_null`) per key, in key order, or null when any key cannot be
 * matched exactly (textarray, unknown or unfilterable fields, unparseable
 * datetimes). A calendar key adds `>= start` and `< end` for its interval. */
export function groupKeyTerms(keys: readonly GroupKey[], group: Record<string, unknown>, schema: FieldSchema): WhereClause[] | null {
  const terms: WhereClause[] = [];
  for (const key of keys) {
    const name = groupKeyField(key);
    const field = resolveField(schema, name);
    if (isCalendarGroupKey(key)) {
      const range = calendarKeyClauses(field, key, group[name]);
      if (!range) return null;
      terms.push(...range);
      continue;
    }
    const term = keyClause(field, group[name]);
    if (!term) return null;
    terms.push(term);
  }
  return terms;
}
