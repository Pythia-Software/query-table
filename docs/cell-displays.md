# Cell displays

`FieldDef.display` describes how a cell should look, independently of its query
`type`. For example, a `number` field can hold seconds, a timestamp, or a ratio;
a `text` field can hold JSON. Units and formats are explicit so consumers do not
need to write another renderer for each column.

```tsx
const fields: FieldDef[] = [
  { name: "payload", label: "Payload", type: "text", source: { kind: "backend" },
    display: { kind: "json", encoding: "auto" } },
  { name: "started", label: "Started", type: "number", source: { kind: "backend" },
    display: { kind: "datetime", sourceUnit: "epochSeconds", timeZone: "UTC", style: "iso" } },
  { name: "elapsed", label: "Elapsed", type: "number", source: { kind: "backend" },
    display: { kind: "duration", sourceUnit: "seconds", style: "clock" } },
  { name: "status", label: "Status", type: "enum", source: { kind: "backend" },
    display: { kind: "chip", labels: { ready: "Ready", failed: "Failed" },
      tones: { ready: "success", failed: "danger" } } },
];
```

These settings also work in JSON schema documents. `loadSchema` validates and
preserves them, and TypeScript code generation includes them. Backend query
bindings, filtering, sorting, and metric semantics continue to use the field's
query `type`; display does not parse or mutate API rows. Choose query capabilities
explicitly for native objects: for a payload that cannot meaningfully be filtered
or sorted by the backend, set `filter.enabled` and `sort.enabled` to `false`.

`resolveRenderer(field, registry, columnDisplay?)` uses a per-column display
override first (see below), then an inline `render` function, then a registered
`render` key, then `display`, then the existing text fallback. Existing renderer
keys remain supported. `{ kind: "text" }` is available to opt out of richer
presentation. The bundled JSON inspector is also available as `render: "json"`.
No display is guessed from arbitrary cell text.

## Per-column overrides for layouts

A host's "reading layout" (which columns, in which order, at which widths) can
also choose how each column's cells look, without changing the field. Set
`display` on a `SelectColumn`:

```ts
api.setQuery((query) => ({
  ...query,
  select: [
    { field: "name" },
    { field: "command", width: 360, display: { kind: "text", lines: 3 } },
    { field: "message", display: { kind: "text", lines: 2 } },
  ],
}));
```

The override applies to that column's table cells and takes precedence over
the field's `render` (key or function) and `display`. Item details, cell menus
and metrics keep using the field's own presentation. Like widths, overrides
live in `QueryState.select`: they travel with `?q=` links, saved queries and
undo/redo, survive column resizing and reordering, and are never sent to a
backend. Schema `defaultSelect` entries are not consulted for overrides (or
widths) by `DataTable`. Normalization validates the override with the same
rules as `FieldDef.display`; a malformed one is dropped and the column keeps
the field's presentation.

In compact links a column with an override encodes as
`[field, width | null, display]`. Columns without one keep the existing
`[field]` / `[field, width]` tuples, so tokens for existing views are
byte-for-byte unchanged, and older clients ignore the third member.

`{ kind: "text", lines: n }` (1–20) wraps the text and clamps it to `n` lines
with an ellipsis; line breaks in the value are kept, and the full text is in
the tooltip. It takes precedence over `truncate`. `DataTable` measures every
rendered row, so clamped rows of different heights scroll, virtualize and
re-measure after column resizes correctly. There is no unbounded wrap: one
very long value would produce a row taller than the viewport, so use a large
`lines` value instead.

| Kind | Configuration | Defaults |
| --- | --- | --- |
| `json` | `encoding`, `maxDecodeDepth`, `previewLength`, `expandDepth` | auto, 4 passes, 80 characters; root open, nested containers with up to 3 entries open, 4 or more collapsed |
| `date`, `datetime` | `sourceUnit`: iso/epochSeconds/epochMilliseconds; `style`: human/iso/custom; `pattern`, `timeZone`, `locale` | ISO input, human output, UTC, en-US |
| `time` | Calendar options plus secondsOfDay/millisecondsOfDay | ISO clock input; civil clocks stay in UTC |
| `duration` | `sourceUnit`: milliseconds/seconds/minutes/hours/days; `style`: human/long/clock/custom; `pattern`, `decimals` | milliseconds, human output |
| `number`, `percent` | `decimals`, `locale` | Numbers keep up to 6 fractional digits; percent defaults to 2 decimals; en-US; percent expects a ratio (0.125 → 12.50%) |
| `chip` | `labels` and `tones` maps keyed by raw value | Raw label, neutral tone; scalar or array values |
| `text` | `truncate`, `lines` (1–20) | Plain text; `truncate` keeps one line with an ellipsis; `lines` wraps and clamps |

Temporal formatting shares the metric formatter. ISO timestamps require an
explicit offset; calendar dates and civil clocks retain their civil values.
Numeric timestamp units must be specified explicitly. Duration clock output
carries rounded seconds into minutes/hours. Custom date patterns accept
`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS`, `Z` and the other tokens documented
in [metric formatting](metrics.md); custom durations use `{h}`, `{mm}`, `{ss}`,
`{ms}`, etc. Invalid values or format settings remain readable with an explanatory
tooltip. Null and empty values show an em dash; zero and false are preserved.

## JSON inspector

