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

## Grouped rows

`useQueryTable({ schema, clientRows })` enables one row-producing grouping stage
for complete local datasets. The standard query builder supplies GROUP BY,
HAVING, aggregate column editing and representative-row ordering. Use
`api.schema`, `api.visibleFields` and `api.rowId` for the active result shape;
set `grouping: false` to opt out. Backend transports currently reject grouped
row queries. See [grouping integration](../../docs/grouping.md) for the query
shape, source-stage controls, saved state and execution boundaries.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react react-dom
```

## Client palettes and column roles

Import `theme.css` and override `--qt-*` properties on a wrapper around your
query table. Each instance can have its own palette; the library does not choose
one from the OS appearance. `color-scheme` can match the host's native controls,
but surfaces and role colors come from explicit tokens. Scoped tokens and
typography also follow pickers and dialogs into mobile portals, including live
changes to the wrapper's `class`, `style`, or `data-theme`.

The general palette uses `--qt-bg`, `--qt-text`, `--qt-muted`, `--qt-header-bg`,
`--qt-border`, and `--qt-border-subtle`. Actions use `--qt-accent` and
`--qt-accent-bg`; filled buttons additionally accept `--qt-accent-fg` (default
white) and `--qt-accent-hover` (default a darker accent).

Grouping roles have their own tokens, independent of actions and metric/chart
category colors:

| Prefix | Meaning | Default text color |
| --- | --- | --- |
| `--qt-column-key` | GROUP BY key | `#956000` |
| `--qt-column-aggregate` | Aggregated value, including custom formulas | `#7942a8` |
| `--qt-column-row` | Value from the group's representative row | `#08786d` |

Each prefix supports these suffixes:

| Suffix | Controls | Default |
| --- | --- | --- |
| `-color` | Role text, label, and badge | Color above |
| `-bg` | Badge and compact option background | 9% role color over `--qt-bg` |
| `-border` | Role selection border | 45% role color over `--qt-border` |
| `-hover-bg` | Hovered role option/control | 15% role color over `--qt-bg` |
| `-selected-bg` | Selected role option/column | Role `-bg` |

For example, a host adapter can map its own palette directly:

```css
.client-query-table {
  --qt-bg: var(--client-panel);
  --qt-text: var(--client-ink);
  --qt-accent: var(--client-accent);
  --qt-accent-fg: var(--client-panel);
  --qt-column-key-color: var(--client-key-label);
  --qt-column-aggregate-color: var(--client-aggregate-label);
  --qt-column-row-color: var(--client-row-label);
  /* Optional: choose a badge surface rather than deriving a tint. */
  --qt-column-key-bg: var(--client-key-surface);
}
```

`ColumnRoleBadge` accepts presentation metadata
`{ kind: "key" | "aggregate" | "row", badge: string, title: string }` and an
optional `className`. Use it with `DataTable.headerAdornment` and
`QueryBuilder.selectPresentation.renderChip`; a `.qt-column-label` wrapper
with the same `data-column-role` colors the field label too. Pass `undefined`
for ordinary ungrouped fields to omit the badge. The host determines provenance;
the component does not infer a role from a field's name or type. Role tokens
also style the grouped column options and column workbench.

The role text remains visible alongside color. Choose readable foregrounds
against your surfaces; you can use neutral colors without losing the KEY,
ROW, and aggregate labels. These presentation settings do not enter saved
queries. Metric category assignments remain in the separate `MetricTheme` API.
The `/grouping` demo includes adapters for Pharos' cream and forest palettes.

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
  available table area after loading and when that area changes. No column
  is trimmed below what its buttons and links need (links shorten to an
  ellipsis first); if those minimums exceed the screen, the table scrolls
  horizontally. Set `select.minWidth` on a field whose host renderer needs
  room the table cannot measure.
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
settings use this surface. `FieldPicker` accepts an optional `anchor` (or
`PickerAnchor` wrapper) for floating desktop use; otherwise it stays inline on
desktop. With `onClose`, it becomes a dismissible sheet on mobile. Omit `onClose`
to keep a standalone picker inline on all screen sizes. Tag multi-select editors and
full workbenches use the shared modal/sheet foundation with Apply/Cancel and focus
containment. Native selects, expandable sections, and formula autocomplete keep
their respective form, disclosure, and combobox interactions.

