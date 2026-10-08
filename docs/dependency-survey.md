# Dependency removal survey

Surveyed 2026-10-08 against the workspace's manifests, source imports, scripts,
lockfile, and package/demo builds. The inventory and build measurements below describe the pre-migration baseline.

Migration follow-up: CodeMirror has been replaced by a native textarea editor
with suggestions, signature help and compiler diagnostics. TanStack is retained
by design, with `@tanstack/react-virtual` pinned to `3.14.11` (and its exact
`@tanstack/virtual-core` dependency at `3.17.9`). Ajv remains unchanged; removal
is a separate proposed cleanup.

## Recommendation

We can make the web libraries **free of third-party runtime dependencies apart
from their React framework peers** without losing query capabilities. Most of
the remaining dependency cost buys editor convenience and variable-height table
virtualization. Those are reasonable places to accept narrower behavior.

The most useful order is:

1. Remove unused Ajv from development tooling.
2. Replace the default formula editor with a native textarea. Preserve validation,
   the function browser, previews, and signature help. Offer CodeMirror through
   a separate adapter package if rich editing remains useful.
3. Remove TanStack by choosing either fixed-height virtualization or a bounded,
   paginated table. Preserve variable-height virtualization through an optional
   adapter if that capability is needed.
4. Consider a simpler package build using TypeScript and small Node scripts.
   This reduces contributor tooling, independently of consumer dependencies.

Keep first-party package relationships and React peers unless there is a
separate reason to redesign distribution or framework support. Removing their
manifest entries alone would obscure real requirements.

Estimates below are engineering judgments for someone familiar with this repo,
including focused verification, rather than measured implementation times.
Small means hours to two days, medium means roughly three to five days, and
large means one to several weeks. Browser compatibility can extend those ranges.

## What “zero dependency” would mean here

| Goal | Current position | Remaining work |
| --- | --- | --- |
| No third-party runtime packages in core, codegen, Go, or native Swift | Already achieved | Maintain the boundary |
| No third-party runtime packages in the React hook layer, excluding React itself | Already achieved | Maintain the boundary |
| No third-party runtime packages in the web UI, excluding React/React DOM | Seven direct packages remain | Replace or relocate CodeMirror and TanStack |
| No npm `dependencies` entries at all | React, UI, and codegen still depend on our own packages | Bundle shared implementation or merge packages; this changes distribution rather than removing an external dependency |
| No framework peers | React and UI require React; UI also requires React DOM | Build an additional framework-independent state/view layer or replace the React products |
| No contributor dependencies | Root build/test tooling and demo tooling remain | A much larger project, with little further consumer benefit |

An editor adapter in a **separate package** can remove its dependency graph from
the default UI installation. An export subpath or dynamic import alone cannot
do that while its packages remain ordinary dependencies in the UI manifest.
Optional peers can work with a carefully isolated entrypoint, but place manual
installation/version coordination on consumers. Bundling or vendoring third-party
code removes installation edges while retaining the code, licenses, and update
responsibility.

## Inventory by shipped library

Versions in this table are manifest constraints, not proposed updates.

| Library | Ordinary dependencies | Framework peers / platform requirements | Assessment |
| --- | --- | --- | --- |
| `packages/core` | None | JavaScript/browser or Node built-ins | Already zero-dependency |
| `packages/react` | Our core `0.5.0` | React `>=18 <20` | Already free of external runtime packages beyond its framework |
| `packages/ui` | Our core and React packages `0.5.0`; six CodeMirror packages; TanStack React Virtual | React and React DOM `>=18 <20` | Main runtime reduction opportunity |
| `tools/schema-codegen` | Our core `0.5.0` | Node file/path/process APIs | Already free of external runtime packages |
| `backends/go` | No `require` entries in `go.mod` | Go standard library; application-supplied PostgreSQL driver/connection for the SQL store | Already zero-dependency |
| Swift `QueryTableCore` | None | Foundation | Already free of external packages |
| Swift `QueryTableFormula` | Our native core | Foundation, Apple JavaScriptCore, bundled generated formula interpreter | Already free of external packages |
| Swift `QueryTableUI` | Our native core and formula targets | AppKit, SwiftUI, Combine, Foundation | Already free of external packages |

