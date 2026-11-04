# Error codes

Every error that Query Table produces carries a machine-readable code from one
enum, `ErrorCode` in [`schema/query-wire.schema.json`](../schema/query-wire.schema.json).
The same codes are used by the Go backend, the HTTP handlers, the TypeScript
client and the Swift client:

| Language   | Type | Codes |
| ---------- | ---- | ----- |
| TypeScript | `ErrorCode`, `QueryError` (`@pythia-software/query-table-core`) | `ERROR_CODES` |
| Go         | `querytable.ErrorCode`, `*PlanDiagnostic` (`Code ErrorCode`) | `ErrorCodeResourceLimit`, ... and `ErrorCodes()` |
| Swift      | `ErrorCode`, `QueryTableError.server(QueryErrorDetail, status:)` | `ErrorCode.resourceLimit`, ... and `.unknown` |

Codes are stable; messages are for people and may change. Clients must accept
codes they do not know (Swift decodes them as `.unknown`; TypeScript keeps the
string).

## HTTP error bodies

`NewQueryV3Handler`, `NewComputedColumnsHandler` and `NewQuerySnapshotsHandler`
answer every failure with `Content-Type: application/json` and a
`QueryErrorBody`:

```json
{ "error": { "code": "conflict", "message": "query snapshot conflict" } }
```

`field` and `metricId` are present when they apply, and `offset` when a
producer reports one (the Go server does not yet). An invalid computed
definition is `definition_invalid` with the definition's `field`. The status is
`ErrorCode.HTTPStatus()` in Go, listed in the table below:

- **400** for invalid requests (the default),
- **403** `forbidden`, **404** `not_found`, **405** `method_not_allowed`,
- **408** `cancelled`, **504** `timeout`,
- **409** for state the client must refresh: `conflict`, `definition_changed`,
  `profile_mismatch`,
- **413** `request_too_large`,
- **422** for well-formed requests over a host budget: `resource_limit` and the
  other `*_limit` codes,
- **500** `internal` and host-configuration errors (`dataset`, `schema`,
  `resolver_required`, ...), **503** `unavailable`, **507** `quota_exceeded`.

Every 500 message is generic: an `internal` or host-configuration error keeps
its code, and its cause stays in server logs. A body that is not one JSON value
is `invalid_json`, one past an endpoint's byte budget `request_too_large`, and
well-formed JSON of the wrong shape `invalid_request` or `invalid_query`.

## Metric errors

A metric that cannot be computed does not fail its siblings. Its
`MetricResult` carries `error` (a message) and `errorCode`:

```json
{ "id": "p95", "buckets": [], "scope": "allMatching", "processedRows": 0, "groupCount": 0,
  "error": "group population exceeds host budget", "errorCode": "resource_limit" }
```

Errors that describe the whole request (version, profile, revisions, filters,
sorts, host configuration) fail the request instead.

The local engine and share/window combination use the same codes:
`invalid_metric`, `resource_limit`, `cancelled`, and `internal` for a metric a
server omitted. A combined metric keeps the code of the part that failed.

## Client-side refusals

The TypeScript request builders (`toQueryRequestV3`, `toDistinctRequestV3`,
...) throw a `QueryError` before anything is sent when the query cannot run on
the negotiated server: a capability the handshake does not advertise
(`capability_unsupported`), a filter or sort that would stay on the client
(`residual_query`), malformed metric or grouping state (`invalid_metric`,
`grouping`), an unavailable profile (`profile_mismatch`). A metric whose
population controls (`where`, `minCount`) the server does not advertise is
left out of the request and reported as that metric's entry with
`errorCode: "capability_unsupported"`. Swift's builders throw
`QueryTableError.refused(ErrorCode, String)`. Servers enforce the same rules on
their own; the client check only avoids a round trip.

## Using errors

TypeScript:

```ts
import { isQueryError, queryErrorFromResponse } from "@pythia-software/query-table-core";

const response = await fetch("/api/query", { method: "POST", body: JSON.stringify(request) });
if (!response.ok) throw await queryErrorFromResponse(response);
// ...
try { await table.refresh(); } catch (error) {
  if (isQueryError(error) && error.code === "definition_changed") reloadHandshake();
}
```

