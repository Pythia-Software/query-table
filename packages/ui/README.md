# @pythia-software/query-table-ui

`ObjectInspector`, `ObjectProperties`, `PropertyViewControls`, and
`PropertyViewEditor` provide customizable read-only object details. See
[object property views](../../docs/object-properties.md) for setup and composition.

`ObjectInspector` supplies a compact card with a saved-view toolbar, property/value
rows, and a read-only footer. The host owns visible identity. Its property editor
opens a modal workbench with an ordered list, display settings and a live preview.

Enable `useQueryTable({ schema, itemDetails: true })` and pass
`itemDetails={api.itemDetails}` to `DataTable` for click popovers, resizable item modals
and row expansion. Detail is a regular draggable/resizable column, defaulting to Modal. Page links
support URL templates and same-tab/new-tab navigation. Item toolbars include Share. Each
modality has independent saved property views; shared links carry the query,
typed item ID, modality and layouts. Property label widths are saved with the
view; values support double click or focused Enter to copy raw data.
The Detail chip's right caret opens its settings in the column selector.
Popovers use compact icon controls and scroll properties within the card;
expanded rows keep Collapse in the card toolbar. Mode labels appear only in
the properties editor's context strip.
Opinionated, themeable React components for query-table, including the data
table, query builder, field picker, metrics panel, saved queries, cell menus,
and selection toolbar.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react react-dom
```

## Column widths

Drag a header edge to resize one column (arrow keys nudge, Enter auto-fits).
Click anywhere in a column header to open its actions menu, including padding
and blank space. Resize handles remain dedicated to resizing.
Open **Column Widths** to resize in one step:

- **Fit This Column** sizes the clicked column to its widest rendered value.
- **Fit All to Content** does the same for every column.
- **Fit All to Screen** fills the viewport; when content overflows, narrow
  columns keep their content width and only the widest ones are trimmed. It
  sets `query.fitToScreen`, so shared links and saved queries fit each viewer's
  available table area after loading and when that area changes.
- **Equal Widths** splits the viewport evenly.
- **Reset Widths** drops explicit widths back to schema defaults.

Widths live in `query.select`, so presets are shareable and undoable.
The fit-to-screen preference travels in the existing encoded `?q=` parameter
(`fs: true` in its compact payload). Manual column resizing, fitting a single
column, another width preset, or resetting widths clears it. Set
`fitToScreen: true` on an initial query to enable the same behavior directly.

## Cell quick filters

Click a text cell to open paired keep/exclude filters. Length comparisons use
`length > / ≤`, `length < / ≥`, and `length = / ≠`, prefilled with the clicked
value's Unicode code-point count.

## Reusable menus

`Menu`, `MenuButton`, `MenuGroup`, `MenuItem`, `MenuSubmenu`, and `MenuSeparator`
serve table header/cell actions, condition choices, and metric actions. They also
work independently of a table.
Mount a `Menu` while open, place it beneath your theme provider, and supply a
trigger element or viewport `{ x, y }` coordinates as its `anchor`:

```tsx
import { useState } from "react";
import { Menu, MenuItem, MenuSubmenu, MenuSeparator } from "@pythia-software/query-table-ui";

function ViewActions() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return <>
    <button aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={event => { const trigger = event.currentTarget; setAnchor(previous => previous ? null : trigger); }}>
      Actions
    </button>
    {anchor && <Menu label="View actions" anchor={anchor} onClose={() => setAnchor(null)}>
      <MenuItem onSelect={() => copyView()}>Copy view</MenuItem>
      <MenuSubmenu label="Export">
        <MenuItem onSelect={() => exportCsv()}>CSV</MenuItem>
        <MenuItem disabled>Image</MenuItem>
      </MenuSubmenu>
      <MenuSeparator />
      <MenuItem tone="danger" onSelect={() => removeView()}>Remove view</MenuItem>
    </Menu>}
  </>;
}
```

For a button trigger, `MenuButton` owns open/close state, click toggling, and
ArrowDown/ArrowUp opening at the first/last enabled action:

```tsx
<MenuButton label="Metric actions" trigger="⋯" width={200}
  buttonProps={{ className: "my-trigger" }}>
  <MenuItem onSelect={duplicate}>Duplicate</MenuItem>
  <MenuItem disabled={!canMove} onSelect={move}>Move up</MenuItem>
  <MenuSeparator />
  <MenuItem tone="danger" onSelect={remove}>Remove</MenuItem>
