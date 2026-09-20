import Foundation

public enum QueryTableError: Error, LocalizedError, Sendable {
  case unsupported(String)
  case invalidQuery(String)
  public var errorDescription: String? {
    switch self {
    case .unsupported(let v), .invalidQuery(let v): return v
    }
  }
}
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
public struct FetchRowsResult: Codable, Equatable, Sendable {
  public var rows: [QueryRow]
  public var total: Int
  public init(rows: [QueryRow], total: Int) {
    self.rows = rows
    self.total = total
  }
}
public struct DistinctValuesQuery: Codable, Equatable, Sendable {
  public var field: String
  public var search: String
  public var limit: Int?
  public init(field: String, search: String = "", limit: Int? = nil) {
    self.field = field
    self.search = search
    self.limit = limit
  }
}
public struct DistinctValuesResult: Codable, Equatable, Sendable {
  public var values: [String]
  public var hasMore: Bool
  public var hasNull: Bool?
  public init(values: [String], hasMore: Bool = false, hasNull: Bool? = nil) {
    self.values = values
    self.hasMore = hasMore
    self.hasNull = hasNull
  }
}
public struct AggregationRequest: Codable, Equatable, Sendable {
  public var whereTerms: [WhereTerm]
  public var aggregations: [AggregationClause]
  enum CodingKeys: String, CodingKey {
    case whereTerms = "where"
    case aggregations
  }
  public init(whereTerms: [WhereTerm] = [], aggregations: [AggregationClause]) {
    self.whereTerms = whereTerms
    self.aggregations = aggregations
  }
}
public struct AggregationBucket: Codable, Equatable, Sendable {
  public var keys: [String?]
  public var value: JSONValue
  public var count: Int
  public init(keys: [String?] = [], value: JSONValue, count: Int) {
    self.keys = keys
    self.value = value
    self.count = count
  }
}
public struct AggregationResultEntry: Codable, Equatable, Sendable {
  public var id: String
  public var buckets: [AggregationBucket]
  public init(id: String, buckets: [AggregationBucket]) {
    self.id = id
    self.buckets = buckets
  }
}
public struct AggregationResult: Codable, Equatable, Sendable {
  public var metrics: [AggregationResultEntry]
  public init(metrics: [AggregationResultEntry] = []) { self.metrics = metrics }
}
public protocol QueryTransport: Sendable {
  func fetchRows(query: ServerQuery) async throws -> FetchRowsResult
  func fetchDistinctValues(query: DistinctValuesQuery) async throws -> DistinctValuesResult
  func fetchAggregations(query: AggregationRequest) async throws -> AggregationResult
}
extension QueryTransport {
  public func fetchDistinctValues(query: DistinctValuesQuery) async throws -> DistinctValuesResult {
    throw QueryTableError.unsupported("This transport does not provide suggestions")
  }
  public func fetchAggregations(query: AggregationRequest) async throws -> AggregationResult {
    throw QueryTableError.unsupported("This transport does not provide metrics")
  }
}
extension QueryState {
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
  public func aggregationQuery(schema: FieldSchema) -> AggregationRequest {
    AggregationRequest(
      whereTerms: serverQuery(schema: schema).whereTerms,
      aggregations: normalized().aggregations.filter { a in
        (a.field == nil || schema.field(named: a.field!)?.source.kind == "backend")
          && a.groupBy.allSatisfy { schema.field(named: $0)?.source.kind == "backend" }
      })
  }
}
