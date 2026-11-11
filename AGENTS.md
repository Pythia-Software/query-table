# Working in query-table

Instructions for coding agents. `CLAUDE.md` points here; keep this file short.

## Setup

- Node 22.14+ is required. If `node -v` is older, run `. scripts/use-node.sh`
  in the same command (it finds an nvm Node 22+). Older Node fails while
  loading `vitest.config.ts`.
- A fresh worktree has no `node_modules`: run `sh scripts/setup-workspace.sh`
  once (Conductor does this on workspace creation).
- Type checks and unit tests read package source. You do not need to build
  packages, and `dist` being absent or stale is not an error.

## Verify with the cheapest thing that covers the change

1. While editing, run only what you touched:
   - `npx vitest run <test file or directory>` or `npm run test:changed`
   - `npm run typecheck -- ui` (any substring of a project path; all nine
     projects take about 5 seconds with no argument)
   - `cd backends/go && go test -run '^TestName$' .`
2. Before pushing, at most once: `npm run check:fast` (about 30 seconds: wire
   codegen, typecheck, vitest, Go tests and vet, SQLite parity).
3. Just push. The pre-push hook picks the tier from the changed paths and
   prints which one it chose. Backend, schema, wire codegen or lockfile
   changes run the full `npm run check`, whose SQLite race suite takes 5 to 10
   minutes, so give `git push` a 10 minute timeout. Do not run `npm run check`
   yourself first; the hook would repeat it. Pull-request CI runs the full
   gate on every change.
4. `npm run package:check` only for packaging or export changes, and
   `npm run release:check` only when releasing. Never run two of
   `build`, `package:check` or `release:check` at once in one worktree.

Send long output to a file under `.context/` and read the tail.

## Browser checks

- `npm run test:demo -- <name>...` starts its own demo server on a free port,
  runs `demo/<name>-test.mjs`, prints one line per check and exits.
  `-- --list` shows the names. These checks are not part of `npm run check`.
- `npm run demo:screenshot -- /menus --out .context/menus.png` captures a
  page the same way (options are in the script header). Use it before writing
  a Playwright script.
- A demo check that fails may already fail on `main`; confirm there before
  fixing it as part of unrelated work.
- Demo pages: `/`, `/cells`, `/chart-layout`, `/date-metrics`,
  `/date-metrics-workbench`, `/filter-values`, `/fit-controls`, `/grouping`,
  `/menus`, `/objects`, `/run-actions`, `/saved-queries`. `/postgres` needs
  `npm run demo:postgres`.
- Postgres tests skip without `QT_TEST_POSTGRES`. Homebrew `pg_ctl` needs
  `LC_ALL=en_US.UTF-8`; use a TCP URL DSN, not a socket path.

## Reading the code

Context is re-read on every step, so what you load early costs the most.

- Find the symbol first (`rg -n`), then read about 100 lines around it.
  Do not read whole files over a few hundred lines.
- `git diff --stat` first, then the diff of the files that matter.
- Never read `package-lock.json`, `*.generated.*`, `wire_generated.go` or
  `CHANGELOG.md` in full; search them.
- Issue independent searches and reads in one step, not one per step.
- For a question that spans many files, delegate the search to a sub-agent
  and work from its summary.

## Where things are

| Area | Location |
|---|---|
| Query model, encoding, filters, grouping, formulas, metrics | `packages/core/src` (`query.ts`, `encode.ts`, `grouping.ts`, `formula.ts`, `metrics.ts` and `metric*.ts`) |
| React state hook and execution | `packages/react/src` (`useQueryTable.ts` is the hub; one `use*.ts` per concern) |
| Components and CSS | `packages/ui/src`. Large components are an entry file plus a folder: `QueryBuilder.tsx` + `queryBuilder/`, `MetricsEditor.tsx` + `metricsEditor/`, `grouping/` |
| DuckDB backend | `packages/duckdb/src` |
| Go backend: validation, planning, SQLite execution, HTTP | `backends/go` (`query_v3_*.go`, `sqlite_*.go`, `plan.go`, `calendar.go`) |
| SQLite and Postgres integration, parity and benchmarks | `backends/sqlite-tests`, `backends/postgres-tests` |
| Wire schema and shared fixtures | `schema/`. Generated: `packages/core/src/wire.generated.ts`, `backends/go/wire_generated.go`, `native/macos/.../Wire.generated.swift`, `docs/errors.md`. Edit `tools/wire-codegen`, then `npm run wire:generate` |
| Demo app and browser checks | `demo/src`, `demo/*-test.mjs` |
| Swift package | `native/macos`, `Package.swift` |
| Design notes and feature docs | `docs/` (one file per feature; search by feature name) |

Unit tests sit in `packages/<name>/test`, named after the source file.

## Conventions

- TypeScript and Go validate the same wire format. Change both, and the
  fixtures in `schema/fixtures`, together.
- User-visible changes get a `CHANGELOG.md` entry under `Unreleased`.
- Add a regression test with a behaviour change.
- New components go in their own file. Keep source files under about 800
  lines; split by concern into a sibling folder before they grow past that.