</MenuButton>
```

`MenuGroup` adds a labeled group. Set `columns={2}` for paired actions: horizontal
arrows move within a row, vertical arrows follow a column, disabled cells are
skipped, and vertical boundaries continue to adjacent actions. Direct action
children should follow visual row order. Set `checked` with
`selectionType="radio"` for exclusive choices; the consumer owns selected state.

Items accept `icon`, `shortcut`, `disabled`, and `textValue` for rich-content
typeahead labels. Set `checked` for checkbox semantics and `closeOnSelect={false}`
for toggles that should keep the menu open. Submenus can nest and accept `width`.
Actions close the whole tree; Escape and the back arrow close one level. Up/Down,
Home/End, typeahead, and direction-aware submenu arrows handle keyboard navigation.
Desktop Tab closes the menu and continues from its trigger. `returnFocus` supplies
a destination for coordinate menus; outside interactions keep their own focus.

Desktop menus follow element anchors, flip/shift at viewport edges, scroll when
long, and portal outside clipping containers. Within a dialog, they remain inside
its focus trap. Coordinate menus dismiss on external scrolling. Mouse travel across
submenu gaps uses a safe corridor; only one child submenu opens at each level.
Phones use the shared focus-trapping sheet with expandable inline submenus.

Scoped `--qt-*` variables, font family, color scheme, and text direction propagate
through portals, including theme changes while open. Optional tokens are
`--qt-menu-bg`, `--qt-menu-border`, `--qt-menu-radius`, `--qt-menu-shadow`, and
`--qt-menu-hover`; defaults use the existing palette. `classNames` supports
`popover`, `submenu`, `item`, and `separator`; existing `qt-cm-*` CSS hooks remain.
Import `theme.css` for the standard visual and responsive behavior.

Visit the demo's `/menus` playground for nested, themed, RTL, clipped, long, and
dialog examples. With the demo running, `npm run test:menus` checks those behaviors
in Chromium and WebKit (`QT_DEMO_URL` can point to a different server).

### Forms and searchable pickers

Use `Popover` for inputs and settings. It shares menu positioning, theme,
dismissal, portals, and mobile sheets, with regular form Tab behavior and dialog
semantics. Desktop focus starts at the first enabled control; `initialFocus` can
supply a selector scoped to the surface. Escape restores the trigger, leaving
focus dismisses the popover, and outside clicks retain the clicked destination.
It accepts `anchor`, `label`, `onClose`, `returnFocus`, `width`, `placement`,
`className`, and arbitrary children. Mount it only while open:

```tsx
{open && trigger.current && <Popover label="View settings" anchor={trigger.current}
  placement="bottom-end" width={280} onClose={() => setOpen(false)}>
  <label>Name <input value={name} onChange={event => setName(event.target.value)} /></label>
  <button onClick={() => { save(name); setOpen(false); }}>Save</button>
</Popover>}
```

Add column/filter/sort field pickers, rich filter-value pickers, and auto-refresh
settings use this surface. `FieldPicker` accepts an optional `anchor` for floating
use; omitting it preserves standalone inline usage. Tag multi-select editors and
full workbenches use the shared modal/sheet foundation with Apply/Cancel and focus
containment. Native selects, expandable sections, and formula autocomplete keep
their respective form, disclosure, and combobox interactions.

## Tag/set filters

Set `filter.editor: "set"` on a `textarray` field to use the native WHERE
multi-select editor, with ANY / ALL / NONE / EMPTY modes, badge presentation,
removable tags, keyboard controls, and a mobile bottom sheet. For stable tag
keys, also set `arrayCaseSensitive: true` and provide static `{ value, label }`
options. NONE includes empty/missing arrays while excluding every selected key.
Other fields and existing predicates keep their current editors.

```ts
filter: {
  editor: "set",
  arrayCaseSensitive: true,
  values: {
    source: "static",
    options: [{ value: "bug", label: "Bug" }, { value: "feature", label: "Feature" }],
  },
}
```

`FilterValueProvider` renders both selected chips and choices. Unknown selected
keys remain removable rather than being silently discarded. The editor honors
`filter.ops` and the query's predicate budget; a restrictive operator allowlist
can disable modes. `classNames.setEditor` and `classNames.setBackdrop` customize
the overlay alongside the existing input/select/button slots. See
[`docs/set-filters.md`](../../docs/set-filters.md) for serialization, alias
canonicalization, backend requirements, and compatibility details.

## Use

```tsx
import { DataTable, QueryBuilder, defaultRenderers } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";

