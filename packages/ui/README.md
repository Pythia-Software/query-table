# @pythia-software/query-table-ui

Opinionated, themeable React components for query-table, including the data
table, query builder, field picker, metrics panel, saved queries, cell menus,
and selection toolbar.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react react-dom
```

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

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for customization and backend integration details.
