# Object property views

Object property views use the same field catalogue as a query table to display
one object. A saved definition selects properties, orders them, overrides
labels, and chooses formats. It applies to every object of a type. It contains
no object values, object IDs, filters, or mutations.

The initial scope is read-only properties and relationship links. Page sections,
relationship previews, related tables, metrics, and enum-to-query navigation are
left for future extensions.

## The item card

`ObjectInspector` renders a compact Query Table item card: a saved-view state bar,
property/value columns, and a count footer. It starts directly with its toolbar;
the host owns visible titles and item identity. `typeLabel` and string `title`
provide an accessible label; `subtitle` is retained for source compatibility and
is not displayed. `className` styles the card root. Borders, surfaces, buttons,
icons and hover/focus states share the builder and table theme tokens.

Built-in item modals and popovers use the card itself as their visible surface. Close sits
beside Reset in the toolbar; the properties scroll between the toolbar and card
footer when the viewport or a resized dialog cannot fit the full view. Small
views size to their content. The shared modal surface still supplies keyboard
focus management, Escape/outside dismissal, desktop resizing, and mobile sheets.
Popovers use compact icon controls and an Open in modal action in the toolbar.
Their placement follows the card's actual height and the space beside the row.
Expanded rows use the same toolbar, with Collapse and Open in modal actions;
they have no separate identity/action strip beneath the card. Mode labels appear
only in the properties editor's context strip, including for standalone viewers.

Properties opens a transactional modal workbench inspired by the metric editor:
an ordered list, settings for the selected property, a live item preview, and
persistent Apply/Cancel actions. On mobile these become Properties, Display and
Preview panels in the shared sheet. Escape discards the draft and restores focus.
The star saves the current view; the picker switches views; the pencil edits
properties. The bookmark opens the existing modal/sheet surface for loading,
defaults, and deletion. Undo, redo, and reset change the property view. All
controls describe presentation changes; object values remain read-only.

For custom compositions, `ObjectProperties` supplies the property/value surface
and `PropertyViewControls` supplies the state bar without adding a card frame.

## Built-in table details

Instance creators enable the feature once; the table handles presentation,
loading and item links without custom row buttons or modal render functions:

```tsx
const api = useQueryTable({ schema, clientRows: items, syncUrl: true,
  itemDetails: true });
return <>
  <QueryBuilder api={api} fields={schema.fields} total={api.total} />
  <DataTable fields={api.visibleFields} rows={api.rows} query={api.query}
    onQueryChange={api.setQuery} rowId={api.rowId} renderers={defaultRenderers}
    itemDetails={api.itemDetails!} />
</>;
```

Modal is the only button selected by default; all four options are available in
Select columns. Creators can change the initial selection with `defaultModes`
and restrict the available options with `modes`. Existing saved queries keep
their explicit selections.

Popovers open only when their button is clicked or keyboard-activated. They stay
open until an outside click, Close, or Escape, including while properties are
being customized. Modal and Row expand buttons use the same property card grammar
with independent layouts, histories, defaults, and named saves for each modality.
Detail is a regular presentation column in the selected list, catalogue,
builder chips and results. Drag, resize, remove and re-add it like a data column.
Its settings choose which detail buttons to show; Apply/Cancel changes the column
layout, detail buttons, and Page settings atomically. This reserved column, `__qt_item_details__`,
is included in schema defaults when details are enabled. Include it explicitly
in a custom SELECT layout. It is never sent to the backend.
One modal or expanded item is active at a time. Expanded rows are part of the
virtualizer's measured layout, so they work with large results.

`QueryState.itemDetails` contains enabled `modes`, optional property `views`
keyed by `hover`, `modal` and `expand`, and `active: { id, mode }`. Legacy `view`
snapshots supply the fallback for every modality. This presentation state round-trips through
`encodeQuery`/`decodeQuery`, saved queries and query undo/redo. The toolbar’s `Share` button
includes the collection query, typed item identity, modality and complete property
view. It does not depend on the recipient having a saved view with the same ID.
With `syncUrl: true`, reload reopens the item; copying an item link also works
without continuous URL synchronization. Popover visibility is transient; sharing
a popover opens a modal with that popover’s appearance. The `hover` state key remains for URL compatibility.

Page displays an out-link icon with a configurable URL template and tab target.
An empty template opens this table’s built-in shareable item modal in a new tab.
Custom templates navigate directly to the host route without fetching or opening
an item card. For example:

```tsx
itemDetails: {
  defaultModes: ["page"],
  page: { urlTemplate: "/items/{id}?workspace={field:workspace_id}&q={query}", target: "_blank" },
}
```

`{id}`, `{query}`, and `{field:catalogue_name}` are substituted with URL-encoded
scalar values. The column editor includes a value picker for inserting these
placeholders. `{query}` contains the complete serialized collection query,
including detail layouts; the destination owns interpretation of that parameter.
Template field dependencies are loaded even when those columns are hidden.
Missing/non-scalar values disable the link. Invalid templates block Apply;
only HTTP, HTTPS, and relative navigation URLs are accepted. `_self` opens in
the current tab; `_blank` opens a new tab. Page settings live in
`QueryState.itemDetails.page`, so saves, links, reset, and undo/redo include them.