Both Swift manifests describe the same target relationships and have no remote
package dependencies. The demo/check executables and native test targets depend
only on our native targets and system frameworks.

### Core: nothing to remove

The core implements schema projection, query normalization, URL encoding,
filtering/sorting, aggregation, adapters, and the formula language itself.
Its source imports only local modules. React node types deliberately do not leak
into core's cell-renderer contract. This is already the desired architecture.

Browser workers, `fetch`, URL handling, JSON, regular expressions, and date
operations are platform facilities rather than downloaded libraries. In
particular, changing the formula editor does not require changing the formula
parser or evaluator.

### React: assess both declared dependencies

| Dependency | Actual use | Removal path | Cost / sacrifice | Recommendation |
| --- | --- | --- | --- | --- |
| Our core `0.5.0` | Runtime query processing, aggregation, adapters, formula compilation/evaluation; shared public types | Bundle selected core implementations, or merge core and React distributions | Medium packaging work. Duplicate implementation across distributions, coordinated releases, and continued public type references must be handled. No external library is eliminated | Keep |
| React peer `>=18 <20` | State, effects, memoization, callbacks, refs throughout hooks | Extract an external-store/controller API into core, then keep thin React bindings; alternatively make consumers write all bindings | Large. Must define subscriptions, cleanup, cancellation, stale responses, persistence, undo, and computed-column lifecycles. React hooks still require React | Keep for this package; pursue a controller only if another framework needs it |

Moving pure state logic into core can improve reuse. It is not a way to make a
package whose product is React hooks independent of React.

### UI: CodeMirror, dependency by dependency

All six direct CodeMirror imports are confined to
[`FormulaEditor.tsx`](../packages/ui/src/FormulaEditor.tsx).
The formula editor is private and reached through a lazy import in
[`SelectColumnEditor.tsx`](../packages/ui/src/SelectColumnEditor.tsx).
That is a useful replacement seam: the rest of the UI does not call CodeMirror.

| Dependency | Constraint / locked version | What we use | What removing it entails |
| --- | --- | --- | --- |
| `@codemirror/state` | `^6.7.5` / `6.7.5` | Editor document/state creation, selection and transactions | Use textarea value and selection APIs. Cannot remove from a working CodeMirror view; view and other extensions also require state |
| `@codemirror/view` | `^6.43.12` / `6.43.12` | Editor DOM, line numbers/wrapping, keymaps, tooltips, themes, update listener | Replace the editor surface. Lose CodeMirror's rendering, cursor/selection handling, and rich inline UI. This is the central dependency |
| `@codemirror/commands` | `^6.11.1` / `6.11.1` | Default editing keymap and history/undo/redo | Native textarea provides ordinary editing/undo, but not the same command/history behavior. Programmatic insertion and externally controlled updates require browser checks |
| `@codemirror/autocomplete` | `^6.20.3` / `6.20.3` | Field/function/keyword completion; paired bracket insertion | Keep the existing field/function browser and explicit insert actions, or implement a small accessible suggestion list. Drop automatic completion and bracket closing initially |
| `@codemirror/lint` | `^6.9.7` / `6.9.7` | Debounced compilation errors as inline diagnostics | Display the existing compiler error below the textarea, with an accessible description and optional “select error” action. Validation survives; underlines/tooltips disappear |
| `@codemirror/language` | `^6.12.4` / `6.12.4` | Custom stream tokenizer, highlighting and bracket matching | Drop syntax coloring/matching, or show a separate read-only highlighted preview. Commands/autocomplete also depend on language, so deleting only our direct import does not remove its installation |

Removing lint or autocomplete independently is small work but makes only a
small graph reduction. Removing commands alone does not remove language because
autocomplete also depends on it. Treat the six as one editor subsystem for the
largest benefit.

**Practical default replacement: medium, approximately three to five days.**
Use a labelled monospace textarea, preserve caret position when inserting a
field/function, retain the existing function browser and preview workflow, and
reuse `FORMULA_FUNCTIONS`, `compile`, `FormulaError`, and `signatureAt`.
`SelectColumnEditor` already computes validation separately from CodeMirror, so
save/preview correctness does not depend on the editor's lint extension.

