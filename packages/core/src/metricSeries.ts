// metricSeries.ts — trailing windows, running values, shares and whole
// intervals, computed from ordinary metrics so every engine supports them.
//
// A window's value is the metric evaluated over every row in the window. Its
// aggregates are rebuilt from per-interval parts: SUM, COUNT, MIN and MAX merge
// across intervals and AVG is SUM / COUNT, so SUM([a]) / SUM([b]) pools its
// parts instead of averaging interval ratios. COUNT_DISTINCT and MEDIAN do not
// merge and are refused rather than approximated. A share divides by the same
// measure grouped by fewer keys, so groups beyond `groupLimit` still count.

import { FormulaError, type FormulaPlan, type FormulaResult } from "./formula";
import type { AggregationBucket, AggregationResultEntry } from "./encode";
import {
  compareMetricValues,
  compileMetric,
  evaluateMetricReductions,
  metricExpression,
  sortMetricBuckets,
  validateMetric,
  type MetricPlan,
} from "./metrics";
import {
  metricCustomEndTime,
  metricDateFloor,
  metricDateNext,
  metricDateTime,
} from "./metricDates";
import { assertMetricNumber } from "./metricPrecision";
import type { MetricDateGrouping, MetricValue } from "./metricTypes";
import { coerceValue } from "./ops";
import {
  isOrGroup,
  MAX_AGGREGATIONS,
  type AggregationClause,
  type QueryState,
  type WhereTerm,
} from "./query";
import { resolveFieldName, type FieldSchema } from "./schema";

export const MAX_METRIC_WINDOW_PERIODS = 1000;
const MERGEABLE = ["SUM", "COUNT", "MIN", "MAX", "AVG"];
type Merge = "SUM" | "COUNT" | "MIN" | "MAX";

/** Whether a clause needs planMetricSeries before an engine can run it. */
export function hasMetricSeries(c: AggregationClause): boolean {
  return (
    c.window !== undefined ||
    c.share !== undefined ||
    c.dateGrouping?.partialIntervals !== undefined
  );
}

// An aggregate cannot nest, so a root aggregate call is the whole metric.
const soleAggregate = (plan: MetricPlan): string | undefined =>
  plan.ast.kind === "call" && plan.aggregates.includes(plan.ast)
    ? plan.ast.name
    : undefined;

// Engine queries one window or share needs: the expressions each grouping
// reduces, before identical texts are merged.
const partBudget = (c: AggregationClause, plan: MetricPlan) =>
  (c.window && (c.window.reduce ?? "total") === "total"
    ? plan.aggregates.reduce((n, node) => n + (node.name === "AVG" ? 2 : 1), 0)
    : 1) * (c.share ? 2 : 1);