Supply an options object instead of `true` to restrict creator-approved `modes`,
provide property `storage`, `objectType`, a detail-only `schema`, `relationships`,
or a custom `loadRow(id, signal)`. Hosts managing their own table URL parameter can
set `queryParameter` (default `q`). Optional `DataTable.itemRenderers` overrides
are layered over its table renderer registry. A standalone `ObjectInspector` can
share the modal view using `propertyApi={api.itemDetails!.properties}` (the
compatibility alias) or select any controller from `propertiesByMode`. Detail
property editors name the current scope; editing a modal never updates a popover or expansion.

Complete client rows are used automatically. On servers, `Transport.fetchRow`
loads a complete item independently of the table projection and filters. A custom
`loadRow` returns `{ row, loadedFields? }` or `null`; without either loader, the
current projected row is used with explicit coverage, showing missing properties
as Not loaded. Loads are cancelled on item changes and stale responses are ignored.
A missing item stays dismissible and a failed load offers Retry. An expanded item
outside the current page appears after the table, preserving the shared identity.
Detail changes do not refetch the collection or enter the backend SELECT request.

Property label widths are draggable and travel with their saved view. Keyboard
arrows resize, Enter fits labels, and Home or double click resets the width.
Desktop detail and property-editor modals are resizable; mobile uses the shared
sheet. Values support double click or focused Enter to copy raw data with success
feedback; unloaded fields and interactive links retain their normal behavior.

## A complete property surface

```tsx
import {
  localPropertyViewStorage,
  type FieldSchema,
} from "@pythia-software/query-table-core";
import { ObjectInspector } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

type Call = { id: string; command: string; started_at: string; duration_ms: number };
const schema: FieldSchema<Call> = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "id", label: "Call ID", type: "text", source: { kind: "backend" } },
    { name: "command", label: "Command", type: "text", source: { kind: "backend" },
      property: { default: true, format: { kind: "code" } } },
    { name: "started_at", label: "Started", type: "datetime", source: { kind: "backend" },
      property: { default: true, format: { kind: "relative" } } },
    { name: "duration_ms", label: "Duration", type: "number", source: { kind: "backend" },
      property: { default: true, format: { kind: "duration", sourceUnit: "milliseconds" } } },
  ],
};
// Create the adapter once. Browser persistence is an explicit opt-in.
const storage = localPropertyViewStorage();

export function CallDetails({ call }: { call: Call }) {
  return <ObjectInspector schema={schema} row={call} storage={storage}
    typeLabel="Tool call" title={call.command} />;
}
```

The host fetches the object and owns its page/dialog, authorization, and routes.
`ObjectInspector.shareUrl(view)` lets a host provide a Share button with its own
route, identity, and view snapshot; `shareAction` supports custom composition.
Built-in details supply Share automatically. The demo and Pharos’s standalone
call dialogs provide their share URL as well.
`ObjectInspector.onClose` adds the same toolbar Close control when a host uses
the card inside its own dialog.
Use `closeLabel` to name a host's dismissal action, and `compact` for an icon toolbar.

`ObjectInspector` supplies the view selector, customization editor, named saves,
default selection, reset, undo/redo, and property display. Apply commits a draft;
Cancel discards it. Empty views remain empty. Unknown or disabled fields remain
visible as unavailable so schema changes do not silently rewrite saved views.

Use `objectType` when the catalogue name is not the desired persistence identity.
Use a stable type key, never the current object's ID. Switching `row` preserves
the view; switching the type or storage adapter hydrates that type's views.

## State and composition

```ts
const view = {
  version: 1,
  properties: [
    { id: "started-relative", field: "started_at", format: { kind: "relative" } },
    { id: "started-exact", field: "started_at", label: "Exact start",
      format: { kind: "datetime", style: "iso", timeZone: "UTC" } },
    { id: "command", field: "command" },
  ],
} satisfies PropertyViewState;
```

Each appearance has its own instance ID, so one field can appear more than once
with different formats. `normalizePropertyView` validates a version-1 definition
and clones it; it limits views to 200 properties and requires unique instance IDs.

`createPropertyView(schema, names?)` derives the first view. Explicit property
defaults take precedence over table `defaultSelect`, followed by `select.default`
and all enabled properties. `property.enabled: false` excludes a field from the
editor and default view. This is a presentation setting; the host still enforces
data access. Fields can be detail-only even with `select.enabled: false`.

For custom chrome, compose `usePropertyView` from the React package with
`PropertyViewControls` and `ObjectProperties` from the UI package, or use your own
controls. `ObjectProperties` accepts an externally owned `view` without storage.
The controller exposes `setView`, `reset`, `undo`, `redo`, `save`, `load`, `remove`,
and `setDefault`, along with loading/error state. History is bounded to 50 entries.

## Formats and renderers

Formats include text, code, JSON, booleans, chips, numbers, percentages, currency,
relative times, dates, times, datetimes, and durations. Time and duration formats
reuse metric formatting; configure their input units explicitly when the source
is numeric. Relative time defaults to ISO input and refreshes every minute. Pass
`now` for deterministic output, and `locale`/`theme` to match the host.

