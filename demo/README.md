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
