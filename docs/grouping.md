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

HAVING predicates use the same operators as WHERE, including their NULL
behavior: `!=` is SQL `<>` on the server backends, so a group whose summary is
NULL (for example `AVG` over only NULL values) does not match `avg != 0`. Add
an `is_null` predicate in an OR group to keep such groups, or `is_not_null` to
drop them explicitly; see [`!=` and NULL](../README.md#the-contracts-at-a-glance).

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

### Median and other formula summaries

`SummaryOp` intentionally has no `"median"`: the built-in ops mirror the
backend `AggOp` matrix (`count`, `count_distinct`, `sum`, `avg`, `min`, `max`)
plus `row`. Medians, percent-of-total ratios and conditional counts are formula
summaries that use the [aggregate formula language](metrics.md):

```ts
{ id: "median_duration", op: "formula", expression: "MEDIAN([duration])", label: "Median duration" }
```

`MEDIAN` ignores NULLs and averages the middle two values for even-sized
groups. Normalization reports `op: "median"` as a diagnostic that points to this
form. Summary ids must differ from source field names (including the group
keys); for example, use `median_duration` rather than `duration`.

### Summary column formats

A summary column can carry the same [`CellDisplay`](cell-displays.md) contract
as `FieldDef.display`. Use it for rates and durations instead of scaling values
by hand:

```ts
summaries: [
  { id: "failure_rate", op: "formula",
    expression: "SUM(IF([failed], 1, 0)) / COUNT()",
    display: { kind: "percent", decimals: 1 } },  // 0.0743 → 7.4%
  { id: "p50_ms", op: "formula", expression: "MEDIAN([duration])",
    display: { kind: "duration", sourceUnit: "milliseconds" } },
]
```

The grouped schema's field for that column gets this `display`, replacing any
`render` or `display` the column would otherwise inherit from its source field.
Normalization validates it with `parseCellDisplay`; an invalid value is dropped
and recorded in `grouping.diagnostics`, so the stage reports the problem instead
of executing. The format travels with `?q=` links and saved queries, and is not
sent to grouped-query backends. A builder metric (`op`/`field`, not an
expression) that measures the column with SUM/AVG/MIN/MAX uses a `number` (with
`decimals`), `percent` or `duration` display as its default value format;
`display.format` on the metric still wins. Counts are never formatted this way.
The column editor offers Number, Percent and Duration with optional decimals
and a duration source unit.

## State, saved views, and authoring

`QueryState.grouping` travels through normal normalization, URL encoding (`?q=`),
StorageAdapters, sharing, and undo/redo. Existing row queries need no migration.
Reset restores the loaded/saved baseline. Removing the last grouping key restores
the source query. Readding the same keys can restore the previous group layout
when the source is unchanged; loading or saving another view clears that cache.
The source snapshot includes record columns, metrics, paging and item details.

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
