# URL state and durable saved-search links

Browser research and baseline measurements: 2026-10-13. The implementation and host integration contract are described below.

Small views use self-contained compressed URLs. Larger views use immutable codes backed by a bounded browser cache during editing. Only explicit Save, Share, or in-app Bookmark actions promote state to durable server storage. One link service owns encoding, local navigation, promotion, and restoration; codes resolve directly to query state.

## Browser and network limits

There is no universal maximum URL length. HTTP recommends supporting at least 8,000 octets, but that is a recommendation, not a guarantee. Chromium's large URL ceiling is not a useful deployment budget. [RFC 9110 §4.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-4.1)

| Layer | Verified limit or qualification | Consequence |
| --- | --- | --- |
| Chrome / Chromium-based desktop browsers, including Edge | Chromium caps URLs crossing process boundaries at 2,097,152 characters. Its documentation separately describes a 32 KB omnibox display limit. | URL parsing, navigation, and address-bar display are not interchangeable guarantees. [Chromium documentation](https://chromium.googlesource.com/chromium/src/+/master/docs/security/url_display_guidelines/url_display_guidelines.md), [source](https://github.com/chromium/chromium/blob/main/url/url_constants.h) |
| Firefox | Mozilla source sets `network.standard-url.max-length` to 1,048,576; `nsStandardURL` enforces it. Persistent browsing history has a separate default `browser.history.maxUrlLength` of 2,000. | Navigating successfully does not imply durable history retention. The history preference is not a 2,000-character limit on navigation or a demonstrated bookmark limit. [Preferences](https://searchfox.org/firefox-main/source/modules/libpref/init/StaticPrefList.yaml), [URL implementation](https://raw.githubusercontent.com/mozilla/gecko-dev/master/netwerk/base/nsStandardURL.cpp) |
| Safari / WebKit | A July 2026 WebKit change adds a 2 MiB URL IPC boundary on Cocoa. This establishes a source-level limit, not which Safari release ships it. Safari's address-bar behavior is separate: an older Apple bug reports editing truncation at 4,096 characters. | Do not promise a current Safari bookmark/address-bar maximum from WebKit tests or old browser comparison tables. Test shipping desktop/iOS Safari UI separately. [WebKit change](https://github.com/WebKit/WebKit/commit/04e3d47960f3135b16aff2382ac0d1b712e0d884), [historical UI bug](https://bugs.webkit.org/show_bug.cgi?id=231652) |
| nginx | Default `large_client_header_buffers` is `4 8k`; the entire HTTP/1 request line must fit one buffer. | The request target has slightly less than 8 KiB available; four buffers do not grant a 32 KiB URL. [nginx documentation](https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers) |
| CloudFront | Maximum URL length: 8,192 bytes. | Large query strings can fail before the app loads. [AWS quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html) |
| Cloudflare Workers | Documented URL size limit: 16 KB. Other Cloudflare products can have different limits. | Use the limit of the actual product and route. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) |

These infrastructure examples are constraints for consuming applications, not a claim that this repository deploys through nginx, CloudFront, or Workers. I found no production hosting configuration that establishes our actual route budget.

Local browser probes used a deliberately permissive Node HTTP server, exact trailing sentinels, `history.replaceState`, and reload. Chromium 148.0.7778.96 and Playwright WebKit 26.4 retained and reloaded URLs at sampled sizes through 2,097,088 bytes. At 2,097,216 bytes Chromium accepted `replaceState`, but reload lost the URL and requested `/`; this is a concrete example of an apparently successful write producing a broken bookmark/reload. The installed WebKit build also reloaded that larger sample, illustrating why trunk source and shipping engine versions must be distinguished. These headless probes do not exercise the real address bar, native bookmark dialog, bookmark sync, or iOS sharing.

Firefox 150.0.2 retained and reloaded the 1,048,500-byte sample, but `replaceState` threw `SecurityError` at 1,048,576 bytes and larger. This confirms the practical vicinity of the source-level 1 MiB limit; the samples do not establish the exact last accepted byte.

A fragment (`#q=…`) is not sent in the HTTP request and could bypass request-target limits. It still travels through browser UI/bookmarks and conflicts with host routing/anchors, so it is an optional transport choice, not the complete overflow solution. `history.state` also cannot substitute for a portable bookmark.

**Proposed policy:** default to a 2,000-byte budget for the complete generated URL, including the host route, other parameters, and fragment. This is a conservative product choice, not a universal browser guarantee. A host that validates its delivery route can configure something like 6,000 bytes to leave margin below common 8 KB limits. Measure the actual serialized URL with `TextEncoder`; the base64url token itself is ASCII and needs no additional percent-escaping. Browser parser/decompression resource limits must remain separate from this much smaller link budget.

## Baseline URL sizes

Before this change, `packages/core/src/encode.ts` encoded normalized JSON as unpadded base64url. Top-level keys are compact, and selected columns use tuples. Filters, sorts, metrics, and property layouts retain full nested property names. Base64 expands UTF-8 bytes by approximately one third; it provides no compression. Despite the comment about omitted defaults, `limit` is always emitted, so even `EMPTY_QUERY` produces a token.

Measurements below used the encoder and normalizer before implementation. The reference URL is `https://example.com/runs?q=` (27 bytes); real host URLs change the totals. Demo metrics/defaults come from checked-in fixtures. Property/set stress cases are synthetic normalized state, not measurements of customer usage. Compression is raw DEFLATE plus base64url and a three-character codec prefix. The packing prototype only omits the fixed limit default, stores intact set editors once, and pools identical property views; it does not implement compact metric/filter keys yet. Every pack/unpack and compression/inflation pair was checked for exact preservation.

| View | Current full URL | Current JSON + compression | Packing + compression |
| --- | ---: | ---: | ---: |
| Demo default columns/sort | 217 B | 176 B | 169 B |
| Three simple filters | 405 B | 248 B | 244 B |
| Actual demo dashboard: 15 metrics | 5,907 B | 1,261 B | 1,254 B |
| Dashboard + item share with three 10-property views | 7,790 B | 1,537 B | 1,529 B |
| Dashboard + three synthetic 50-property views | 29,518 B | 2,236 B | 2,069 B |
| ANY set, 50 short values | 5,106 B | 612 B | 364 B |
| ALL set, 25 short values | 13,925 B | 516 B | 296 B |
| ALL set, 50 short values | 47,625 B | 844 B | 361 B |
| ALL set, 100 short values | 175,025 B | 1,921 B | 484 B |

Against an illustrative 8,000-byte budget, the demo dashboard already uses 74%, leaving 2,093 bytes; the item-detail variant uses 97%, leaving 210 bytes. Several structurally valid views already exceed that budget. Against the proposed 2,000-byte policy, the compressed dashboard uses about 63%, leaving 746 bytes after the packing prototype. Compression buys substantial room for typical repetitive state, but cannot guarantee fit: 100 synthetic opaque 10,000-character hex filter values still produce a compressed URL of roughly 723 KB.

Two avoidable sources of growth deserve priority:

* `createSetFilter` puts the complete selected-value array into the metadata of every emitted term. For ALL, N values produce N copies of an N-value array, in addition to the execution predicates. NONE has the same duplication and uses two predicates per value; its existing 100-predicate limit permits at most 50 values. ANY repeats values in metadata and predicates, but grows linearly.
* `itemDetailHref` snapshots hover, modal, and expanded property views, even when they are identical; it also spreads existing detail state, which can retain the legacy fallback view. These snapshots preserve portability, but their representation can share identical content.

The existing structural limits allow 200 selected columns, 100 total predicates, 20 sorts, 20 metrics with up to 20 group fields each, and up to 200 properties per view. These are execution/validation bounds, not URL-fit guarantees. Unicode matters: a synthetic valid query with 100 values of 5,000 emoji each encodes to 2,672,331 characters and fails our own 2 MiB decoder guard. The baseline encoder emitted it anyway and its decoder silently returned `EMPTY_QUERY`. The v2 codec compresses this repetitive state and enforces both encoder and decoder token limits.

Other baseline seams that motivated the implementation:

* `useQueryTable` writes `?q=` with `replaceState` on query changes, without a byte budget or error status. Its fetch debounce does not debounce URL writes. Initial URL resolution is synchronous; storage restoration is async. There is no `popstate` listener in this hook.
* QueryBuilder sharing and item-detail links independently call `encodeQuery`, so guarding only address-bar synchronization would miss outgoing links.
* `SavedQuery` is `{id,name,savedAt,query}`. `StorageAdapter` has no anonymous snapshot creation or code resolution capability. Defaults are in-memory; localStorage is opt-in. Neither provides cross-device resolution. Existing IDs are timestamp-derived, and the current UI updates a save through delete/recreate; neither is a suitable durable shortcode contract.
* Computed column source is already stored separately; query state carries `@computed/<id>` references. Metric expressions and presentation travel in the query. Returned rows, aggregation results, row selections, and refresh timers are not included in this URL codec. PostgreSQL demo execution uses POST bodies, so its query API requests are not the immediate URL bottleneck; navigating to the app is.

## Compact URL encoding

`encodeQuery` now emits `2j.<base64url-json>` or `2d.<base64url-raw-deflate>`, choosing the shorter form. Encoding omits the fixed page-size default, represents each intact set editor once, and pools identical property layouts. The decoder expands those representations into the existing `QueryState`; row and metric execution protocols are unchanged. Packing uses `readSetFilter` to recognize intact editor output, so altered or fragmented predicates keep their actual semantics.

`decodeQueryStrict` reports invalid, unsupported-version, or oversized input through `QueryDecodeError`. Navigation uses this decoder and fails visibly rather than running an empty/default query. Encoded tokens are bounded to 2 MiB and expanded wire JSON to 4 MiB; streaming inflation checks output as it arrives. `decodeQuery` remains a tolerant convenience function. Existing unprefixed tokens still decode, but new links require clients that understand v2. Nested metric-key dictionaries and binary formats remain possible later optimizations; they are not part of this implementation.

## Local links while editing

The complete URL budget defaults to 2,000 UTF-8 bytes and is configurable through `useQueryTable({ links: { maxUrlBytes } })`. Host parameters and fragments count toward the budget and are preserved. A fitting query stays inline. An oversized query gets `?q=@<code>` after its cache entry is successfully written. A code always identifies the same state; later edits get another code, while repeated identical state can reuse an existing entry.

The default FIFO cache stores at most 100 snapshots and approximately 2 MiB of UTF-16 string storage under `query-table:link-cache:v1`. Configure it with `localQuerySnapshotCache({ maxEntries, maxBytes, storageKey })`, or inject a `QuerySnapshotCache` implementation, including a hydrated memory cache backed by IndexedDB that provides the synchronous lookup/materialization contract. Each cache write replaces one envelope atomically and retains the newly created entry while evicting older entries. Malformed envelopes are treated as empty, and reduced host limits trim the oldest entries; the next successful write repairs the stored envelope. It does not track active references in other tabs or native bookmarks.

Ordinary URL synchronization does not call the server store. Cache quota/access failures retain the previous URL and expose `api.links.error`; the live query remains editable. QueryBuilder labels local references “Temporary link · this browser only.” Browser bookmark sync copies the URL without copying the cache. Evicted entries and cleared site storage can therefore invalidate native browser bookmarks unless the code was explicitly promoted earlier.

Webpages have no reliable native bookmark-created event. The browser star, menu, mobile controls, and Cmd/Ctrl+D cannot trigger guaranteed server promotion. Save/Share in the application are the durability boundary. Hosts can implement their own Bookmark action by awaiting `api.links.create()` and presenting its returned URL. Sites cannot create a native browser bookmark through ordinary page JavaScript.

## Durable snapshots on Save and Share

`StorageAdapter.snapshots` optionally supplies the authenticated `QuerySnapshotStore`. Its persisted envelope is:

```ts
interface QuerySnapshot {
  version: 1;
  code: string;       // 128 random bits, 22 base64url characters
  token: string;      // versioned encoding of complete query/view state
  createdAt: number;
}

interface QuerySnapshotStore {
  save(key: string, snapshot: QuerySnapshot,
       signal?: AbortSignal): Promise<QuerySnapshot>;
  resolve(key: string, code: string,
          signal?: AbortSignal): Promise<QuerySnapshot | null>;
}
```

The store must preserve code and token, reject a different token for an existing code, and return the original record on retry. Code identity supplies idempotency; failed or uncertain client requests retry the same code. Reads must resolve a committed write immediately. Retention and quotas belong to the host; deleting a named saved search must not delete its published snapshot.

When a store is configured, explicit Share always creates or reuses a server snapshot, even for a small query. Save uses the same path before creating the named entry and passes `snapshotCode` as the fifth `StorageAdapter.saveNamed` argument. The built-in memory/localStorage adapters retain that association. A host adapter should persist it with the named search. Snapshot persistence and named-save persistence are separate operations in this generic adapter contract: a failed named save can leave an unreferenced durable snapshot, while a failed snapshot write prevents the named save. No cross-store transaction is assumed.

Updating a saved search first persists the new immutable snapshot, then calls the optional `StorageAdapter.updateNamed(key, id, query, savedAt, snapshotCode)` operation. This operation must atomically replace the query, timestamp and snapshot association while preserving the saved search's ID, name and default selection. On failure the original entry must remain unchanged. Both built-in adapters support this contract; the localStorage adapter replaces its saved-entry envelope with one write. `api.saved.canUpdate` controls whether QueryBuilder offers Update for host adapters. There is no delete/recreate fallback. An updated search points to its new snapshot; previously shared snapshots remain immutable and resolvable.

Promotion keeps the original local code, so earlier bookmarks to that code can subsequently resolve on other devices. The cache retains a durability marker; an evicted promoted entry still resolves through the server. Repeated promotions are coalesced within the controller. The browser address bar updates to the durable link when URL sync is enabled and the same query/page is still current; a late response cannot overwrite a newer query or navigation.

Without `storage.snapshots`, Share remains available for a fitting inline URL. Oversized Share fails visibly rather than copying a local-only reference. Named saves continue to use the configured storage adapter. Server-backed portability requires the host to configure the snapshot capability.

## Host integration

```tsx
import {
  httpQuerySnapshotStore,
  localQuerySnapshotCache,
  localStorageAdapter,
} from '@pythia-software/query-table-core';

const storage = {
  ...localStorageAdapter(),
  snapshots: httpQuerySnapshotStore('/api/query-snapshots'),
};
const cache = localQuerySnapshotCache({
  maxEntries: 100,
  maxBytes: 2 * 1024 * 1024,
});

const api = useQueryTable({
  schema, transport, storage, syncUrl: true,
  links: { maxUrlBytes: 2000, cache },
});

// Explicit in-app Bookmark or custom Share control:
const { url } = await api.links.create();
```

Stable storage/cache objects reduce avoidable work. Inline storage adapters are supported: initial restoration and the named-save list load once per dataset, and subsequent explicit operations use the latest adapter. Applications that require actor-specific browser-cache isolation should set an appropriate `storageKey` or supply their own scoped cache.

`httpQuerySnapshotStore` uses `PUT endpoint?dataset=<key>&code=<code>` with a snapshot JSON body, and GET on that same URL. A missing code returns 404; an immutable-code conflict returns 409. Query state never goes in the creation request URL. A code is a lookup identifier and does not grant dataset access.

The Go backend exports `QuerySnapshotsDDL`, `SQLQuerySnapshotStore`, and `NewQuerySnapshotsHandler`. The DDL/store work with PostgreSQL and SQLite. Hosts provide their driver, database, quota/retention policy, and an authorization callback that checks read/write dataset access and CSRF for cookie-authenticated writes. The callback supplies the trusted actor/tenant scope; nil authorization denies access. HTTP bodies, encoded token size, and expanded token JSON are bounded before persistence. Persisted tokens are metadata and are not executed by the snapshot handler.

The PostgreSQL demo creates the table during seeding and exposes `/api/postgres/query-snapshots` behind its existing local-only guard. Its `StorageAdapter` uses the HTTP store. Named search names/default selections still live in browser storage in this demo, while shared snapshot payloads persist in PostgreSQL.

## Restoration and item links

The controller resolves an explicit query URL before row/metric execution, last-state persistence, or URL rewriting. Resolution tries the dataset-scoped local cache first, then the host store. Missing/corrupt references and duplicate state parameters produce a visible error and preserve the incoming URL. `popstate` restores only when this table's query parameter changes; hash-only and unrelated host-router history entries preserve rows and undo history. The same cancellable resolution flow prevents stale loads from overwriting an intervening query edit. With no explicit URL or `initialQuery`, existing default-saved/last-query restoration continues to apply.

`api.links` exposes `create`, `local`, and `snapshot`, along with `kind`, `busy`, `error`, and `maxUrlBytes`. QueryBuilder Share and item-detail Share use `create`. Fitting row page links render as inline anchors without touching the cache; oversized row page actions call `local` only when followed, so rendering a page cannot evict its collection link. Item sharing captures the row identity and full property layouts before awaiting promotion. Clipboard/native-sharing success is reported only after a valid link has been created. Native mobile sharing may lose transient user activation during a network write and falls back to copying.

Custom page templates still receive a v2 inline token through `{query}`. An oversized template result is disabled with an explanatory tooltip; hosts must adopt reference resolution in their destination to support larger state. Those destinations cannot transparently interpret a code as inline JSON.

Snapshots preserve query/view state, not historical result rows, dataset contents, or relative-date execution time. Computed-column IDs still depend on the host's definition catalogue; freezing their historical meanings would require immutable definition revisions separately.

## Validation

Core tests exercise compression/Unicode, malformed and expanded oversized inputs, intact/altered sets, FIFO eviction, dataset scoping, complete URL budgets, cache failures, idempotent promotion, HTTP identity, and fresh-cache resolution. React tests cover zero remote writes during editing, Save/Share association, restoration gating, missing links, browser navigation, and late promotion. Go handler tests cover authorization, immutable conflicts, invalid bodies, and compressed-size limits; SQLite integration tests exercise real durable storage and scope isolation.

The original browser probes and baseline measurements remain in the workspace's gitignored `.context` directory. Native browser bookmarks are intentionally best effort for local links; the page does not attempt to infer bookmarking from keyboard shortcuts or browser focus changes.
