# Changelog

## 0.4.2 — 2026-09-20

- Add opt-in `filter.arrayCaseSensitive` for exact text-array keys in local queries, metrics, PostgreSQL compilation, native macOS queries, and generated schemas. Existing fields remain case-insensitive.


## 0.4.1 — 2026-09-20

- Resolve keyboard selection to canonical option keys after searching display names.
- Display object-option labels even without a custom presentation provider.


## 0.4.0 — 2026-09-20

- Add generic stable-value/display-label options and rich filter presentation for
  current values, searchable static choices, and cell quick filters.
- Add consumer query canonicalization and whole-query validation hooks for both
  local and server rows/metrics; rejected queries retain editable state and clear results.
- Preserve string option and unconfigured consumer compatibility.


Notable user-visible changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, minor releases may
contain intentional API changes described in their release notes.

## [Unreleased]

### Fixed

- Native compact query imports preserve valid WHERE predicates when neighboring
  members are malformed, matching React's member-by-member normalization.
- Native column display honors an explicitly empty `defaultSelect`, keeping
  visible columns consistent with backend projections.

### Added

- Format large row totals with grouped or compact counts and reveal exact totals on hover.
- Native macOS Swift packages with an AppKit table, SwiftUI query builder,
  column layout, multi-sort, selection, saved queries, metrics, and query history.
- Shared schema/query JSON contracts, compact query tokens, pluggable asynchronous
  transports, HTTP integration, and an in-memory adapter for native applications.
- Native computed-column editing and sampled previews using the shared qt-expr
  interpreter in JavaScriptCore. Regex formulas report unsupported explicitly.
- A runnable macOS sample, integration checks, XCTest coverage, and macOS CI.

## [0.3.0] - 2026-09-17

### Added

- Added a wide SELECT editor with column ordering, a searchable catalogue,
  sampled value frequencies, and grouped live formula previews.
- Added reusable computed SELECT columns with text, regex, numeric, conditional,
  array, and UTC date operators, evaluated in bounded browser workers.
- Added shared definition storage by ID with optimistic revisions, HTTP and
  in-memory adapters, and an optional authorized PostgreSQL-backed Go endpoint.
- Added formula documentation and regression coverage for Unicode limits,
  opaque revisions, missing-definition repair, and worker timeout recovery.
- Added positive and negative regex filters plus regex-extract ordering across
  query state, local execution, the QueryBuilder UI, schema codegen, and the Go
  PostgreSQL compiler.
- Added atomic `selection.replace(ids)` and `selection.retain(ids)` operations;
  `SelectionToolbar` action callbacks now also receive the public selection API.
- Added filter negation and OR groups (conjunctive normal form). Any predicate
  can be negated — ops flip to their complement (`>=`→`<`, `=`→`!=`,
  `is_null`→`is_not_null`) or carry a null-exclusive `negated` flag when they
  have none (`contains`/`starts_with`/`ends_with`/`includes`). WHERE filters are
  now draggable chips: drop one onto another to build an OR group and drag more
  in later. Spans query state, local execution, `?q=` encoding, saved queries,
  the QueryBuilder UI, a two-column positive/negative CellMenu, and the Go
  PostgreSQL compiler.

### Changed

- The Go backend now enforces per-field `filter.ops` overrides when compiling
  queries.
- `QueryState.where` is now `WhereTerm[]` — each term a predicate or an
  `{ any: [...] }` OR group — instead of a flat `WhereClause[]`; flat legacy
  queries and `?q=` tokens decode unchanged. `useQueryTable` adds
  `updatePredicate`, `removePredicate`, `negatePredicate`, `reorderFilters`, and
  `mergeFilters` intents. The WHERE operator control is a keep/exclude picker —
  the same two-column layout as the CellMenu, with the active choice
  highlighted — so a predicate and its negation are chosen from one place
  instead of a separate operator dropdown and NOT toggle.

### Security

- Updated Vitest to resolve a development-time path traversal advisory.

## [0.2.0] - 2026-09-08

### Added

- Added a QueryBuilder Share button that copies the current query as a URL,
  including when the current query is a saved default.

### Changed

- Added responsive and touch-friendly UI behavior, including horizontally
  scrollable tables, touch-sized controls, button-based query-chip reordering,
  sticky row selection, single-column metric cards, and bottom-sheet overlays.
- `DataTable` now virtualizes its body rows inside a 600px maximum-height
  viewport, keeping large client-side result sets responsive. Consumers can
  tune the viewport, row-height estimate, and overscan with component props.
- Removed the package-level 1,000-row query limit. Consumers and their backends
  can apply smaller operational caps when appropriate.
- Improved large-table column resizing by using a frame-coalesced resize guide
  and avoiding row recomputation or transport refetches for width-only changes.

### Security

- Updated transitive development tooling dependencies to address known
  `browserslist` and `fast-uri` advisories.

## [0.1.0] - 2026-08-10

### Added

- Publishable ESM builds and declarations for the core, React, UI, and schema
  codegen packages.
- A working `query-table-codegen` CLI and programmatic generation API.
- Package-level documentation, release verification, CI, Dependabot, security
  policy, contribution guidance, and community standards.
- Runtime query normalization and matching TypeScript/Go resource limits.
- Safe-protocol enforcement for the generic link renderer.

### Changed

- URL synchronization and durable browser storage are now explicit opt-ins.
- Package manifests use the initial `0.1.0` version and public scoped-publishing
  metadata.

### Security

- Updated the JavaScript toolchain to remove known dependency advisories.
- Added Git-history secret scanning and Go/npm vulnerability checks to CI.

[Unreleased]: https://github.com/Pythia-Software/query-table/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Pythia-Software/query-table/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Pythia-Software/query-table/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Pythia-Software/query-table/releases/tag/v0.1.0