Enums and arrays default to chips with stable colors. Long strings wrap instead
of inheriting table truncation. Zero, false, and NULL are distinct. Format errors
retain the raw value with a diagnostic tooltip.

Precedence is the saved appearance's `render` or `format`, then field `property`
metadata, then custom field renderers, `FieldDef.display`, and type defaults. A
field's display supplies the same JSON decoding, date/time or duration units,
and configured chip labels/tones in table cells and detail properties.
Hosts can register
detail-specific renderers using `property.render`; they receive the existing
renderer context, including the complete row and `presentation: "property"`.
The view editor changes
presentation only and has no object update callback.

JSON properties embed collapsible, pretty-printed JSON directly, including when using
`render: "json"`. Native objects, serialized JSON, and encoded/escaped strings
share compact upper-right key/path/value search and original, decoded, and
per-object/value copying. Search retains the matching branches' JSON structure. The
properties editor offers JSON encoding, decode-pass, and expansion settings;
these persist in named views and item share links. A literal string can use
`format: { kind: "json", encoding: "value" }`. Configured chips can use
`format: { kind: "chip", labels: { ok: "Ready" }, tones: { ok: "success" } }`.
See [cell displays](cell-displays.md) for options and inspection limits, or try
the `/cells` demo. `JsonValueView` is exported for custom detail surfaces.

If a fetched row is a projection, pass `loadedFields` as **catalogue field names**.
An omitted field then displays “Not loaded”, while a loaded NULL displays a dash.
Derived properties can render when their declared dependencies are loaded. Fetch
all permitted detail fields, or fetch the dependencies for the current view;
`ObjectInspector` does not fetch missing data automatically.

## Persistence

Default storage is in memory for the mounted controller. To persist across
instances, provide a shared adapter. `memoryPropertyViewStorage`,
`localPropertyViewStorage`, and `jsonPropertyViewStorage(read, write)` implement
`PropertyViewStorage`. The JSON factory can use synchronous host preferences;
hosts with asynchronous persistence can implement the interface directly.

The standalone namespace is `query-table:properties:<objectType>`. Built-in details
append `:modal`, `:hover` or `:expand` to the type key. These are independent of
saved collection queries. Only presentation definitions are stored. There are
at most 100 named views per type; names must be unique and at most 200 characters.
Storage errors surface in the controls.

Restore order is explicit `initialView`, then last working view, then the saved
default, then schema defaults. A default supplies the view when there is no last
working view. Reset restores the schema defaults. Deleting a default
clears its default designation, while preserving the current working view.

## Relationships

An explicit relationship maps target key names to local catalogue fields:

```ts
{
  name: "workspace_id", label: "Workspace", type: "text",
  source: { kind: "backend" },
  origin: { table: "tool_calls", column: "workspace_id" },
  relationship: { objectType: "workspaces", key: { id: "workspace_id" } },
}
```

Supply a `RelationshipAdapter` to `ObjectInspector`/`ObjectProperties`:

```ts
const relationships: RelationshipAdapter = {
  async resolve(references, signal) {
    const response = await fetch("/api/object-properties/references", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ references }), signal,
    });
    if (!response.ok) throw new Error("Relationship lookup failed");
    return response.json();
  },
};
// Response: [{ reference: { objectType: "workspaces", key: { id: "w1" } },
//              label: "Query table", href: "/work/w1" }]
```

Visible references are deduplicated into one cancellable batch. Changing the
object invalidates previous results. Unresolved references keep their original
value. Returned links are validated with the existing safe-link policy; hosts
can instead provide `onOpenReference` for application navigation. The host owns
caching, existence checks, labels, routes, and per-target permissions.

For discovery, the Go `DiscoverSQLiteForeignKeys(ctx, db, registeredTables)`
helper reads declared constraints in SQLite's main schema, including composite
keys and implicit primary-key targets. Pass these constraints to
`discoverFieldRelationships(fields, foreignKeys, objectTypes)` with a registry:

```ts
const objectTypes = [{ name: "workspaces", table: "workspaces", keyFields: ["id"] }];
const linkedFields = discoverFieldRelationships(schema.fields, foreignKeys, objectTypes);
```

Origins must describe physical table/column provenance; SQL expressions and
normalized aliases cannot reliably reveal it. Fully mapped, unambiguous
constraints become links. Explicit metadata wins. Missing keys, ambiguous aliases,
unregistered targets, and undeclared ID-looking fields are not guessed. Other
backends can supply the same `ForeignKey` contract.

## Example integration

The `/objects` demo switches between Pharos-style tool calls while preserving
saved views. Run `npm run demo`, then `npm run test:properties` for the browser
regression check.

Pharos's tool-call and MCP-call dialogs reuse their catalogues, load complete
detail records, and preserve specialized duration/token/result renderers.
Named definitions/defaults follow Pharos's library preferences; the last working
view remains per Mac. Tool-call workspace and conversation links use discovered
foreign keys and a host-owned batch resolver.