Accept the loss of syntax coloring, line-number gutters, bracket matching,
automatic completions/closing, inline squiggles, and hover documentation.
Function documentation can remain in the browser/help area. Basic selection,
typing, copy/paste, and undo remain native; we need to verify controlled updates
and insert actions do not unexpectedly reset history or the caret.

Building an editor with full feature parity is a large and ongoing project.
The installed CodeMirror view changelog includes composition/IME, bidi,
mobile scrolling, Safari, and VoiceOver fixes. A native textarea lets the browser
own basic editing; a custom contenteditable/highlighting overlay makes us own
many of those details. A narrowly scoped formula editor is a reasonable cost to
pay; recreating a general-purpose editor is much less attractive.

**Optional rich editor: medium.** Add an editor component contract based on the
current `value`, `onChange`, `fields`, and `compile` props, and ship CodeMirror in
a separate package. Existing users who want rich editing install/pass the
adapter; everyone else gets the textarea. This preserves capability at the cost
of an extra configuration step and adapter/version maintenance.

### UI: TanStack virtualization

`@tanstack/react-virtual` (`^3.14.11`, locked `3.14.11`) is imported only by
[`DataTable.tsx`](../packages/ui/src/DataTable.tsx). It pulls in
`@tanstack/virtual-core` (`3.17.9`). The table uses a relatively narrow API:

- Count, viewport/scroll element, estimated row size, stable row keys, overscan.
- Sticky-header scroll margin and an initial viewport rectangle for SSR.
- Virtual item positions and total height for table spacer rows.
- **Actual row measurement** through `measureElement`.