Distinct filter values use a freeform combobox. Focus or click the value input
to open suggestions; Arrow Up/Down highlights a choice and Enter selects it.
Escape dismisses suggestions and Tab leaves without selecting. The menu sizes
to its contents independently of the compact input, wraps long values, and
scrolls within the viewport, including inside mobile filter dialogs. Loading,
unavailable suggestions, and no matches never prevent typing arbitrary values.
While fetching new suggestions, matching values from the previous response stay
visible and selectable. A loading message appears only when no known values match.

## Tag/set filters

Set `filter.editor: "set"` on a `textarray` field to use the native WHERE
multi-select editor, with ANY / ALL / NONE / EMPTY modes, badge presentation,
removable tags, keyboard controls, and a mobile bottom sheet. For stable tag
keys, also set `arrayCaseSensitive: true` and provide static `{ value, label }`
options. NONE includes empty/missing arrays while excluding every selected key.
`enum` fields, and `text` fields with static `filter.values.options`, can opt in
too: they get ANY ("is one of") and NONE ("is none of", keeping empty rows)
without writing one `!=` term per value. Other fields and existing predicates
keep their current editors.

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

`QueryBuilder` has an inline **Query** label and chevron in its toolbar to fold
the editor. Set `defaultCollapsed` for its initial state, or use `collapsed` and
`onCollapsedChange` to control it from a parent. Folding keeps the current query,
its summary, saved-query controls, history, and run actions available; pass
`summary` to replace the default folded summary. The demo's Metrics and Table
sections fold independently through their inline labels, with metric and row
counts visible in their headers and 44px touch targets on small screens.

`DataTable` virtualizes body rows and uses a 600px maximum-height scroll
viewport by default. Set `maxHeight` to match the surrounding layout;
`estimateRowHeight` (37px by default) and `overscan` (8 rows) are available for
unusually sized or expensive custom row renderers. Visible rows are measured,
so the estimate does not require every row to have a fixed height.

The bundled `link` renderer allows only HTTP(S), email, telephone, relative,
and fragment URLs. Applications remain responsible for validating URLs emitted
by custom renderers.

Pass `savedQueryControls` to `QueryBuilder` to replace its built-in saved-query
name/star, Update action, and Saved menu with host-owned React controls; omitting
the prop keeps the default interface. Use `api.saved` for persistence and loading,
and handle selection, save feedback, and unsaved-edit protection in your controls.
Share and query history remain available. The demo's `/saved-queries` route shows
an integrated prototype of this slot.

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

### Responsive target sizing

Set the public, unitless `--qt-touch-target-scale` CSS custom property to
configure the **added** touch-target size in the bundled theme:

| Value | Target sizing |
| --- | --- |
| `1` (default, including when unset) | Existing responsive enlargement |
| `0.5` | Half the added size |
| `0` | Desktop target sizing with the responsive layout |

```css
/* Scope to a host wrapper containing the builder, table and metrics. */
.pharos-query-table {
  --qt-touch-target-scale: 0.5;
}
```

For each enlarged dimension, the theme uses
`desktop + (responsive - desktop) * scale`. A desktop 24px button that normally
grows to 44px therefore becomes 34px at `0.5`. Each control uses its own desktop
baseline, including its line box, padding and borders; collapse controls, chips,
picker rows and editor buttons have different baselines. Narrow and coarse
pointer rules use the final responsive size once, so matching both does not
compound the enlargement. Use a number from `0` to `1`, without a unit.

The setting covers query actions/chips, table cells/actions, picker and menu
rows, selection actions, saved-query controls, JSON controls, and select,
property and metric editor controls. Content remains a lower bound: wrapped
labels, icons, native controls and the retained mobile input fonts can require
more room than the scaled minimum. Existing responsive size reductions stay
compact. Layout widths, wrapping, sheets, scrolling, focus behavior, drag/touch
actions, breakpoints and input font sizes are independent of the factor.

Use `:root` for an application-wide setting, or a wrapper for independent
instances. Built-in portaled menus, pickers, dialogs and sheets inherit the
setting from their trigger/overlay anchor through the same theme propagation
as the palette, including live ancestor `class`, `style` and `data-theme`
changes. Keep standalone overlays beneath that wrapper in the React tree (and
their anchor within it). Host-owned portals and controls with custom styling
must propagate/apply their own sizing. `QueryBuilder`'s `compact` prop controls
clause presentation separately.

Run `npm run test:touch-targets` with `npm run demo` running to check relative
sizing, scoped portal updates and interactions in Chromium and WebKit.

### Responsive layout and interactions

