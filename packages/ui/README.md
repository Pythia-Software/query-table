# @pythia-software/query-table-ui

Opinionated, themeable React components for query-table, including the data
table, query builder, field picker, metrics panel, saved queries, cell menus,
and selection toolbar.

## Install

```bash
npm install @pythia-software/query-table-core @pythia-software/query-table-react @pythia-software/query-table-ui react
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

The bundled `link` renderer allows only HTTP(S), email, telephone, relative,
and fragment URLs. Applications remain responsible for validating URLs emitted
by custom renderers.

The query builder's **Share** button copies a URL containing the complete
current query, including a saved default query. Configure `useQueryTable` with
`syncUrl: true` so recipients load shared query URLs. Query tokens are encoded,
not encrypted, and may contain raw filter values.

See the [repository README](https://github.com/Pythia-Software/query-table#readme)
for customization and backend integration details.