export function OrdersTable({ table, schema }) {
  return (
    <>
      <QueryBuilder
        api={table}
        fields={schema.fields}
        total={table.total}
        running={table.loading}
      />
      <DataTable
        fields={table.visibleFields}
        rows={table.rows}
        query={table.query}
        onQueryChange={table.setQuery}
        renderers={defaultRenderers}
        rowId={table.rowId}
        total={table.total}
        loading={table.loading}
      />
    </>
  );
}
```

`DataTable` virtualizes body rows and uses a 600px maximum-height scroll
viewport by default. Set `maxHeight` to match the surrounding layout;
`estimateRowHeight` (37px by default) and `overscan` (8 rows) are available for
unusually sized or expensive custom row renderers. Visible rows are measured,
so the estimate does not require every row to have a fixed height.

The bundled `link` renderer allows only HTTP(S), email, telephone, relative,
and fragment URLs. Applications remain responsible for validating URLs emitted
by custom renderers.

The query builder's **Share** button copies a URL containing the complete
current query, including a saved default query. Configure `useQueryTable` with
`syncUrl: true` so recipients load shared query URLs. Query tokens are encoded,
not encrypted, and may contain raw filter values.

Pass `selection={table.selection}` to enable row checkboxes with editable ranges:

- Click a checkbox to toggle it and start a new range, preserving prior checks.
- Shift-click to grow or shrink the range from its fixed starting row. Starting
  by unchecking a row makes Shift-click uncheck the range instead.
- Ctrl/Cmd-click toggles one checkbox; Ctrl/Cmd+Shift-click adds the span while
  preserving every existing check.
- Space toggles the focused checkbox; Shift+Space adjusts the range, with
  Ctrl/Cmd+Shift+Space available for an additive span.

For example, click 2, Shift-click 4, click 8, Shift-click 12, then Shift-click 10
to select rows 2–4 and 8–10. Shrinking an overlapping range preserves checks that
existed before it began. Ranges follow the current page's displayed order,
including virtualized rows, and reset when that order changes. The header
checkbox selects or clears the current page and starts a fresh range context.

`SelectionToolbar` action callbacks receive `(selectedIds, selection)`, so
consumer-owned bulk actions can call `selection.replace(ids)` or
`selection.retain(ids)` atomically. Existing callbacks that use only the first
argument remain compatible.

## Icons

The bundled theme aligns table-header sort arrows and priority indicators with
their labels for both single-column and multi-column sorts.

`Icon` is the shared, hand-drawn SVG set used throughout the UI and demo. Its
24px grid, rounded 1.8px strokes, and `currentColor` styling keep controls
cohesive without forcing every shape into the same silhouette. Drag handles
use solid dots; saved and priority stars can use a filled active state.

```tsx
import { Icon } from "@pythia-software/query-table-ui";

