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
