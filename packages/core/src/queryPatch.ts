// queryPatch.ts — apply, recognise and remove partial queries ("patches").
//
// A host keeps reusable presets (a saved filter set, a column layout, a
// grouped report) as patches. Each patch owns some facets of a QueryState and
// leaves the others alone. Filters are additive and identified structurally:
// there is no provenance on WHERE terms, so a term the user typed that is
// structurally identical to a patch term is indistinguishable from it. See
// docs/query-patches.md for the full contract.

import { exitGrouping, withGroupingKeys, type GroupingState, type SummaryColumn } from "./grouping";
import { NULLARY_OPS } from "./ops";
import {
  isWhereConjunction,
  isWhereGroup,
  normalizeQueryState,
  type AggregationClause,
  type QueryState,
  type WhereBranch,
  type WhereClause,
  type WhereTerm,
} from "./query";

export type QueryFacet = "filters" | "columns" | "order" | "grouping" | "metrics" | "limit";

export interface QueryPatch {
  /** Host identity for the patch; not interpreted. */
  id: string;
  /** Facets this patch controls. Facets not listed are never touched. */
  owns: QueryFacet[];
  /** Values for the owned facets. A `grouping` value makes this a group-stage
   *  patch: its `where` is HAVING and its filters are `grouping.source.where`. */
  query: Partial<QueryState>;
}

export interface QueryPatchMatch {
  status: "active" | "modified" | "inactive";
  /** Owned facets that differ; only populated when `status` is "modified". */
  modified: QueryFacet[];
}

export interface ApplyPatchOptions {
  /** A previously applied patch to remove first (see `removePatch`). */
  replacing?: QueryPatch;
}

// ---- structural WHERE helpers (shared with drilldown) -----------------------

function clauseKey(clause: WhereClause): string {
  return JSON.stringify([
    clause.field,
    clause.op,
    NULLARY_OPS.has(clause.op) ? "" : clause.value,
    clause.negated === true,
  ]);
}

/** Structural identity of one WHERE term. OR-group members and the literals
 *  of a conjunction branch are unordered, and presentation metadata (set-filter
 *  identity) is ignored. */
export function whereTermKey(term: WhereTerm): string {
  if (!isWhereGroup(term)) return clauseKey(term);
  const branchKey = (member: WhereBranch) =>
    isWhereConjunction(member) ? `all:${JSON.stringify(member.all.map(clauseKey).sort())}` : clauseKey(member);
  return `any:${JSON.stringify(term.any.map(branchKey).sort())}`;
}

/** Append terms that are not already structurally present. */
export function appendWhereTerms(where: readonly WhereTerm[], terms: readonly WhereTerm[]): WhereTerm[] {
  const present = new Set(where.map(whereTermKey));
  const out = [...where];
  for (const term of terms) {
    const key = whereTermKey(term);
    if (present.has(key)) continue;
    present.add(key);
    out.push(term);
  }
  return out;
}

/** Owned units: each OR group (of literals or conjunctions) or literal alone, except that a run of
 *  consecutive `!=` literals on one field (an exclusion list) is one unit. */
function filterUnits(where: readonly WhereTerm[]): WhereTerm[][] {
  const units: WhereTerm[][] = [];
  for (const term of where) {
    const last = units[units.length - 1];
    const previous = last?.[last.length - 1];
    if (
      last && previous && !isWhereGroup(term) && !isWhereGroup(previous) &&
      term.op === "!=" && previous.op === "!=" && term.field === previous.field
    )
      last.push(term);
    else units.push([term]);
  }
  return units;
}

function unitPresent(unit: readonly WhereTerm[], present: ReadonlySet<string>): boolean {
  return unit.every((term) => present.has(whereTermKey(term)));
}

function removeUnits(where: readonly WhereTerm[], units: readonly WhereTerm[][]): WhereTerm[] {
  const present = new Set(where.map(whereTermKey));
  const remove = new Set(
    units.filter((unit) => unitPresent(unit, present)).flatMap((unit) => unit.map(whereTermKey)),
  );
  return where.filter((term) => !remove.has(whereTermKey(term)));
}

function sameTermSet(a: readonly WhereTerm[], b: readonly WhereTerm[]): boolean {
  const keys = (where: readonly WhereTerm[]) => JSON.stringify(where.map(whereTermKey).sort());
  return keys(a) === keys(b);
}

// ---- patch interpretation ---------------------------------------------------

interface PatchGrouping {
  keys: string[];
  summaries: SummaryColumn[];
  representative: GroupingState["representative"];
  having: WhereTerm[];
}

interface PatchParts {
  owns: Set<QueryFacet>;
  stage: "records" | "groups";
  filters: WhereTerm[];
  units: WhereTerm[][];
  grouping: PatchGrouping | null;
  select: QueryState["select"];
  orderBy: QueryState["orderBy"];
  limit: number | undefined;
  aggregations: AggregationClause[];
}