<button aria-label="Copy value"><Icon name="copy" /></button>
<Icon name="star" size={20} filled />
```

Icons default to 16px; use `size` and `className` for larger carets or scoped
styling. SVGs are decorative and excluded from keyboard focus. Keep a visible
text label or an `aria-label` on the surrounding control; give standalone
status indicators an accessible label on their wrapper.

## Mobile behavior

The bundled theme keeps the table as a horizontally scrollable grid on narrow
screens so columns remain comparable. Narrow screens (up to 760px) and short,
touch-based landscape viewports use a mobile interaction model:

- **Tap to edit or delete:** filters, sorts, and metrics become readable summaries
  with pencil buttons. Remove actions live inside the editor, including removal
  of an entire OR group, and support Undo. There are no inline trash buttons.
  Adding a filter, sort, or metric immediately
  opens its editor. Filters can be combined with OR without relying on drag-and-drop.
- **Direct ordering:** columns, sorts, and metrics have leading drag handles
  directly in the query builder, with no Order buttons. Column chips stay
  wrapped and can move horizontally or between rows. Keyboard arrow keys reorder
  a focused handle. A drop commits the new order; cancelled gestures leave the
  query unchanged. Filters have no ordering controls because their order does
  not affect results. Ordinary scrolling outside a handle does not start a drag.
- **Consistent sheets:** field and value pickers, conditions, cell/header actions,
  saved queries, auto-update settings, and the column editor use bottom sheets
  with a scrim, a visible close action, and pull-down dismissal from the handle.
  Sheets trap and restore focus, lock background scrolling, respect safe areas
  and reduced motion, and fit the visible viewport when the keyboard opens.
  Mobile portals preserve inherited `--qt-*` theme variables.
- **Focused column workbench:** Selected, Catalogue, and Preview sections replace
  stacked desktop panels. Selected columns reorder directly using their leading
  handles; draft changes still require Apply.
  Layout actions remain visible in the footer.
- **Compact spacing:** mobile sheets, lists, query sections, and editors reduce
  padding and redundant headings. Query chips, their buttons, and inline handles
  use a 32px minimum height with zero vertical padding; long summaries can wrap.
  Filter, sort, and metric inputs use 36px controls. Keyword sections have extra breathing room
  and solid horizontal rules on desktop and mobile.
- **Dense query setup:** filter, sort, and metric actions share a section header.
  Summaries use one line when space allows and wrap without truncating values.
  Labeled condition/value and function/measure pairs replace wrapping desktop
  chips. Sort direction and null-value placement use native selects; regex
  extraction stays optional. Its configuration opens a dialog (a bottom sheet on small screens) with a live, worker-isolated preview of up to 100 matching rows. The preview shows original values, extracted sort values, and no-match/null states; Apply commits any syntactically valid pattern even when the preview is unavailable or still loading, while Cancel leaves the sort unchanged. Grouping uses removable tags and a field picker.
  Simple metric results share two-column rows; grouped results use the full width.
- **Touch-first controls:** dedicated drag handles, 16px text inputs,
  sticky bulk actions, a horizontal table scroll cue, and the device's native
  share sheet when available (clipboard fallback otherwise).

Filter and sort edits update the query immediately; **Done** dismisses the sheet. The column and metric workbenches retain explicit **Apply** draft workflows. Desktop chips, popovers, and drag-and-drop remain available.

Keep the standard viewport meta tag in the host page:

```html
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

Applications that omit `theme.css` and use only `classNames` are responsible for
providing their own responsive and touch-target styles, including styles for
the mobile summary, sheet, and reorder-list structural classes.

To run browser interaction checks, start `npm run demo`, install Playwright's
Chromium and WebKit browsers, and run `npm run test:mobile` from the repository
root. The suite covers narrow phones, small tablets, and phone landscape; it
also exercises real Chromium touch events and saves previews in `.context/`.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for customization and backend integration details.

## SELECT editor

`QueryBuilder` includes a split **Add** button and **Reset** action for Columns: Add opens the field picker, while its caret opens the column customizer. Actions follow the selected chips on desktop and sit in the section header on small screens. The exported `SelectColumnEditor` also accepts `{ api, onClose }` for standalone use. It supports draft column ordering, a searchable catalogue, sampled value frequencies, and a lazy-loaded, dependency-free textarea formula editor with field/function suggestions, signature help, and compiler diagnostics with grouped live previews and regex inspection. A Function library beside the editor supports search by name or intent, browsing by concept and return type, and insertion at the cursor or around selected text; it stacks below the editor on narrow screens. Shared-definition saves and query-layout application are separate actions.

