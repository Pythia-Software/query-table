# @pythia-software/query-table-ui

Opinionated, themeable React components for query-table, including the data
table, query builder, field picker, metrics panel, saved queries, cell menus,
and selection toolbar.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react react-dom
```

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

`SelectionToolbar` action callbacks receive `(selectedIds, selection)`, so
consumer-owned bulk actions can call `selection.replace(ids)` or
`selection.retain(ids)` atomically. Existing callbacks that use only the first
argument remain compatible.

## Icons

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

Edits continue to update the query immediately, as on desktop; **Done** dismisses
the sheet. The column workbench retains its explicit **Apply columns** draft
workflow. Desktop chips, popovers, and drag-and-drop remain available.

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

`QueryBuilder` includes a split **Add** button and **Reset** action for Columns: Add opens the field picker, while its caret opens the column customizer. Actions follow the selected chips on desktop and sit in the section header on small screens. The exported `SelectColumnEditor` also accepts `{ api, onClose }` for standalone use. It supports draft column ordering, a searchable catalogue, sampled value frequencies, and a lazy-loaded CodeMirror formula editor with grouped live previews and regex inspection. Shared-definition saves and query-layout application are separate actions.

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
