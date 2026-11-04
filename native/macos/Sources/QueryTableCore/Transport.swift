import Foundation

public enum QueryTableError: Error, LocalizedError, Sendable {
  case unsupported(String)
  case invalidQuery(String)
  case invalidResponse(String)
  /// A server's `QueryErrorBody` (see docs/errors.md) and the HTTP status.
  case server(QueryErrorDetail, status: Int)
  /// A client-side refusal: the request was not sent.
  case refused(ErrorCode, String)
  public var errorDescription: String? {
    switch self {
    case .unsupported(let v), .invalidQuery(let v), .invalidResponse(let v), .refused(_, let v): return v
    case .server(let detail, _): return detail.message
    }
  }
  /// The machine-readable code of a server error or client refusal.
  public var code: ErrorCode? {
    switch self {
    case .server(let detail, _): return detail.code
    case .refused(let code, _): return code
    default: return nil
    }
  }
}

// MARK: - v3 protocol
//
// The wire structs (ServerQuery, QueryCapabilitiesV3, QueryRequestV3,
// QueryResultV3, ...) are generated into Wire.generated.swift from
// schema/query-wire.schema.json. The extensions below add the hand-written
// conveniences: initializers with defaults, request builders and validation.

extension QueryCapabilitiesV3 {
  public init(
    profile: String, version: Int = 3, groupedRows: Bool = false, calendarGrouping: Bool = false,
    calendarCycles: Bool? = nil, calendarGroupKeys: Bool? = nil,
    computedSourceFilters: Bool = false, regex: Bool = false, regexSourceFilters: Bool? = nil,
    regexAggregateExpressions: Bool? = nil, metricFilters: Bool? = nil,
    metricMinCount: Bool? = nil, metricMinCountMeasures: Bool? = nil, maxRows: Int = 10_000,
    maxGroups: Int = 2_000, maxPopulation: Int = 250_000
  ) {
    self.version = version
    self.groupedRows = groupedRows
    self.calendarGrouping = calendarGrouping
    self.calendarCycles = calendarCycles
    self.calendarGroupKeys = calendarGroupKeys
    self.computedSourceFilters = computedSourceFilters
    self.regex = regex
    self.regexSourceFilters = regexSourceFilters
    self.regexAggregateExpressions = regexAggregateExpressions
    self.metricFilters = metricFilters
    self.metricMinCount = metricMinCount
    self.metricMinCountMeasures = metricMinCountMeasures
    self.maxRows = maxRows
    self.maxGroups = maxGroups
    self.maxPopulation = maxPopulation
    self.profile = profile
  }
}

extension DistinctRequestV3 {
  public static let maxLimit = 500
  /// In UTF-16 code units, as TypeScript and Go count it.
  public static let maxSearchLength = 2000
}

extension AggregationClause {
  /// The metric as sent: `label` is presentation-only and never crosses the wire.
  public var wireSpec: MetricSpecV3 { MetricSpecV3(id: id, op: op, field: field, groupBy: groupBy) }
}

/// One v3 query: rows, metrics or distinct values over a source stage. Ungrouped
/// requests use the same stage for `source` and `result`. Grouping is not
/// built by the native client.
extension QueryRequestV3 {
  public init(
    profile: String, now: Int64, source: ServerQuery, result: ServerQuery? = nil,
    rows: Bool = true, metrics: [MetricSpecV3] = [], distinct: DistinctRequestV3? = nil,
    expectedRevisions: [String: String] = [:], planToken: String? = nil,
    snapshot: String? = nil, hostState: [String: JSONValue]? = nil,
    grouping: GroupingDefinition? = nil
  ) {
    self.version = 3
    self.profile = profile
    self.now = now
    self.source = source
    self.result = result ?? source
    self.grouping = grouping
    self.rows = rows
    self.metrics = metrics
    self.distinct = distinct
    self.expectedRevisions = expectedRevisions
    self.planToken = planToken
    self.snapshot = snapshot
    self.hostState = hostState
  }
  /// A request whose metrics are client aggregation clauses (sent without `label`).
  public init(
    profile: String, now: Int64, source: ServerQuery, result: ServerQuery? = nil,
    rows: Bool = true, metrics: [AggregationClause], distinct: DistinctRequestV3? = nil,
    expectedRevisions: [String: String] = [:], planToken: String? = nil,
    snapshot: String? = nil, hostState: [String: JSONValue]? = nil
  ) {
    self.init(
      profile: profile, now: now, source: source, result: result, rows: rows,
      metrics: metrics.map(\.wireSpec), distinct: distinct, expectedRevisions: expectedRevisions,
      planToken: planToken, snapshot: snapshot, hostState: hostState)
  }

