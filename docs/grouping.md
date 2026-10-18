# Row-producing grouping

Grouping is part of the core query model, the headless React controller, and the
standard query editor. It produces one table row per key tuple. It supports one
GROUP BY stage, optional HAVING, aggregate columns (including supported formulas
such as `MEDIAN([duration])`), and one optional representative row per group.

## Integration

For a complete local dataset, grouping is available by default:

```tsx
const table = useQueryTable({ schema, clientRows: allRows });

<QueryBuilder api={table} fields={table.schema!.fields} />
<DataTable
  fields={table.visibleFields}
  rows={table.rows}
  query={table.query}
  onQueryChange={table.setQuery}
  rowId={table.rowId}
/>
<MetricsPanel api={table} aggregations={table.aggregations} fields={table.schema!.fields} />
```

Pass `grouping: false` to disable it. Fields follow the schema's existing
`aggregate.groupable`, `aggregate.measure`, `aggregate.ops`, select and sort
capabilities. No demo-specific fields or named representative strategies are
required. `QueryBuilder` supplies grouping controls unless the host overrides
its `clauses` slot.

Grouped rows are flat projections; they are not instances of the source record
type. Use `table.schema`, `table.visibleFields`, and `table.rowId` when rendering.
For code consuming arbitrary grouped values, use core's `GroupedRow` and the
explicitly typed `prepareGrouping` result. Inline source-row renderer functions
are not inherited by projected fields; named renderer registrations can be
reused if they render the supplied value without assuming a source-row shape.
Record item-detail controls are hidden on groups and restored when grouping is
removed. Independent source inspectors can use `table.grouping.source.itemDetails`.

## Query shape and execution order

The active query describes the result. Its `where` is HAVING while grouping is
active; the source WHERE is `grouping.source.where`:

```ts
const groupedQuery = normalizeQueryState({
  grouping: {
    source: originalQuery,
    keys: ["customer"],
    summaries: [
      { id: "run_count", op: "count" },
      { id: "median_duration", op: "formula", expression: "MEDIAN([duration])" },
      { id: "example_name", op: "row", field: "name" },
    ],
    representative: {
      orderBy: [{ field: "created_at", dir: "desc", nulls: "last" }],
    },
  },
  select: ["customer", "run_count", "median_duration", "example_name"].map(field => ({ field })),
  where: [{ field: "run_count", op: ">=", value: "10" }],
  orderBy: [{ field: "median_duration", dir: "desc" }],
  limit: 25,
  offset: 0,
});
```

Execution is source WHERE → grouping → HAVING → result ORDER BY → result
OFFSET/LIMIT. Source paging and sorting do not truncate the group population.
All-matching metrics operate on groups after HAVING; shown-row metrics operate
on the displayed group page. Source metrics remain in the source snapshot so
leaving grouped mode restores their original meaning.

`applyQuery` executes grouped queries. `applyAggregations` and `evaluateMetrics`
can evaluate metrics over them. `prepareGrouping(rows, sourceSchema, grouping)`
returns `{ inputs, rows, schema }`; apply the result query with
`withoutGrouping(query)` to avoid grouping twice. A core evaluation captures one
clock for relative source and result predicates.

The React controller shares that clock across source WHERE, HAVING, previews and
committed metrics until the grouped source is recomputed or refreshed. Paging
keeps the same source population. Shown-row metrics preserve the table's stable
ordering when sort values tie. Grouped metrics always use typed reductions,
including shorthand `op`/`field` definitions, so null and empty-text group keys
remain distinct in both the table and its metrics. Type-preserving projections
(representative fields and MIN/MAX) retain explicit host `aggregate.groupable`
settings, including opt-in calendar grouping of datetime values.

All ROW projections come from the same representative, including its null
values. Ordering is lexicographic, with independent null placement per field.
Source ID descending breaks ties unless ID is explicitly ordered. Representative
selection requires unique string or finite numeric source IDs within each group;
the ID need not be a selectable catalogue field. There is no separate filter
or second representative strategy.

## State, saved views, and authoring

`QueryState.grouping` travels through normal normalization, URL encoding (`?q=`),
StorageAdapters, sharing, and undo/redo. Existing row queries need no migration.
Reset restores the loaded/saved baseline. Removing the last grouping key restores
the source query. Readding the same keys can restore the previous group layout
when the source is unchanged; loading or saving another view clears that cache.
The source snapshot includes record columns, metrics, paging and item details.

