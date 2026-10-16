# Changelog

## Unreleased

## 0.7.1 — 2026-10-16

### Changed

- Compact box covers use a shared axis, honor linear/log settings, draw denser
  rows, and retain sampled outliers and actual extrema. Sparse interpolated
  quartiles no longer leave whisker caps inside the box in compact or full charts;
  observed statistical endpoints remain available in tooltips and data tables.
- Isolate chart tooltip state so hovering or focusing marks does not reconstruct
  axes or formatted labels. Tooltips include the actual series color, including
  multi-series lines. Compact histogram tooltips omit the repeated population
  denominator while full charts retain it.
- Give compact top/bottom pie/ring legends aligned category/value/share fields
  and two-column layout, configurable through `--qt-metric-legend-columns`.
  Query definitions, exact denominators, computation, and backend protocols are
  unchanged.

## 0.7.0 — 2026-10-14

### Added

- Add optional compact metric covers, bounded display group counts with additive
  Other remainders, and configurable list bar placement and label wrapping.
- Add a reusable TypeScript DuckDB backend profile for native and Wasm
  connections, including parameterized filters, metadata, metrics, exact
  distributions, grouped rows/HAVING, representative rows and calendar metrics.
- Add a static public demo with versioned NYC 311, NYC taxi and Open Food Facts
  Parquet cohorts, a saved-query sidebar, an action-checked guided tour, item details and a
  GitHub Pages workflow building from the current library source.

- Add a saved-query interface prototype at `/saved-queries` with a native query
  select, adjacent save actions, explicit loading/saving states, a transient
  saved confirmation, and protection for unsaved edits when switching queries.
  Add an optional `QueryBuilder.savedQueryControls` slot for host-owned controls.
- Add row-producing GROUP BY for complete client datasets, with source filters,
  HAVING, result sorting and paging, custom aggregate formulas including MEDIAN,
  and one representative row chosen by configurable ordering. Preserve grouping
  in saved views, URLs and history, and evaluate metrics over matching or shown
  groups. Legacy backend transports explicitly reject grouped-row queries;
  negotiated v3 transports execute them on the server.
- Add opt-in v3 SQLite/PostgreSQL execution for grouped rows, canonical computed
  source filters, representative rows, HAVING, and calendar/timezone metrics,
  with narrow source dependency plans and host-owned execution budgets.
- Add independent collection URL parameters, explicit cancellable router
  restoration and readiness, paused hidden tables, remote grouping previews,
  and server execution and multi-table router integration examples.
- Add partial computed-capability descriptions, exported snapshot validation,
  host-owned snapshot transactions, and typed actionable snapshot HTTP errors.
- Export shared resizable, closable editor panels and customizable column-role
  theme tokens for group keys, aggregate values and representative-row fields;
  add grouping integration documentation and themed playground examples.
- Add compact compressed query URLs and a bounded FIFO browser cache for
  oversized views. Explicit Save/Share promotes immutable link codes through
  an optional snapshot store; query editing never writes snapshots remotely.
  Add HTTP and Go PostgreSQL/SQLite snapshot storage, fresh-session restoration,
  missing-link errors, and browser back/forward resolution.

- Display JSON as collapsible, pretty-printed code with branch-preserving search
  in the upper-right toolbar and whole-object/per-value copying. Align its
  resizable modal, Close control, footer, and mobile sheet with item details.
- Add typed, serializable field cell displays for JSON, date/time, duration,
  number/percent, text, and labeled chips, with a shared searchable JSON inspector
  for native, serialized, encoded, and escaped values.
- Embed the shared JSON inspector in item detail properties across popovers,
  modals, and expanded rows. Inherit field display settings, add editable JSON
  property options that persist in saves/share links, and export `JsonValueView`.
- Keep JSON property trees initially collapsed without nested scrolling, with
  hidden-key/value counts and a viewer button beside the property label. In the
  full viewer, open the root and small containers by default, bucket long arrays
  into ranges of 20, and offer filter/highlight search with match navigation.
  Preserve standard cell click/copy behavior and add Open in JSON Viewer to
  JSON cell menus.

- Add an isolated date metric demo prototype with calendar intervals, optional
  empty buckets, explicit ranges, and count/sum versus average behavior.
- Add date interval and empty-date settings to the existing metric editor,
  persisted with metric definitions. Complete calendar buckets locally over
  query, observed, or custom bounds, with an example at `/date-metrics-workbench`.
  Legacy metric transports reject date grouping; v3 transports execute it on
  the server.
- Add named timezones to metric date grouping (UTC by default), with local
  calendar boundaries, custom date bounds, and matching graph/list/table labels.
  Handle daylight-saving gaps, repeated hours, and fractional offset changes;
  persist timezone settings with metric definitions and shared URLs.
- Detail columns default to Modal and support configurable Page URL templates,
  tab targets, and item toolbar sharing. Query history uses compact header icons
  matching item views, with one-step undo/redo under React Strict Mode.

