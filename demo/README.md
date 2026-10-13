# query-table demo — local playground

A runnable Vite + React app that mounts the real `@pythia-software/query-table-ui` components
over an in-memory dataset (no backend). Use it to see changes to the packages
working live, and to manually test interactions like drag-to-reorder.

The published packages export compiled ESM from `dist/`. The demo's Vite config
aliases the local `packages/*/src` entry points so edits still hot-reload during
development.

## Run it

```bash
npm install            # once, from the repo root
npm run demo           # serves http://localhost:5179
```

Then open http://localhost:5179. You can:

- drag the **select** chips or the **table headers** to reorder columns,
- drag the **order by** chips to re-prioritize multi-sort,
- resize columns, sort via the header menu, filter, select rows.

The current view is encoded in the `?q=` URL, so reloads and bookmarks restore it.

## Date metric prototype

Open http://localhost:5179/date-metrics for an isolated metric-definition prototype.
The complete fixture contains 96 orders on seven of fourteen days (October 1–14,
2026). Toggle **Include empty dates**, switch Day/Week/Month, choose query,
observed, or custom bounds, and compare count, revenue, and average order value.
Line, bars, and table displays use the real `MetricCard` renderer. Empty count/sum
buckets are zero; empty averages are null. The empty-population scenario shows
how an explicit range can still produce buckets. Weeks start on Monday in UTC.

Apply/Cancel operate on this isolated example's in-memory metric definition.
Custom bounds restrict this fixture's metric population, and generated calendars
are capped at 400 buckets.

Run `npx vitest run demo/test/dateMetricsPrototype.test.ts` for calendar and
empty-value checks, or `node demo/date-metrics-test.mjs` with the dev server
running for interaction checks and screenshots in `.context/date-metrics/`.

## Empty dates in the existing metric workbench

Open http://localhost:5179/date-metrics-workbench to use the real `QueryBuilder`,
metric editor, dashboard, and record table over 96 runs in October 1–14, 2026.
Choose **Edit metrics → Runs by day → Grouping**. Date interval, Grouping timezone,
Include empty dates, and range settings live in the metric definition and persist through
Apply/Cancel, saved queries, and shared URLs. The count chart has seven zero
dates; Average duration by day leaves those dates blank.

Calendar grouping runs in the local metric engine. Complete client datasets and
committed shown rows are supported; all-matching metric servers report that date
grouping is unsupported. Calendar intervals use the named grouping timezone
(UTC by default), with Monday weeks and daylight-saving transitions. Custom
date bounds and calendar labels use that zone; query filters retain their
absolute instants. Try America/Denver with a custom October 1–14 range, or
Pacific/Auckland to see noon UTC runs move to the following calendar day.
Custom ranges must include observed buckets; query filters control the metric population.
Completion respects the engine's group, memory, and operation limits. The main
record table continues to show only actual runs.

Run `node demo/date-metrics-workbench-test.mjs` with the dev server running to
check the editor, preview, persistence, shared URLs, and mobile layout. Set
`QT_DEMO_URL` to use a different server origin.
Run `node demo/date-metrics-timezone-test.mjs` for timezone editing, local labels,
custom bounds, validation, persistence, and a timezone workbench screenshot.

## Menu playground and regression checks

Visit http://localhost:5179/menus to try the reusable menu components with light,
dark, and warm themes, nested submenus, RTL navigation, long scrollable lists,
clipped containers, viewport edges, context menus, dialogs, and mobile sheets.
It also includes paired radio actions, searchable field/value pickers, and forms.

```bash
npx playwright install chromium webkit
npm run demo                     # leave running in another shell
npm run test:menus
```

The browser suite checks theme inheritance and live updates, diagonal mouse travel,
keyboard focus and dismissal, scrolling, viewport bounds, clipping, RTL, dialogs,
phone sheets, and real table/query/metric consumers, including tag filters.
Set `QT_DEMO_URL` to test another local server or built preview.

## Row-producing grouping playground

Open `/grouping` on the same demo server. It uses the existing QueryBuilder,
SELECT chips, searchable FieldPicker, column customizer, filter editor, metric
editor, saved-query controls, and DataTable from the standard library. Grouping
is also available in the main and object collection playgrounds. See
[grouping integration](../docs/grouping.md).