  /// Epoch milliseconds for a request clock.
  public static func epochMilliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
  }

  /// Filter autocomplete: a distinct section over the unfiltered population.
  public static func distinctValues(
    field: String, search: String = "", limit: Int = 50, schema: FieldSchema,
    capabilities: QueryCapabilitiesV3, execution: QueryExecutionV3? = nil, now: Date = Date(),
    hostState: [String: JSONValue]? = nil
  ) throws -> QueryRequestV3 {
    // As TypeScript toDistinctRequestV3: a profile refusal, then the limit and
    // search, then revisions; the first code, with every message.
    let envelope = try ExecutionEnvelope(capabilities: capabilities, execution: execution, throwing: false)
    var refusals = envelope.profileRefusals
    if !(1...DistinctRequestV3.maxLimit).contains(limit) {
      refusals.append((.invalidQuery, "Distinct value limit must be between 1 and \(DistinctRequestV3.maxLimit)."))
    }
    if search.utf16.count > DistinctRequestV3.maxSearchLength {
      refusals.append((.invalidQuery, "Distinct search exceeds its budget."))
    }
    refusals.append(contentsOf: envelope.revisionRefusals)
    if let first = refusals.first {
      throw QueryTableError.refused(first.code, refusals.map(\.message).joined(separator: " "))
    }
    return QueryRequestV3(
      profile: capabilities.profile, now: epochMilliseconds(now),
      source: ServerQuery(select: [], limit: 1), rows: false,
      distinct: DistinctRequestV3(field: field, search: search, limit: limit),
      expectedRevisions: envelope.revisions, planToken: envelope.planToken,
      snapshot: envelope.snapshot, hostState: hostState)
  }

  /// Row refresh by identity. A total above one is a non-unique identity.
  public static func rowLookup(
    id: JSONValue, select: [String], schema: FieldSchema, capabilities: QueryCapabilitiesV3,
    execution: QueryExecutionV3? = nil, now: Date = Date(), hostState: [String: JSONValue]? = nil
  ) throws -> QueryRequestV3 {
    let stage = ServerQuery(
      select: Array(Set(select + [schema.idField])).sorted(),
      whereTerms: [.predicate(.init(field: schema.idField, op: "=", value: id.displayString))],
      // Two rows within the server's budget; the total reports a duplicate either way.
      limit: max(1, min(2, capabilities.maxRows)))
    let envelope = try ExecutionEnvelope(capabilities: capabilities, execution: execution)
    return QueryRequestV3(
      profile: capabilities.profile, now: epochMilliseconds(now), source: stage,
      expectedRevisions: envelope.revisions, planToken: envelope.planToken,
      snapshot: envelope.snapshot, hostState: hostState)
  }
}