/** Throws when a clause's window or share cannot be computed exactly. */
export function validateMetricSeries(
  c: AggregationClause,
  plan: FormulaPlan,
): void {
  const { window, share } = c;
  if (!window && share === undefined) return;
  if (!("aggregates" in plan) || c.display?.kind === "scatter")
    throw new FormulaError(
      "Windows and shares apply to single-value metrics, not distributions or scatters.",
    );
  const metric = plan as MetricPlan,
    sole = soleAggregate(metric);
  if (window) {
    if (!c.dateGrouping)
      throw new FormulaError(
        "A window needs a calendar interval on the first grouping field.",
      );
    if (!c.dateGrouping.includeEmpty)
      throw new FormulaError(
        "A window spans every interval, including empty ones: include empty dates.",
      );
    const { periods, reduce = "total", partial = "omit" } = window;
    if (
      periods !== "all" &&
      !(
        Number.isInteger(periods) &&
        periods >= 2 &&
        periods <= MAX_METRIC_WINDOW_PERIODS
      )
    )
      throw new FormulaError(
        "A window covers 2–1,000 intervals, or all of them.",
      );
    if (
      !["total", "mean"].includes(reduce) ||
      !["omit", "include"].includes(partial)
    )
      throw new FormulaError("Invalid metric window.");
    if (reduce === "mean") {
      if (!sole || !["SUM", "COUNT", "COUNT_DISTINCT"].includes(sole))
        throw new FormulaError(
          "A mean per interval needs a single SUM, COUNT or COUNT_DISTINCT; it would weight each interval's ratio or average equally. A window total pools them instead.",
        );
    } else
      for (const node of metric.aggregates)
        if (!MERGEABLE.includes(node.name))
          throw new FormulaError(
            node.name === "COUNT_DISTINCT"
              ? "A window total cannot combine COUNT_DISTINCT across intervals, because one value can occur in several. Use a mean per interval."
              : `A window total cannot combine ${node.name} across intervals.`,
            node.from,
            node.to,
          );
  }
  if (share !== undefined) {
    if (share !== "total" && share !== "group0")
      throw new FormulaError("Invalid metric share.");
    if (sole !== "SUM" && sole !== "COUNT")
      throw new FormulaError(
        "A share divides additive totals: use a single SUM or COUNT. Distinct counts, averages and ratios do not add up across groups.",
      );
    if (share === "group0" ? c.groupBy.length < 2 : !c.groupBy.length)
      throw new FormulaError(
        share === "group0"
          ? "A share within the first grouping needs a second grouping field."
          : "A share of the total needs a grouping field.",
      );
    if (share === "total" && window)
      throw new FormulaError(
        "A windowed share divides by each interval's own total: share within the first grouping.",
      );
  }
  if (partBudget(c, metric) > MAX_AGGREGATIONS)
    throw new FormulaError(
      `A window or share runs one metric per aggregate; this one needs more than ${MAX_AGGREGATIONS}.`,
    );
}

/** The whole intervals inside the conjunctive bounds on the date field (the
 * query's and the metric's own), ending by `now`: [start, end). */
export function wholeIntervalSpan(
  c: AggregationClause,
  query: QueryState,
  schema: FieldSchema,
  now: number,
): { start?: number; end: number } {
  const { field, interval, timeZone } = c.dateGrouping!;
  const canonical = (name: string) => resolveFieldName(schema, name) ?? name;
  let lower = -Infinity,
    upper = Infinity;
  for (const term of [...query.where, ...(c.where ?? [])]) {
    if (
      isOrGroup(term) ||
      term.negated ||
      canonical(term.field) !== canonical(field) ||
      !["=", ">", ">=", "<", "<="].includes(term.op)
    )
      continue;
    // An empty value is no filter yet, and a malformed one fails where the
    // filter runs; neither bounds the intervals.
    if (term.value === "") continue;
    let time: number;
    try {
      time = Number(coerceValue("datetime", term.value, now));
    } catch {
      continue;
    }
    if (!Number.isFinite(time)) continue;
    if (term.op === ">" || term.op === ">=" || term.op === "=")
      lower = Math.max(lower, time + (term.op === ">" ? 1 : 0));
    if (term.op === "<" || term.op === "<=" || term.op === "=")
      upper = Math.min(upper, time + (term.op === "<" ? 0 : 1));
  }
  const floor = (time: number) => metricDateFloor(time, interval, timeZone);
  const end = floor(Math.min(upper, now));
  if (!Number.isFinite(lower)) return { end };
  const first = floor(lower);
  return {
    start: first === lower ? lower : metricDateNext(first, interval, timeZone),
    end,
  };
}

export interface MetricSeriesOptions {
  /** The evaluation clock: intervals ending after it are partial. */
  now?: number;
  resolveComputed?: (name: string) => FormulaPlan | undefined;
}
export interface MetricSeriesPlan {
  /** Plain metric queries within the metric budget. A clause's parts always
   * share one query, so they read one population. */
  queries: QueryState[];
  /** The requested clauses' results, in request order, from the metric
   * results of every query. */
  combine(results: readonly AggregationResultEntry[]): AggregationResultEntry[];
}

