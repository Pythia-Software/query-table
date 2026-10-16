# Public Query Table demo

The externally facing demo is a single-page static application, built from the
current core/react/ui/DuckDB source in this checkout. It contains no API server,
account requirement, development feedback overlay, or production database.
One `index.html` plus relative JS/CSS, DuckDB workers/Wasm and versioned Parquet
files works on GitHub Pages, a subdirectory, or another static host.

```sh
npm ci
npm run build:showcase
npm run preview:showcase
```

Publish the **contents** of `demo/dist-showcase/`. Its `.nojekyll`, relative
asset URLs and query-parameter navigation support GitHub project Pages under
`/query-table/` without a router rewrite or 404 fallback. Modern browsers with
WebAssembly are required. The first visit downloads one DuckDB engine bundle;
later visits benefit from ordinary HTTP caching. Both exception-handling and
MVP bundles are shipped, and feature detection selects one. They are copied from
the exact installed `duckdb-wasm` package. ICU, Parquet and JSON extensions are
also served from the same static origin. The build fetches these official
DuckDB binaries into `.context/duckdb-runtime/`, verifies the SHA-256 and size
against `demo/duckdb-runtime.json`, and copies them into the output. Browser
queries never need a runtime CDN or upstream data API. When intentionally
updating the Wasm package, update that lock's engine/package versions and run
`node demo/scripts/prepare-showcase-runtime.mjs --record`, then review the new
binary hashes and rerun the browser checks. Upstream runtime license notices
are included under the output's `duckdb/` directory.

## Local verification and static hosting

Demo builds and browser checks run locally; pushes to `main` do not trigger a
GitHub Actions demo build or deployment. The tag-only npm release workflow is
retained for trusted publishing; see [Releasing](../RELEASING.md).

From the repository root, install dependencies and the browser once, then run
the same native DuckDB, production build and browser checks together:

```sh
npm ci
npx playwright install chromium
npm run check:showcase
```

On Linux, use `npx playwright install --with-deps chromium` to install required
system libraries as well. Checks use Playwright's bundled Chromium by default;
set `QT_BROWSER_CHANNEL=chrome` to use an installed Chrome instead.

After verification, upload the **contents** of `demo/dist-showcase/` to your
static host. No deployment provider or credentials are configured in this
repository; publishing is a separate maintainer operation. The build works
at a host root or under `/query-table/`, and the browser
suite verifies subpath hosting locally.

Ordinary builds use the committed datasets and do not fetch new source data,
so library updates cannot change counts or break upstream downloads.

Data refresh is a separate reviewed operation:

```sh
npm run data:showcase              # refresh/rebuild all cohorts
npm run data:showcase -- 311       # rebuild only one
npm run data:showcase -- trips
npm run data:showcase -- food
```

The preparation script uses native DuckDB and caches downloaded source data
under `.context/dataset-cache/`. Remove only the source cache file for the
specific dataset when an upstream refresh is intended. Food Facts pins the
Hugging Face commit returned by its metadata service. Rebuilds record original
download URLs, hashes/revisions, normalization and cohort rules. Commit each
Parquet together with its adjacent manifest. Client loading verifies its byte
count and SHA-256 before registering it with DuckDB.

## Included cohorts and attribution

| Dataset | Cohort | Source |
| --- | --- | --- |
| NYC 311 | January 2025, request key divisible by 17 | NYC Open Data |
| NYC taxi trips | January 2025 yellow trips, every 101st source row with January pickup | NYC TLC |
| Open Food Facts | First 8,000 source rows, retaining named products and unique barcodes | Open Food Facts |

These bounded cohorts demonstrate query behavior. They are **not** estimates of
citywide volumes or the global food market. Source anomalies and useful nulls
are retained. Taxi cash tips are not recorded. Food nutrient quantities use the
source's per-100g/per-100ml conventions, and missing allergen tags do not establish
absence. Status/closure fields on 311 reflect the downloaded export, not a
historical status snapshot. See `demo/public/data/*.json` for exact provenance.
Each dataset's **Data & sources** dialog exposes source/license links and a
download of the same cohort. Food Facts data remains ODbL; the surrounding code
is MIT. No product photographs are included.

## Features and persistence

The public app uses the standard QueryBuilder, MetricsPanel, DataTable, item
details and editors. The page opens directly onto the query editor and records,
with a saved-query sidebar and metrics underneath. The example queries are
read-only entries in the same `api.saved` catalogue as personal views. Saving a
copy, loading it, updating it, and managing it use the ordinary controller API;
the host supplies the sidebar through `QueryBuilder.savedQueryControls`.
Chart categories add filters; grouped examples execute GROUP BY/HAVING through the DuckDB v3
transport. Metrics cover ratios, median, time series, donut/bar charts, boxes
and histograms. Selection exports records from the displayed page as JSON.

**Take the tour** introduces the product through five chapters and 21 lessons:

1. **The idea**: a query becomes a table and metrics; change the question and see the results.
2. **Use the table**: header sorting, cell filters, resizing, column dragging, selection, and record details.
3. **Build a query**: column selection, AND/OR filters, an authored IF/ROUND formula, GROUP BY, aggregate columns, and HAVING.
4. **Explore with metrics**: author a measure, drill into a chart, and undo the drilldown.
5. **Save & share**: save a focused view, switch away and restore it, explore a saved example, and create a share link.

