# Portable JSON inspection and semantic attention

JSON inspection is a query definition. Native item details carry it in
`QueryState.itemDetails.jsonInspections`, alongside their property layouts.
The native Save, Update, Share, snapshots, history and URL controls retain the
same definition. Oversized links use the existing durable snapshot store;
sharing never depends on another browser's cache. Version 0.9.7 does not expose
this contract; consume the release containing this change before integrating.

Each entry has `{ dataset, rowId, field, state }`. Dataset is the detail
catalogue's `schema.name`; `rowId` is the stable record ID, retaining its string
or number type. `field` is the catalogue field name, independent of row position,
property instance IDs, labels and layout ordering. A different record or dataset
cannot inherit the entry. Native details connect this automatically. Standalone
`ObjectProperties`/`ObjectInspector` accept `recordId`, `jsonInspections` and
`onJsonInspectionChange`; their local fallback for records without an ID is not
a portable identity.

Standalone components accept a controlled state and emit complete replacements:

```tsx
const [inspectionState, setInspectionState] = useState(() =>
  createJsonInspectionState(inspectJsonValue(value), { kind: "json" }),
);
<JsonCell value={value}
  inspectionScope={{ dataset: "calls", rowId: call.id, field: "payload" }}
  inspectionState={inspectionState}
  onInspectionStateChange={setInspectionState} />
// JsonValueView accepts the same props, plus compact.
```

Keep controlled states keyed by `jsonInspectionScopeKey(scope)` when navigating
between records. Omit `inspectionState` for local ownership. Closing a cell's
inspector retains the state; reopening it restores its choices. Refreshing the
same scoped record preserves state and does not repeat match scrolling.

`JsonInspectionState.version` is `1`. Its complete required members are:

| Member | Meaning |
| --- | --- |
| `open` | Cell/property inspector open or closed |
| `search` | Applied literal search, including the empty string |
| `searchMode` | `filter` or `find` |
| `raw` | Original source or JSON tree |
| `collapsedPaths` | Ordered set of collapsed bracket JSONPaths |
| `expandedBuckets` | Ordered set of expanded array ranges |
| `visibleEntryLimit` | Inspected entries shown, from 1 to 10,000 |
| `searchOverrides` | Ordered `{ path, expanded }` choices while searching |
| `selectedMatch` (optional) | Deliberately chosen `{ path, part, start }` occurrence |

Paths use `$["key.with.dots"]["quote\"key"][21]`, exactly as the inspector
emits them. Buckets use a path plus `:bucket:20`, `:bucket:40`, etc., in ranges
of 20. Match `part` is `key`, `value` or `path`; `start` is the UTF-16 offset in
the displayed text. Ordered sets are retained without sorting. Hover, keyboard
focus, copy feedback, measurements, scroll offsets and editor drafts are absent.

`parseJsonInspectionState` and `parseJsonInspections` validate boundaries, clone
arrays and discard unknown/transient members. Future versions, malformed states
and duplicate scopes are rejected, including by strict link decoding, rather
than silently opening a different view. Limits are 200 scopes, 5,000 paths per
set and 10,000 UTF-16 units per path/search. Native updates retain up to 200 scopes ordered by their latest edit, preferring to evict the oldest closed inspector
before the oldest open inspector when adding a new scope at capacity. Updating
an existing scope refreshes its position without evicting another scope. Codec
boundaries still reject oversized envelopes. The tree's existing size/depth
inspection limits still apply. Missing paths do not redirect to similar keys;
`onInspectionResolution` on the JSON component reports `unavailable`, including
`missingPaths` and `selectedMatchUnavailable`. A deleted selected match is never
silently replaced with another one.

Both TypeScript and Go link codecs preserve this envelope. Go exposes
`JSONInspectionState`, `JSONMatchIdentity`, `JSONSearchOverride` and
`ScopedJSONInspectionState`; `NewJSONInspectionState()` initializes empty sets
as JSON arrays. Marshal the scoped entries in `LinkQuery.ItemDetails`, alongside
its `modes`, layouts and active identity. False booleans and empty search strings
are explicit; none use `omitempty`.

## Semantic attention

```tsx
const attention = useMemo(() => createAttentionRegistry(), []);
const table = useQueryTable({
  schema, clientRows, itemDetails: { attention }, syncUrl: true,
});
const result = await attention.resolve({
  dataset: schema.name, rowId: 42, field: "payload", path: '$["events"][41]',
}, { signal: navigation.signal });
// status: "revealed", "unavailable", or "cancelled"
```

Omit `path` to reveal a property, and omit both `field` and `path` to reveal a
row's details. Standalone JSON components accept the same `attention` plus
`inspectionScope`. Native details load the exact record through their configured
`loadRow`/transport, open a supported detail surface, wait for rendering, and
resolve the field by its stable name. Unavailable records, unloaded/disabled
fields, absent properties and missing JSONPaths return `unavailable`. They do
not change filters, sorting or paging to run a different query. Derived properties
are available when their declared backend dependencies are loaded, just as in
rendering. JSON paths use the actual rendered viewer's decoding options; null
values and text/renderer overrides without a JSON viewer return `unavailable`.

A JSON reveal opens ancestors and array ranges and increases the visible limit
so the target exists before scrolling/highlighting. It clears any search/raw
presentation hiding the target through the controlled change callback. It never
calls focus; a modal opened for attention also preserves the caller's focus.
Scrolling and highlighting are immediate, with no motion animation, including
when reduced motion is enabled. Background refresh does not replay a reveal.
Restored nested JSON dialogs follow the attention focus policy; manually opening
the viewer still focuses it normally. Each explicit reveal rematerializes an
expanded virtual row and keeps its detail mounted until the reveal settles.
The `attentionRevision` and `attentionPending` controller members coordinate
that materialization and are transient, absent from links and snapshots.

For custom virtualized surfaces, `attention.register(target, provider)` returns
an unregister function. A provider can supply `ready(signal)`,
`materialize(target, signal)` and `reveal(target, signal)`. Await
`attention.whenRegistered(target, signal)` after requesting a render. Providers
must honor abort signals and resolve the exact target. New resolves cancel the
previous request; `attention.cancel()` and native open/close navigation cancel
pending work. Hosts should abort navigation when abandoning their route.

Run `npm run test:json-inspection` against the running demo (`QT_DEMO_URL`
selects its `/cells` URL) for restoration checks in independent browser contexts.
TypeScript/Go shared fixtures cover both codec directions.

## Downstream release integration

Publish the normal synchronized package/Go release from the upstream release
workflow after review. Pin core, react, ui, codegen (and duckdb when consumed)
and the Go module to that same release. Pharos must then connect this state to
its shared contract, add the upstream composite to its control ledger and run
fresh-browser coverage before removing `viewDependencyGaps.query_table_json`.
Those downstream changes are separate from this upstream implementation.