The compact cell button opens a dialog on desktop and a bottom sheet on mobile.
Only the JSON badge opens the viewer directly. Clicking the preview or the rest
of the cell opens the standard cell menu, including **Open in JSON Viewer**;
double-clicking copies the original cell value.
In item details (popovers, modals, expanded rows, and standalone `ObjectInspector`
cards), JSON appears as a plain collapsible tree in the property value. It starts
fully collapsed, with no inner toolbar, footer, or scroll area. A viewer button
beside the property label opens the full modal with search and copy controls.
The inspector displays pretty-printed JSON with quoted keys, indentation, braces,
commas, and syntax colors. Use the chevron beside an object or array to collapse
or expand that section. Objects and arrays with three or fewer immediate entries
open by default in the full viewer; nested containers with four or more start
collapsed. The root always starts open in that viewer. Set `expandDepth` explicitly to override nested expansion
with a fixed number of expanded levels. Long arrays show their first 20 items,
then expandable index ranges of 20 items each. Hover a line (or focus it with the
keyboard) to copy that object, array, or scalar; copy controls stay visible on
touch devices in the full viewer. Collapsed containers show a muted count of
hidden keys (objects) or values (arrays).

Literal, case-insensitive search stays in the upper-right toolbar. Choose **Filter**
to show matching paths and their ancestors, or **Find** to retain surrounding
content. Search includes descendants of collapsed containers and list buckets.
The adjoining arrows navigate individual matches (also Enter and Shift+Enter),
opening the selected match's ancestors and bucket and scrolling it into view.
The counter shows the current match and total; the selected match is highlighted.
Clearing search restores the previous expansion state. Line tooltips and copy-button labels use
JSONPath bracket notation to keep keys with dots, brackets, quotes, or Unicode
unambiguous. Clipboard copying always uses the complete selected value, even
when search filters the visible document.

- `auto` accepts native JSON values, serialized JSON text, JSON-encoded strings,
  and escaped JSON such as `{\"id\":42}`. It unwraps the whole value up to
  `maxDecodeDepth` (1–8); it preserves strings inside objects and arrays.
- `value` treats the input as a native JSON value, including a literal string.
- `json` parses string input once. Use this for JSON string primitives whose
  contents should remain strings, such as `"123"` or `"{\"id\":42}"`.
- `escaped` allows the same bounded string unwrapping as `auto`, expressing that
  the input is expected to contain an encoded or escaped document.

**Copy original** preserves API strings exactly (including escapes); native
objects/arrays are serialized as JSON. **Copy JSON** copies the decoded, formatted
JSON. Each path's copy button copies its typed JSON value; string values include
quotes. The toolbar's source toggle shows the original input. Malformed JSON opens with its
original text and an error, and remains copyable.

Inspection accepts up to 1,048,576 UTF-16 characters of source/formatted JSON and
visits at most 5,000 entries and 64 nested levels. Tree traversal starts when the
inspector opens or a detail property mounts. Browsing uses batches of 200 entries
with balanced closing braces and a Show more control; search can reveal any
inspected match across those batches. A visible notice states
when inspection/search is partial; copying a valid decoded document still includes
the full accepted value. Larger or unserializable values show an error. Very large
original text is truncated in the viewer while Copy original retains the source.
Integer literals outside JavaScript's safe integer precision keep the original
JSON text and disable decoded copying, preventing a silently rounded identifier.
Decimal/exponent notation and native numeric values retain JavaScript number
semantics and remain inspectable.
No HTML from a value is executed.

## Details defaults and overrides

`FieldDef.display` also supplies the default presentation in object property
views. Specify JSON decoding, timestamp units, duration units, or chip labels
and tones once for the table and its details. Saved property `render`/`format`
overrides and field `property` metadata take precedence; custom field renderers
are retained. See [object property views](object-properties.md).

Choose **json** in the properties editor to customize input encoding, decode
passes, and initial expansion depth for that appearance. For example:

```ts
{ id: "response", field: "payload", format: {
  kind: "json", encoding: "escaped", maxDecodeDepth: 6, expandDepth: 2,
} }
```

The editor uses the same Apply/Cancel flow and live preview as other properties.
These settings travel with named property views, query saves, and item-detail
share links. Each detail modality retains its own appearance.

For standalone compact or embedded inspectors:

```tsx
import { JsonCell, JsonValueView } from "@pythia-software/query-table-ui";

<JsonCell value={payload} label="Response" display={{ kind: "json", encoding: "auto" }} />
<JsonValueView value={payload} label="Response" display={{ kind: "json", encoding: "auto" }} />
```

`inspectJsonValue` and `searchJsonEntries` are exported for custom inspection
surfaces. Import `theme.css` for bundled styling, or provide equivalent styles for
the `qt-json-*` and `qt-cell-format-error` classes. The inspector uses the existing
modal focus trap, Escape dismissal, focus restoration, and mobile sheet behavior.
Its flush toolbar, icon Close control, fixed footer, and resizable desktop frame
follow the item-details modal conventions. The JSON body scrolls independently
so search remains available in the toolbar.

The `/cells` playground includes **Cell displays** with object, serialized, encoded,
escaped, array, and malformed payload examples beside formatted timestamps,
durations, and status chips, followed by a 400-row **Reading layout** whose
Command and Message columns are clamped through `SelectColumn.display`. Its Detail buttons open inline JSON properties in
all three surfaces. With `npm run demo` running, `npm run test:cells` checks
desktop/mobile interactions, property editing, shared-link restoration, and
that clamped virtual rows tile without gaps while scrolling and after a column
resize, and writes screenshots to `.context/`.

Inspection choices can be controlled and shared through native query/item state;
see [portable JSON inspection](json-inspection-state.md).