The bundled theme keeps the table as a horizontally scrollable grid on narrow
screens so columns remain comparable. Narrow screens (up to 760px) and short,
touch-based landscape viewports use a mobile interaction model:

- **Tap to edit or delete:** filters, sorts, and metrics become readable summaries
  with pencil buttons. Remove actions live inside the editor, including removal
  of an entire OR group, and support Undo. There are no inline trash buttons.
  Adding a filter or metric opens its editor. Add sort lets you choose a field,
  then ascending or descending before committing; Back returns to the same field search.
  Filters can be combined with OR without relying on drag-and-drop.
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
  without divider lines between clauses on desktop and mobile.
- **Dense query setup:** filter, sort, and metric actions share a section header.
  Summaries use one line when space allows and wrap without truncating values.
  Labeled condition/value and function/measure pairs replace wrapping desktop
  chips. Sort direction and null-value placement use native selects; regex
  extraction stays optional. It is available from Add sort's field options or its detailed-sort caret, with direction configurable in the dialog. Plain desktop sort chips omit the extraction action; configured extractions remain editable. Its configuration opens a dialog (a bottom sheet on small screens) with a live, worker-isolated preview of up to 100 matching rows. The preview shows original values, extracted sort values, and no-match/null states; Apply commits any syntactically valid pattern even when the preview is unavailable or still loading, while Cancel leaves the sort unchanged. Grouping uses removable tags and a field picker.
  Simple metric results share two-column rows; grouped results use the full width.
- **Touch-first controls:** dedicated drag handles, 16px text inputs,
  sticky bulk actions, a horizontal table scroll cue, and the device's native
  share sheet when available (clipboard fallback otherwise).

Filter and sort edits update the query immediately; **Done** dismisses the sheet. The column and metric workbenches retain explicit **Apply** draft workflows. Desktop chips, popovers, and drag-and-drop remain available.

In compact mode, **Add offset** reveals and focuses the inline offset input without changing the query. Enter or blur commits the value; the clear action returns to **Add offset**.

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

### Shared editor components

`EditorModal`, `useEditorWorkbench`, `EditorPanelToggle`, and
`EditorPanelSeparator` provide the shared shell and panel geometry used by the
metric editor and the grouped column editor. The hook accepts a
fixed list of `{ width, minWidth, defaultVisible? }` panel sizes in pixels. Attach `root` to the
workspace, build its grid from `visibleIndices` and `widths` with 6px separators,
and hide panels with `visiblePanes`. The modal wires the header and Reset layout;
its `panelControls` slot places panel toggles beside Reset layout. Pass the same
workbench to panel toggles and separators. Reset restores dialog/pane sizes and
each panel's current `defaultVisible` setting (true when omitted). Defaults can
follow the selected column; changing them alone does not override manual toggles.
Separators support
pointer drag, arrow keys (Shift for larger steps), Home/double-click reset, and
Escape to cancel a drag. Toggles keep at least one panel open. Geometry stays
separate from query drafts; the consumer owns draft validation, Apply/Cancel,
panel contents, and responsive section navigation.

`FormulaEditor` is also exported for reuse. Supply `value`, `onChange`, `fields`,
and `compile`; an optional `functions` catalogue drives completions, signature
help, and the Function library. Row formulas use `FORMULA_FUNCTIONS` by default.
Aggregate editors can combine core's `METRIC_FUNCTIONS` and `FORMULA_FUNCTIONS`
with `compileMetric`, including `MEDIAN`. A catalogue describes available
functions; the supplied compiler determines which expressions are valid.
For a separate function panel, set `showLibrary={false}` and connect the exported
`FormulaFunctionBrowser` with `variant="panel"` to the editor's
`actionsRef.current.insertFunction(name)`. This preserves cursor/selection and
native text undo. Omitting the browser's `onInsert` makes it a reference-only
library when no formula is selected.

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

QueryBuilder offers **Add metric** while the query has no metrics. Once metrics exist, editing moves to the always-visible **Edit** button in `MetricsPanel`, which opens the resizable four-pane `MetricsEditor`. Apply commits drafts together; Cancel discards them. Dashboard layout provides draggable canvas widths, whole-rem card sizing through corner handles or inputs, canvas presets, pointer/keyboard reordering, and inline names. Metrics use their own workbench on desktop and compact viewports; their changes commit on Apply.