type Reduction =
  | { name: Merge; part: number }
  | { name: "AVG"; sum: number; count: number };
type Prepared =
  | { kind: "error"; clause: AggregationClause; error: string }
  | { kind: "empty"; clause: AggregationClause }
  | { kind: "plain"; clause: AggregationClause; parts: [AggregationClause] }
  | {
      kind: "series";
      clause: AggregationClause;
      plan: MetricPlan;
      parts: AggregationClause[];
      /** Window totals rebuild each aggregate from parts, by position. */
      reductions?: Reduction[];
      size: number;
    };

/** Expand clauses with a window, a share or whole intervals into plain
 * metrics, or return undefined when no clause has them.
 *
 * - **Window.** Each point is the metric over the rows of its trailing
 *   intervals (`reduce: "total"`), or the mean of their per-interval values
 *   (`reduce: "mean"`), with the window's row count. Points whose window starts
 *   before the first interval have no value unless `partial: "include"`.
 * - **Share.** Each bucket divided by the total of its first grouping key, or
 *   of every group. With a window, both are windowed first.
 * - **Whole intervals.** `partialIntervals: "exclude"` narrows the metric to
 *   the intervals the query bounds and `now` leave whole.
 *
 * `sort`, `groupLimit` and `minCount` (counting a window's rows) apply to the
 * combined buckets. Windowed and share results have no Other remainder. */