/// The revisions, plan token and snapshot a request carries from a server
/// handshake, as the TypeScript builders send them.
struct ExecutionEnvelope {
  var revisions: [String: String] = [:]
  var planToken: String?
  var snapshot: String?
  /// A profile refusal, then revision refusals, in the TypeScript order.
  var profileRefusals: [(code: ErrorCode, message: String)] = []
  var revisionRefusals: [(code: ErrorCode, message: String)] = []
  var refusals: [(code: ErrorCode, message: String)] { profileRefusals + revisionRefusals }
  init(capabilities: QueryCapabilitiesV3, execution: QueryExecutionV3?, throwing: Bool = true) throws {
    if capabilities.version != 3 || (execution.map { $0.profile != capabilities.profile } ?? false) {
      profileRefusals.append((.profileMismatch, "The negotiated query profile is unavailable."))
    }
    for (id, revision) in execution?.resolvedRevisions ?? [:] {
      if revision.isEmpty || id.count > 256 || revision.count > 256 {
        revisionRefusals.append((.definitionChanged, "Invalid computed revision envelope."))
      } else {
        revisions[id.hasPrefix("@computed/") ? String(id.dropFirst(10)) : id] = revision
      }
    }
    planToken = execution.flatMap { $0.planToken.isEmpty ? nil : $0.planToken }
    snapshot = execution?.snapshot
    if throwing, let first = refusals.first {
      throw QueryTableError.refused(first.code, refusals.map(\.message).joined(separator: " "))
    }
  }
}

extension AggregationBucket {
  public init(
    keys: [JSONValue] = [], value: JSONValue, count: Int, error: String? = nil,
    y: JSONValue? = nil, yError: String? = nil, distribution: MetricDistributionResult? = nil,
    nullCount: Int? = nil, inputErrorCount: Int? = nil
  ) {
    self.keys = keys
    self.value = value
    self.count = count
    self.error = error
    self.y = y
    self.yError = yError
    self.distribution = distribution
    self.nullCount = nullCount
    self.inputErrorCount = inputErrorCount
  }
  /// Group keys as display strings; NULL keys are nil. `keys` keeps the JSON
  /// values (servers may key buckets by numbers or booleans).
  public var keyLabels: [String?] { keys.map { $0 == .null ? nil : $0.displayString } }
}
extension AggregationResultEntry {
  public init(
    id: String, buckets: [AggregationBucket], error: String? = nil, scope: String? = nil,
    processedRows: Int? = nil, groupCount: Int? = nil, coverage: String? = nil,
    hiddenGroups: Int? = nil, other: AggregationBucket? = nil
  ) {
    self.id = id
    self.buckets = buckets
    self.error = error
    self.scope = scope
    self.processedRows = processedRows
    self.groupCount = groupCount
    self.coverage = coverage
    self.hiddenGroups = hiddenGroups
    self.other = other
  }
}

extension ComputedFieldCapabilityV3 {
  public init(
    type: String, select: Bool = false, sort: Bool = false, measure: Bool = false,
    group: Bool = false, filter: Bool? = nil, reason: String? = nil
  ) {
    self.type = type
    self.select = select
    self.sort = sort
    self.measure = measure
    self.group = group
    self.filter = filter
    self.reason = reason
  }
}
/// The execution envelope (TypeScript `ComputedExecution`). `planToken` is
/// always on the wire; an empty token means none.
extension QueryExecutionV3 {
  public init(
    profile: String, planToken: String? = nil, resolvedRevisions: [String: String] = [:],
    fields: [String: ComputedFieldCapabilityV3] = [:], fingerprint: String? = nil,
    snapshot: String? = nil
  ) {
    self.profile = profile
    self.planToken = planToken ?? ""
    self.resolvedRevisions = resolvedRevisions
    self.fields = fields
    self.fingerprint = fingerprint
    self.snapshot = snapshot
  }
}