Use the icon buttons beside **Panels** in the modal header to show or hide the metric list, definition, references, and preview. At least one panel stays visible; the metric picker and Previous/Next controls remain available when the list is hidden. **See in dashboard** reveals the selected card in the same draft; **Back to metric**, the card’s pencil action, or a double-click returns to editing. Open settings and panel preferences survive these transitions.

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
Detail properties inherit these displays and embed initially collapsed JSON
trees in popovers, modals, and expanded rows. A button beside the property label
opens the full viewer with Filter/Find search, match navigation, and copy
controls. JSON property options can be edited, saved, and shared through the
existing property-view controls.
See the [cell display guide](../../docs/cell-displays.md) for typed configuration,
units, examples, and inspection limits. `JsonCell` and the embedded `JsonValueView`
are also exported for standalone use.

## Compact metric covers

`<MetricCard compact clause={clause} result={result} fields={fields} />` uses
sparse round numeric ticks and short unit labels for a small chart. Calendar
charts keep the computation timezone and use sparse local calendar boundaries;
bar timelines render chronologically. This is a rendering option, so saved query
formats and full data values are unchanged. Explicit axis bounds are respected.

Compact Cartesian charts put both axis titles below the plot on one line,
with ↑ for the vertical axis and → for the horizontal axis. The compact plot
reserves only the tick gutter, allowing more width for data. Full charts retain
their usual title placement. Metric loading uses an accessible spinner and
respects reduced-motion preferences.

Compact box plots label each row above its glyph and show its median. All
visible rows share one axis spanning their full observed range, including
sampled outliers and true extremes. `display.xScale` selects linear or log
coordinates and retains explicit bounds; as in full charts, nonpositive boxes
are omitted on a log axis with a visible explanation. Allow about 30px per row,
20px for the shared ticks, and room for the guide; constrain the supplied bucket
count when using a fixed-height cover.

Linear-interpolated quartiles in sparse samples can extend past the last
observed Tukey inlier. Visual whiskers meet the box edge in that case rather
than ending inside it. Hover retains the original quartiles, observed whisker
endpoints, full range, mean, sample count, and outlier count. Neither the
computation nor the returned summary is modified.

Tooltips include the hovered series color. Their hover/focus state is isolated
from plot construction, so moving between marks does not rebuild axes or
reformat chart labels. Escape dismisses the tooltip before reaching an enclosing
dialog. Compact histogram tooltips show the interval and its frequency; full
charts and data tables retain population and NULL counts.

Compact pie/ring legends in top/bottom positions use aligned category, value,
and share slots in two columns. Set `--qt-metric-legend-columns: 1` on the card
for a single column, or use the `MetricClassNames.legend` CSS hook. These are
host presentation choices and do not change the saved query or exact pie
denominator. Native SVG charts preserve the viewport aspect ratio, including
circular pie/ring geometry and circular scatter markers.

### Underline list bars

Use `display: { kind: "list", list: { barPosition: "below" } }` to put a thin
bar under each label and value. Labels wrap across the available row instead of
being ellipsized in a narrow column. The default `"inline"` layout keeps the bar
beside the label. The metric editor exposes both under **Bar placement**. This
setting survives query links and saved views; it does not change computation,
sort order, values, or the `showBars` / `showValues` switches.

Set `display.list.maxLabelLines` to a positive integer to cap the wrapped label
height when `barPosition` is `"below"`, for example
`list: { barPosition: "below", maxLabelLines: 2 }`. Omit it for unlimited lines;
the editor's **Maximum label lines** input accepts a blank value for unlimited.
The limit has no effect on inline bars. Truncated labels keep their full text in
the tooltip, and the limit survives query links and saved views.

### Visible groups and remainder

`display.maxGroups` caps displayed groups in result order without changing the
metric computation or its server `groupLimit`. It is a positive integer, and
the editor exposes it as **Maximum displayed groups**. Omission retains the
automatic layout limits (for example eight pie slices and six histogram series).

`display.showOther` controls the synthetic remainder in pie/donut charts
(default true) and lists (default false). Lists combine only exact additive
counts or sums, with complete results or an exact server remainder. Averages,
rates, missing values, and partial results never produce an invented remainder.
Hiding a pie remainder retains the full denominator and leaves its angular
share empty; it does not rescale the selected groups to 100%. A real group named
Other remains visible. Both settings survive query links and saved views.
Use `display.legendPosition: "none"` to hide the chart key.

JSON inspection choices now travel with item query links and snapshots. See
[portable inspection state and semantic attention](../../docs/json-inspection-state.md).