The **Palette** selector previews Query-table, **Pharos · cream**, and
**Pharos · forest** without changing the active query or saved view. The base
Pharos colors come from `internal/archive/assets/ui.py` at `d797511`; the role
mapping in `src/grouping/groupingThemes.css` is a proposed adapter, not a change
to Pharos. It uses client-owned key, aggregate, and representative-row tokens
across chips, table headers, pickers, and dialogs. Cream uses a darker gold for
small key labels. Try **Busy workers** to compare all three roles together.
See the [UI palette contract](../packages/ui/README.md#client-palettes-and-column-roles).

Try these paths:

- **Individual runs** → **add group by** → **Platform**. SELECT starts with
  the group key; **add column** starts with a field, then offers aggregates.
  Back returns to the same field search.
- **Duration by platform** shows COUNT, AVG, and MAX side by side. Change an
  operator in a SELECT chip, or add another summary of the same source field.
- **Busy workers** filters on run count using HAVING and includes the Run ID
  and Job from each worker's representative run, initially ordered by Duration
  descending. Edit **representative row** beside GROUP BY to choose any sortable
  scalar source field, direction, empty-value placement, and secondary sorts.
  All ROW columns read from that same record. The shared ordering is independent
  of the final ORDER BY; aggregates still summarize every source match.
- After configuring a representative rule in GROUP BY, **Add column** → **Job**
  offers **Representative row** under **From one row**, separate from aggregates.
  Column selection only uses that shared rule; configure it through GROUP BY.
  Removing the rule explicitly removes its row columns; Undo restores both.
- **Add column** → **Duration** → **Custom aggregate…** opens a formula draft.
  Try `MEDIAN([total_ms])` or `MAX([total_ms]) - MIN([total_ms])`, give the
  column a name, and inspect its per-group values before applying. Field/function
  suggestions and the searchable Function library use the existing formula
  editor. Its separate Function library panel opens for custom aggregates and
  closes when selecting other columns. Panel controls can override this until
  the next column selection. Invalid formulas block Apply; removing one unblocks
  the other changes.
- Add a WHERE filter, switch saved views, and remove the final group key to
  return to individual rows and their previous columns and metrics. Removing a
  key in SELECT also removes its grouping. **Reset** restores the loaded saved
  definition. Undo/redo includes structural changes.
- Collapse the entire editor; active grouping remains visible and
  saved views remain accessible. Save a new view with the star, make it the
  default, and reload. **Share** encodes the complete grouping query in the standard `?q=` format.

The execution order is `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT/OFFSET`.
Grouping always consumes the full matching fixture, regardless of the detail
page. Metrics target the active result rows: group metrics see groups after
HAVING; `shownRows` sees the displayed group page. Changing group keys clears
group metrics; changing a summary clears its dependent HAVING/sort and group
metrics, with an explanatory notice and undo. Record metrics are preserved.

Unused WHERE, ORDER BY, GROUP BY, metrics, and zero OFFSET share a compact
row of add actions. Used clauses stay visible; empty metrics have no result
panel. GROUP BY and HAVING remain together and always show their controls. Result headers
mark keys, aggregates, and individual row values with amber, purple, and teal
labels, respectively. Role labels also appear in SELECT and the column editor.
These distinctions appear only in grouped views; individual runs use plain labels.

The column workbench and metric editor use shared library modal/panel components,
context strips, reorder lists, and visual language. Choose a column on the left, change its field
or summary in the middle, and inspect actual values in the live preview. Adding,
removing, reordering, and changing summaries are drafts until **Apply columns**.
The same field-first picker serves quick add and modal add; field search survives
Back, and keyboard arrows navigate choices. Advanced computed definitions remain
in the existing computed editor; apply summary drafts before using that editor.
Drag separators or use their arrow keys to resize panels. Close a panel with its
× and reopen it from Panels in the modal header, beside Reset layout. At least one stays open; closing panels
preserves draft content and scroll positions. Reset layout restores all panels
without changing drafts. Phones use section navigation, including a Functions
tab that inserts into the formula and returns to the Column tab.

The showcase uses 40 sample runs and the public library implementation. It
supports one grouping stage, aggregate formulas and one representative-row
ordering. Source paging never limits group membership. PostgreSQL/SQLite
execution, joins and nested grouping are not implemented. See the
[execution boundary](../docs/grouping.md#current-execution-boundary).

Compatible prototype snapshots are imported once from
`query-table:grouping-prototype:v2` (or v1) into the standard StorageAdapter.
Views mixing multiple legacy row strategies show an import notice. Original
storage and unreadable backups are retained. Old `?view=` links remain readable;
new links use `?q=`. The computed-column catalogue remains session-scoped;
snapshots contain its references, not its definitions.

With the demo running:

```bash
npx vitest run demo/test/grouping.test.ts
QT_DEMO_URL=http://localhost:5179 npm run test:grouping
QT_DEMO_URL=http://localhost:5179 npm run test:grouping-metrics
QT_DEMO_URL=http://localhost:5179 npm run test:grouping-theme
```

The browser checks cover both modes, source WHERE, HAVING, target metrics,
SELECT operators, complete saved views/defaults/sharing, undo/redo, custom aggregate
formulas, panel geometry and draft preservation in both editors, and a narrow
mobile viewport, plus short landscape touch screens in Chromium and WebKit.
Optional `QT_BROWSER_PATH` or
`QT_BROWSER_CHANNEL` chooses an installed browser. Screenshots are written to
`.context/grouping-desktop.png`, `.context/grouping-mobile.png`, and
`.context/grouping-aggregate-editor.png`. The theme suite runs Chromium and WebKit,
including 320px/390px mobile portals, host token aliases, isolated table palettes,
nested computed editors under an OS-dark preference, and query preservation.
It saves palette previews as `.context/grouping-theme-*.png`.

The grouping-metrics suite runs in Chromium and WebKit. It checks independent
expected values through source WHERE, HAVING, LIMIT/OFFSET (including empty
pages), both metric scopes, editor creation/previews, URL reload, mode switching
and undo. It uses the built core package for query serialization; run
`npm run build:packages` first. Screenshots go to `.context/grouping-metrics/`.
The npm script enables type stripping for the shared TypeScript fixture on all
supported Node versions, including 22.14. The full grouping suite also checks
one-time prototype migration, preserved backups, and old shared links.
Core and React tests additionally cover generated populations, a 50,000-row
dataset, nulls, tied sorting, custom formulas/distributions, relative dates,
representative dependencies, data replacement, host validation and saved views.

To run on a workspace-specific port, pass Vite arguments to the demo workspace:

```bash
npm run dev --workspace @pythia-software/query-table-demo -- --host 127.0.0.1 --port 55140 --strictPort
```

## Component-specific feedback

The development playground includes Agentation. Use the toolbar in the
bottom-right corner to activate annotation mode, click a component, and write
your comment. Open the actual column customizer or filter/sort/metric sheet
before activating annotation mode to comment on its controls. The toolbar
follows the topmost dialog so comment inputs remain usable inside focus traps.
Development dialogs reserve space for the launcher so it does not cover their
normal actions.

In Agentation settings, choose **Detailed** or **Forensic** output for more
context. Use **Copy feedback** and paste the generated feedback into your coding
agent's chat. Feedback includes the selected element's path and available React
component context; notes persist locally in this browser. Copying feedback is
the handoff: automatic MCP syncing is not configured.

Agentation is loaded only by `npm run demo`. It is excluded from the production
build and is not installed in the published query-table UI package.

With the dev server running, `npm run test:feedback` verifies annotation,
source/selector export, note persistence, and focus inside desktop dialogs and mobile sheets using
an isolated browser session. It writes a preview to
`.context/query-agentation-playground.png` without changing your own notes.

## Drag-and-drop regression test

Native OS drag deadlocks headless Chromium, so `dnd-test.mjs` drives the live
app with synthetic HTML5 `dragstart → dragover → drop` sequences against the real
React tree and checks that the committed order matches the live preview, that
there are no dead drop zones, and that the dragged element stays mounted (removing
it mid-drag aborts the native drag).

```bash
npm run demo                       # in one shell (leave running)
node demo/dnd-test.mjs             # in another — prints PASS/FAIL per scenario
```

It needs Playwright's Chromium once: `npx playwright install chromium`.

## Mobile interaction checks

On phones, tap filter/sort/metric summaries to edit or remove them in sheets.
Drag the leading handles on columns, sorts, and metrics directly in the query
builder; there are no Order buttons or filter ordering controls.
Inside the column workbench, drag
the leading handles directly in the selected list; Apply commits the draft.
Selected, Catalogue, and Preview are compact, focused sections.

```bash
npx playwright install chromium webkit
npm run demo                     # leave running in another shell
npm run test:mobile
```

The suite exercises Chromium and WebKit at phone, tablet, and landscape sizes.
It checks sheet bounds, scoped themes, picker scroll safety, nested conditions,
column editing, compact section headers, native sort settings, optional regex
extraction, metric setup/grouping, deletion through the pencil editor and undo,
32px zero-padding chips, section spacing without clause dividers, cell/header menus,
and direct touch reordering (including wrapped columns). Chromium ordering uses
real touch events, not synthetic HTML5 drag events. Preview screenshots are
saved in the gitignored `.context/` directory.