extension QueryResultV3 {
  public init(
    now: Int64, rows: [QueryRow], total: Int, sourceTotal: Int, schema: ProjectedSchemaV3,
    metrics: [AggregationResultEntry] = [], execution: QueryExecutionV3,
    distinct: DistinctResultV3? = nil
  ) {
    self.version = 3
    self.now = now
    self.rows = rows
    self.total = total
    self.sourceTotal = sourceTotal
    self.schema = schema
    self.metrics = metrics
    self.execution = execution
    self.distinct = distinct
  }
  /// A response that echoes `request`'s clock and envelope, for custom transports.
  /// The projected schema lists the requested `result.select` fields known to `schema`.
  public init(
    answering request: QueryRequestV3, schema: FieldSchema, rows: [QueryRow] = [],
    total: Int = 0, sourceTotal: Int? = nil, metrics: [AggregationResultEntry] = [],
    distinct: DistinctResultV3? = nil
  ) {
    let projected =
      request.rows
      ? request.result.select.compactMap { name in
        schema.field(named: name).map { ProjectedFieldV3(name: name, type: $0.type) }
      } : []
    self.init(
      now: request.now, rows: rows, total: total, sourceTotal: sourceTotal ?? total,
      schema: ProjectedSchemaV3(name: schema.name, idField: schema.idField, fields: projected),
      metrics: metrics,
      execution: QueryExecutionV3(
        profile: request.profile, planToken: request.planToken,
        resolvedRevisions: request.expectedRevisions, snapshot: request.snapshot),
      distinct: distinct)
  }
  /// Mirrors TypeScript `validateQueryResultV3`. Without `schema`, only the
  /// envelope, totals and identities (by the response's own `idField`) are checked.
  public func validate(for request: QueryRequestV3, schema: FieldSchema? = nil) throws {
    let safe = 9_007_199_254_740_991
    guard version == 3, now == request.now, total >= 0, total <= safe, sourceTotal >= 0,
      sourceTotal <= safe, execution.profile == request.profile,
      execution.planToken == (request.planToken ?? ""),
      (execution.snapshot ?? "") == (request.snapshot ?? ""),
      schema == nil || self.schema.idField == schema!.idField,
      request.distinct == nil || distinct != nil
    else { throw QueryTableError.invalidResponse("Invalid or mismatched query execution response.") }
    if let schema {
      let expected = Dictionary(
        schema.fields.map { ($0.name, $0.type) }, uniquingKeysWith: { first, _ in first })
      let names = Set(self.schema.fields.map(\.name))
      guard self.schema.fields.allSatisfy({ expected[$0.name] == $0.type }),
        !request.rows || request.result.select.allSatisfy(names.contains)
      else { throw QueryTableError.invalidResponse("The server returned a different projected schema.") }
    }
    for (id, revision) in request.expectedRevisions
    where execution.resolvedRevisions[id] != revision {
      throw QueryTableError.invalidResponse(
        "Computed definitions changed. Refresh the server execution handshake.")
    }
    let idField = schema?.idField ?? self.schema.idField
    var seen = Set<JSONValue>()
    for row in rows {
      // Servers key rows by field name; a local transport returns rows whose
      // identity may live at the field's source path.
      let id = row[idField] ?? schema?.field(named: idField)?.value(in: row) ?? .null
      switch id {
      case .string, .number, .integer: break
      default:
        throw QueryTableError.invalidResponse(
          "The server returned invalid or duplicate group identities.")
      }
      guard seen.insert(id).inserted else {
        throw QueryTableError.invalidResponse(
          "The server returned invalid or duplicate group identities.")
      }
    }
  }
}

/// A query backend. `fetchQueryV3` is the only entry point; rows, metrics and
/// filter autocomplete are sections of one `QueryRequestV3`.
public protocol QueryTransport: Sendable {
  var queryCapabilities: QueryCapabilitiesV3 { get }
  func fetchQueryV3(_ request: QueryRequestV3) async throws -> QueryResultV3
}

// MARK: - Request construction

