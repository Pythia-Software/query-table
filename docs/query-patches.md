# Query patches

A query patch is a partial `QueryState` that owns selected parts of a query: a
saved filter set, a column layout, a grouped report. Hosts apply patches over the
user's current query, show whether each one is still in effect, and remove them
without discarding the user's own edits. The functions are pure core helpers: no
React, storage or UI.

```ts
import { applyPatch, matchPatch, removePatch, type QueryPatch } from "@pythia-software/query-table-core";

const openWork: QueryPatch = {
  id: "open-work",
  owns: ["filters", "order"],
  query: {
    where: [{ field: "status", op: "=", value: "open" }],
    orderBy: [{ field: "due", dir: "asc" }],
  },
};

table.setQuery(q => applyPatch(q, openWork, { replacing: previousPatch }));
matchPatch(table.query, openWork); // { status: "active" | "modified" | "inactive", modified }
table.setQuery(q => removePatch(q, openWork));
```

## Facets

| Facet | Record-stage patch | Group-stage patch |
| --- | --- | --- |
| `filters` | record WHERE | record WHERE (`grouping.source.where`) |
| `grouping` | ungrouped | keys, summaries, representative row and HAVING |
| `columns` | record `select` | grouped `select` |
| `order` | record `orderBy` | grouped `orderBy` |
| `limit` | record `limit` | grouped `limit` |
| `metrics` | record `aggregations` | grouped `aggregations` |

A patch is a group-stage patch when `patch.query.grouping` is set. Its
`query.where` is HAVING and its filters are `query.grouping.source.where`; the
rest of `grouping.source` is ignored. Otherwise `query.where` holds its filters.

While a query is grouped, its record stage is `grouping.source`: a record-stage
patch that owns `columns` edits the layout restored when grouping ends, not the
grouped table. Group-stage `columns`, `order`, `limit` and `metrics` have no
target on an ungrouped query unless the patch also owns `grouping`; they are then
skipped by `applyPatch` and never match.

`limit` has no neutral value without a schema. A patch that owns `limit` without
a `query.limit` is treated as not owning it.

## applyPatch

`applyPatch(query, patch, { replacing })`:

1. With `replacing`, first runs `removePatch(query, replacing)`.
2. Owned `grouping` is replaced. A group-stage patch enters grouping through
   `withGroupingKeys`, the transition the grouping controls use, or re-keys an
   existing stage (which clears group metrics, as the controls do). Summaries,
   representative row and HAVING are then replaced. If summaries change, grouped
   columns and sorts on them are dropped and group metrics cleared. A record-stage
   patch that owns `grouping` leaves grouping via `exitGrouping`.
3. Owned `filters` are additive: patch terms not already structurally present are
   appended. Terms are never removed by applying.
4. Owned `columns`, `order`, `limit` and `metrics` are replaced.
5. `offset` resets to 0 (also in the source snapshot while grouped).

Facets the patch does not own are untouched.

## Structural filter matching

Terms are compared after normalization by field, operator, value (ignored for
`is_null`/`is_not_null`) and negation. OR-group members, and the predicates of
an `{ all: [...] }` branch, are unordered.
Set-filter presentation metadata is ignored.

A patch's filters are split into units. An OR group (of predicates or of
conjunctions) is one unit, a run of
consecutive `!=` terms on one field (an exclusion list) is one unit, and every
other term is its own unit. A unit is present when all of its terms are present.
Removal removes only units that are fully present, and then every term
structurally equal to one of their terms. If the user deletes one exclusion from
a run, the remaining exclusions are left alone.

Filters carry no provenance. A user-authored term structurally equal to a patch
term is treated as the patch's. Other user terms are never removed.

### Why not provenance?

Tagging terms with an origin (for example `WhereTerm.origin`) would let the user
and a patch own identical terms separately. It would also change normalization,
URL encoding, saved queries, every server validator and the filter editor. For
the presets this API targets, a duplicate term owned by both has the same
meaning, so structural matching gives the same results with no wire-format
change. If provenance becomes necessary, keep it client-only and strip it before
transport, so servers and shared links are unaffected.

## matchPatch

Both queries are normalized (`normalizeQueryState`). Column widths,
`fitToScreen`, labels (metric and summary), metric `display`/`layout` and metric
IDs are ignored. Metrics compare as an unordered set. Group keys, summary IDs
and their order are significant.

Each owned facet matches when:

- `filters`: every unit is present. Extra user filters are allowed.
- `grouping`: both are ungrouped, or keys, summaries, representative row and the
  set of HAVING terms are equal.
- `columns`: the target stage's `select` field sequence is equal.
- `order`, `limit`, `metrics`: the target stage's values are equal.

The status is:

- `active`: every owned facet matches (a patch that owns nothing is active).
- `modified`: some owned facet differs, but the patch is still recognizable,
  meaning at least one owned facet matches, or at least one of its filter units
  is still present. An owned `filters` facet with no terms matches trivially and
  does not make a patch recognizable. `modified` lists the facets that differ.
- `inactive`: otherwise. `modified` is empty.

## removePatch

`removePatch(query, patch)` removes the patch's fully present filter units. Each
other owned facet that still matches the patch is reset: `columns` and `order`
to `[]` (schema defaults), `metrics` to none, and `grouping` exited. Facets the
user has changed since, and `limit`, are left alone. `offset` resets to 0.