export function planMetricSeries(
  query: QueryState,
  schema: FieldSchema,
  options: MetricSeriesOptions = {},
): MetricSeriesPlan | undefined {
  const clauses = query.aggregations ?? [];
  if (!clauses.some(hasMetricSeries)) return undefined;
  const now = options.now ?? Date.now();
  const taken = new Set(clauses.map((c) => c.id));
  let next = 0;
  const id = () => {
    let value: string;
    do value = `qt-series-${next++}`;
    while (taken.has(value));
    return value;
  };
  const prepared = clauses.map((c): Prepared => {
    if (!hasMetricSeries(c)) return { kind: "plain", clause: c, parts: [c] };
    // A clause that cannot be planned fails alone, never the whole batch.
    try {
      return prepare(c);
    } catch (e) {
      return {
        kind: "error",
        clause: c,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  function prepare(c: AggregationClause): Prepared {
    const issue = validateMetric(c, schema, options.resolveComputed)[0];
    if (issue) return { kind: "error", clause: c, error: issue.message };
    let where = c.where ?? [];
    let dateGrouping: MetricDateGrouping | undefined;
    if (c.dateGrouping) {
      const { partialIntervals, ...config } = c.dateGrouping;
      dateGrouping = config;
      if (partialIntervals === "exclude") {
        const span = wholeIntervalSpan(c, query, schema, now);
        if (span.start !== undefined && span.end <= span.start)
          return { kind: "empty", clause: c };
        const field = resolveFieldName(schema, config.field) ?? config.field;
        const iso = (time: number) => new Date(time).toISOString();
        where = [
          ...where,
          ...(span.start !== undefined
            ? [{ field, op: ">=", value: iso(span.start) } as WhereTerm]
            : []),
          { field, op: "<", value: iso(span.end) },
        ];
        // Completion would otherwise refill the partial intervals as empty.
        if (config.includeEmpty && config.range !== "observed") {
          const floor = (time: number) =>
            metricDateFloor(time, config.interval, config.timeZone);
          let from = span.start,
            through = span.end - 1;
          if (config.range === "custom") {
            const start = floor(
              metricDateTime(config.start ?? "", config.timeZone),
            );
            from = Math.max(from ?? start, start);
            through = Math.min(
              through,
              metricCustomEndTime(config.end ?? "", config.timeZone),
            );
          }
          if (from !== undefined) {
            if (through < from) return { kind: "empty", clause: c };
            dateGrouping = {
              ...config,
              range: "custom",
              start: iso(from),
              end: iso(through),
            };
          }
        }
      }
    }
    const scoped = (groupBy: string[]): Partial<AggregationClause> => ({
      ...(c.scope ? { scope: c.scope } : {}),
      ...(where.length ? { where } : {}),
      ...(dateGrouping && groupBy.length ? { dateGrouping } : {}),
    });
    if (!c.window && c.share === undefined) {
      const {
        dateGrouping: _date,
        where: _where,
        scope: _scope,
        ...rest
      } = c;
      return {
        kind: "plain",
        clause: c,
        parts: [{ ...rest, id: id(), ...scoped(c.groupBy) }],
      };
    }
    const source = metricExpression(
      c.expression === undefined && c.field
        ? { ...c, field: resolveFieldName(schema, c.field) ?? c.field }
        : c,
    );
    const plan = compileMetric(source, schema, options.resolveComputed);
    const texts: string[] = [];
    const at = (text: string) => {
      const index = texts.indexOf(text);
      return index < 0 ? texts.push(text) - 1 : index;
    };
    let reductions: Reduction[] | undefined;
    if (c.window && (c.window.reduce ?? "total") === "total")
      reductions = plan.aggregates.map((node): Reduction => {
        const text = source.slice(node.from, node.to);
        if (node.name !== "AVG") return { name: node.name as Merge, part: at(text) };
        const input = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
        return { name: "AVG", sum: at(`SUM(${input})`), count: at(`COUNT(${input})`) };
      });
    else at(source);
    const parts = (groupBy: string[]) =>
      texts.map(
        (text): AggregationClause => ({
          id: id(),
          // The whole legacy measure keeps its operation, so v1 servers run it.
          ...(text === source && c.expression === undefined
            ? { op: c.op, ...(c.field ? { field: c.field } : {}) }
            : { op: "count" as const, expression: text }),
          groupBy,
          ...scoped(groupBy),
        }),
      );
    return {
      kind: "series",
      clause: c,
      plan,
      parts: [
        ...parts(c.groupBy),
        ...(c.share === "group0"
          ? parts(c.groupBy.slice(0, 1))
          : c.share === "total"
            ? parts([])
            : []),
      ],
      ...(reductions ? { reductions } : {}),
      size: texts.length,
    };
  }
  const queries: QueryState[] = [];
  let batch: AggregationClause[] = [];
  for (const item of prepared) {
    if (item.kind === "error" || item.kind === "empty") continue;
    if (batch.length + item.parts.length > MAX_AGGREGATIONS) {
      queries.push({ ...query, aggregations: batch });
      batch = [];
    }
    batch.push(...item.parts);
  }
  if (batch.length) queries.push({ ...query, aggregations: batch });
  return {
    queries,
    combine(results) {
      const byId = new Map(results.map((r) => [r.id, r]));
      return prepared.map((item): AggregationResultEntry => {
        const c = item.clause;
        if (item.kind === "error")
          return { id: c.id, buckets: [], error: item.error };
        if (item.kind === "empty")
          return {
            id: c.id,
            buckets: [],
            scope: c.scope ?? "allMatching",
            groupCount: 0,
            coverage: "exact",
          };
        const entries = item.parts.map(
          (part) =>
            byId.get(part.id) ?? {
              id: part.id,
              buckets: [],
              error: "Server omitted this metric.",
            },
        );
        if (item.kind === "plain") return { ...entries[0]!, id: c.id };
        try {
          return combineSeries(item, entries);
        } catch (e) {
          return {
            id: c.id,
            buckets: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      });
    },
  };
}

// One part's buckets, per series tuple, by interval position.
type Track = (AggregationBucket | undefined)[];

class Accumulator {
  private total = 0;
  private seen = false;
  private best: MetricValue = null;
  error: string | undefined;
  constructor(private readonly name: Merge) {}
  add(bucket: AggregationBucket | undefined): void {
    if (!bucket || this.error) return;
    if (bucket.error) {
      this.error = bucket.error;
      return;
    }
    const value = bucket.value;
    if (value === null) return;
    if (this.name === "SUM" || this.name === "COUNT") {
      if (typeof value !== "number") {
        this.error = `${this.name} returned a non-numeric value.`;
        return;
      }
      this.total += value;
      this.seen = true;
    } else if (
      this.best === null ||
      compareMetricValues(value, this.best) * (this.name === "MIN" ? 1 : -1) < 0
    )
      this.best = value;
  }
  result(): FormulaResult {
    if (this.error) return { value: null, error: this.error };
    if (this.name === "MIN" || this.name === "MAX") return { value: this.best };
    return { value: this.name === "COUNT" || this.seen ? this.total : null };
  }
}

function combineSeries(
  item: Extract<Prepared, { kind: "series" }>,
  entries: AggregationResultEntry[],
): AggregationResultEntry {
  const c = item.clause,
    window = c.window;
  for (const entry of entries) {
    if (entry.error) throw Error(entry.error);
    if (
      entry.coverage === "partial" ||
      (entry.groupCount ?? entry.buckets.length) > entry.buckets.length
    )
      throw Error(
        "A window or share needs every group, but the engine returned only some of them.",
      );
  }
  const numerator = entries.slice(0, item.size),
    denominator = c.share ? entries.slice(item.size) : [];
  // Calendar positions: includeEmpty supplies every interval of the range.
  // Rows without a date have a null first key and no calendar position.
  const dateOf = (keys: MetricValue[]) =>
    keys[0] === null || keys[0] === undefined ? undefined : keys[0];
  const times = new Map<MetricValue, number>();
  if (window)
    for (const entry of entries)
      for (const bucket of entry.buckets) {
        const date = dateOf(bucket.keys);
        if (date !== undefined && !times.has(date))
          times.set(date, metricDateTime(date));
      }
  const order = [...times.entries()].sort((a, b) => a[1] - b[1]);
  const position = new Map(order.map(([date], index) => [date, index]));
  const positionOf = (keys: MetricValue[]) => {
    const date = dateOf(keys);
    return date === undefined ? undefined : position.get(date);
  };
  const tracks = (part: AggregationResultEntry) => {
    const byTail = new Map<string, Track>();
    for (const bucket of part.buckets) {
      const at = positionOf(bucket.keys);
      if (at === undefined) continue;
      const tail = JSON.stringify(bucket.keys.slice(1));
      const track =
        byTail.get(tail) ?? Array<AggregationBucket | undefined>(order.length);
      track[at] = bucket;
      byTail.set(tail, track);
    }
    return byTail;
  };
  const exact = (part: AggregationResultEntry) =>
    new Map(
      part.buckets.map((bucket) => [JSON.stringify(bucket.keys), bucket]),
    );
  const numeratorTracks = numerator.map(tracks),
    denominatorTracks = denominator.map(tracks);
  const numeratorBuckets = numerator.map(exact),
    denominatorBuckets = denominator.map(exact);

  type Point = {
    value: MetricValue;
    count: number;
    error?: string;
    intervals?: number;
  };
  const checked = (result: FormulaResult, count: number): Point => {
    if (!result.error && typeof result.value === "number")
      try {
        assertMetricNumber(result.value);
      } catch (e) {
        result = { value: null, error: (e as Error).message };
      }
    return result.error
      ? { value: null, count, error: result.error }
      : { value: result.value as MetricValue, count };
  };
  // The metric over some buckets of each part: one window, or one bucket.
  const evaluate = (
    members: (AggregationBucket | undefined)[][],
    mean: boolean,
  ): Point => {
    const own = members[0]!,
      count = own.reduce((n, bucket) => n + (bucket?.count ?? 0), 0);
    if (item.reductions) {
      const reduce = (name: Merge, part: number) => {
        const accumulator = new Accumulator(name);
        for (const bucket of members[part]!) accumulator.add(bucket);
        return accumulator.result();
      };
      const reductions = item.reductions.map((r): FormulaResult => {
        if (r.name !== "AVG") return reduce(r.name, r.part);
        const sum = reduce("SUM", r.sum),
          rows = reduce("COUNT", r.count);
        if (sum.error || rows.error)
          return { value: null, error: (sum.error ?? rows.error)! };
        return {
          value:
            sum.value === null || !rows.value
              ? null
              : Number(sum.value) / Number(rows.value),
        };
      });
      return checked(evaluateMetricReductions(item.plan, reductions), count);
    }
    if (!mean)
      return own[0]?.error
        ? { value: null, count, error: own[0].error }
        : checked({ value: own[0]?.value ?? null }, count);
    // SUM, COUNT and COUNT_DISTINCT of an empty interval are 0.
    let total = 0;
    for (const bucket of own) {
      if (bucket?.error) return { value: null, count, error: bucket.error };
      if (bucket?.value === null || bucket?.value === undefined) continue;
      if (typeof bucket.value !== "number")
        return { value: null, count, error: "Expected a numeric metric value." };
      total += bucket.value;
    }
    return checked({ value: total / own.length }, count);
  };
  const periods = window?.periods === "all" ? Infinity : (window?.periods ?? 1);
  const point = (
    keys: MetricValue[],
    tracksOf: Map<string, Track>[],
    bucketsOf: Map<string, AggregationBucket>[],
  ): Point => {
    const at = positionOf(keys);
    // Without a window, or for rows without a date, a bucket is its own point.
    if (!window || at === undefined)
      return evaluate(
        bucketsOf.map((parts) => [parts.get(JSON.stringify(keys))]),
        false,
      );
    const from = Math.max(0, at - periods + 1),
      intervals = at - from + 1,
      tail = JSON.stringify(keys.slice(1));
    const members = tracksOf.map((byTail) => {
      const track = byTail.get(tail);
      return Array.from({ length: intervals }, (_, i) => track?.[from + i]);
    });
    const result = evaluate(members, window.reduce === "mean");
    return intervals < periods &&
      periods !== Infinity &&
      (window.partial ?? "omit") === "omit"
      ? { value: null, count: result.count, intervals }
      : { ...result, intervals };
  };
  const keyed = new Map<string, MetricValue[]>();
  for (const entry of numerator)
    for (const bucket of entry.buckets)
      keyed.set(JSON.stringify(bucket.keys), bucket.keys);
  let buckets = [...keyed.values()].map((keys): AggregationBucket => {
    const own = point(keys, numeratorTracks, numeratorBuckets);
    let { value } = own,
      error = own.error;
    if (c.share && !error) {
      const total = c.share === "group0" ? keys.slice(0, 1) : [];
      const whole = point(total, denominatorTracks, denominatorBuckets);
      error = whole.error;
      value =
        error ||
        typeof value !== "number" ||
        typeof whole.value !== "number" ||
        whole.value === 0
          ? null
          : value / whole.value;
    }
    return {
      keys,
      value: error ? null : value,
      count: own.count,
      ...(error ? { error } : {}),
      ...(own.intervals !== undefined ? { intervals: own.intervals } : {}),
    };
  });
  let hiddenGroups: number | undefined;
  if (c.minCount !== undefined) {
    const kept = buckets.filter(
      (b) => b.count === 0 || b.count >= c.minCount!,
    );
    hiddenGroups = buckets.length - kept.length;
    buckets = kept;
  }
  sortMetricBuckets(buckets, c);
  const groupCount = buckets.length;
  if (c.groupLimit) buckets = buckets.slice(0, c.groupLimit);
  const first = entries[0]!;
  return {
    id: c.id,
    buckets,
    scope: first.scope ?? c.scope ?? "allMatching",
    ...(first.processedRows !== undefined
      ? { processedRows: first.processedRows }
      : {}),
    groupCount,
    coverage: "exact",
    ...(hiddenGroups !== undefined ? { hiddenGroups } : {}),
  };
}
