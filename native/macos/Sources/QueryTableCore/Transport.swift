import Foundation

public enum QueryTableError: Error, LocalizedError, Sendable {
  case unsupported(String)
  case invalidQuery(String)
  case invalidResponse(String)
  public var errorDescription: String? {
    switch self {
    case .unsupported(let v), .invalidQuery(let v), .invalidResponse(let v): return v
    }
  }
}

/// One query stage of a v3 request (`source` or `result`); the TypeScript
/// `ServerQuery`. It encodes only the readable keys the Go decoder accepts.
public struct ServerQuery: Codable, Equatable, Sendable {
  public var select: [String]
  public var whereTerms: [WhereTerm]
  public var orderBy: [OrderByClause]
  public var limit: Int
  public var offset: Int
  enum CodingKeys: String, CodingKey {
    case select
    case whereTerms = "where"
    case orderBy, limit, offset
  }
  public init(
    select: [String] = [], whereTerms: [WhereTerm] = [], orderBy: [OrderByClause] = [],
    limit: Int = 100, offset: Int = 0
  ) {
    self.select = select
    self.whereTerms = whereTerms
    self.orderBy = orderBy
    self.limit = limit
    self.offset = offset
  }
}

// MARK: - v3 protocol

/// The server's query handshake (TypeScript `QueryCapabilitiesV3`).
public struct QueryCapabilitiesV3: Codable, Equatable, Sendable {
  public var version: Int
  public var groupedRows: Bool
  public var calendarGrouping: Bool
  public var calendarCycles: Bool?
  public var calendarGroupKeys: Bool?
  public var computedSourceFilters: Bool
  public var regex: Bool
  public var regexSourceFilters: Bool?
  public var regexAggregateExpressions: Bool?
  public var metricFilters: Bool?
  public var metricMinCount: Bool?
  public var metricMinCountMeasures: Bool?
  public var maxRows: Int
  public var maxGroups: Int
  public var maxPopulation: Int
  public var profile: String
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

/// Filter autocomplete over `source.where` (TypeScript `DistinctRequestV3`).
public struct DistinctRequestV3: Codable, Equatable, Sendable {
  public static let maxLimit = 500
  public static let maxSearchLength = 2000
  public var field: String
  public var search: String
  public var limit: Int
  public init(field: String, search: String = "", limit: Int = 50) {
    self.field = field
    self.search = search
    self.limit = limit
  }
}
public struct DistinctResultV3: Codable, Equatable, Sendable {
  public var values: [String]
  public var hasMore: Bool
  public var hasNull: Bool
  public init(values: [String], hasMore: Bool = false, hasNull: Bool = false) {
    self.values = values
    self.hasMore = hasMore
    self.hasNull = hasNull
  }
}

/// One v3 query: rows, metrics or distinct values over a source stage. Ungrouped
/// requests use the same stage for `source` and `result`. Grouping is not
/// modelled by the native client.
public struct QueryRequestV3: Codable, Equatable, Sendable {
  /// Host-owned query state, passed through uninterpreted.
  public var hostState: JSONValue?
  public var version: Int
  public var profile: String
  /// The evaluation clock (epoch milliseconds) for relative datetime operands.
  public var now: Int64
  public var expectedRevisions: [String: String]
  public var planToken: String?
  public var snapshot: String?
  public var source: ServerQuery
  public var result: ServerQuery
  public var rows: Bool
  /// Encoded without `label`, which is presentation-only.
  public var metrics: [AggregationClause]
  public var distinct: DistinctRequestV3?
  public var diagnostics: [String]
  enum CodingKeys: String, CodingKey {
    case hostState, version, profile, now, expectedRevisions, planToken, snapshot, source, result,
      rows, metrics, distinct, diagnostics
  }
  public init(
    profile: String, now: Int64, source: ServerQuery, result: ServerQuery? = nil,
    rows: Bool = true, metrics: [AggregationClause] = [], distinct: DistinctRequestV3? = nil,
    expectedRevisions: [String: String] = [:], planToken: String? = nil,
    snapshot: String? = nil, hostState: JSONValue? = nil, diagnostics: [String] = []
  ) {
    self.version = 3
    self.profile = profile
    self.now = now
    self.source = source
    self.result = result ?? source
    self.rows = rows
    self.metrics = metrics
    self.distinct = distinct
    self.expectedRevisions = expectedRevisions
    self.planToken = planToken
    self.snapshot = snapshot
    self.hostState = hostState
    self.diagnostics = diagnostics
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(hostState, forKey: .hostState)
    try c.encode(version, forKey: .version)
    try c.encode(profile, forKey: .profile)
    try c.encode(now, forKey: .now)
    try c.encode(expectedRevisions, forKey: .expectedRevisions)
    try c.encodeIfPresent(planToken, forKey: .planToken)
    try c.encodeIfPresent(snapshot, forKey: .snapshot)
    try c.encode(source, forKey: .source)
    try c.encode(result, forKey: .result)
    try c.encode(rows, forKey: .rows)
    try c.encode(
      metrics.map {
        var metric = $0
        metric.label = nil
        return metric
      }, forKey: .metrics)
    try c.encodeIfPresent(distinct, forKey: .distinct)
    try c.encode(diagnostics, forKey: .diagnostics)
  }

