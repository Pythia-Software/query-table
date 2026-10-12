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
32px zero-padding chips, section spacing, clause separators, cell/header menus,
and direct touch reordering (including wrapped columns). Chromium ordering uses
real touch events, not synthetic HTML5 drag events. Preview screenshots are
saved in the gitignored `.context/` directory.
