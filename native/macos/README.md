# query-table for macOS

A native SwiftUI and AppKit frontend for query-table, targeting macOS 14 or later.
The table is an `NSTableView`; the query builder, editors, menus, and metrics are
native views. No browser or webview is embedded. Existing Go or application-owned
backends can serve it through the same JSON transport contracts as React.

The package has three layers: `QueryTableCore` owns typed schema/query contracts
and transports; `QueryTableFormula` evaluates reusable expressions;
`QueryTableUI` owns interaction state and native views. The sample and executable
checks consume these public APIs in the same way a host app does.

## Run the sample

```sh
swift run --package-path native/macos QueryTableDemo
```

The sample loads the shared `runs.schema.json` and 320 deterministic records.
Click headers to cycle sorting; Shift-click to add a sort. Drag headers to reorder
and resize columns. Right-click a cell for copying and quick filters. Use WHERE,
SELECT, ORDER BY, and Metrics to edit the query; the overflow menu contains saved
queries, computed columns, import/export, and automatic refresh.

## Add to an app

The repository root is a Swift package, so Xcode can add this repository URL as a
package dependency. Select the branch containing the native package until it is
included in a release tag. For local development, either the repository root or
`native/macos` can be used as a local package dependency. Add `QueryTableUI` and
`QueryTableCore` to your app target.

```swift
import SwiftUI
import QueryTableCore
import QueryTableUI

@MainActor
struct RunsView: View {
    @StateObject private var table: QueryTableController

    init(schemaData: Data, transport: any QueryTransport) throws {
        let schema = try FieldSchema.load(data: schemaData)
        _table = StateObject(wrappedValue: QueryTableController(
            schema: schema,
            adapter: transport
        ))
    }

    var body: some View {
        QueryTableView(controller: table)
    }
}
```

Keep the controller alive for the lifetime of the table. It exposes query edits,
undo/redo, refresh/cancel, stable selection IDs, selected visible rows, and saved
snapshots. Host applications can put their own actions beside `QueryTableView`
and act on `selectedIDs` or `selectedVisibleRows`. Selection survives pagination;
only the current page's selected row data is locally available.

The `renderers` argument accepts native cell factories keyed by field name or the
schema's `render` key. Factories receive the typed JSON value, complete returned
row, and field definition, and return an `NSView`. Backend SQL bindings in schema
documents are ignored by the frontend.

## Connect a backend

Implement `QueryTransport.fetchRows(query:)`; autocomplete and metrics methods
have default unsupported implementations. Methods are asynchronous and should
cooperate with task cancellation. The controller also rejects stale responses.

For JSON HTTP services, use the included adapter with explicit routes:

```swift
let transport = HTTPQueryTransport(
    endpoints: .init(
        rows: URL(string: "https://example.com/api/runs/query")!,
        distinctValues: URL(string: "https://example.com/api/runs/values")!,
        aggregations: URL(string: "https://example.com/api/runs/metrics")!
    ),
    prepareRequest: { request in
        var request = request
        // Supply your application's authentication here.
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }
)
```

These URLs are examples, not prescribed query-table routes. The HTTP adapter
POSTs readable JSON to each route. Implement a custom transport for other HTTP
methods, response envelopes, RPC, or direct local data access.

| Method | Request | Response |
| --- | --- | --- |
| Rows | `{select, where, orderBy, limit, offset}` | `{rows, total}` |
| Suggestions | `{field, search, limit?}` | `{values, hasMore, hasNull?}` |
| Metrics | `{where, aggregations}` | `{metrics: [{id, buckets: [{keys, value, count}]}]}` |

`total` is the matching count before paging. Row projection always includes the
stable ID and inputs required by computed columns. Metrics run independently of
rows over the full filtered dataset. Authorization, database validation, enforced
filters, and operational query limits remain the backend's responsibility.

`LocalQueryTransport(schema:rows:)` provides immutable in-memory rows for demos
and small datasets. It handles filters, sorting, pagination, suggestions, and
metrics. It is not a database adapter.

## Saved queries and computed columns

Persistence defaults to memory. Supply `persistence: UserDefaults` explicitly to
retain named queries, the last view, and computed definitions, namespaced by dataset. They contain
raw filter/formula text. Query JSON and the existing compact base64url tokens can
be imported; `QueryState.encodedToken()` produces tokens readable by React.

The formula editor uses the existing `qt-expr` parser, type checker, and interpreter
bundled in JavaScriptCore. Formula text is parsed as data, never executed as user
JavaScript. Evaluation runs off the main actor with bounded input and output,
dependency expansion, cancellation checks, and per-cell errors. Backend samples
fetch hidden inputs in batches of up to 500, start at offset zero, and are separate
from the displayed page. Frequency previews describe the sampled rows.

Definitions retain the React wire shape and `@computed/id` references. The public
catalogue import/export methods let a host load definitions from its service;
automatic remote catalogue synchronization is not included. Local edits check
revision conflicts. Definitions remain independent of query undo history.

Named queries can be marked as the default view. Initial state precedence is an
explicit `initialQuery`, a default saved query, an opted-in last view, then schema
defaults.

## Compatibility boundaries

This is a first native implementation, with the existing query structure and core
interaction patterns. It does not yet reproduce every React feature:

- Regex filters and regex sort extraction can be sent to a backend. The local
  adapter rejects them. Native formulas reject regex functions because the public
  JavaScriptCore API offers no hard execution watchdog; no regex inspector is shown.
- Native controllers require backend-capable filters. Queries with client-only
  filters are rejected explicitly so totals and paging do not become misleading.
- Custom React renderers/accessors must be replaced with native renderers.
  Formula inputs currently use selectable backend fields.
- Metrics use native ranked bars, two-axis pivots, or multi-axis tables. Large
  presentations are capped with an explicit notice; the returned results remain
  available on the controller.
- Formula editing uses a native text editor and diagnostics, without CodeMirror
  syntax highlighting/completion. Live remote definition subscriptions are not
  provided.
- Shared query tokens preserve logical state. CSS pixel widths are interpreted
  as macOS points, and custom cell appearance is platform-specific.

The local adapter follows null-exclusive SQL comparisons; the existing TypeScript
local executor differs for some null/equality edge cases. Use the same backend
for identical database semantics across clients. Query values follow JSON's
numeric model; use string IDs for values outside interoperable integer ranges.

## Development and verification

```sh
swift build --package-path native/macos
swift run --package-path native/macos QueryTableChecks
swift test --package-path native/macos
```

`swift test` requires full Xcode, including XCTest. `QueryTableChecks` also runs
with the Command Line Tools installation and covers actual async controller and
formula integration. CI runs both. To render the demo window for visual review:

```sh
swift run --package-path native/macos QueryTableDemo --snapshot /tmp/query-table.png
```

After changing `packages/core/src/formula.ts`, regenerate the checked-in runtime:

```sh
npm ci --ignore-scripts
node native/macos/scripts/build-formula-runtime.mjs
node native/macos/scripts/check-wire-compatibility.mjs
```

The generated runtime is committed so Swift consumers do not need Node. The root
and native package manifests expose the same targets; the root manifest adds
source paths so remote SwiftPM dependencies work.