  /// Epoch milliseconds for a request clock.
  public static func epochMilliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
  }

  /// Filter autocomplete: a distinct section over the unfiltered population.
  public static func distinctValues(
    field: String, search: String = "", limit: Int = 50, schema: FieldSchema,
    capabilities: QueryCapabilitiesV3, now: Date = Date(), hostState: JSONValue? = nil
  ) -> QueryRequestV3 {
    QueryRequestV3(
      profile: capabilities.profile, now: epochMilliseconds(now),
      source: ServerQuery(select: [], limit: 1), rows: false,
      distinct: DistinctRequestV3(
        field: field, search: search, limit: max(1, min(DistinctRequestV3.maxLimit, limit))),
      hostState: hostState)
  }

  /// Row refresh by identity. A total above one is a non-unique identity.
  public static func rowLookup(
    id: JSONValue, select: [String], schema: FieldSchema, capabilities: QueryCapabilitiesV3,
    now: Date = Date(), hostState: JSONValue? = nil
  ) -> QueryRequestV3 {
    let stage = ServerQuery(
      select: Array(Set(select + [schema.idField])).sorted(),
      whereTerms: [.predicate(.init(field: schema.idField, op: "=", value: id.displayString))],
      // Two rows within the server's budget; the total reports a duplicate either way.
      limit: max(1, min(2, capabilities.maxRows)))
    return QueryRequestV3(
      profile: capabilities.profile, now: epochMilliseconds(now), source: stage,
      hostState: hostState)
  }
}

public struct AggregationBucket: Codable, Equatable, Sendable {
  /// Group keys as display strings; NULL keys are nil.
  public var keys: [String?]
  public var value: JSONValue
  public var count: Int
  public var error: String?
  enum CodingKeys: String, CodingKey { case keys, value, count, error }
  public init(keys: [String?] = [], value: JSONValue, count: Int, error: String? = nil) {
    self.keys = keys
    self.value = value
    self.count = count
    self.error = error
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Servers may key buckets by numbers or booleans (TS MetricKey = MetricValue).
    keys = try c.decode([JSONValue].self, forKey: .keys).map {
      $0 == .null ? nil : $0.displayString
    }
    value = try c.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null
    count = try c.decode(Int.self, forKey: .count)
    error = try c.decodeIfPresent(String.self, forKey: .error)
  }
}
public struct AggregationResultEntry: Codable, Equatable, Sendable {
  public var id: String
  public var buckets: [AggregationBucket]
  public var error: String?
  public var scope: String?
  public var processedRows: Int?
  public var groupCount: Int?
  public var coverage: String?
  public var hiddenGroups: Int?
  public init(
    id: String, buckets: [AggregationBucket], error: String? = nil, scope: String? = nil,
    processedRows: Int? = nil, groupCount: Int? = nil, coverage: String? = nil,
    hiddenGroups: Int? = nil
  ) {
    self.id = id
    self.buckets = buckets
    self.error = error
    self.scope = scope
    self.processedRows = processedRows
    self.groupCount = groupCount
    self.coverage = coverage
    self.hiddenGroups = hiddenGroups
  }
}

