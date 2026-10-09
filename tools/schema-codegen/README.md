# @pythia-software/query-table-codegen

Projects a query-table JSON schema document into frontend TypeScript and a
direct Go backend schema literal, keeping both projections in lockstep.

## Install

```bash
npm install --save-dev @pythia-software/query-table-codegen
```

## Generate

```
runs.schema.json
   ├── --ts  runs.fields.generated.ts   →  export const RUNS_SCHEMA / RUNS_FIELDS
   └── --go  runs_schema_generated.go    →  func RunsSchema() querytable.Schema
```

This keeps the frontend and backend projections of a field catalog in lockstep.

```
query-table-codegen runs.schema.json \
  --ts src/runs.fields.generated.ts \
  --go internal/catalog/runs_schema_generated.go \
  --go-package catalog
```

The TS output drops backend `bindings` (the frontend never sees SQL) and leaves
`render` as a string key (the consumer maps it to a real renderer at runtime).
The Go output reads `bindings.postgres` into `FieldSpec{Expr, Kind, Synthetic}`
and emits server-filter/sort capabilities directly, without runtime JSON
parsing.

The generated Go file imports
`github.com/Pythia-Software/query-table/backends/go` by default. Override that
path with `--go-import` when using a fork or a vendored module.

The package also exports `generateTypeScript` and `generateGo` for build-tool
integrations.

## SQLite

Pass `--dialect sqlite` with `--go` (or `{ dialect: "sqlite" }` to `generateGo`)
to read `bindings.sqlite`. The default remains `postgres`; neither dialect falls
back to the other's expressions. SQLite bindings support `datetimeFormat`:
`rfc3339`, `utc-millis`, `unix-seconds`, and `unix-millis`. The frontend projection
continues to omit backend SQL. See [the SQLite guide](../../docs/backend-sqlite.md).