`queryErrorFromResponse` parses a `QueryErrorBody`; for any other body (a
proxy's HTML error page, say) it falls back to a code derived from the HTTP
status (`forbidden`, `not_found`, `timeout`, `internal`, ...).

Go:

```go
var issue *querytable.PlanDiagnostic
if errors.As(err, &issue) && issue.Code == querytable.ErrorCodeResourceLimit { ... }
querytable.WriteQueryError(w, err) // the handlers' JSON body and status
```

## Codes

Generated from the schema by `npm run wire:generate`. HTTP `client` means a
server never sends the code. Retry `after refresh` means the request can
succeed after refreshing the capabilities or execution handshake (or reloading
the stored object).

<!-- error-codes:start -->
| Code | HTTP | Retry | Meaning |
| --- | --- | --- | --- |
| `invalid_json` | 400 | no | The request body is not one well-formed JSON value. |
| `invalid_request` | 400 | no | The request is malformed outside the query itself: a missing or invalid dataset or code parameter, or an invalid stored body. |
| `method_not_allowed` | 405 | no | The endpoint does not support the HTTP method; the Allow header lists the ones it does. |
| `forbidden` | 403 | no | The host's authorization callback refused the request, or none is configured. |
| `not_found` | 404 | no | The requested stored object (such as a query snapshot code) does not exist in the caller's scope. |
| `request_too_large` | 413 | no | The request body exceeds the endpoint's byte budget. |
| `conflict` | 409 | after refresh | A write conflicts with stored state: a computed definition changed since it was loaded, or a snapshot code already identifies different state. |
| `quota_exceeded` | 507 | no | The host's storage quota refused a write. |
| `timeout` | 504 | yes | The query exceeded the server's time budget. |
| `cancelled` | 408 | yes | The request was cancelled before it completed, usually because the client went away. |
| `unavailable` | 503 | yes | The server cannot answer right now, for example while a data snapshot is refreshed. |
| `internal` | 500 | yes | An unexpected server failure. The message is generic; details stay in server logs. |
| `version` | 400 | no | The request is not a version 3 query. |
| `invalid_query` | 400 | no | A query stage, metric list or distinct request is malformed: an unknown property, a wrong shape, or an out-of-range limit, offset, list length or name. |
| `profile_mismatch` | 409 | after refresh | The request's profile is not the server's profile; refresh the capabilities handshake. |
| `definition_changed` | 409 | after refresh | A computed definition's revision differs from expectedRevisions, or the revision envelope is invalid; refresh the execution handshake. |
| `definition_unavailable` | 400 | no | A referenced computed definition is missing or not accessible to the caller. |
| `definition_invalid` | 400 | no | A computed definition does not compile. |
| `datetime_value` | 400 | no | A datetime value or the evaluation clock is invalid or outside the supported range. |
| `residual_query` | 400 | no | Part of the query cannot run on the server (a client-only filter or sort); refusing is safer than answering a different question. |
| `dataset` | 500 | no | The host's dataset configuration is invalid for this request. |
| `schema` | 500 | no | The host schema is invalid, for example an empty binding or a reserved field name. |
| `source_required` | 500 | no | The host did not configure a source relation. |
| `resolver_required` | 500 | no | Computed fields are referenced but the host configured no definition resolver. |
| `resolver_scope` | 500 | no | The computed definition resolver is not bound to the request's scope and dataset. |
| `snapshot_transaction_required` | 500 | no | A snapshot-bound request needs a read-only snapshot transaction from the host. |
| `snapshot_validation_required` | 500 | no | A snapshot-bound request needs a host snapshot validator. |
| `plan_token_validation_required` | 500 | no | A request with a plan token needs a host plan-token validator. |
| `numeric_domain_required` | 500 | no | A numeric SQL binding did not opt into the bounded arithmetic profile. |
| `unknown_field` | 400 | no | A field is not in the schema allowlist. |
| `select_required` | 400 | no | The request selects no field where at least one is required. |
| `filter` | 400 | no | A filter is invalid for its field: operator, value or shape. |
| `filter_disabled` | 400 | no | The field is not server-filterable (for a computed field: not in the host's filter allowlist). |
| `sort` | 400 | no | A sort term is invalid, or the field is not server-sortable. |
| `collation_required` | 400 | no | Text ordering needs a collation this profile does not provide. |
| `unsupported_regex` | 400 | no | Regex filtering or sorting is outside this server profile. |
| `unsupported_literal` | 400 | no | A text value cannot be represented (for example NUL or an unpaired surrogate). |
| `unsupported_type` | 400 | no | The value type does not support the operation (for example boolean extrema or arrays in expressions). |
| `invalid_source_value` | 400 | no | A stored source value does not match its declared type. |
| `numeric_range` | 400 | no | A numeric literal is outside the range the profile computes exactly. |
| `encoding` | 400 | no | Text is not valid UTF-8. |
| `identity_required` | 400 | no | The operation needs a stable identity field. |
| `duplicate_identity` | 400 | no | Representative rows need unique non-null source identities within every group. |
| `scope` | 400 | no | A metric scope is invalid. |
| `window_required` | 400 | no | A shownRows metric needs a positive page limit. |
| `syntax` | 400 | no | An expression does not parse; the message says where. |
| `unsupported_syntax` | 400 | no | An expression uses syntax this server does not execute. |
| `unsupported_function` | 400 | no | An expression calls a function this server does not execute. |
| `arity` | 400 | no | A function is called with the wrong number of arguments. |
| `type_error` | 400 | no | An expression combines values of incompatible types. |
| `aggregate_required` | 400 | no | A metric expression needs an aggregate around a field. |
| `aggregate_context` | 400 | no | A row field or aggregate appears where it is not allowed, such as a bare field outside an aggregate. |
| `aggregate_disabled` | 400 | no | The field does not allow that aggregate. |
| `paired_expression_required` | 400 | no | A scatter metric needs both expression and expressionY. |
| `dependency_cycle` | 400 | no | Computed definitions depend on each other in a cycle. |
| `invalid_metric` | 400 | no | A metric is malformed: a missing or invalid field, an unknown op or malformed state. |
| `duplicate_metric` | 400 | no | Two metrics share an id. |
| `metric_sort` | 400 | no | A metric sort key is invalid for the metric. |
| `distribution` | 400 | no | A box or histogram distribution is invalid for its input. |
| `date_grouping` | 400 | no | A metric's calendar grouping is invalid: interval, zone, range or field type. |
| `unsupported_date_grouping` | 400 | no | Calendar grouping is unavailable on this execution path. |
| `min_count_grouping` | 400 | no | minCount needs a grouped metric. |
| `min_count_field` | 400 | no | minCount's distinct or sum field is invalid. |
| `min_count_distribution` | 400 | no | minCount cannot be combined with a distribution. |
| `group_disabled` | 400 | no | The field cannot be a group key (for a computed field: not in the host's grouping allowlist). |
| `grouping` | 400 | no | A grouping definition is invalid: keys, summaries or a calendar key. |
| `representative` | 400 | no | The representative-row ordering of a grouping is invalid. |
| `resource_limit` | 422 | no | The request is well formed but exceeds a host budget: rows, groups, population, samples or work. |
| `complexity_limit` | 422 | no | An expression exceeds the complexity budget. |
| `dependency_limit` | 422 | no | Computed definitions or the revision envelope exceed the dependency budget. |
| `expansion_limit` | 422 | no | An expanded computed expression exceeds its size budget. |
| `source_limit` | 422 | no | An expression's source text is empty or exceeds its byte budget. |
| `stage_limit` | 422 | no | The query needs more SQL stages than the budget allows. |
| `schema_limit` | 422 | no | The projected schema exceeds its field budget. |
| `capability_unsupported` | client | no | Client only: the query needs a capability the server's handshake does not advertise (grouped rows, calendar grouping, regex source filters, ...). The request is not sent. |
| `unexpanded_series` | client | no | Client only: a windowed or share metric must be expanded with planMetricSeries before it is sent. |
| `invalid` | client | no | Query link: the encoded query state is malformed (TypeScript QueryDecodeError, Go QueryLinkError). |
| `too_large` | client | no | Query link: the encoded query state exceeds its size budget. |
| `unsupported_version` | client | no | Query link: the encoded query state has a version this build cannot read. |
<!-- error-codes:end -->