function patchParts(patch: QueryPatch): PatchParts {
  const raw = patch.query ?? {};
  const normalized = normalizeQueryState(raw);
  const stage = normalized.grouping ? "groups" : "records";
  const filters = normalized.grouping ? normalized.grouping.source.where : normalized.where;
  const owns = new Set(patch.owns);
  // A limit has no neutral value without the schema; an absent one is not owned.
  if (typeof raw.limit !== "number") owns.delete("limit");
  return {
    owns,
    stage,
    filters,
    units: filterUnits(filters),
    grouping: normalized.grouping
      ? {
          keys: normalized.grouping.keys,
          summaries: normalized.grouping.summaries,
          representative: normalized.grouping.representative,
          having: normalized.where,
        }
      : null,
    select: normalized.select,
    orderBy: normalized.orderBy,
    limit: typeof raw.limit === "number" ? normalized.limit : undefined,
    aggregations: normalized.aggregations ?? [],
  };
}

const recordStage = (query: QueryState): QueryState => query.grouping?.source ?? query;

function withRecordStage(query: QueryState, next: QueryState): QueryState {
  return query.grouping ? { ...query, grouping: { ...query.grouping, source: next } } : next;
}

/** Columns, order, limit and metrics address the stage the patch was written
 * for: the record query (the source snapshot while grouped) for record-stage
 * patches, the grouped result for group-stage patches. */
function stageOf(query: QueryState, stage: PatchParts["stage"]): QueryState | undefined {
  if (stage === "records") return recordStage(query);
  return query.grouping ? query : undefined;
}

function withStage(query: QueryState, stage: PatchParts["stage"], update: (stage: QueryState) => QueryState): QueryState {
  if (stage === "records") return withRecordStage(query, update(recordStage(query)));
  return query.grouping ? update(query) : query;
}

function withAggregations(query: QueryState, aggregations: AggregationClause[]): QueryState {
  const { aggregations: _previous, ...rest } = query;
  return aggregations.length ? { ...rest, aggregations } : rest;
}

const clone = <T>(value: T): T => structuredClone(value);

// ---- comparison -------------------------------------------------------------

const summaryMeaning = ({ id, op, field, expression, link }: SummaryColumn) =>
  JSON.stringify(op === "link" ? [id, op, link ?? null] : [id, op, field, expression]);

function summarySignature(summaries: readonly SummaryColumn[]): string {
  return JSON.stringify(summaries.map(summaryMeaning));
}

/** JSON with object keys sorted at every depth; array order is kept. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function metricSignature(metric: AggregationClause): string {
  const { id: _id, label: _label, display: _display, layout: _layout, ...rest } = metric;
  return canonicalJson(rest);
}

function facetMatches(query: QueryState, parts: PatchParts, facet: QueryFacet): boolean {
  switch (facet) {
    case "filters": {
      const present = new Set(recordStage(query).where.map(whereTermKey));
      return parts.units.every((unit) => unitPresent(unit, present));
    }
    case "grouping": {
      const grouping = query.grouping;
      if (!parts.grouping || !grouping) return !parts.grouping && !grouping;
      return (
        JSON.stringify(grouping.keys) === JSON.stringify(parts.grouping.keys) &&
        summarySignature(grouping.summaries) === summarySignature(parts.grouping.summaries) &&
        JSON.stringify(grouping.representative) === JSON.stringify(parts.grouping.representative) &&
        sameTermSet(query.where, parts.grouping.having)
      );
    }
    case "columns": {
      const stage = stageOf(query, parts.stage);
      return !!stage && JSON.stringify(stage.select.map((c) => c.field)) === JSON.stringify(parts.select.map((c) => c.field));
    }
    case "order": {
      const stage = stageOf(query, parts.stage);
      return !!stage && JSON.stringify(stage.orderBy) === JSON.stringify(parts.orderBy);
    }
    case "limit": {
      const stage = stageOf(query, parts.stage);
      return !!stage && stage.limit === parts.limit;
    }
    case "metrics": {
      const stage = stageOf(query, parts.stage);
      const signatures = (metrics: readonly AggregationClause[]) => JSON.stringify(metrics.map(metricSignature).sort());
      return !!stage && signatures(stage.aggregations ?? []) === signatures(parts.aggregations);
    }
  }
}

/** Compare a query with a patch. Both are normalized first; column widths,
 * `fitToScreen`, labels, metric display/layout and metric IDs are ignored.
 *
 * - `active`: every owned facet matches.
 * - `modified`: some owned facet differs, but the patch is still recognizable:
 *   at least one owned facet matches (an owned `filters` facet with no terms
 *   does not count), or at least one of its filter units is still present.
 * - `inactive`: otherwise. */
