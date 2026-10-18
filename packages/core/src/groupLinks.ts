// groupLinks.ts — compose and route group-grain link columns.
//
// A link column's cell value (`GroupLinkValue`) carries everything that
// depends on the group row. These helpers combine it with the current query
// and the host's routes. Query-table owns composing the query; the host owns
// turning it into a URL.

import { exitGrouping, type GroupLinkValue, type SummaryColumn } from "./grouping";
import { EMPTY_QUERY, type QueryState } from "./query";
import { appendWhereTerms, applyPatch } from "./queryPatch";

/** Host routes for query-kind links, keyed by `LinkSpec.to.target`. Each
 * returns an href; it is safety-checked before rendering. */
export type LinkTargets = Record<string, (query: QueryState, params: Record<string, string>) => string>;

export interface ResolvedGroupLink {
  label: string;
  /** Not yet safety-checked; null when the link cannot be followed. */
  href: string | null;
  problem?: string;
}

/** Link columns are computed on the client. Server requests carry only the
 * keys and summaries they read. */
export function withoutLinkSummaries(summaries: readonly SummaryColumn[]): SummaryColumn[] {
  return summaries.filter((column) => column.op !== "link");
}

/** The query a query-kind link opens, or null for template links, invalid
 * links and ungrouped queries.
 *
 * Starts from `grouping.source` (or `EMPTY_QUERY` for `base: "empty"`), adds
 * the group's key predicates unless `keyFilters` is false, resets the offset
 * and finally applies the link's patch. With the defaults this is
 * `groupSourceQuery` followed by the patch. */
export function groupLinkQuery(query: QueryState, value: GroupLinkValue): QueryState | null {
  const to = value.to;
  if (!query.grouping || to?.kind !== "query" || value.problem) return null;
  const base = to.base === "empty" ? structuredClone(EMPTY_QUERY) : exitGrouping(query);
  if (to.keyFilters !== false && !value.terms) return null;
  const filtered: QueryState = { ...base, where: appendWhereTerms(base.where, value.terms ?? []), offset: 0 };
  return to.patch ? applyPatch(filtered, to.patch) : filtered;
}

/** Resolve a link cell to its label and href. Unregistered targets, failing
 * routes and unresolvable values return `href: null` with a `problem`. */
export function resolveGroupLink(query: QueryState, value: GroupLinkValue, targets: LinkTargets = {}): ResolvedGroupLink {
  const unresolved = (problem: string): ResolvedGroupLink => ({ label: value.label, href: null, problem });
  if (value.problem) return unresolved(value.problem);
  if (value.to?.kind === "template") return value.href ? { label: value.label, href: value.href } : unresolved("Invalid link.");
  if (value.to?.kind !== "query") return unresolved("Invalid link definition.");
  const route = Object.prototype.hasOwnProperty.call(targets, value.to.target) ? targets[value.to.target] : undefined;
  if (typeof route !== "function") return unresolved(`Link target "${value.to.target}" is not registered.`);
  const destination = groupLinkQuery(query, value);
  if (!destination) return unresolved("This group cannot be matched exactly.");
  try {
    const href = route(destination, { ...value.to.params });
    return typeof href === "string" && href.trim() ? { label: value.label, href } : unresolved(`Link target "${value.to.target}" returned no URL.`);
  } catch (error) {
    return unresolved(`Link target "${value.to.target}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
