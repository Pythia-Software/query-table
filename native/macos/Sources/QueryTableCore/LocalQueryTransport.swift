import Foundation

/// An immutable in-memory adapter for previews, small local datasets, and tests.
/// Scalar comparisons follow SQL null exclusion, including `!=`. Empty strings
/// are considered empty by nullity and negated predicates, matching the UI.
/// Regex is deliberately delegated to server transports: Foundation's regex engine
/// cannot enforce the execution budget required for untrusted query patterns.
public struct LocalQueryTransport: QueryTransport {
  public let schema: FieldSchema
  public let rows: [QueryRow]
  public init(schema: FieldSchema, rows: [QueryRow]) {
    self.schema = schema
    self.rows = rows
  }
  public func fetchRows(query: ServerQuery) async throws -> FetchRowsResult {
    try Task.checkCancellation()
    var result = try filtered(query.whereTerms)
    let sorts =
      (query.orderBy.isEmpty ? schema.defaultSort ?? [] : query.orderBy)
      + (schema.tiebreakSort ?? [])
    for term in sorts where term.extract != nil {
      throw QueryTableError.unsupported(
        "Regex extraction requires a server transport (\(term.field))")
    }
    result = result.enumerated().sorted { left, right in
      for term in sorts {
        guard
          let field = schema.field(named: term.field)
            ?? schema.fields.first(where: { $0.sort?.field == term.field })
        else { continue }
        let a = field.value(in: left.element)
        let b = field.value(in: right.element)
        if a == b { continue }
        if a == .null || b == .null {
          return a == .null ? term.nulls == "first" : term.nulls != "first"
        }
        let comparison = compare(a, b, type: field.type)
        if comparison != 0 { return term.dir == "desc" ? comparison > 0 : comparison < 0 }
      }
      return left.offset < right.offset
    }.map(\.element)
    let offset = max(0, min(query.offset, result.count))
    let count = max(0, min(query.limit, result.count - offset))
    return FetchRowsResult(rows: Array(result.dropFirst(offset).prefix(count)), total: result.count)
  }
  public func fetchDistinctValues(query: DistinctValuesQuery) async throws -> DistinctValuesResult {
    try Task.checkCancellation()
    guard let field = schema.field(named: query.field) else {
      throw QueryTableError.invalidQuery("Unknown field: \(query.field)")
    }
    let source = rows.map { field.value(in: $0) }
    let values = Set(
      source.flatMap { value -> [String] in
        if value == .null { return [] }
        if case .array(let a) = value { return a.map(\.displayString) }
        return [value.displayString]
      }
    ).filter { query.search.isEmpty || $0.localizedCaseInsensitiveContains(query.search) }.sorted()
    let limit = max(1, query.limit ?? 50)
    return DistinctValuesResult(
      values: Array(values.prefix(limit)), hasMore: values.count > limit,
      hasNull: source.contains(.null))
  }
  public func fetchAggregations(query: AggregationRequest) async throws -> AggregationResult {
    try Task.checkCancellation()
    let matching = try filtered(query.whereTerms)
    let metrics = try query.aggregations.map { a -> AggregationResultEntry in
      guard ["count", "count_distinct", "sum", "avg", "min", "max"].contains(a.op) else {
        throw QueryTableError.invalidQuery("Unknown aggregation: \(a.op)")
      }
      let measure = a.field.flatMap { schema.field(named: $0) }
      guard a.op == "count" || measure != nil else {
        throw QueryTableError.invalidQuery("Metric requires a known measure")
      }
      let axes = try a.groupBy.map { name -> FieldDefinition in
        guard let f = schema.field(named: name) else {
          throw QueryTableError.invalidQuery("Unknown group field: \(name)")
        }
        return f
      }
      var groups: [[JSONValue]: [QueryRow]] = [:]
      for row in matching { groups[axes.map { $0.value(in: row) }, default: []].append(row) }
      if axes.isEmpty && groups.isEmpty { groups[[]] = [] }
      let buckets = groups.map { keys, records -> AggregationBucket in
        let values =
          measure.map { field in records.map { field.value(in: $0) }.filter { $0 != .null } } ?? []
        let numbers = values.compactMap { numeric($0) }
        let value: JSONValue
        switch a.op {
        case "count": value = .number(Double(measure == nil ? records.count : values.count))
        case "count_distinct": value = .number(Double(Set(values).count))
        case "sum": value = numbers.isEmpty ? .null : .number(numbers.reduce(0, +))
        case "avg":
          value = numbers.isEmpty ? .null : .number(numbers.reduce(0, +) / Double(numbers.count))
        case "min":
          value = values.min { compare($0, $1, type: measure?.type ?? "text") < 0 } ?? .null
        case "max":
          value = values.max { compare($0, $1, type: measure?.type ?? "text") < 0 } ?? .null
        default: value = .null
        }
        return AggregationBucket(
          keys: keys.map { $0 == .null ? nil : $0.displayString }, value: value,
          count: records.count)
      }.sorted { $0.keys.map { $0 ?? "" }.lexicographicallyPrecedes($1.keys.map { $0 ?? "" }) }
      return AggregationResultEntry(id: a.id, buckets: buckets)
    }
    return AggregationResult(metrics: metrics)
  }
  private func filtered(_ terms: [WhereTerm]) throws -> [QueryRow] {
    for p in terms.flatMap(\.predicates) {
      guard let f = schema.field(named: p.field), f.filterOperators.contains(p.op) else {
        throw QueryTableError.invalidQuery("Unsupported field or operator: \(p.field) \(p.op)")
      }
      if p.op.contains("regex") {
        throw QueryTableError.unsupported("Regex matching requires a server transport")
      }
    }
    return rows.filter { row in
      terms.allSatisfy { term in term.predicates.contains { matches($0, row: row) } }
    }
  }
  private func matches(_ clause: WhereClause, row: QueryRow) -> Bool {
    guard let field = schema.field(named: clause.field) else { return false }
    let value = field.value(in: row)
    let empty = value == .null || value == .string("") || value == .array([])
    if clause.value.isEmpty && !["=", "!=", "is_null", "is_not_null"].contains(clause.op) {
      return true
    }
    if clause.op == "is_null" { return clause.negated == true ? false : empty }
    if clause.op == "is_not_null" { return clause.negated == true ? false : !empty }
    if value == .null || (clause.negated == true && empty) { return false }
    let rhs: JSONValue
    if field.type == "number" {
      guard let n = Double(clause.value), n.isFinite else { return false }
      rhs =
        Int64(clause.value).flatMap {
          $0 > 9_007_199_254_740_991 || $0 < -9_007_199_254_740_991 ? JSONValue.integer($0) : nil
        } ?? .number(n)
    } else if field.type == "bool" {
      switch clause.value.lowercased() {
      case "true", "1", "t": rhs = .bool(true)
      case "false", "0", "f": rhs = .bool(false)
      default: return false
      }
    } else {
      rhs = .string(clause.value)
    }
    let comparison = compare(value, rhs, type: field.type)
    let text = value.displayString.lowercased()
    let needle = clause.value.lowercased()
    let result: Bool
    switch clause.op {
    case "=":
      result =
        field.type == "text" || field.type == "enum"
        ? value.displayString == clause.value : comparison == 0
    case "!=":
      result =
        field.type == "text" || field.type == "enum"
        ? value.displayString != clause.value : comparison != 0
    case ">": result = comparison > 0
    case ">=": result = comparison >= 0
    case "<": result = comparison < 0
    case "<=": result = comparison <= 0
    case "contains": result = text.contains(needle)
    case "starts_with": result = text.hasPrefix(needle)
    case "ends_with": result = text.hasSuffix(needle)
    case "includes":
      if case .array(let items) = value {
        result = items.contains {
          field.filter?.arrayCaseSensitive == true
            ? $0.displayString == clause.value : $0.displayString.lowercased() == needle
        }
      } else {
        result = false
      }
    default: result = false
    }
    return clause.negated == true ? !result : result
  }
  private func numeric(_ v: JSONValue) -> Double? {
    if case .number(let n) = v { return n }
    return Double(v.displayString)
  }
  private func compare(_ a: JSONValue, _ b: JSONValue, type: String) -> Int {
    if type == "number",
      let x = Decimal(string: a.displayString, locale: Locale(identifier: "en_US_POSIX")),
      let y = Decimal(string: b.displayString, locale: Locale(identifier: "en_US_POSIX"))
    {
      return x == y ? 0 : x < y ? -1 : 1
    }
    if type == "datetime" {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let plain = ISO8601DateFormatter()
      if let x = formatter.date(from: a.displayString) ?? plain.date(from: a.displayString),
        let y = formatter.date(from: b.displayString) ?? plain.date(from: b.displayString)
      {
        return x == y ? 0 : x < y ? -1 : 1
      }
    }
    let x = a.displayString
    let y = b.displayString
    return x == y ? 0 : x < y ? -1 : 1
  }
}