export function matchPatch(query: QueryState, patch: QueryPatch): QueryPatchMatch {
  const normalized = normalizeQueryState(query);
  const parts = patchParts(patch);
  const owned = [...parts.owns];
  const modified = owned.filter((facet) => !facetMatches(normalized, parts, facet));
  if (!modified.length) return { status: "active", modified: [] };
  const present = new Set(recordStage(normalized).where.map(whereTermKey));
  const recognizable =
    owned.some((facet) => !modified.includes(facet) && (facet !== "filters" || parts.units.length > 0)) ||
    (parts.owns.has("filters") && parts.units.some((unit) => unitPresent(unit, present)));
  return recognizable ? { status: "modified", modified } : { status: "inactive", modified: [] };
}

// ---- application ------------------------------------------------------------

function resetOffsets(query: QueryState): QueryState {
  return query.grouping
    ? { ...query, offset: 0, grouping: { ...query.grouping, source: { ...query.grouping.source, offset: 0 } } }
    : { ...query, offset: 0 };
}

function applyGrouping(query: QueryState, grouping: PatchGrouping | null): QueryState {
  if (!grouping) return exitGrouping(query);
  const before = query.grouping;
  // Enter or re-key through the same transition the grouping controls use.
  const keyed = before && JSON.stringify(before.keys) === JSON.stringify(grouping.keys)
    ? query
    : withGroupingKeys(query, grouping.keys);
  const previous = keyed.grouping!;
  const summaries = clone(grouping.summaries);
  // Result columns, sorts and metrics over replaced aggregates lose their meaning.
  const kept = new Set(summaries.map(summaryMeaning));
  const changed = new Set(previous.summaries.filter((column) => !kept.has(summaryMeaning(column))).map((column) => column.id));
  const next: QueryState = {
    ...keyed,
    grouping: { ...previous, summaries, representative: clone(grouping.representative) },
    where: clone(grouping.having),
    select: keyed.select.filter((c) => !changed.has(c.field)),
    orderBy: keyed.orderBy.filter((term) => !changed.has(term.field)),
  };
  return changed.size ? withAggregations(next, []) : next;
}

/** Remove a patch: its filter units that are still fully present are removed;
 * each other owned facet that still matches the patch is reset (columns and
 * order to the schema defaults, metrics to none, grouping exited). Facets the
 * user has since changed, and `limit`, are left alone. Resets offsets to 0. */
export function removePatch(query: QueryState, patch: QueryPatch): QueryState {
  const parts = patchParts(patch);
  const matches = (facet: QueryFacet) => parts.owns.has(facet) && facetMatches(normalizeQueryState(query), parts, facet);
  const reset = {
    columns: matches("columns"),
    order: matches("order"),
    metrics: matches("metrics"),
    grouping: matches("grouping"),
  };
  let next = query;
  if (parts.owns.has("filters")) {
    const records = recordStage(next);
    next = withRecordStage(next, { ...records, where: removeUnits(records.where, parts.units) });
  }
  next = withStage(next, parts.stage, (stage) => {
    let out = stage;
    if (reset.columns) out = { ...out, select: [] };
    if (reset.order) out = { ...out, orderBy: [] };
    if (reset.metrics) out = withAggregations(out, []);
    return out;
  });
  if (reset.grouping) next = exitGrouping(next);
  return resetOffsets(next);
}

/** Apply a patch. Facets it does not own are untouched. Owned non-filter
 * facets are replaced; owned filters are additive: units already present are
 * not duplicated and user-authored terms are never removed. With `replacing`,
 * that patch is first removed with `removePatch`. Resets offsets to 0. */
export function applyPatch(query: QueryState, patch: QueryPatch, options: ApplyPatchOptions = {}): QueryState {
  let next = options.replacing ? removePatch(query, options.replacing) : query;
  const parts = patchParts(patch);
  if (parts.owns.has("grouping")) next = applyGrouping(next, parts.grouping);
  if (parts.owns.has("filters")) {
    const records = recordStage(next);
    next = withRecordStage(next, { ...records, where: appendWhereTerms(records.where, clone(parts.filters)) });
  }
  next = withStage(next, parts.stage, (stage) => {
    let out = stage;
    if (parts.owns.has("columns")) out = { ...out, select: clone(parts.select) };
    if (parts.owns.has("order")) out = { ...out, orderBy: clone(parts.orderBy) };
    if (parts.owns.has("limit")) out = { ...out, limit: parts.limit ?? out.limit };
    if (parts.owns.has("metrics")) out = withAggregations(out, clone(parts.aggregations));
    return out;
  });
  return resetOffsets(next);
}