The last point matters: `estimateRowHeight` is an estimate, not a current
fixed-height restriction. Arbitrary custom renderers can change row height.
The upstream [virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
documents the measurement, viewport, key, and scroll-margin responsibilities a
replacement would inherit.

| Approach | Work | Sacrifice / responsibility |
| --- | --- | --- |
| Render every row in the loaded page | Small | Give up the existing large-page DOM bound. Query default limit is 100, but callers can supply much larger pages; preview limits do not constrain `DataTable` |
| Implement fixed-height windowing | Medium | Require one actual uniform row height, constrain renderer content, and handle clipping/wrapping. Keep overscan, stable IDs, spacers, header offset, resizing and SSR |
| Implement measured-height windowing | Large, approximately one to three weeks initially | Preserve behavior but own measurement caches, cumulative offsets/range lookup, invalidation on reorder/resize, scroll correction and browser table geometry indefinitely |
| Default to a bounded/plain table; separate virtualized adapter | Medium to large | Default installation gets simpler behavior; large-data users explicitly select an adapter. Requires a rendering/windowing seam and migration guidance |

A fixed-height hook can derive the visible range from scroll offset, header
height, viewport height, row height and overscan. It needs scroll observation,
`ResizeObserver`, lifecycle cleanup, data-change clamping, and a stable initial
SSR range. That is manageable if the product accepts uniform rows.

Avoid pretending a fixed-height implementation preserves existing measured
rows. Also, native `content-visibility` can reduce rendering work but does not
bound the number of React elements/DOM rows created.

**Recommendation:** remove TanStack if uniform rows or small bounded pages are
acceptable. If arbitrary-height custom renderers are a requirement, keep it
until an adapter boundary is ready. The current test explicitly expects fewer
than 20 rendered rows for a 12,000-row input; removing virtualization requires
changing that supported behavior intentionally.

### UI: first-party and framework dependencies

| Dependency | Actual use | Removal path | Cost / sacrifice | Recommendation |
| --- | --- | --- | --- | --- |
| Our core `0.5.0` | Runtime capability/query/formula helpers and shared public types across components | Bundle core or merge packages | Medium. Duplication and public type distribution; no external graph reduction | Keep |
| Our React package `0.5.0` | Most imports are API types, but `DataTable` calls `useColumnDrag` for its local fallback | Move that shared hook to another entrypoint, require host-provided drag state, or inline/bundle it; also solve public `.d.ts` references | Small to medium for the hook; larger for standalone type packaging. Duplicating it risks divergence, requiring it loses the standalone fallback. Converting only this to a peer shifts installation to consumers | Keep unless independent UI distribution is valuable |
| React peer `>=18 <20` | Components, hooks, context, JSX runtime | Rewrite UI for DOM/custom elements or another framework | Large, many weeks; loses the current React API and transfers view lifecycle/accessibility work to us | Keep |
| React DOM peer `>=18 <20` | `createPortal` in `AdaptiveOverlay`; TanStack also declares this peer | Remove TanStack and use an inline overlay or native dialog/top-layer approach | Medium with mobile verification. Inline overlays can be clipped/stacked by ancestor containers; dialog changes focus, dismissal, scroll and theme behavior. Host-supplied portals shift responsibility | Keep; React browser applications already normally have it |

React/React DOM are peers supplied by the host. They do not represent a private
framework copy we should bundle. The lockfile's React 18 install also includes
`loose-envify`, `js-tokens`, and, through React DOM, `scheduler`; these belong to
the chosen framework version, not to our own helpers.

### Codegen

Its only package dependency is our core `0.5.0`.
[`generate.ts`](../tools/schema-codegen/src/generate.ts) imports `loadSchema` to
validate/project documents. The CLI already uses a hand-written argument parser
and Node built-ins; there is no CLI, formatting, or schema-validation library to
replace.

We could bundle the tree-shaken schema loader into codegen and remove its core
installation requirement (small to medium packaging work). That preserves a
standalone CLI at the cost of carrying a snapshot of shared validation logic.
Generated TypeScript would still import the core `FieldSchema` **type**, and
generated Go still references our Go backend types. Duplicating those contracts
to claim complete independence would make generated output harder to maintain.
Keep the current relationship unless a single-package CLI is a specific goal.

### Go and native platform dependencies

Go uses standard library JSON, SQL, HTTP, strings, time, etc. The SQL store expects
the application to provide a PostgreSQL driver via `database/sql`; we already
push that dependency to the host. Removing SQL/HTTP helpers from the backend
would remove useful integrations without reducing third-party library count.

Native core relies on Foundation for JSON, URLs, dates and networking. Native
UI relies on SwiftUI/AppKit for views, the `NSTableView` grid and interaction,
and Combine for controller observation. These are system frameworks, not SPM
downloads. Replacing them is a platform/API redesign with no external-package
benefit. Moving Combine observation to newer native observation facilities would
also change the controller API rather than reduce downloads.

`QueryTableFormula` uses Apple's JavaScriptCore to execute our generated
TypeScript parser/interpreter. Replacing it with Swift would require porting
parsing, type checking, function semantics, evaluation limits and compatibility
tests (large, several weeks or more), then maintaining two implementations.
We would gain a Swift-only runtime but lose the shared implementation. Regex
formulas are currently rejected in the native bridge because it lacks an
interruptible execution watchdog; a port needs an explicit regex policy too.
Making computed columns an optional native UI feature would require splitting
the UI's dependency on `QueryTableFormula`. None of these reduce external
package count, so they are low priority for this goal.

## Transitive runtime footprint and measured build

Following **ordinary dependency edges** in the checked-in npm lockfile:

| Subsystem | Distinct packages, including direct roots | Additional packages |
| --- | --- | --- |
| CodeMirror | 13 | `@lezer/common`, `@lezer/highlight`, `@lezer/lr`, `@marijn/find-cluster-break`, `crelt`, `style-mod`, `w3c-keyname` |
| TanStack virtualization | 2 | `@tanstack/virtual-core` |
| Combined removable UI graph | **15** | Excludes our packages and React/React DOM peers |

Lezer supplies language/tree/highlighting infrastructure; the other helpers
support grapheme boundaries, DOM construction, style injection and key names.
We do not import these seven helpers directly. Remove their parent subsystem
rather than fork/replace each helper or override its dependency declarations.

The 13-package CodeMirror count is the union, not the sum of six overlapping
trees. Dropping all six direct declarations eliminates that graph from the
default UI installation, assuming no other selected feature introduces it.

Baseline builds succeeded using Node `22.23.2`:

- `npm run build:packages`: UI emits a separate formula-editor chunk that still
  imports CodeMirror; the main UI entry imports TanStack.
- `npm run build:demo`: formula-editor chunk is **351.81 kB minified / 114.53 kB
  gzip**, and the main JavaScript chunk is **361.18 kB / 114.02 kB gzip**.

Those are Vite's decimal kB measurements of complete chunks, not exact
dependency-only sizes or promised savings. The editor chunk includes our wrapper.
The current lazy split already defers the formula editor's network cost in this
demo, but npm still installs its dependency graph. Removing it mainly improves
install footprint and the cost of opening the editor; it does not save that
entire chunk from the initial page load. No comparative replacement benchmark
has been run.

## Development and demo dependencies: complete declared inventory

These affect contributors and the playground, not published consumer runtime
graphs. All package build scripts use root tooling; no library declares its own
development dependencies. Keeping good test/package tooling is compatible with
zero-dependency libraries.

| Dependency / declared constraint | Where and why | Removal path and sacrifice | Assessment |
| --- | --- | --- | --- |
| `ajv` `^8.20.0` | Root development declaration; no tracked source/script/config usage found | Delete declaration and regenerate lockfile; no observed behavior loss. Core uses its own schema loader, which is not a full JSON Schema validator | **Small; remove first** |
| `husky` `^9.1.7` | Root `prepare`; `.husky/pre-push` runs `npm run check` | Configure Git hooks with a small setup script/`core.hooksPath`, or rely on CI/manual checks | Small; lose automatic hook setup unless replaced |
| `tsup` `^8.5.1` | Builds all four npm packages, declarations, maps, CSS, split editor/CLI chunks | Use `tsc` emit plus Node clean/copy scripts; alternatively call esbuild directly and `tsc` for declarations | Medium; preserve ESM paths, CSS export, CLI shebang/executable packaging, lazy editor and clean output. Direct esbuild is a smaller toolchain, not zero tooling |
| `typescript` `^5.6.3` | Types, build declarations, examples/demo checks, native formula-runtime generation | Convert sources to JS/JSDoc with hand-maintained declarations, or shift compilation to consumers | Large; loses current typing workflow and native transpilation. **Keep** |
| `vitest` `^4.1.11` | All TS unit/component suites; matchers, fake timers, mocks, source aliases | Compile tests and use `node:test`/`node:assert`; recreate necessary fixtures/mocks and module mocking strategy | Large migration. Pure core/codegen tests are easier than timed React/UI tests. Keep initially |
| `jsdom` `^29.1.1` | Explicit DOM environment for React/UI tests | Move DOM tests to actual browser pages driven by existing Playwright | Medium to large; no browserless component suite, more harness/setup and slower execution. Browser tests give better layout evidence; retain coverage rather than write a homegrown DOM |
| `playwright` `^1.60.0` | Demo interaction/browser checks, Chromium and WebKit coverage | Manual checks or own browser automation protocol integration | Large for parity; lose repeatable real-browser mobile/layout/worker checks if simply removed. **Keep** |
| `publint` `^0.3.23` | `package:lint` checks publication metadata/layout | Expand `verify-packages.mjs` with checks we choose to maintain | Small to remove, medium to replace meaningful coverage. Loses maintained packaging diagnostics; no runtime benefit |
| `@arethetypeswrong/cli` `^0.18.5` | `attw` in `package:lint` checks declaration/module resolution | Expand packed-consumer type checks across intended resolution modes | Medium; existing script tests one NodeNext consumer, not all diagnostics/modes. Keep unless simplifying release tooling deliberately |
| `@types/node` `^20.11.30` | Node APIs in CLI/tests and core TS configuration | Separate browser-only configs, or maintain minimal Node declarations | Small to isolate, ongoing cost to replace. Not a runtime dependency; keep where used |
| `@types/react` `^18.3.0` | React source/JSX/public API typing | Rewrite framework or maintain declarations ourselves | Large for useful parity; consumer declarations may still need host React types. **Keep** |
| `@types/react-dom` root `^18.3.7`, demo `^18.3.0` | Portal, browser test roots and server-render test typing | Remove actual React DOM usage, or declare a smaller surface manually | Small for manual shims, but type drift and framework requirement remain. Keep |
| `react` `^18.3.1` | Root development fixture and demo runtime; library peer provider | Use a consumer fixture workspace or retire/rewrite React tests/demo | Moving ownership does not eliminate the framework; keep for validating supported peers |
| `react-dom` `^18.3.1` | Root development fixture and demo runtime; test rendering and demo mount | Same fixture move, or rewrite React browser mounting/tests | Required to exercise the current products; keep |
| `@vitejs/plugin-react` `^4.7.0` | Demo React transforms/refresh | Configure Vite's JSX handling without the plugin | Small; lose React Fast Refresh/state preservation during edits. Production and ordinary reload should be checked |
| `vite` `^6.4.3` | Demo dev server, workspace aliases, production bundling and CSS | Direct esbuild plus a small static/watch server and alias config | Medium; own live reload, module handling, assets and lazy chunks. Does not reduce shipped library dependencies; keep initially |
| `agentation` `^3.1.2` | Demo-only annotation/feedback UI in `PlaygroundFeedback`; browser check | Remove feedback UI, conditional import and `test:feedback`/its check | Small; lose visual feedback capture, with no query-table behavior loss |

The demo's other three declared dependencies are our core, React and UI
packages, all `0.5.0`. They intentionally exercise our products; replacing them
with relative source imports/aliases changes bookkeeping, not required code.
Demo `@types/react-dom` overlaps the root declaration and could be centralized
without changing runtime behavior.

Ajv's lockfile tree has five nodes including Ajv. Removing the unused declaration
should eliminate **four** lockfile entries: Ajv, `fast-deep-equal`, `fast-uri`,
and `json-schema-traverse`. `require-from-string` remains needed through
`bidi-js` in the DOM test tooling. This is a graph prediction, not an applied
lockfile change.

There is also an **undeclared direct tooling import**: the native
[`check-wire-compatibility.mjs`](../native/macos/scripts/check-wire-compatibility.mjs)
imports `esbuild`, currently supplied transitively by tsup/Vite. If replacing
those, either declare esbuild explicitly or change that check to import built
core output. Otherwise a tooling cleanup can silently break native wire checks.
The native formula-generation script imports the already declared TypeScript.

A tsc-only build needs more than changing one command: source relative imports
are extensionless under Bundler resolution, while published Node ESM needs
resolvable extensions. Use `.js` specifiers in source or a carefully checked
emit step, preserve lazy imports, copy CSS, and validate packed declarations.
The [TypeScript module documentation](https://www.typescriptlang.org/docs/handbook/modules/theory.html)
explains the Node ESM extension requirement. Multi-file declaration output is
acceptable if all referenced files are included; a single bundled `.d.ts` is a
packaging preference, not a necessary capability.

## Proposed implementation sequence and acceptance criteria

| Step | Result | What must be checked |
| --- | --- | --- |
| 1. Remove unused Ajv | No product change; four predicted lockfile entries removed | Clean install, existing build/check pipeline; confirm no undocumented validation script depends on it |
| 2. Plain editor + optional rich adapter | Six direct UI dependencies and their 13-node graph removed from default install | Valid/invalid formulas, field escaping, caret insertion, undo/paste, IME, mobile keyboard/focus, accessible error/help, preview/save/cancel; existing `test:computed` |
| 3. Choose table height/page contract, then remove TanStack | Two more packages removed | 12,000-row DOM bound if retaining windowing; top/middle/end scrolling, empty/page changes, sticky header, resize/font changes, selection/drag, SSR/hydration, renderer height contract in Chromium/WebKit |
| 4. Simplify build tooling if desired | Smaller contributor toolchain | `typecheck`, builds, packed-consumer runtime/types/CLI/CSS checks, native formula generation and wire compatibility |

After steps 2–3, UI would depend ordinarily only on our core/React packages and
have React/React DOM peers. Core, React bindings, codegen, Go and native Swift
already meet the equivalent third-party-free runtime target. That is a useful
and achievable dependency boundary without sacrificing the query engine,
formula language, persistence, transports, or backend behavior.

Verification for this survey: all manifests and production import sites were
inspected; lockfile ordinary-dependency closures were calculated; both package
and demo production builds passed. No behavior tests were rerun because this
change only adds this document. Replacement effort and behavior remain proposals
until implemented and tested.