extension QueryState {
  /// The source/result stage for this state (TypeScript `toServerQuery`).
  public func serverQuery(schema: FieldSchema) -> ServerQuery {
    let q = normalized()
    let terms = q.whereTerms.filter {
      $0.predicates.allSatisfy { schema.field(named: $0.field)?.isPushdownFilter == true }
    }
    let sorts = q.orderBy.compactMap { term -> OrderByClause? in
      guard let f = schema.field(named: term.field), f.source.kind == "backend", f.isSortable else {
        return nil
      }
      var t = term
      t.field = f.sort?.field ?? f.name
      return t
    }
    var names = Set([schema.idField])
    for f in schema.selectedFields(q) {
      if f.source.kind == "backend" {
        names.insert(f.name)
      } else {
        for dependency in f.source.dependencies ?? []
        where schema.field(named: dependency)?.source.kind == "backend" { names.insert(dependency) }
      }
    }
    for p in q.whereTerms.flatMap(\.predicates) {
      if let f = schema.field(named: p.field), f.isFilterable, !f.isPushdownFilter,
        f.source.kind == "backend"
      {
        names.insert(f.name)
      }
    }
    return ServerQuery(
      select: names.sorted(), whereTerms: terms, orderBy: sorts, limit: q.limit, offset: q.offset)
  }

  /// An ungrouped v3 request (TypeScript `toQueryRequestV3`): source == result,
  /// `rows` selects the row section and `metrics` the aggregation clauses.
  /// Throws `QueryTableError.refused` before anything is sent when the query
  /// needs a capability the server lacks, or would leave a filter, sort or
  /// malformed metric on the client (TypeScript throws a `QueryError`).
  public func queryRequestV3(
    schema: FieldSchema, capabilities: QueryCapabilitiesV3, execution: QueryExecutionV3? = nil,
    now: Date = Date(), rows: Bool = true, metrics includeMetrics: Bool = true,
    hostState: [String: JSONValue]? = nil
  ) throws -> QueryRequestV3 {
    let q = normalized()
    var refusals: [(code: ErrorCode, message: String)] = []
    if includeMetrics && aggregations.count != q.aggregations.count {
      refusals.append((.invalidMetric, "The query exceeds its metric budget or contains malformed metric state."))
    }
    let envelope = try ExecutionEnvelope(capabilities: capabilities, execution: execution, throwing: false)
    refusals.append(contentsOf: envelope.profileRefusals)
    let stage = q.serverQuery(schema: schema)
    if q.whereTerms.flatMap(\.predicates).contains(where: {
      ["matches_regex", "not_matches_regex"].contains($0.op)
    }) && capabilities.regexSourceFilters != true {
      refusals.append((.capabilityUnsupported, "This server profile does not support isolated regex source filtering."))
    }
    if stage.whereTerms.count != q.whereTerms.count {
      refusals.append((.residualQuery, "The query contains unsupported source or result predicates."))
    }
    if stage.orderBy.count != q.orderBy.count {
      refusals.append((.residualQuery, "The query contains unsupported result ordering."))
    }
    let metrics = includeMetrics ? q.aggregations : []
    for metric in metrics {
      refusals.append(contentsOf: metric.diagnostics(schema: schema).map { (ErrorCode.invalidMetric, $0) })
    }
    refusals.append(contentsOf: envelope.revisionRefusals)
    if let first = refusals.first {
      var unique = Set<String>()
      let message = refusals.map(\.message).filter { unique.insert($0).inserted }.joined(separator: " ")
      throw QueryTableError.refused(first.code, message)
    }
    return QueryRequestV3(
      profile: capabilities.profile, now: QueryRequestV3.epochMilliseconds(now), source: stage,
      rows: rows, metrics: metrics, expectedRevisions: envelope.revisions,
      planToken: envelope.planToken, snapshot: envelope.snapshot, hostState: hostState)
  }
}

extension AggregationClause {
  /// Schema checks for a server metric (a subset of TypeScript `validateMetric`).
  public func diagnostics(schema: FieldSchema) -> [String] {
    if groupBy.count > 20 { return ["At most 20 grouping fields are allowed."] }
    for key in groupBy {
      guard let f = schema.field(named: key), f.isGroupable else {
        return ["Field \(key) cannot group metrics."]
      }
    }
    guard let name = field else {
      return op == "count" ? [] : ["Metric \(op) requires a measure field."]
    }
    guard let f = schema.field(named: name), f.isMeasurable, f.aggregateOperators.contains(op)
    else { return ["Field \(name) cannot be measured with \(op)."] }
    return []
  }
}
