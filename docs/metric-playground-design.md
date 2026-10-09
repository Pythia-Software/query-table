# Metric playground proposal

> Design reference preserved from the approved prototype. Production APIs and current integration limits are documented in [Metrics](metrics.md) and [Backend metrics](backend-metrics.md).

Status: design proposal and executable mockup, October 2026. No production behavior changes are included.

Revision after merging `origin/main` at `2b28794` (PR #92): preserve the native expression editor and add no third-party runtime dependencies. The current UI revision is a desktop workbench with four resizable panes, a wider resizable modal, native select view switching, full-width dashboard layout, rem card sizes, consistent category colors, and collapsed settings. Mobile authoring is deferred. Dashboard authoring, arbitrary supported group arity, two-key pivots, labels, card dimensions, and responsive arrangement are now in the UI scope. Full-dataset regex execution is out of scope. The shared server-backed computed-column planner is now the execution foundation, and chart presentation is part of the initial UI scope. See the [server-backed computed-column proposal](server-computed-columns-design.md) for SELECT evaluation and global sorting.

## Recommendation

Move metric authoring into a dedicated **Edit metrics** modal beside **Edit columns**. Keep metric chips and cards in the Metrics section, where clicking either opens the corresponding draft. Remove the inline metrics editor from the query builder. A metric owns its expression (two named axis expressions for scatter), grouping, row scope, result sort, and presentation. The table still owns its filters, row sorting, and pagination.

Use the computed-column language and editor as the foundation, with an explicit aggregate context. `SUM([x]) / SUM([y])` evaluates independently for each group. Result sorting happens after this expression is evaluated, before group pagination. Default scope remains **All matching rows** to preserve existing behavior.

I considered a focused single-chip dialog, a tabbed settings dialog, and a catalogue-style playground. A single-chip dialog is smaller but makes comparing and arranging several metrics cumbersome. Putting the preview on a desktop tab hides the effect of edits. The recommended metric list + definition + field/function library + preview layout follows the column selector and keeps the expression, reference material and active result visible simultaneously. This authoring workflow targets desktop first; a mobile editor layout is deferred. The catalogue here contains only metrics in this query, not a new global library.

The modal is a transaction over query-local metric definitions. **Apply metrics** commits the entire draft in one undoable change. Previewing, switching metrics, and cancelling do not change the table or its history. Reusable, shared metric definitions are a separate future feature: a saved query already saves its metrics, and introducing shared mutable definitions would add unnecessary revision and dependency complexity to this release.

## Deliverables and walkthrough

- [Interactive mockup](mockups/metric-playground.html): served locally, with real calculations on deterministic synthetic rows. Resize the modal and four panes; use the separate field/function reference; expand summary-led settings to change scope, formula, grouping, sort, presentation, formatting, and metric selection; apply or cancel the draft. It reuses the current formula compiler/interpreter for scalar and row expressions in a terminated-on-timeout worker. Aggregate extraction is a prototype scaffold, not the proposed production parser.
- [Sample dashboard](mockups/metric-playground.html?view=dashboard): 18 pre-created metrics, including two scalar cards, both bar orientations, a time trend, pie/donut, duration-vs-efficiency scatter, ranked list, X/Y pivot, signed bars, three-key table a shown-row regex metric, duration/date/time examples, and box-plot/histogram distributions. These are synthetic preview fixtures, not production starter suggestions. They are the default configuration at every prototype URL, including after refresh. Apply persists the demo configuration to browser localStorage; Cancel discards drafts. Storage is versioned; unavailable storage falls back to the seeded demo.
- [Mockup source](mockups/metric-playground.js), [native pane/modal resizing](mockups/metric-workbench.js), and [worker source](mockups/metric-playground.worker.ts).
- [Computed-column mockup](mockups/computed-column-server.html): contrasts the proposed server-backed sortable field with a browser-only regex definition. Its worker simulates evaluation and sorting over all synthetic rows before returning 100; it is not a backend implementation.
- [Server execution design](server-computed-columns-design.md): admitted language profile, authoritative definition resolution, value/error lowering, revision consistency, SELECT/sort/metric reuse, transport changes, and performance.
- Browser screenshots and interaction-check output live in the workspace's gitignored `.context/` directory.

To open the prototype from the repository root:

```sh
python3 -m http.server 8765
# Open http://localhost:8765/docs/mockups/metric-playground.html
# Default is the 18-metric dashboard; append ?view=editor for the four-pane editor
```

Rebuild the worker after editing its TypeScript or the formula runtime:

```sh
node_modules/.bin/esbuild docs/mockups/metric-playground.worker.ts --bundle --format=iife --platform=browser --outfile=docs/mockups/metric-playground.worker.js
node_modules/.bin/esbuild docs/mockups/metric-expression-tools.ts --bundle --format=iife --platform=browser --alias:@pythia-software/query-table-core=./packages/core/src/index.ts --outfile=docs/mockups/metric-expression-tools.js
```

The mockup uses a lightweight textarea rather than CodeMirror, a limited aggregate grammar, a repeatable grouping list (four fields in this synthetic schema), X/Y pivots for exactly two keys, one primary sort rule with null placement and a group display cap, and a fully local dataset. Table, list, horizontal/vertical bars, a day-keyed line, eligible pies/donuts, paired-measure scatterplots, box plots and shared-bin histograms are interactive. A Dashboard layout mode offers native drag handles, touch/keyboard reorder, phone/tablet/desktop canvas widths, editable labels and preferred/minimum card sizes; the individual preview is resizable. The searchable function library uses PR #92’s own catalogue helpers in a separate design bundle; full-scope regex is explicitly rejected. It does not implement a transport, SQL generation, result pagination, shared definitions, or authoritative backend capability enforcement. Those are specified below, not implied by a successful prototype preview.

## What exists today

| Area | Observed behavior | Implication |
| --- | --- | --- |
| `core/src/query.ts`, `agg.ts` | `AggregationClause` contains one op/field and backend-only group fields. | A ratio needs a new expression representation and context-aware validation. |
| `core/src/apply.ts` | Filters the full local dataset, groups, then orders numeric values descending; nonnumeric values use group size. Keys become strings and empty text merges with null. | Add scope selection, typed buckets, explicit comparators, and aggregation semantics fixtures. |
| `core/src/encode.ts` | Aggregate requests contain pushdown WHERE and specs, omit paging, and drop unsupported fields. | All-row scope exists already, but residual client filters can make results a superset. Unsupported new expressions must produce diagnostics, not disappear. |
| `react/src/useAggregations.ts` | Cache/request key includes WHERE and metrics, ignores table sort/limit/offset. | Shown-row metrics must additionally depend on the committed page and its effective ordering. |
| `ui/src/QueryBuilder.tsx` | `MetricsRow` / `MetricChip` directly mutate each clause. | Replace with a modal entry point and a transaction-based draft API. |
| `ui/src/MetricsPanel.tsx` | Shape is selected by group arity: scalar, bars, pivot, flat table. | Give users a display choice; separate group-result order from metric-card order. |
| `ui/src/SelectColumnEditor.tsx`, `FormulaEditor.tsx` | Draft layout, asynchronous preview, native textarea suggestions, argument hints, searchable function library, selection wrapping, diagnostics, and mobile panel switching (PR #92). | Reuse the interaction pattern and components, not the shared-column save semantics. |
| `ui/src/previewOrdering.ts` | Existing preview sort compares string labels through a natural-language collator. | Do not reuse unchanged for numeric metric results: define typed numeric ordering. |
| `core/src/formula.ts`, `react/src/formulaWorker.ts` | Typed scalar language, explicit errors, native JS regex in a watchdog-controlled worker. | Reuse AST/editor/runtime concepts; add row/group contexts and aggregate nodes. |
| `docs/computed-columns.md`, `core/src/computed.ts` | Computed references are SELECT-only; their definitions are stored, but never evaluated by Go/SQL. | Merely allowing a computed column in a measure picker cannot provide full-dataset aggregation. |
| `backends/go/compile.go`, `query.go` | Validates aggregate op/type/schema and returns SELECT/GROUP BY fragments; host supplies FROM/JOIN and executes. | Versioned requests, server validation, ordering, paging, and execution integration are required; compiler work alone is insufficient. |

Paths in this table are relative to `packages/` unless otherwise stated. Existing metrics are capped at 20; retain that initial metric count limit and introduce separate AST/group/result budgets.

## Interface and interaction

### Entry and layout

The Metrics section header contains a count and **Edit metrics**. Empty state offers **Create metric**. Existing chips show label, a short grouping summary, and **All matching** or **Shown rows**. Scope and processed-row coverage appear in authoring context/inspection, not as a footer on preview or final cards. Keep the finished dashboard free of scope/dimension debug captions. Metric reorder changes card order only.

Desktop modal: **1,560px default maximum width and 900px height**, bounded by the viewport minus 48px. The modal itself is resizable. The top header contains **Edit metrics**, a native **Metric editor / Dashboard layout** select, **Reset layout**, and Close; remove the explanatory subtitle and the extra toggle strip. Query scope context stays in a slim row below it, with pinned Apply/Cancel in the footer.

The editor has four independent scrollable panes, in this order:

1. **In this query** (240px default, 180px minimum): metric selection and Create; per-item three-dot menus hold Duplicate / Remove / Move up / Move down. The drag handle and three-dot menu share the chip boundary and appear together on selection, hover or keyboard focus. Keyboard/menu alternatives reorder the draft. The wider default accommodates names and grouping summaries. Dirty items are marked; changes remain reversible until Apply.
2. **Metric definition** (390px default, 300px minimum): title and expression are always visible. Scope, grouping, ordering/limits, display/format, labels and card size live in separate collapsed sections. Each summary shows the current setting (for example `All matching rows`, `Platform × Worker`, `Horizontal bars · percent`, or `24 × 12 rem · min 18 × 10 rem`). These summaries help an author identify the relevant control before expanding it. Do not put the removed row/group tutorial text or example chips below the formula.
3. **Fields & functions** (250px default, 200px minimum): an always-available reference pane with a native Fields / Functions select, search and function concept filters. Field rows show canonical references and types; function rows show signatures and descriptions. Clicking a field inserts at the caret; clicking a function wraps selected expression text. Keep selection/caret ownership in the native editor so moving focus to search does not lose the insertion location. This pane is not an accordion embedded in the formula area, and it does not recommend preset metric formulas.
4. **Live preview** (remaining space, 280px minimum): compact resizable card, scope/coverage, validation status and optional inspection. Aggregate inspection is collapsed by default; selecting a result/mark opens it. Calculation or compatibility errors remain visible rather than being hidden in a collapsed section.

Three vertical split handles adjust adjacent panes while respecting minimum widths. They support Pointer Events with pointer capture, keyboard Left/Right (Shift for a larger step), visible focus and `role="separator"` with accessible current width/min/max. Double-click/Home reset pane widths. The modal’s lower-right handle adjusts width and height; arrow keys provide an alternative, and Reset layout restores both dialog and pane defaults. Cancelled resize/Escape restores the dimensions at drag start. Pane/modal resizing never changes metric/card dimensions, dirty state, computation keys, or saved queries. Keep these dimensions as local editor preferences; remember them within the authoring session, with optional host preference persistence later.

When the dialog shrinks, redistribute space within pane minima. Below the total minimum, use contained horizontal scrolling instead of an unreadably narrow editor or a new mobile tab workflow. The first UI release does not optimize authoring on phones. This does not remove narrow-screen dashboard testing or responsive metric consumption: authors can still test a 360px dashboard canvas from the desktop workbench.

**Data scope**, **Grouping**, **Ordering & limits**, **Display**, **Labels** and **Card size** start closed. Expanding one does not require closing others; preserve the author’s open sections while switching metrics. Display choice and formatting share one section; label overrides and card dimensions have separate sections because they answer different questions. Section summaries update immediately without recomputing data. Invalid settings need a visible summary indicator and an action that expands/focuses the affected section in production. Formula diagnostics stay next to the expression.

**Basic** offers operation and field controls and generates an expression such as `SUM([total_ms])`. **Formula** reuses the native textarea editor from PR #92, with selection wrapping and inline diagnostics. Remove the Suggestions button, suggestion section and shortcut hint from metric authoring; the separate field/function pane provides explicit insertion. Extend the existing registry/browser with aggregate functions and execution-context hints; do not introduce a second editor engine. Switching Basic → Formula is lossless. Switching back is available only for an exact supported simple aggregate; otherwise show “This formula cannot be represented in Basic” and leave the expression intact. Do not overwrite a custom formula to switch modes.

Remove the static “[fields] inside SUM are row values. Division runs once per group.” explanation and all preset formula chips from the shipping interface (and this revised mockup). Keep actionable diagnostics and deliberate reference browsing; signatures are shown in the reference pane. Synthetic scenarios in the prototype’s outer banner are demonstration fixtures only, not a proposed production preset picker. Explicit unit selection prevents a ratio from incorrectly inheriting a duration renderer from its input field.

Grouping uses an add/remove/reorder field list with no two-key UI ceiling, including approved server-capable computed definitions; no grouping means one scalar. Multiple fields produce a tuple, not independently aggregated subgroups. Zero keys produce a scalar; one permits compact list/bars/table; exactly two default to an X/Y pivot with axis swapping; three or more use a flat table containing every key. The synthetic prototype offers all four available grouping fields; production accepts every distinct schema-eligible key within the transport’s advertised resource budget. Resource limits are reported explicitly, never implemented as a silent truncation to two keys. Reuse the column editor to define a grouping transform once; defer a second arbitrary group-expression editor. Raw timestamps can be used as ordered keys when allowed by the schema, but useful time bucketing (hour/day/week) requires a tested UTC DATE_TRUNC capability or an existing backend date-bucket field. Grouping by every raw timestamp is usually a high-cardinality table, not a useful trend.

### Native editor and dependency budget

The merged PR #92 removes all six CodeMirror packages from `packages/ui/package.json` and the lockfile. The only remaining third-party runtime dependency in the UI is the existing `@tanstack/react-virtual`; React and React DOM remain peers. The dependency survey predates removal, so its seven-package count is historical. This metrics work must not add editor, chart, drag-and-drop, layout-grid, date or SQL-parser runtime packages. Core/React/Go retain their existing dependency boundaries. Keep the current lockfile removal intact.

Reuse `FormulaEditor.tsx`, `formulaEditorHelpers.ts`, `FormulaFunctionBrowser.tsx` and `formulaFunctionCatalogue.ts`. Parameterize editor context, aria label, admitted function/field registry, aggregate signature metadata and library placement. Expose the existing insertion pipeline to an external reference pane (via callbacks or a small editor handle) instead of reaching into textarea DOM from production metric code. Support external field insertion and function wrapping through the same caret/undo/IME logic, and avoid rendering the embedded browser a second time. The current helpers use a scalar registry; merely showing `SUM` in a browser is insufficient. Add metric-aware diagnostics for row arguments versus reduced values, while preserving native undo/redo, IME composition, caret editing, quoted strings/escaped fields, paired delimiters and error selection. Keep existing computed-column behavior and editor tests unchanged through context adapters. The standalone mockup demonstrates the shared helpers, separate reference pane, search and wrapping; production reuses the complete component rather than copying its simplified scaffold.

Use React plus native SVG for bounded chart results, CSS flex/grid for wrapping, ResizeObserver for actual chart dimensions, and existing pointer reorder primitives where reusable. Native controls/pointer capture and stable IDs cover dashboard interaction. A keyboard/menu alternative must always be available. First-party code has maintenance costs: keep renderers small, bound mark/label counts, and test signed axes, null/error gaps, accessible values and responsive dimensions. Do not claim a dependency reduction by vendoring a chart library. The prototype bundles only existing first-party helpers using the repository’s existing esbuild tooling.

### Dashboard authoring, labels and dimensions

**Metric editor** and **Dashboard layout** are two views of the same transactional draft. Dashboard layout is a full-width canvas: hide In this query, the definition, reference and preview panes, and all three dividers; restore the four editor panes and widths on return. It displays all draft cards through shared renderers/cached reductions. Clicking any noninteractive part of a card (including its body), keyboard Enter/Space on the focused card, or the native selected-metric dropdown selects it without leaving layout. The toolbar edits its name plus preferred/minimum rem dimensions. **Edit metric** opens the definition explicitly. Card menus include Edit metric / Duplicate / Remove / Move up / Move down. Edit metric opens the selected definition. Dashboard handles and menus appear only on hover or keyboard focus, including on selected cards; they overlay the heading rather than reserving space in the resting title. Drag handles reorder directly. Remove the scope/dimension footer from preview and final cards; retain required missing/limited-data diagnostics and authoring scope context. Labels, sizes, canvas width, color theme and card order never execute a database query.

Expose a card title (the existing metric label), value label, X-axis label and Y-axis label. Empty labels fall back to field/unit names. Bar orientation changes which field/value is on each physical axis; label inputs explicitly refer to physical X/Y, with previews showing the outcome. Pie has no axes; preserve unused axis settings when changing display. Labels only affect presentation, never field identity, definition references, sort keys or SQL aliases. Long titles/ticks truncate with full accessible text/tooltips. Axis labels describe data; they do not change units or scale. Tables use the custom value label, including the tooltip on pivot cells.

Start with a compact **20 × 12 rem** preferred card and **14 × 10 rem** minimum, including title/scope chrome. The collapsed Card size section and dashboard's selected-card toolbar edit the same four values in **whole rem steps** using native number inputs. Validate finite positive values and host bounds (mockup widths 1–75 rem, heights 1–50 rem). Effective height is max(preferred, minimum); width respects minimum and available row space. Increasing a minimum above its desired size raises the desired value immediately, in both views. Desired edits below the current minimum clamp to that minimum. Lowering a minimum does not shrink the desired size. Legacy fractional rem values round up on load. Allow sizes below 8 rem; very small cards may clip titles or scroll their bodies, so their visible frame still respects the requested size. Rem follows the document root font size; use a consistent rem gap (0.75 rem) and wrapping grid to grow/shrink naturally. Temporary preview and test-canvas measurements remain CSS pixels. Bounded lists/tables scroll inside cards; charts use the actual measured plot area after chrome.

The live preview has width/height inputs and a native resize handle; **Use card size** restores saved dimensions. Preview resizing is temporary. Card dimension controls use rem and are persisted settings; test-canvas dimensions are editor state only. The preview can intentionally test a size below the card minimum without changing the saved minimum. Keep diagnostic/inspection details outside the compact card. Charts may reduce tick/legend density at smaller sizes; horizontal bars show a disclosed ranked subset with all buckets still available in View data. Pies add exact Other for omitted slices; lines retain the complete admissible series with sparser ticks. Resizing must never change a metric’s meaning or covertly change its group limit.

The dashboard canvas offers Phone / Tablet / Desktop preset buttons alongside the Canvas width input in one clearly grouped row. Mark a preset active only when its value matches the current canvas; a custom width clears the preset highlight. These simulate the actual metric container width in CSS pixels, not device pixel ratio or full browser chrome. Cards use an ordered wrapping layout: preferred width is the flex basis, unused row space is shared, minimum width is respected, and cards wrap in order. Chart drawing uses each card’s **actual** post-layout dimensions, not its preferred width. Per-card height can differ. Prefer this deterministic flow to absolute X/Y coordinates or a breakpoint-specific grid in the first release. Drag/drop changes the persisted metric order, never aggregation-result order. It does not resize a card or manufacture empty layout slots.

Provide drag handles in the sidebar and dashboard, touch pointer capture with cancel cleanup, keyboard movement (Alt + arrows in the prototype), Move up/down in the menu, a visible drop target and a live announcement of the new position. Preserve stable metric IDs and focus. Production should add auto-scroll near viewport/container edges for longer dashboards. Reorder writes one undoable draft operation; Apply commits all layout/metric changes once; Cancel restores both definitions and order. A narrow screen whose container is smaller than a card’s explicit minimum scrolls horizontally, with an author-facing explanation in the editor; do not silently squeeze it or clip inaccessible content. Offer a reset to adaptive defaults during implementation.

Preview of many cards needs a bounded worker/request coordinator. The mockup permits two dashboard workers at a time and rejects outdated signatures; production should share reduction leaves and use one existing worker/coordinator where possible. Remote dashboard previews stay explicit and batch compatible requests; changing canvas widths must not fan out expensive scans. Loading/error/stale/empty states must fit the card and retain the last correctly labelled result where applicable.

### Preview and inspect

Preview uses the committed table query as its context and only substitutes draft metrics. Filter edits still waiting for the table's Run action are not included. Opening the modal captures a query revision; if the committed filters/page change elsewhere, show **Query changed · Refresh context**, disable Apply until refreshed, and preserve draft definitions. Refresh rebases only context, never silently overwrites concurrent metric edits; conflicts require review.

Validate syntax/types immediately. After 400ms of inactivity, automatically preview shown rows or a complete local dataset. For remote all-row scope, edits mark the last result **Out of date** and require **Run preview** (Cmd/Ctrl+Enter). This avoids an expensive grouped scan on every keystroke. A lightweight parser/plan check must not execute a dataset scan. Cancel requests and terminate obsolete workers; only responses matching the draft revision and query fingerprint may render.

An exact result says **All 12,840 matching rows · 5 groups** or **100 shown rows · page 1**. Unknown totals say **All matching rows · count pending**, never an invented count. A sample says **Sample: 1,000 of 12,840 matching rows · not the final metric**. Sampling is an explicit preview action, never the execution mode of a saved all-row metric. The same semantic plan drives preview and the saved card; Apply does not save preview data.

Inspect a group to expose its numerator, denominator, group row count, null input counts, and result status. This distinguishes `SUM(x)/SUM(y)` from `AVG(x/y)`. An overall summary of group ratios must recompute the expression on underlying rows; it must never add or average group ratios implicitly.

### Sorting and presentation

Result sort offers **Metric value**, each named **Group key**, and **Rows in group**, with Ascending / Descending, ordered multi-sort rules, and Nulls first/last. Clicking a preview column header updates the active draft's persisted sort, so Apply produces the same ordering on the card. Numeric sorting compares raw numeric results, before formatting or rounding. Display formatting never changes calculations or ties. Append the full typed key tuple as a stable tiebreaker.

**Show first N groups** is distinct from table row limit: aggregate all scope rows → evaluate group formula → sort all group results → take N groups. Always show “20 of 340 groups” when a result display is limited. Do not preselect the biggest groups by count and then sort their ratios; that can exclude the true highest ratio.

Display choices are Value (zero groups), List, Table, Bar chart (horizontal or vertical), Line chart, Pie/Donut chart, Scatterplot, and the existing Pivot. Automatic display preserves the current arity defaults. Group sorting, row scope, calculation, and display are separate: changing bar orientation never reexecutes an aggregation. Store chart settings with the query-local metric; UI controls remain small and type-aware.

| Display | Initial supported data | Ordering and meaning |
| --- | --- | --- |
| Horizontal bars | One categorical/numeric/date key + numeric result | Uses result ranking. Best default for long labels/ranked comparisons. Numeric scale includes zero and supports signed values. |
| Vertical bars | Same | Same results and order, different orientation; tick budget/label rotation must stay readable. |
| Line | One date/time or numeric key + numeric result | Key-ascending x axis, with actual numeric/time spacing. Metric-value ranking is not used to connect points. Date formatting/bucket timezone are explicit. |
| Pie / Donut | One key + additive, finite, nonnegative numeric measure | COUNT and SUM of nonnegative row quantities initially. Ratios, averages, MIN/MAX, distinct counts, negative values, and group errors are incompatible; offer a bar/table instead. |
| Scatterplot | One or more group keys + two numeric expressions | One point per full typed tuple. Independent axis units/scales; shared row scope. Sort by X, Y, count or keys before applying one point cap. Missing/error pairs are disclosed. |
| Table / List | Any permitted scalar result; one or more keys | Exact formatted values, errors and nulls remain inspectable. |
| Value / Pivot | Zero / exactly two keys | Retain existing behavior. Separate key-order pivot axes with swap; no implicit reaggregation of ratios. |

Line charts preserve chronological/numeric axis order independently of stored ranking rules. Switching back to bars restores ranking. Do not silently select the top-N values and call that a time series: initially require complete series coverage within a chart-point budget, or use a clearly labelled explicit axis range. NULL/errored values break the line; missing time buckets remain missing unless a real gap-filling operation is requested. A temporal key is an instant in a specified UTC domain, not a string label alphabetically sorted. Defer categorical “line charts,” stacked/dual-axis lines and second-key line series. Two-measure scatter is explicitly supported; two-key single-measure results retain Table/Pivot.

For pies, calculate each share against the sum of **all valid group quantities in the selected row scope**. This is not always the row count: SUM(duration) shares duration. Zero values do not create slices; all-zero or no-valid-data pies get an empty state. Use at most a small visible slice count (default 8); when ranking/display limits exclude groups, add **Other groups** from their exact sum under the same query/revision/snapshot. Never silently renormalize the displayed top-N as if they were the complete result. The backend must return total/remainder information when results are paged; “hasMore” alone cannot determine slice angles. NULL-only groups are reported as missing quantities; group errors disable a complete pie because the total is unknown. An actual key named Other remains separate from the synthetic remainder.

Chart preview includes units, axis labels, scope/coverage, accessible titles, keyboard/touch inspection, and **View data** with the equivalent table. Value/null/error counts stay available even when no mark can be drawn. Use a shared field/typed-category color resolver for categorical bars, pies/donuts, scatter points and list swatches, with accent for temporal lines; pair colors with direct labels and a legend. A legend click initially selects/highlights a slice; it must not hide a category and silently change the denominator. Chart clicks inspect groups without filtering the table. Format percent ratios with an appropriate metric unit; pie share percentages are a separate quantity from the raw measure's unit. No automatic smoothing, interpolation, downsampling, or aggregation of visible group ratios.

For pivot, row-axis and column-axis key ordering are separate from flat-result sorting. Sorting an axis by metric requires an explicit summary expression recomputed for that axis; do not sum cell ratios. Initially offer ascending/descending key order on both axes. Flat result ranking may still select the top-N tuple buckets before pivoting; it does not order pivot axes by a nonexistent subtotal. Metric-value axis ordering requires that future summary expression. Use distinct cell states for a real NULL (`—`), absent tuple (`·`, no matching rows), group error, and bucket omitted by display limits (`…`). Do not fill missing cells with zero. Pivot row/column group IDs remain explicit when swapping axes; swapping is a presentation edit, with no new aggregation. A scalar hides group sorting and group limits.

Lists use bars only for finite, nonnegative numeric values. Negative values use a diverging scale; text, error, and null results use a plain list. NULL and errors never become zero-width bars masquerading as zero values.

### Paired measures and additional graph formats

A scatterplot should own **X expression** and **Y expression**, rather than referencing two independent dashboard cards. Both use one dataset, predicate, scope, snapshot, revision set and ordered group tuple. The worker prototype already evaluates both in one request over the same group rows; production should extract/deduplicate their aggregate leaves into one SQL GROUP BY, evaluate both outer expressions, then order/page the paired rows. Each response bucket has typed keys, row count and separate X/Y value-or-error channels. A scoped computation such as `AVG(duration)` against `SUM(useful)/NULLIF(SUM(total),0)` is straightforward with the proposed planner; no second query or client-side positional joining is necessary.

Each group tuple is one point, so `platform × worker` gives a point for each observed pair. This is **aggregated scatter**, not a plot of individual rows. A row-level scatter mode would need a separate bounded row projection/paging contract. Expose X/Y labels, units and independent numeric formatting. Retain an equivalent paired data table and inspection of both reductions. Color is only an aid; group identity is in accessible titles and the data view. Do not connect points or automatically imply correlation with a fit line.

A NULL, error, or non-finite value on either axis excludes that point, never substitutes zero. Keep the reason/count visible inside the card and in View data. Require numeric types for both expressions, enforce function/scope capabilities for both, and block Apply on invalid expressions. Sorting targets a named measure; select a single tuple set after both expressions are calculated. Never take independent top-N lists and zip/join them. A point cap or explicit sample must disclose excluded groups and cannot silently represent complete coverage. Default to a complete bounded result; over-budget results require an explicit ranked limit or a narrower query. Units/formats/geometry remain presentation state; either expression changes the computation key. Switching to an existing one-measure display keeps X as its primary expression and retains Y in the draft for a return to scatter; only active measures execute.

| Format | Feasibility with the proposed result contract | Recommended timing |
| --- | --- | --- |
| Donut | Same additive totals, exact Other and missing-quantity rules as pie; only rendering differs. | Include with pie; working prototype included. |
| Scatter | Two expressions in one grouping plan; independent numeric axes and paired error channels. | Include after multi-measure protocol support; working local prototype included. |
| Heatmap | Reuse the two-key pivot plus a numeric color scale and accessible cells; distinguish zero, absent, NULL, error and limited cells. | Best next display after pivot; no new reductions needed. |
| Area | Reuse complete chronological line results; baseline/negative values and gap rules must be explicit. Filling ratios can visually imply quantities. | Later presentation addition; start with additive quantities. |
| Stacked / grouped bars | Complete category × series tuples; explicit additive stacking, signed stacks, shared legend and consistent Other semantics. Grouped bars can compare nonadditive values without stacking. | Later bounded series contract; do not stack ratios/averages. |
| Bubble scatter | A third numeric size expression; require nonnegative finite size and area-proportional encoding. | Later extension of the same multi-measure plan. |
| Histogram / box plot | Requires bucket definitions or distribution/quantile reductions; COUNT/SUM group results cannot recover a distribution. | Working local distribution prototype included; production requires the [distribution protocol and reductions](metric-distribution-design.md). |

Cross-card formula references remain deferred: they add graph dependencies, lifecycle/revision coupling and ambiguous joins. Owning the measures within a chart definition meets the scatter use case without that complexity. A later multi-measure model can generalize the named axis slots without shipping arbitrary dependency graphs now.

### Mobile and accessibility

At <=760px use the existing `ModalSurface` full-screen pattern: Metrics / Definition / Preview panels with persistent footer actions and a compact active-metric switcher. No squeezed three-column layout. Keep labels visible, targets >=44px, formula editor scroll independent of the page, and avoid horizontal scrolling except for genuinely wide result tables. Provide keyboard reorder buttons in addition to drag.

Use `role="dialog"`, accessible title, focus trap/restoration, Escape-to-cancel, and inert underlying content. Unsaved changes require a local discard confirmation on Escape/backdrop/Cancel. Worker errors use an alert; successful preview/count updates use a polite status. Formula diagnostics have textual messages and exact source spans. Cmd/Ctrl+Enter runs preview; Apply is a distinct explicit action. Show initial loading, empty match set, empty group result, invalid formula, null result, group error, unsupported execution, stale context, cancelled request, timeout, and per-metric transport failure as distinct states.

## Semantic contract

### Row scope

| Scope | Input rows | What triggers recomputation |
| --- | --- | --- |
| All matching rows (default) | Authorized dataset after **every effective filter**; ignore table LIMIT and OFFSET. Table ORDER BY does not affect aggregates. | Dataset/snapshot, filters, metric expression/grouping. Result-sort edits reuse aggregates when possible. |
| Shown rows | Logical rows on the committed table page after filters, effective ORDER BY + schema tiebreak, OFFSET, LIMIT. | All of the above plus page membership, row sort, limit, offset, refresh. |

“Shown” means the current page, including rows outside the virtualized viewport. It does not mean selected rows, expanded children, the first page regardless of current offset, or the formula editor's sample. Hidden measure fields must still be fetched. Use the exact page row identities and snapshot token when available; a separately rerun page subquery can drift if data changes. If a host cannot guarantee shared snapshots, disclose that rows/metrics were refreshed separately.

All-row results must not be labelled exact if there are residual client-only filters. The current projector drops such filters. The new planner must either execute the complete predicate on the server or report **All matching rows unavailable for this filter**. Shown rows remain usable after the client has applied the final predicate. Never silently broaden scope or change it to a sample.

### Expression contexts

Retain bracketed canonical field names, case-insensitive functions, JSON strings, existing arithmetic/comparison/conditional syntax, and `qt-expr` conventions. Add a versioned **metric** context rather than silently changing version-1 computed-column meanings.

```text
COUNT()                                            // COUNT(*)
SUM([x]) / NULLIF(SUM([y]), 0)                       // ratio per group
AVG([x] / NULLIF([y], 0))                           // average row ratio: different
SUM(IF([overall] = "PASS", 1, 0)) / COUNT()        // pass share
SUM(IF(REGEX_TEST([job_name], "^build-", "i"), 1, 0))
ROUND(100 * SUM([x]) / NULLIF(SUM([y]), 0), 2)
```

Inside an aggregate argument, fields are row values and scalar functions operate per row. Outside aggregates, scalars operate on reduced group values. Initially, raw row fields outside aggregates are invalid, including grouped field references; grouping columns are already exposed in result keys. Reject nested aggregates (`SUM(AVG([x]))`), window functions, subqueries, arbitrary SQL, implicit reaggregation, cross-metric references, and bare row expressions as metrics. A valid metric must contain at least one aggregate. Permit scalar wrappers and comparisons on reduced values, with a scalar number/text/bool/datetime result; reject array results initially.

`COUNT()` counts rows; `COUNT(expr)` counts non-null values; `COUNT_DISTINCT(expr)` excludes null; SUM/AVG/MIN/MAX ignore null. No groups plus zero rows produces COUNT = 0 and other aggregates = NULL; grouping plus zero rows produces no buckets. Distinguish NULL from empty string and typed group keys from display strings. This intentionally corrects current empty-string/null bucketing; document the migration behavior.

Division by zero is a **group expression error**, consistent with computed columns, not Infinity or a silent zero. `NULLIF(denominator, 0)` deliberately produces NULL, which renders `—` with an inspectable reason; `IFERROR` can explicitly catch expression errors. Bad input conversions are errors, not missing values: a row-expression error fails the affected group and reports its input-error count rather than silently excluding those rows. Other groups may still succeed. Transport/timeout failures are metric-level failures. Error buckets sort after successful values and nulls regardless of direction; null placement is explicit.

Numeric v1 is finite IEEE-754 display arithmetic, matching computed columns, not exact decimal accounting. Cast SQL integer division to the numeric domain and reject unsafe large integer aggregates instead of silently rounding them. Specify cross-runtime rounding, null comparisons, lazy IF/COALESCE/IFERROR, UTC date semantics, overflow, and aggregate accumulation tolerance through conformance fixtures. A host requiring exact decimal measures needs a separate decimal type/protocol and matching client executor; do not promise it through formatting.

Text sort uses a defined, versioned ordinal Unicode ordering (or a negotiated collation), not browser-locale order on one end and database-default collation on the other. Numbers sort numerically, dates by UTC instant, booleans false before true. Keys preserve type; encode tuples with type and null markers. Do not compare tuple JSON for numeric sorting.

## Proposed state and transport

Conceptual types, not additions to the public API in this change:

```ts
type MetricSpecV2 = {
  version: 2;
  id: string;
  label?: string;
  expression: { language: "qt-expr"; version: 2; context: "metric"; source: string };
  secondaryExpression?: { language: "qt-expr"; version: 2; context: "metric"; source: string }; // Y; retained when switching display, executes only for scatter
  scope: "allMatching" | "shownRows";
  groupBy: Array<{ id: string; field: string }>; // expression keys are a later capability
  orderBy: Array<{
    target: { kind: "value" } | { kind: "secondaryValue" } | { kind: "count" } | { kind: "group"; groupId: string };
    dir: "asc" | "desc";
    nulls: "first" | "last";
  }>;
  display: { kind: "auto" | "value" | "list" | "table" | "pivot" | "bar" | "line" | "pie" | "donut" | "scatter" | "box" | "histogram";
    orientation?: "horizontal" | "vertical"; // bar only
    legendPosition?: "left" | "right" | "top" | "bottom" | "none"; // pie, donut, scatter
    list?: { showBars: boolean; useGroupColors: boolean; showValues: boolean };
    valueLabel?: string; xAxisLabel?: string; yAxisLabel?: string;
    pivot?: { rowGroupId: string; columnGroupId: string;
      rowDirection: "asc" | "desc"; columnDirection: "asc" | "desc" };
    line?: { order: "keyAscending"; missing: "gap" };
    scatter?: { x: "primary"; y: "secondary"; xFormat: "number" | "percent"; yFormat: "number" | "percent"; missing: "omitAndReport" };
    pie?: { maxSlices: number; remainder: "other" };
    // Distribution reduction/input contract is specified in metric-distribution-design.md.
    format: "auto" | "number" | "percent" | "duration" | "date" | "time" | "datetime"; decimals: number;
    valueFormat?: MetricValueFormat; // source units, preset/custom pattern, explicit timezone; see output-format design };
  layout: { unit: "rem"; preferredWidth: number; preferredHeight: number;
    minWidth: number; minHeight: number }; // rem, includes card chrome
  groupLimit?: number; // result display cap; never an input-row cap
};
```

Use stable group IDs so reorder/removal does not retarget a sort rule. Removing a grouping explicitly removes its associated sort and announces that change. Keep source canonical and reconstruct a typed AST/plan at validation. Never trust a client-supplied AST, schema SQL, SQL fragment, type annotation, permission, or reported completeness.

Version the wire protocol, schemas, saved-query representation, URL decoding, and public adapters together. Decode old `op/field/groupBy` clauses into equivalent expressions with allMatching scope, legacy display and sort. Existing old nonnumeric sorts must retain count-desc ordering; existing numeric sorts retain value-desc. Preserve ID, label, metric order, and per-field op restrictions. Do not regenerate IDs while opening the editor. On migration, label the change from collapsed empty-string/null buckets to separate typed buckets.

Old transport implementations continue receiving v1 requests for losslessly representable legacy metrics. New specs require an explicit v2 capability; unknown version or unrepresentable formula gets an actionable error. Preserve invalid/unsupported definitions for editing rather than dropping them during normalization. Bound source size, AST size/depth, aggregates per expression, group count, sort rules, and response size at every trust boundary.

A v2 execution request needs effective filters, authorized dataset identity, metric computation specs, result sort/limit/cursor, and optional snapshot. ShownRows additionally needs page identities + snapshot (preferred), or a full effective row-window spec. Hosts that aggregate rows from joins must preserve the table's logical row multiplicity; an ID-only IN filter is safe only if identities map to the same logical rows. SELECT projection must not restrict required metric inputs.

The response needs typed keys, final value **or structured error** for each active named measure (X and Y for scatter), count, optional inspected component values, per-metric status, processed row count, scope, coverage (`complete`, `sample`, `limited`), group count/hasMore, cursor, and snapshot/query fingerprint. A result-page limit is not incomplete row coverage: state both independently. Avoid overloading `null` to mean error or treating absent metrics as success. Optional explain/inspection details are requested on demand to control payload size.

## Execution design and feasibility

### Aggregate arithmetic is practical now

Extend parsing/typechecking to two contexts. Extract and deduplicate aggregate leaves; reduce each leaf in a single grouping pass, then evaluate the outer scalar expression per bucket. Share reduced leaves across metrics with the same scope, predicates, and group tuple. Never stitch numerator/denominator requests by display labels or inconsistent snapshots.

For the first remote implementation, compile the SQL-safe numeric subset (aggregates, arithmetic, comparisons, IF, NULLIF, COALESCE) to a parameterized, schema-allowlisted plan. The database can reduce inputs in an inner query and evaluate/order the final expression in an outer query. Model errors explicitly, e.g. guarded division plus a companion error flag; plain SQL NULLIF is only equivalent to the user's NULLIF, not to an unguarded divide. CASE/lazy functions must preserve interpreter error behavior. The host integrates FROM/JOIN, permissions, cancellation, and transaction/snapshot semantics.

For high-cardinality groups, **the database must sort the final expression before selecting the result page**. Keep the admitted remote expression plan SQL-backed. Sorting a partial response in the browser is incorrect. Local mode can reduce and sort a complete local dataset within its existing worker budgets; it is not a remote execution fallback.

Shown-row computation can reduce a bounded page in the existing worker. Fetch missing dependencies for the exact page identities under the same snapshot; do not fetch another independently offset page and call it the displayed page. A server window can also aggregate a subquery containing row ORDER BY/OFFSET/LIMIT before GROUP BY, with the same snapshot and final predicate semantics.

### Shared row planner; regex stays on shown rows

Remove all-row regex from the delivery plan, including a JS service executor and a portable regex dialect. Existing computed-column regex remains browser-only; shown-row metric expressions may reuse it in the current isolated worker. The metric editor disables allMatching for such a plan with **Regex is available on shown rows only** and an explicit **Use shown rows** action. Preserve the definition/scope when it is unavailable; no implicit fallback. This restriction applies consistently in the local design playground too, so the mockup does not promise a larger feature than the target.

The [server-backed computed-column proposal](server-computed-columns-design.md) supplies the practical alternative for the expressions we do need globally: independently validated row AST → SQL-safe value/error nodes → dependency projection → global sort/paging or GROUP BY. Start with arithmetic, comparisons, boolean conditions, IF/NULLIF/COALESCE/IS_NULL/ABS and backend fields. Add text/date functions only after parity fixtures; there is no blanket SQL translation of the full registry.

Server-capable computed definitions can be metric measures and grouping keys. Bind a coherent transitive definition revision set for each execution while retaining latest-definition semantics for saved queries. The server is authoritative for definitions, access and capability; missing/changed/browser-only dependencies remain visible errors. Both SELECT and metric requests share the resolved row plan so values, sorts, and aggregates cannot disagree about which definition was used. Do not push native accessor functions or render-only fields to SQL.

### Resource, consistency, and failure contracts

Reuse current formula source/token/depth/output budgets and watchdog principles. Run user regex exclusively in an isolated executor, never on the UI thread. Bound distinct sets and group memory; enforce max groups before materializing unbounded results. Limit diagnostics and inspection payloads. Backend requests need authorization, timeouts, cancellation, rate/cost controls, and limits for all-row scans. A cancelled browser request is not proof that the database query stopped; the host must propagate cancellation.

A shared snapshot across numerator, denominator, page inputs, and sibling metrics is ideal. At minimum each composed metric must be internally consistent. Report cross-card freshness if the transport cannot share a snapshot. Show old results as stale during refresh and never relabel an old value with a new scope. The request key is dataset + predicates + resolved expression/dependency revision + groups + scope + snapshot; shownRows additionally includes page membership/effective window. Presentation stays outside compute keys; result order/page is a separate result-query key.

Introduce `MetricCapabilities` per transport/dataset: protocol versions, scopes, aggregate/scalar/group functions, approved computed-field profiles, snapshot support, result sorting/paging, and resource bounds. The browser independently advertises shown-row regex support; the remote planner never advertises regex. Capability checks are advisory in the client and enforced again server-side. Unsupported plans remain editable with a specific failing function/filter and an explicit **Use shown rows** action. The action requires a user click because changing scope changes the meaning.

## Temporal output presentation

The [output-format proposal](metric-output-format-design.md) defines Number/Percent/Duration/Date/Time/Date & time selection, explicit numeric source units or ISO encoding, readable presets, bounded custom strings, civil versus instant timezone handling and shared pure formatting. `84000` seconds can display as `23h20m` without changing arithmetic, ranking or coordinates. Scatter axes format independently; only presentation changes, with no server recomputation.

## Client theme contract

The [metric theme proposal](metric-theme-design.md) specifies caller-supplied named palette layers, stable dimension domains/category overrides, semantic tokens, CSS-variable/classNames integration and per-instance ownership. Colors are presentation state and do not enter SQL, aggregation cache keys or query URLs. The prototype implements this resolver with consistent OS colors across chart formats.

## Delivery sequence

1. **Modal and dashboard UI:** retain PR #92’s native editor/function discovery with a separate reference pane; four independently scrollable resizable panes and a wider resizable dialog; header view switching and collapsed summary-led settings; transactional draft editing, multiple grouping keys, two-key pivots, authoring scope context, explicit sorts, labels, compact shared card renderers, preferred/minimum dimensions, responsive test canvas and accessible reorder; horizontal/vertical bars, single-axis line, eligible pies/donuts with remainder and local scatter previews. The scatter UI must remain capability-gated for legacy transports until step 3. Add no third-party runtime dependencies. Retain legacy calculation transport. UI/rendering can be reviewed independently of the new backend.
2. **Shared server row profile:** bounded TS/Go parsing and SQL lowering, authoritative definition resolution/revision handshake, server SELECT values, hidden computed ORDER BY before LIMIT, and capability-aware normalization/projection. This enables robust global computed sorts and is the core new backend work.
3. **Metric composition and scope:** extend the row plan with aggregate nodes, full-dataset ratio/sort, approved computed inputs/keys, shown-row windows, exact pie/donut totals/remainders, paired scatter expressions in one reduction plan with independent value/error channels, typed buckets/errors, wire migration, and worker fallback for shown-row regex. Reuse the row compiler instead of a second unrelated formula engine.
4. **Targeted additions only:** UTC time bucketing, further proven text/date helpers, then computed-field filters and their counts. Full-dataset regex, expression-group editor, shared metric catalogue, window functions, cross-metric dependencies, stacked charts and multiple series stay out of scope.

Avoid numerical delivery estimates until the consuming backend and data cardinality are known. The repository contains a compiler library rather than an owned full aggregation service, so integrating host endpoints and snapshot behavior is a real dependency.

## Acceptance checks for implementation

- Ratio-of-sums fixture: one group with `(x,y)=(1,1),(9,3)` returns `2.5`; average-of-ratios returns `2`. SQL/client agree, including integer inputs.
- Page of 100 within >100 matches; second page and changed row ordering alter shownRows only. Virtualization and row selection do not alter scope. Hidden measure inputs are available.
- Residual client filter cannot produce an “all matching” result over a pushdown superset. Unsupported function/transport retains the definition and requested scope.
- Sort by final value asc/desc, key asc/desc, multiple keys, counts, decimals, negatives, booleans, dates, null placement, group errors, and ties. A highest-ratio small group survives a top-N cap; server pagination is globally ordered.
- Empty set, all-null measure, empty-string vs NULL key, zero denominator with/without NULLIF, lazy branches, non-finite/unsafe numbers, per-row conversion error, distinct limits, high cardinality, and duplicate joined identities.
- Draft cancellation, one-step Apply/undo, reorder, dirty switching, custom Basic fallback, stale context, concurrent metric edit conflict, aborted previews, timeout and recovery, and partial metric failures.
- v1/v2 URL and saved-query round trips, malformed/unknown versions, source limits, schema capabilities/op overrides, injection attempts in fields/literals, authorization, and migration defaults.
- Client/Go/SQL conformance fixtures for every admitted server function; regex stays a worker-only shown-row feature. Test semantic outputs and error statuses, not merely SQL strings.
- Global computed sort finds extrema beyond the original page; hidden computed sorts work; SELECT/sort/metric values bind the same transitive definition revisions; browser-only fields cannot be global sort keys.
- Bar orientation changes only presentation; signed bars include zero; line x coordinates use actual time/number spacing and key order; nulls break lines; ratios cannot become pie slices; pie top-N includes exact Other against the full scoped quantity; zero/NULL/error states and accessible data views are explicit.
- Desktop authoring and narrow-canvas metric rendering checks, keyboard-only flow, focus restoration, screen-reader diagnostics, visible authoring scope context and inspected result coverage, and no label implying sample coverage is complete.

- Group arity 0/1/2/3/4+ preserves all keys; exactly two produces the X/Y pivot. Swap/order axes without recalculation; NULL/missing/error/omitted cells differ, and no ratio totals are inferred.
- Rem preferred/minimum sizes round-trip, including whole-rem stepping, minimum-to-desired synchronization, sub-8-rem sizes and root font scaling; dashboard/editor controls update the same draft without aggregate requests. Card title/value/axis labels round-trip with stable IDs; long text remains accessible. Labels/sizing/order/display do not invalidate compute keys.
- Compact previews and saved cards share renderers; resize by control and handle; actual layout dimensions drive SVG. Test signed values, narrow cards, long labels, dense groups, null/error states and Other.
- Preferred/minimum dimensions, dashboard order, Apply/Cancel and query URL/saved-layout migration round-trip. Phone/tablet/desktop canvases wrap identically to the metric container. Explicit oversized minimum remains accessible with horizontal scroll.
- Pointer/touch/keyboard/menu reorder, cancelled drag, focus restoration, drop feedback and announcements; contained overflow at smaller desktop dialog sizes. Mobile authoring is deferred. Remote preview remains explicit and concurrency bounded.
- Package/lockfile checks keep CodeMirror removed and add no new third-party runtime dependencies. Run PR #92 editor tests to preserve computed-column completion/signatures and shared wrapping, IME, undo/redo and escaped-field behavior after adding aggregate context; metric authoring hides suggestions.

- Scatter pairs X/Y by the complete typed group tuple under one scope/snapshot; no independent pagination or positional join. Test NULL/error on either axis, both invalid expressions, different units, Y sorting, tied points, cap coverage and both-axis revision changes. Reference insertion follows the focused expression; the suggestion section/button/hint are absent.
- Sidebar drag/action buttons are inside the chip’s single visual boundary; selected/hover/focus show all controls together without nesting interactive buttons. Keyboard controls stay discoverable and focusable.
- The prototype opens with 16 saved synthetic fixtures at every entry URL; Apply persists across refresh, while Cancel discards drafts. Layout hides every editor pane/sidebar and divider; the native select restores editor widths. No fixture/preset suggestions enter the production authoring UI.
- Default desktop dialog/sidebar widths are larger, view switching is in the header, and both removed explanatory sentences/preset chips are absent. A native select switches Fields/Functions, matching the header view select. Fields/functions remain visible next to the expression while settings scroll.
- All four pane widths resize through adjacent dividers; pointer and keyboard controls respect minima, cancellation restores the drag start, and Reset layout restores defaults. Modal width/height are independently adjustable within viewport bounds.
- Workbench geometry and accordion state remain separate from card dimensions and Apply/Cancel drafts. Resizing and accordion/reference tab changes issue no aggregate requests. Hidden preview transitions do not overwrite card-preview dimensions with zero.
- Desktop authoring is the initial target; narrow-screen metric/dashboard rendering remains supported. Do not add a mobile-authoring acceptance gate to this phase.

- Dashboard layout permits inline name editing, body/keyboard card selection, hover/focus-only action overlays, menu Edit, a shared preset/custom-width row and no scope/dimension footer in preview or final cards. Apply persists names/sizes/order; Cancel restores them. Size and label edits do not recompute.

- Temporal presentation round-trips units/presets/patterns/timezones; strict parsing, date-only preservation, offset-qualified instants, signed durations, carries, hours >24 and invalid-format channels are tested. Format edits start no aggregation work and never mutate raw values/sort keys.

### Legends, list styling and mark details

The Display section now offers legend placement (left, right, above, below or none) for pie, ring/donut and scatter displays. Legends reserve space inside the existing card; they never increase its requested size. Side legends stack entries, horizontal legends wrap, and overflow scrolls within the reserved area. Pie/ring keys include percentage shares and retain the same full-scope denominator and Other remainder. Scatter keys describe the first grouping dimension used for categorical color; each dot tooltip includes its full grouping tuple and both independently formatted measures. The remaining tuple dimensions distinguish points rather than introducing a second color scale. None hides the key but preserves mark tooltips and the data table.

List cards independently configure line bars, group colors and final values. The same renderer is used by the editor and dashboard. Group colors affect bars and category markers through the caller palette resolver; disabling colors uses the host accent for all bars and removes category markers. Bars remain proportional to raw values, independently of number/percent/temporal formatting. Only finite, nonnegative numeric buckets support these simple bars; signed, text or error groups retain label/value output without a misleading bar. Hidden values remain available on hover/focus and in Inspect. Defaults enable all three options; legacy configurations without these fields use the defaults.

Dashboard mark details use a shared native DOM tooltip, positioned within the viewport, with text-only content, immediate pointer hover and keyboard focus. Scatter points have an enlarged transparent hit area, full tuple labels and formatted X/Y values; pie/ring slices show label, value and share. Bars/line marks also identify their grouping key and value. Tooltips dismiss on pointer exit, blur, scroll or Escape. Escape dismisses an active tooltip before closing the editor. Mark hover does not select/reorder a card or launch a worker. Card selection, menu actions and drag handles remain independent of the hover interaction. Persist these presentation flags with the metric; they do not enter computation/cache keys.

## Distribution outputs

The [distribution proposal](metric-distribution-design.md) adds row-value expressions, exact quartiles, min/max or Tukey whiskers, optional means and bounded outliers, and shared-edge histogram counts. Box plots preserve full grouping tuples; histograms initially support no grouping or one comparison key. These results require backend statistical reductions, not reinterpretation of existing SUM/AVG outputs. Use one batched request and a shared snapshot for any multi-stage plan.
