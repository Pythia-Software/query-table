# Native tag/set filters

Opt in with `filter.editor: "set"` on a `textarray` field. Scalar fields and
unconfigured array fields retain the existing single-predicate UI. To preserve
case-sensitive stable keys, set `filter.arrayCaseSensitive: true`. Static
`filter.values.options` can contain strings or `{ value, label }` objects.
The demo's **Error codes** field demonstrates adoption through schema config.

The native WHERE field picker opens a searchable checkbox multi-select. Static
choices search keys, schema labels, and `FilterValueProvider.label` names; the
provider's `render` presents badges in choices and selected chips. Autocomplete
fields use `api.filterValues` and search the returned keys/names. Applications
whose names live outside the transport should provide a static catalogue for
complete display-name search. Matching search is case-insensitive, but choosing
a value always stores its exact key. Display changes never rewrite predicates.
Freeform and autocomplete fields also allow adding a nonblank typed key with
Enter or the explicit Add button, even when there are no suggestions. Enter
selects the first matching suggestion when one is available; static fields
only accept existing options. Typed keys retain their exact case and spacing,
and adding an already-selected key does not remove it.

Keyboard users choose modes with the native select, Tab through controls, and
toggle checkboxes with Space. Escape cancels without changing the query; focus
returns to the explicit trigger: the WHERE chip for edits, or the persistent
**+ add filter** button for new filters. That same element anchors the popover,
independent of whether clicking it gave it browser focus. The popover contains
focus and becomes a bottom sheet
below 600px. Apply commits atomically and resets pagination. Selected tags can
also be removed directly from the WHERE chip. Removing the final tag removes
that filter; applying an empty selection is disabled except in EMPTY mode.

## Execution contract

For keys `a` and `b`, `createSetFilter("tags", mode, ["a", "b"], editorId)`
produces the existing WHERE language:

| Mode | Top-level AND terms |
| --- | --- |
| ANY | `(includes(a) OR includes(b))` |
| ALL | `includes(a) AND includes(b)` |
| NONE | `(is_null OR NOT includes(a)) AND (is_null OR NOT includes(b))` |
| EMPTY | `is_null` |

`is_null` on a textarray means NULL/missing **or an empty array**. A bare negated
membership predicate remains null/empty-exclusive. NONE adds the empty branch
explicitly. The local executor and bundled PostgreSQL compiler implement these
semantics. The PostgreSQL compiler now uses `COALESCE(cardinality(expr), 0)` for
array nullity and negated-array guards, fixing its prior empty-array mismatch.
Custom backends must implement the same semantics; no new operators or wire
capabilities are required. `filter.ops` must allow `includes` and `is_null` for
all four modes. The editor disables unsupported modes and rejects selections
that exceed the existing 100-predicate query budget (NONE costs two per key).

## Editor identity, saved queries, and migration

Every term emitted by one editor carries presentation-only metadata:

```json
{ "setFilter": { "id": "opaque-editor-id", "mode": "all", "values": ["a", "b"] } }
```

The predicates remain the execution authority. `readSetFilter(where, index)`
recognizes only explicitly marked, contiguous terms whose predicates and
metadata exactly match the compiler's output. It never infers a set from
unrelated includes predicates or a legacy OR. Fragmented or altered output
falls back to ordinary predicate editors rather than absorbing other filters.

Normalization, compact URL tokens, saved query storage, and undo/redo preserve
the metadata, including singleton ANY versus ALL versus NONE. EMPTY stores no
keys. `toServerQuery` and `toAggregationQuery` strip metadata from all terms and
inner predicates. Custom transports should use these existing projections, not
send editor metadata as an operator. Unrelated filters are unchanged on edit.

No token-version bump, saved-query migration, transport capability negotiation,
or backend schema migration is necessary: this is additive editor metadata, not
a new predicate representation. Older clients still evaluate the predicates,
but their normalization may discard editor identity when saving/sharing. A
round trip through those clients (including native clients without metadata
support) can therefore reopen as ordinary predicates. Deploy matching core,
react, and ui versions to retain editing identity. Existing legacy queries
remain ordinary predicates/ORs and keep their meaning.

## Aliases and unavailable keys

Value aliases belong to the application, not to option labels. Use the existing
pure `canonicalizeQuery` callback with `mapSetFilterValues`:

```ts
canonicalizeQuery: (query) => ({
  ...query,
  where: mapSetFilterValues(query.where, (field, key) =>
    field === "tags" ? (aliases[key] ?? key) : key),
})
```

This rebuilds explicitly marked sets, updates both keys and predicates, and
deduplicates aliases that resolve to the same exact key. Unmarked predicates
are untouched; retain the application's existing canonicalizer for those.
Never replace an unknown key with its display name. Static choices mark missing
selected keys as unavailable, retaining them for removal or replacement. An
autocomplete result is incomplete, so absence there is not proof of deletion.
`validateQuery` can reject deleted keys before rows/metrics execute; the query
and set editor remain available for repair.

## Verification and release

Core tests cover all modes against `[]`, `[a]`, `[b]`, `[a,b]`, `[c]`, `[A]`, and
NULL, plus transport projection, singleton identity, legacy OR compatibility,
and metadata bounds. UI tests cover adding/searching, badge rendering, editing,
pagination reset, alias/deletion repair, keyboard focus/Escape, and history.

The Go integration test executes the same matrix on real PostgreSQL with
prepared, bound keys. It is opt-in and uses standard libpq connection settings:

```sh
cd backends/go
QUERY_TABLE_TEST_POSTGRES=1 PGHOST=/path/to/socket PGDATABASE=postgres go test ./...
```

The feature ships in the normal core/react/ui package builds. Follow the
repository's existing release process to publish matching versions; no consumer
forks, dependency patches, DOM portals, or backend operators are needed.