A short preview highlights each topic's feature. **Learn more** opens its guided
steps; **Skip** moves to the next preview, and **Finish** lets visitors leave
after the final preview. The topic picker also opens previews. Browsing previews,
skipping, and going back preserve the current query. Entering the guided steps
establishes a fresh record view; Save & share starts with a focused example.
Starting, restarting, and ending the tour preserve the current query.
**Do it for me** performs the actual controller action for a lesson and leaves its
result visible for review. Lessons also recognize actions taken through the
ordinary table, query editors, and saved-query controls. The guide then moves
its arrows from the input control to the changed table, query, or metric.

The tour card always uses the opposite theme from Query Table. The demo follows
the initial system theme and provides a persistent light/dark toggle. A light
14% backdrop, spotlight cutouts, and curved arrows retain context. The guide
tracks scrolling and resizing and leaves room above native editors. Inside an
editor it belongs to that editor's focus scope, so keyboard users can reach the
assisted action too. A segmented progress line replaces visible chapter and
lesson counts. The pointer icon indicates an action; the eye indicates reviewing
a result. Clicking either reveals its target. The footer has a previous-step
icon, **Do it for me** (which becomes a continue arrow after completion), and a
next-topic icon. All icon controls have accessible names and hover hints.
Preview cards label their two choices explicitly; detailed steps retain the
compact icon controls. Returning from a topic's first step shows its preview
without undoing the work, so visitors can reconsider exploring the rest.

Drag the card by its grip or heading; arrows follow its facing edges as it moves.
The chosen position persists through steps and is clamped to the visible viewport.
Editors retain a separate position so opening one doesn't cover its controls.
The grip also supports arrow keys (Shift for smaller moves) and Home to restore
automatic placement; double-clicking the grip restores placement too.

Finishing the tour offers an optional **Build with Query Table** finale. Visitors
can keep exploring or open five interactive slides; the same entry is available
in the workspace header at any time:

1. **Integrate**: React and native macOS starters, with PostgreSQL, SQLite, and DuckDB executor choices and setup links.
2. **Boundaries**: the library owns interaction, state, contracts, and bundled SQL planning; the host supplies authorized data, execution, drivers, endpoints, and persistence. A request inspector shows the actual row-query contract.
3. **Defaults**: switch columns, sorting, page size, and filters in a live sample table, with corresponding configuration examples.
4. **Views & links**: save and restore a view, compare inline and short links, then resolve a captured query through a fresh client.
5. **Theme**: change scoped accent and radius tokens, including selected rows, and copy the CSS.

The finale uses the real controller, table, storage adapter, and link service
with isolated sample orders. It does not change the main dataset query, URL, or
saved catalogue. Its named views and immutable link snapshots use a simulated
in-memory host that is discarded when the guide closes. Example application
URLs are illustrative; a production host must implement durable snapshot save
and resolve for cross-device short links. GitHub Pages supplies static hosting,
and the public dataset demo continues to share portable inline URLs.
The slide modal uses the opposite theme, scrolls within the viewport, and keeps
navigation visible and keyboard focus inside the guide.

The host refreshes an immutable DuckDB execution handshake when the local
computed-column catalogue changes. Each handshake uses its own connection and
isolated temporary staging tables over the same verified snapshot. Formulas are
validated against the DuckDB profile before persistence; supported definitions
can be selected, filtered, sorted, or grouped through the normal v3 transport.
Old connections drain before closing. This keeps custom formula authoring in
the demo connected to the real backend rather than a separate display state.

Personal saved queries and last views are explicitly stored in browser localStorage,
namespaced by dataset. The current view is encoded in that dataset's URL
parameter. Switching datasets keeps other views in localStorage and removes
their URL parameters. Shared links are inline and portable up to the configured
12 KiB URL budget; a new browser can restore them without that local storage.
Very large states can require trimming before sharing. Computed definitions persist
in a separate local catalogue and are negotiated with the browser DuckDB backend.
When browser storage is inaccessible, personal queries remain usable for the page
session through the memory adapter.

## Verification

`npm run test:duckdb` executes native DuckDB conformance tests, and
`npm run test:showcase` tests browser loading, metrics, filters, grouping, item
details, fresh-context links, mobile layout, and every guided action on all three
datasets (including a mobile walkthrough). It also verifies saved-view reloads,
both themes, all assisted lessons, chapter jumps, result arrows, native controls,
formula execution, and overlay cleanup. The suite also verifies the optional
finale, integration choices, live defaults, saved views, fresh-resolver short
links, theme tokens, isolated state, focus containment, and 320px layouts.
`demo/test/integrationExamples.test.ts` covers the example snapshot adapter's
immutable retries, cache-independent resolution, and dataset scoping.
`demo/test/showcaseStorage.test.ts` covers
catalogue isolation, updates/defaults, example protection and session fallback.
Build the showcase first; the
test starts its own static server under `/query-table/`. To use an existing
preview instead, set `QT_SHOWCASE_URL` to its URL or a project subpath. Test screenshots
are saved under `.context/`.
On failure, the suite saves `showcase-failure.json` with the error, browser
errors and requested URLs, plus `showcase-failure-*.png` screenshots of open
pages in the same directory.
