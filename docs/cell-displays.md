# Cell displays

`FieldDef.display` describes how a cell should look, independently of its query
`type`. For example, a `number` field can hold seconds, a timestamp, or a ratio;
a `text` field can hold JSON. Units and formats are explicit so consumers do not
need to write another renderer for each column.

```tsx
const fields: FieldDef[] = [
  { name: "payload", label: "Payload", type: "text", source: { kind: "backend" },
    display: { kind: "json", encoding: "auto", expandDepth: 1 } },
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

`resolveRenderer` uses an inline `render` function first, then a registered
`render` key, then `display`, then the existing text fallback. Existing renderer
keys remain supported. `{ kind: "text" }` is available to opt out of richer
presentation. The bundled JSON inspector is also available as `render: "json"`.
No display is guessed from arbitrary cell text.

| Kind | Configuration | Defaults |
| --- | --- | --- |
| `json` | `encoding`, `maxDecodeDepth`, `previewLength`, `expandDepth` | auto, 4 passes, 80 characters, 1 level |
| `date`, `datetime` | `sourceUnit`: iso/epochSeconds/epochMilliseconds; `style`: human/iso/custom; `pattern`, `timeZone`, `locale` | ISO input, human output, UTC, en-US |
| `time` | Calendar options plus secondsOfDay/millisecondsOfDay | ISO clock input; civil clocks stay in UTC |
| `duration` | `sourceUnit`: milliseconds/seconds/minutes/hours/days; `style`: human/long/clock/custom; `pattern`, `decimals` | milliseconds, human output |
| `number`, `percent` | `decimals`, `locale` | Numbers keep up to 6 fractional digits; percent defaults to 2 decimals; en-US; percent expects a ratio (0.125 → 12.50%) |
| `chip` | `labels` and `tones` maps keyed by raw value | Raw label, neutral tone; scalar or array values |
| `text` | `truncate` | Plain text |

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
In item details, the same inspector is embedded directly in the property value,
including popovers, modals, expanded rows, and standalone `ObjectInspector`
cards. Search and copy controls stay inside the details surface.
The inspector displays pretty-printed JSON with quoted keys, indentation, braces,
commas, and syntax colors. Use the chevron beside an object or array to collapse
or expand that section. Hover a line (or focus it with the keyboard) to copy that
object, array, or scalar; copy controls stay visible on touch devices.

Literal, case-insensitive search stays in the upper-right toolbar. Search includes
descendants of collapsed containers, opens matching branches, and highlights
matching text while retaining ancestor braces and indentation. Clearing search
restores the previous expansion state. Line tooltips and copy-button labels use
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
inspector opens or a detail property mounts, and values are shown in batches of
200 with balanced closing braces and a Show more control. A visible notice states
when inspection/search is partial; copying a valid decoded document still includes
the full accepted value. Larger or unserializable values show an error. Very large
original text is truncated in the viewer while Copy original retains the source.
Numbers outside JavaScript's safe integer precision keep the original text and
disable decoded copying, preventing a silently rounded identifier.
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
durations, and status chips. Its Detail buttons open inline JSON properties in
all three surfaces. With `npm run demo` running, `npm run test:cells` checks
desktop/mobile interactions, property editing, and shared-link restoration,
and writes screenshots to `.context/`.