### Filter value presentation

Queries keep stable string keys while consumers can display names and rich badges.
Static options accept either strings (the existing API) or `{ value, label }` objects.
Wrap the table and query builder in `FilterValueProvider` to supply presentation for
current values, suggestions, and cell quick filters:

```tsx
<FilterValueProvider value={{
  label: (field, key) => lookup(field, key)?.name ?? key,
  render: (field, key) => <Badge value={lookup(field, key)} fallback={key} />,
}}>
  <QueryBuilder api={api} fields={schema.fields} total={api.total} />
  <DataTable {...tableProps} />
</FilterValueProvider>
```

The searchable static picker matches both labels and keys. Selection emits the
canonical `value` only; presentation is never serialized into queries. A resolver
can present a current value even when it is absent from the options. Strings without
a presentation provider retain the existing select control.

## Metric workbench and dashboards

QueryBuilder's **Edit metrics** opens the resizable four-pane `MetricsEditor`. Apply commits drafts together; Cancel discards them. Dashboard layout provides draggable canvas widths, whole-rem card sizing through corner handles or inputs, canvas presets, pointer/keyboard reordering, and inline names. Metrics use their own workbench on desktop and compact viewports; their changes commit on Apply.

Use the icon buttons beside **Panels** to show or hide the metric list, definition, references, and preview. At least one panel stays visible; the metric picker and Previous/Next controls remain available when the list is hidden. **See in dashboard** reveals the selected card in the same draft; **Back to metric**, the card’s pencil action, or a double-click returns to editing. Open settings and panel preferences survive these transitions.

Drag the dashboard canvas’s right edge to test responsive wrapping. Card corner handles adjust preferred width and height in whole rems; arrow keys resize and Shift increases the step. Escape or a cancelled pointer gesture restores the dimensions at drag start. Canvas and panel geometry are temporary preferences; card geometry commits on Apply. Removal offers **Undo remove**, and **Review issues** opens the metric needing attention while valid metrics continue to preview.

Use **Dialog size** for keyboard-editable pixel width/height controls; the native resize corner remains available. **Reset layout** restores the modal and all pane widths without changing metric drafts. Card minimum widths apply equally in the layout canvas and saved dashboard; narrower containers scroll horizontally.

**Value** requires no grouping. Incompatible drafts show an actionable diagnostic and block Apply; standalone `MetricCard` also rejects grouped or multiple scalar buckets. Lists suppress magnitude bars for signed results. Charts visibly disclose missing/error points and drawing limits while keeping ordinary captions compact. Malformed remote box/histogram summaries produce a card-local diagnostic instead of throwing during rendering.

`MetricsPanel` renders values, lists, pivots/flat tables, bars, lines, pie/ring, scatter, box, and histogram cards through native SVG and accessible data tables/tooltips. Pass a `MetricTheme` as `metricTheme` to QueryBuilder and `theme` to MetricsPanel for consistent typed-category palette assignments. Labels, temporal units/patterns, legends, list styling, axis labels, and card dimensions are query-local. `MetricCard` and `MetricsEditor` are also exported for standalone integration.

See [the production metrics guide](../../docs/metrics.md). Run `npm run test:metrics` against the demo for authoring/layout/persistence and chart interactions.

## Cell displays

Set `FieldDef.display` for built-in JSON, date/time, duration, number/percent,
text, and chip presentation. JSON cells open a searchable tree with nested paths
and original/decoded copying; objects, JSON strings and escaped strings share
the same inspector. Custom `render` functions and registered keys take precedence.
See the [cell display guide](../../docs/cell-displays.md) for typed configuration,
units, examples, and inspection limits. `JsonCell` is also exported for standalone use.