- Add opt-in click popovers, resizable item modals and virtualized row expansion.
  Item details is a draggable, resizable presentation column with configurable
  buttons. Each modality has independent property views and named saves; item
  links restore collection query, identity, modality and property layouts.
  Property columns support saved widths, auto-fit/reset and raw-value clipboard copy. Property authoring uses a modal workbench
  with live preview, and item cards start at the view toolbar.
- Add read-only object property views with field selection/order, per-appearance
  formats, transactional customization, named saves/defaults, and undo/redo.
- Add explicit and discovered foreign-key relationships, cancellable batched
  label/link resolution, and a driver-independent SQLite constraint reader.
- Add an object inspector demo and integration guide for host-owned detail pages.
- Give object inspectors a Query Table item card identity, shared SVG controls,
  saved-view modal/sheet, and table-style property/value surfaces.
- Export reusable menus, nested submenus, action groups, and form popovers with
  shared theme inheritance, viewport positioning, keyboard navigation, focus
  restoration, RTL support, and mobile sheets; add a themed menu playground.
- Persist `fitToScreen` in saved queries and shared URLs so each viewer's table
  fits its available area after loading and on viewport changes. Show the active
  preference in the width menu and clear it on manual width changes while
  preserving the displayed widths.
- Add optional PostgreSQL `CompileCombinedMetrics` execution with shared input
  stages and compatible scalar reductions, preserving independent metric plans.
- Export Go relative datetime resolution and SQLite `SaveIn` for host-owned
  transactions that validate computed definitions before committing.

### Changed

- Move Query, Metrics and Table expand/collapse controls inside the layout,
  beside clickable section labels. Keep metric and row summaries visible in
  section headers, preserve independent folding and query actions, and retain
  44px mobile touch targets without controls extending into page margins.
- Unify column, metric and property editors around shared panels, field-first
  selection and contextual formula libraries. Compact optional query controls,
  keep sort direction in the picker, and improve property-list density,
  scrolling, add-property placement and live previews.
- Display cell-menu string-length comparisons with `>`, `≤`, `<`, `≥`, `=`,
  and `≠` symbols in the paired keep/exclude actions.
- Use the shared overlay system for table and metric actions, condition choices,
  field/value pickers, auto-refresh settings, and tag filter editors.
- Prune unused SQL bindings and stage-local inputs, and evaluate PostgreSQL
  SELECT-only and shown-row metric bindings after the ordered page window.
- Reuse identical SQLite metric results and compatible reductions within one
  transaction, with independent result payloads and temporary-table cleanup.
- Avoid rational allocations for safe integral SQLite SUM/AVG inputs and build
  only the needed field input for direct-field browser aggregate samples.
- Preserve SQLite indexed windows for trusted text identities and canonical
  UTC-millisecond datetime storage.

### Fixed

- Bound v3 calendar scratch tables by population and byte budgets, stage only
  metric dependencies, assign bucket keys in batches, and release tables after
  each metric. Ignore cleared date filters when resolving query-range calendars.
- Preserve pending and failed query links during empty undo/redo, retain history
  when reactivating hidden tables, accept relative router locations, and capture
  fresh evaluation clocks for ordinary v3 requests and previews.
- Keep computed runtime errors in individual v3 cells, batch group identity
  assignment, preflight UTF-8 staging budgets, sanitize infrastructure errors,
  and restrict grouping source statistics to backend fields with cancellation.
- Ignore synthetic timezone boundaries after explicit DST data ends, preserve
  future partial-hour transitions in browser/server execution, and skip empty
  date filling when no dated series exists.
- Preserve grouped rows and metric results during column resizing/reordering,
  and retain default key columns when adding a group key to an empty SELECT.
- Retain grouped rows during refresh, normalize saved grouping safely, and show
  validation failures without unmounting editors. Restore hidden computed
  columns, discard removed aggregate drafts, and respect contextual panel
  defaults when resetting editor layouts.
- Preserve inline standalone field pickers and dismissible mobile sheets,
  including consistent grouping layouts on landscape touch screens.
- Exclude invisible JSON container summaries from search, preserve manual
  scrolling when toggling sections during search, and apply the precision guard
  to source integer literals while accepting large floats and native numbers.
- Keep raw chart group labels when a scatter/histogram X format survives a
  display change without calendar grouping.
- Reuse the last date bucket's boundaries and ISO key for dense timestamp rows,
  avoiding repeated timezone conversion while preserving DST boundaries,
  out-of-order results, and evaluation limits.
- Honor temporal `xFormat` on explicitly calendar-grouped labels so date axes can
  display compact calendar labels while retaining raw grouping values.
- Preserve parent palettes in submenus and let a second column-header click
  dismiss its menu, including open submenus; avoid stale mobile filter editors
  opening after a desktop viewport resize.
- Align table-header sort indicators with their labels in the bundled theme.
- Open column actions when clicking anywhere in a table header, including
  padding and blank space, while preserving resize handle behavior.
- Keep browser-only computed columns evaluating locally beside server sidecars,
  without browser-only revision edits blocking valid v2 pages.
- Support raw PostgreSQL text-array SELECT while retaining expression and
  grouping restrictions.