public struct ComputedFieldCapabilityV3: Codable, Equatable, Sendable {
  public var type: String
  public var select: Bool
  public var sort: Bool
  public var measure: Bool
  public var group: Bool
  public var filter: Bool?
  public init(
    type: String, select: Bool = false, sort: Bool = false, measure: Bool = false,
    group: Bool = false, filter: Bool? = nil
  ) {
    self.type = type
    self.select = select
    self.sort = sort
    self.measure = measure
    self.group = group
    self.filter = filter
  }
}
/// The execution envelope (TypeScript `ComputedExecution`).
public struct QueryExecutionV3: Codable, Equatable, Sendable {
  public var profile: String
  public var planToken: String?
  public var resolvedRevisions: [String: String]
  public var fields: [String: ComputedFieldCapabilityV3]
  public var fingerprint: String?
  public var snapshot: String?
  enum CodingKeys: String, CodingKey {
    case profile, planToken, resolvedRevisions, fields, fingerprint, snapshot
  }
  public init(
    profile: String, planToken: String? = nil, resolvedRevisions: [String: String] = [:],
    fields: [String: ComputedFieldCapabilityV3] = [:], fingerprint: String? = nil,
    snapshot: String? = nil
  ) {
    self.profile = profile
    self.planToken = planToken
    self.resolvedRevisions = resolvedRevisions
    self.fields = fields
    self.fingerprint = fingerprint
    self.snapshot = snapshot
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    profile = try c.decode(String.self, forKey: .profile)
    planToken = try c.decodeIfPresent(String.self, forKey: .planToken)
    // Go encodes empty maps as null.
    resolvedRevisions =
      try c.decodeIfPresent([String: String].self, forKey: .resolvedRevisions) ?? [:]
    fields = try c.decodeIfPresent([String: ComputedFieldCapabilityV3].self, forKey: .fields) ?? [:]
    fingerprint = try c.decodeIfPresent(String.self, forKey: .fingerprint)
    snapshot = try c.decodeIfPresent(String.self, forKey: .snapshot)
  }
}

public struct ProjectedFieldV3: Codable, Equatable, Sendable {
  public var name: String
  public var type: String
  public init(name: String, type: String) {
    self.name = name
    self.type = type
  }
}
public struct ProjectedSchemaV3: Codable, Equatable, Sendable {
  public var name: String
  public var idField: String
  public var fields: [ProjectedFieldV3]
  public init(name: String, idField: String, fields: [ProjectedFieldV3]) {
    self.name = name
    self.idField = idField
    self.fields = fields
  }
}

public struct QueryResultV3: Codable, Equatable, Sendable {
  public var version: Int
  public var now: Int64
  public var sourceTotal: Int
  public var rows: [QueryRow]
  public var total: Int
  public var schema: ProjectedSchemaV3
  public var metrics: [AggregationResultEntry]
  public var execution: QueryExecutionV3
  public var distinct: DistinctResultV3?
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
      (execution.planToken ?? "") == (request.planToken ?? ""),
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
  /// Unsupported state is reported in `diagnostics`, which servers refuse.
  public func queryRequestV3(
    schema: FieldSchema, capabilities: QueryCapabilitiesV3, execution: QueryExecutionV3? = nil,
    now: Date = Date(), rows: Bool = true, metrics includeMetrics: Bool = true,
    hostState: JSONValue? = nil
  ) -> QueryRequestV3 {
    let q = normalized()
    var diagnostics: [String] = []
    if includeMetrics && aggregations.count != q.aggregations.count {
      diagnostics.append("The query exceeds its metric budget or contains malformed metric state.")
    }
    if capabilities.version != 3 || (execution.map { $0.profile != capabilities.profile } ?? false) {
      diagnostics.append("The negotiated query profile is unavailable.")
    }
    let stage = q.serverQuery(schema: schema)
    if q.whereTerms.flatMap(\.predicates).contains(where: {
      ["matches_regex", "not_matches_regex"].contains($0.op)
    }) && capabilities.regexSourceFilters != true {
      diagnostics.append("This server profile does not support isolated regex source filtering.")
    }
    if stage.whereTerms.count != q.whereTerms.count {
      diagnostics.append("The query contains unsupported source or result predicates.")
    }
    if stage.orderBy.count != q.orderBy.count {
      diagnostics.append("The query contains unsupported result ordering.")
    }
    let metrics = includeMetrics ? q.aggregations : []
    for metric in metrics { diagnostics.append(contentsOf: metric.diagnostics(schema: schema)) }
    var revisions: [String: String] = [:]
    for (id, revision) in execution?.resolvedRevisions ?? [:] {
      if revision.isEmpty || id.count > 256 || revision.count > 256 {
        diagnostics.append("Invalid computed revision envelope.")
      } else {
        revisions[id.hasPrefix("@computed/") ? String(id.dropFirst(10)) : id] = revision
      }
    }
    var unique = Set<String>()
    return QueryRequestV3(
      profile: capabilities.profile, now: QueryRequestV3.epochMilliseconds(now), source: stage,
      rows: rows, metrics: metrics, expectedRevisions: revisions,
      planToken: execution?.planToken.flatMap { $0.isEmpty ? nil : $0 },
      snapshot: execution?.snapshot, hostState: hostState,
      diagnostics: diagnostics.filter { unique.insert($0).inserted })
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
