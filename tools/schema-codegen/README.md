# schema-codegen

Projects a JSON schema document (`schema/*.schema.json`, validated against
`schema/query-table.schema.json`) into the two consumable forms, so the
frontend and backend can never drift:

```
runs.schema.json
   ├── --ts  runs.fields.generated.ts   →  export const RUNS_FIELDS: FieldDef[]
   └── --go  runs_schema_generated.go    →  func RunsSchema() querytable.Schema
```

Generalizes the pattern explo already ships (`metricsFields.generated.ts` is
generated from `perfmetrics.Registry()`) to the entire field catalog.

```
schema-codegen <doc.schema.json> --ts <out.ts> [--go <out.go> --go-package <pkg>]
```

The TS output drops backend `bindings` (the frontend never sees SQL) and leaves
`render` as a string key (the consumer maps it to a real renderer at runtime).
The Go output reads `bindings.postgres` into `FieldSpec{Expr, Kind, Synthetic}`
and omits `serverFilter:false` fields from the filterable set.

Status: contract only — the generator is not implemented yet.