The same transitions are pure core functions: `withGroupingKeys(query, keys)`
enters, re-keys or (with no keys) leaves the stage, and `exitGrouping(query)`
returns the source snapshot. `groupSourceQuery(query, groupRow, schema)` drills
from one grouped row to its records: it starts from `exitGrouping(query)`, keeps
the source WHERE, columns, order and item details, adds `=` per key (`is_null`
for a null key, ISO instants for datetimes), and resets the offset. It returns
`null` for ungrouped queries and for `textarray`, unknown or unfilterable keys.

Headless controls are exposed through `table.grouping`: `changeKeys`,
`addSummary`, `changeSummary`, `applyColumns`, and `changeRepresentative`.
`table.grouping.source` exposes source-stage query/filter controls; normal
`table.addFilter` edits HAVING in grouped mode. Structural changes are single
undoable query edits. Changes to a representative rule clear dependent
row-value filters, sorts and metrics. Aggregate-only consumers remain intact.

The shared column workbench uses field-first selection, aggregate formulas,
resizable/closable panels, a function library and live previews. KEY, aggregate,
and ROW badges appear only while grouping. All role colors use the library's
[client palette tokens](../packages/ui/README.md#client-palettes-and-column-roles).

## Link columns

A link column turns each group row into a way into the rows behind it, or into
a different view of them. It is a summary column with `op: "link"`:

```ts
interface LinkSpec {
  label: string | { column: string };  // static text, or a key / summary value
  to:
    | { kind: "template"; template: string }  // "/repos/{field:repo}"
    | {
        kind: "query";
        target: string;                  // a key of the host's linkTargets
        base?: "source" | "empty";       // default "source" (grouping.source)
        keyFilters?: boolean;            // default true: = / is_null per key
        patch?: QueryPatch;              // applied last, with applyPatch
        params?: Record<string, string>; // passed to the host target
      };
}
```

For example, a table of tool calls grouped by `tool`, where each tool's name
opens its failing calls in the host's triage layout:

```tsx
const failing: QueryPatch = {
  id: "failing",
  owns: ["filters", "columns"],
  query: {
    where: [{ field: "status", op: "=", value: "error" }],
    select: [{ field: "started_at" }, { field: "repo" }, { field: "error" }],
  },
};

const query: QueryState = {
  ...withGroupingKeys(callsQuery, ["tool"]),
  grouping: {
    source: callsQuery,
    keys: ["tool"],
    representative: null,
    summaries: [
      { id: "calls", op: "count" },
      { id: "failure_rate", op: "formula", label: "Failure rate",
        expression: 'AVG(IF([status] = "error", 1, 0))' },
      { id: "open", op: "link", label: "Tool", link: {
        label: { column: "tool" },
        to: { kind: "query", target: "triage", patch: failing, params: { lens: "triage" } },
      } },
    ],
  },
  select: [{ field: "open" }, { field: "calls" }, { field: "failure_rate" }],
};

const linkTargets: LinkTargets = {
  // query-table composes the query; the host owns routing.
  triage: (query, params) => `/calls?lens=${params.lens}&q=${encodeQuery(query)}`,
};

<DataTable
  fields={table.visibleFields}
  rows={table.rows}
  query={table.query}
  onQueryChange={table.setQuery}
  rowId={table.rowId}
  renderers={defaultRenderers}
  linkTargets={linkTargets}
  onNavigate={(href) => { router.push(href); return true; }}
/>
```

The `apply_patch` row links to the source query (its WHERE, columns and order),
plus `tool = "apply_patch"` and then the `failing` patch. That is
`groupSourceQuery` followed by `applyPatch`. A null key adds `is_null`, and
datetime keys are compared as ISO instants. `base: "empty"` starts from
`EMPTY_QUERY` instead, and `keyFilters: false` leaves the keys out. A template
link, such as `{ kind: "template", template: "/library/{field:repo}" }`, uses
the same `{field:name}` placeholders as item pages, over keys and non-link
summaries. Substituted values are percent-encoded.

- Cells are real `<a href>` elements. `onNavigate(href, event)` is only called
  for unmodified primary clicks. When it returns `true`, the default action is
  prevented. Modifier clicks, middle clicks and "open in new tab" keep native
  behavior. Without `onNavigate` links navigate normally.
- Every href goes through `safeLinkHref`. Blocked or unresolvable links (an
  empty template value, a key that cannot be matched exactly, an unregistered
  target, a route that throws) render as muted text whose title explains why.
- Problems in the definition (an unknown label column or placeholder, an
  invalid template, `keyFilters` over a `textarray` or unfilterable key, a
  malformed spec) are reported by `table.grouping.diagnostics` and
  `model.linkDiagnostics(definition)`. They never block the grouped table.
  Targets the host has not registered are reported when rendering.
- Link cells are computed on the client from the returned group row.
  `toQueryRequestV3` strips them from the grouping it sends. Go, SQLite,
  PostgreSQL and DuckDB executors never see `op: "link"`, but the keys and
  summaries a link reads are always requested.
- Link columns cannot be sorted, used in HAVING or measured. They are absent
  from the sort, filter and metric pickers.
- Link specs travel with the query: normalization, `?q=` links, saved queries
  and snapshot links. A malformed spec is kept as an invalid column instead of
  being partly applied. A link's patch cannot itself contain link columns.
- `groupLinkQuery(query, value)` and `resolveGroupLink(query, value, targets)`
  expose the same composition for custom renderers. The cell value is a
  `GroupLinkValue`, and `createGroupLinkRenderer` is the renderer `DataTable`
  uses.

The column editor lists link columns with their destination and can reorder
and remove them. Hosts author link columns through the API; the editor has no
form for creating them.

Link columns are group-grain only. At row grain, use a derived field with a
named renderer; registry renderers receive the current query:

```tsx
// In the schema:
{
  name: "similar",
  label: "Similar calls",
  type: "text",
  source: { kind: "derived", dependencies: ["tool"] },
  render: "similar_calls",
}

// In the renderers passed to DataTable:
const renderers: RenderRegistry<Call> = {
  ...defaultRenderers,
  similar_calls: ({ row, query }) => {
    const similar = { ...query, offset: 0,
      where: [...query.where, { field: "tool", op: "=", value: row.tool }] };
    const href = safeLinkHref(`/calls?q=${encodeQuery(similar)}`);
    return href ? <a href={href}>{row.tool}</a> : row.tool;
  },
};
```

## Current execution boundary

Remote row-producing grouping executes through a negotiated `fetchQueryV3`
transport. Local grouping accepts `clientRows` already available in memory. The Go
`QueryDatasetV3` adapter executes groups and metrics in SQLite/PostgreSQL.
Unextended v1/v2 transports still reject grouping before fetching. Passing a
server page as `clientRows` does not make it complete. There is no bulk-download
fallback for unsupported remote queries. Backend draft previews
use the same versioned executor. See the
[host integration guide](host-integration-next-release.md) for setup, budgets,
source dependency planning and simultaneous-checkout development.

There are no nested stages, joins, arbitrary SQL, or calendar bucketing of table
rows. Canonical computed keys, formulas, predicates and representative ordering
use the host's healthy capability/revision envelope. Backend source filtering
requires the independent `ComputedFilterable` allowlist. Complete local sources
can supply approved materialized canonical fields; ordinary unapproved computed
predicates remain disabled. SQLite source regex predicates use its bounded RE2
profile; PostgreSQL/local grouping retain rejection. Regex aggregate formulas
require isolated execution and are not enabled here.
Ordinary supported aggregate formulas use the same compiler, reductions, numeric
checks and null semantics as the metric engine. Datetime reductions return ISO
instants. Group keys preserve scalar types and distinguish null from empty text.

Definitions allow up to 20 keys, 64 summary columns and eight representative sort
fields. Local evaluation bounds source rows, groups, key sizes, retained grouping
memory and formula operations; exceeding a bound reports an error. Malformed or
nested grouping remains in query state with diagnostics rather than silently
turning into an ungrouped query. Host validation and server authorization remain
the host's responsibility, as with ordinary queries.

`/grouping` is a showcase of these standard components. It imports compatible
older prototype saved views into the standard storage format once and retains
the original prototype keys and unreadable backups. Old `?view=` links remain
readable; newly shared links use the standard `?q=` format.