- Return HTTP 400 for computed-definition plan diagnostics, including wrapped
  validation errors.

## 0.6.0 — 2026-10-08

### Added

- Add a driver-independent Go SQLite v1 adapter with guarded basic aggregates,
  Unicode/RE2 and JSON-array filters, stable paging, transaction-consistent reads,
  autocomplete, field statistics, and revision-safe computed-definition storage.
- Support `bindings.sqlite` in shared schemas and `--dialect sqlite` in Go schema
  generation, including trusted numeric expression opt-in.
- Add SQLite v2 metric/formula planning and transaction-based execution under
  `qt-sqlite-v1`: paired metrics, shown-row scopes, computed projection/sorting,
  transitive revision checks, top-N groups, guarded exact SUM/AVG/MEDIAN, and
  frontend-compatible capabilities/results.
- Add SQLite exact-linear box plots with bounded Tukey outliers and histograms
  with shared edges before top-N, numeric precision guards, typed payloads,
  null/error counts, and cross-language conformance tests.

- Add a metric and dashboard workbench with composed aggregate formulas, multiple
  groupings, result sorting, shown-row and all-matching scopes, resizable cards,
  configurable charts, temporal output formatting, and caller-owned palettes.
- Add versioned Go/PostgreSQL metric and computed-column execution with guarded
  formulas, snapshot consistency, scatter measures, and exact distributions.
- Add request activity diagnostics and a seeded PostgreSQL playground with
  configurable database and response latency.
- Add a responsive formula function library with search by name or intent,
  concept and return-type filters, and keyboard insertion at the cursor or
  around selected formula text.
- Document dependency removal options across the web, Go, and native libraries.
- Accept signed compound duration operands (`-1h`, `+8d2h10m`) in existing
  datetime comparisons. Preserve operands in saved queries and URLs; resolve
  them against one server clock during SQL compilation, with matching local
  execution in TypeScript and Swift.

- Add a **Column Widths** submenu to the `DataTable` header menu: fit the
  clicked column, fit all to content, fit all to screen, equal widths, or reset.
  Presets write every width in one query update, so they share, undo, and
  persist like manual resizes.

### Changed

- Replace CodeMirror with a native textarea formula editor, retaining suggestions,
  signature help, diagnostics, paired insertion, and native undo while removing
  syntax coloring, line-number gutters, and hover tooltips.
- Pin `@tanstack/react-virtual` to `3.14.11` and remove the CodeMirror dependency graph.
- Compare local datetime filters as instants, including timezone offsets, and
  report invalid datetime filters instead of falling back to string comparison.

- Measure intrinsic content for header-handle auto-fit (Enter), so auto-fit can
  shrink a column as well as grow it.

- Tag each release for the Go module as `backends/go/v<version>` so `go get`
  and pkg.go.dev resolve semantic versions instead of pseudo-versions.

## 0.5.0 — 2026-10-06

### Added

- Add schema-opted-in native textarray set filters with searchable badge choices,
  removable chips, ANY/ALL/NONE/EMPTY modes, keyboard controls, and mobile sheets.
  Explicit editor metadata round-trips through URLs, storage, and query history
  while server requests retain existing CNF predicates without new operators.
  Add `mapSetFilterValues` for consumer-owned alias canonicalization.
- Add responsive query-builder sheets, touch and keyboard ordering, compact clause
  editors, a focused column workbench, and native sharing with clipboard fallback.
- Add worker-isolated regex extraction previews and export the shared SVG `Icon`
  component and its types from the UI package.
- Add text length filters (`length_gt`, `length_lt`, and `length_eq`) across the
  query builder, local and PostgreSQL execution, and native macOS. Zero-length
  filters distinguish empty strings from NULL and offer direct cell-menu actions.
- Add development-only Agentation feedback with source references and local notes.

### Changed

- Format large row totals with grouped or compact counts and reveal exact totals on hover.

### Fixed

- Preserve desktop field-picker focus until click selection, including browsers
  that do not focus pressed buttons, without selecting fields during touch scrolling.
- Allow syntactically valid regex sort extraction when sampling or preview workers
  are unavailable, and present preview failures as non-blocking warnings.
- Keep development feedback inputs inside nested desktop dialogs as well as mobile sheets.
- Avoid synchronous React updates during virtual table row measurement.
- Update locked transitive dependencies to resolve npm audit advisories.

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

- Align PostgreSQL textarray nullity and negated membership with local execution:
  empty arrays count as empty, and bare NOT membership excludes empty arrays.

- Native compact query imports preserve valid WHERE predicates when neighboring
  members are malformed, matching React's member-by-member normalization.
- Native column display honors an explicitly empty `defaultSelect`, keeping
  visible columns consistent with backend projections.

### Added

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

[Unreleased]: https://github.com/Pythia-Software/query-table/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Pythia-Software/query-table/compare/v0.6.0...v0.7.0
[0.3.0]: https://github.com/Pythia-Software/query-table/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Pythia-Software/query-table/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Pythia-Software/query-table/releases/tag/v0.1.0
