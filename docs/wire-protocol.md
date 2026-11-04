# The v3 wire protocol

Every JSON value that crosses the v3 query wire (the capabilities handshake,
`QueryRequestV3` and `QueryResultV3`) is described by one JSON Schema
(draft 2020-12):

```
schema/query-wire.schema.json
```

That file is the source of truth. The TypeScript, Go and Swift wire types are
generated from it, and golden fixtures check that all three encode and decode
the same JSON.

| Language   | Generated file                                             | Public names                                                    |
| ---------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| TypeScript | `packages/core/src/wire.generated.ts`                      | re-exported by `queryV3.ts`, `encode.ts`, `query.ts`, `computed.ts`, `groupKeys.ts`, `metricTypes.ts` (`QueryRequestV3`, `QueryResultV3`, `QueryCapabilitiesV3`, `ServerQuery`, ...) |
| Go         | `backends/go/wire_generated.go`                            | package `querytable` (`QueryRequestV3`, `WireQuery`, `AggSpec`, `MetricResult`, ...) |
| Swift      | `native/macos/Sources/QueryTableCore/Wire.generated.swift` | `QueryTableCore` (`QueryRequestV3`, `ServerQuery`, `AggregationBucket`, ...) |

Builders, validation and convenience initializers stay hand-written next to
the generated types: `toQueryRequestV3` and friends in TypeScript,
`DecodeQueryRequestV3` and `Validate` in Go, and the `extension`s in Swift's
`Transport.swift`.

## Encoding rules

- **Property order** in the schema is the encoding order. Go encodes struct
  fields in that order, and the TypeScript builders emit request envelopes,
  stages and predicates in the same order, so the builder fixtures and their
  Go re-encodings are byte-identical. (Metric specs built from saved
  aggregation clauses keep the clause's key order; order is not semantic.)
  Swift's `JSONEncoder` does not keep key order; Swift is compared on sorted
  keys.
- **Required properties are always present.** A required list or map is `[]`
  or `{}`, never omitted or `null`, in every language (Go writes nil slices
  and maps as empty). Decoders still accept `null` for the maps older Go
  servers wrote as `null` (`expectedRevisions`, `resolvedRevisions`, `fields`).
- **Optional properties are omitted** when unset, except the capability flags
  and `MetricResult.scope`/`processedRows`/`groupCount`, which Go always writes
  (`x-go-omit: none`).
- Go escapes `<`, `>` and `&` in strings as `<`, `>` and `&`
  (the default of `encoding/json`). This is the same JSON string; it is the
  only byte difference between the encoders, and the Go conformance test
  undoes it before comparing.

## Changing the protocol

1. Edit `schema/query-wire.schema.json`. Keep `additionalProperties: false`
   on request objects: the Go decoder rejects unknown keys.
2. Run `npm run wire:generate` and commit the three generated files.
   `npm run wire:check` (part of `npm run check`) regenerates them and fails
   if they differ from what is committed.
3. Update or add golden fixtures in `schema/fixtures/wire/requests` and
   `schema/fixtures/wire/results`. Fixtures are formatted as
   `JSON.stringify(value, null, 2)` plus a newline, in schema property order;
   row objects and maps use sorted keys (Go sorts map keys). The builder
   fixtures (`rows.json`, `distinct.json`, `row-lookup.json`,
   `field-stats.json`) are produced by the TypeScript builders; after an
   intended change, regenerate them with
   `WIRE_FIXTURES_UPDATE=1 npx vitest run packages/core/test/wireConformance.test.ts`.
4. Run the conformance suites:
   - TypeScript: `npx vitest run packages/core/test/wireConformance.test.ts`
     (every fixture and builder output validates with ajv; builder outputs
     equal their fixtures byte for byte).
   - Go: `cd backends/go && go test -run TestWire .` (request fixtures decode
     with `DecodeQueryRequestV3`, result fixtures into `QueryResultV3`, and
     both re-marshal identically).
   - Swift: `swift run --package-path native/macos QueryTableChecks` (and
     `WireFixtureTests` under Xcode): every fixture decodes and re-encodes to
     the same JSON.
   - `node native/macos/scripts/check-wire-compatibility.mjs` compares the
     TypeScript and Swift request builders.

## Generator keywords

The `x-` keywords configure the generators; validators ignore them.

| Keyword | Meaning |
| --- | --- |
| `x-ts-name`, `x-go-name`, `x-swift-name` | The type's name in one language (default: the `$defs` key). Property-level `x-go-name`/`x-swift-name` rename a field (`where` is `whereTerms` in Swift). |
| `x-go-repr`, `x-swift-repr` | A different representation of the same JSON, such as `int64`, a pointer that keeps `0` distinct from absent, or `Int64`. |
| `x-go-omit` | `none` always writes the field; `omitzero` uses Go's `omitzero`. The default is `omitempty` for optional fields. |
| `x-go-extra` | Unserialized Go fields appended to the struct. |
| `x-swift-case` | The enum case of a union variant. |
| `x-swift-default`, `x-swift-init` | Default arguments of the generated memberwise initializer, or `false` for no initializer (one is hand-written in an extension). |
| `x-ts-type`, `x-go-type`, `x-swift-type` | **Escape hatch**: the type is hand-written in that language. |

## Escape hatches

An escape hatch is for JSON that is genuinely polymorphic, where a generated
type would be worse than the hand-written one. The schema still describes the
JSON completely, the fixtures cover it, and each escape is kept as small as
possible:

| Schema type | Language | Hand-written type | Why |
| --- | --- | --- | --- |
| `WhereClause`, `WhereConjunction`, `WhereBranch` | Go | `WhereClause` | One struct carries a literal or an `{"all": [...]}` branch, so the SQL compilers walk one type; its `MarshalJSON` writes exactly one shape. |
| `WhereTerm`, `OrGroup` | Go | `WhereTerm` | A literal or an `{"any": [...]}` group in one struct; it also carries the presentation-only `setFilter` used by query links, which never reaches the v3 wire. |
| `WhereTerm` | Swift | `WhereTerm` | The native editor works on `.predicate` and flat `.any` groups; OR groups with conjunction branches decode as `.group(OrGroup)` and re-encode unchanged. |
| `MetricMinCount` | Go | `MetricMinCount` | A number (rows) or `{min, distinct}` / `{min, sum}`. |
| `GroupingDefinition` | Go | `GroupingDefinition` | `keys` mixes field names and calendar keys; Go stores names plus a `KeyIntervals` map. |
| `MetricDistributionResult` | Go | `MetricDistributionResult` | A box or histogram union discriminated by `kind`. |
| `hostState` | Go, Swift | `json.RawMessage`, `JSONValue` | Host-owned state, passed through uninterpreted. |
| `MetricSort.key` | TypeScript | `` "value" \| "y" \| "count" \| "samples" \| `group${number}` `` | A template literal type is more precise than `string`. |

Scalar unions such as `MetricValue` (number, string, boolean or null) are not
escape hatches: they generate `any` in Go and `JSONValue` in Swift.
