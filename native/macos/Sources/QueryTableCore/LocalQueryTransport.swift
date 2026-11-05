import Foundation

/// An immutable in-memory adapter for previews, small local datasets, and tests.
/// Scalar comparisons follow SQL null exclusion, including `!=`. Empty strings
/// are considered empty by nullity and negated predicates, matching the UI.
/// Regex is deliberately delegated to server transports: Foundation's regex engine
/// cannot enforce the execution budget required for untrusted query patterns.
public struct LocalQueryTransport: QueryTransport {
  public static let profile = "qt-native-local-v1"
  public let schema: FieldSchema
  public let rows: [QueryRow]
  public var queryCapabilities: QueryCapabilitiesV3 {
    QueryCapabilitiesV3(
      profile: Self.profile, maxRows: 10_000, maxGroups: 100_000,
      maxPopulation: max(1, rows.count))
  }
  public init(schema: FieldSchema, rows: [QueryRow]) {
    self.schema = schema
    self.rows = rows
  }
  /// Executes one ungrouped request in process. Relative datetime operands are
  /// evaluated against `request.now`.
  public func fetchQueryV3(_ request: QueryRequestV3) async throws -> QueryResultV3 {
    try Task.checkCancellation()
    guard request.version == 3, request.diagnostics.isEmpty else {
      throw QueryTableError.invalidQuery(
        request.diagnostics.first ?? "A valid version 3 query is required")
    }
    guard request.profile == Self.profile else {
      throw QueryTableError.invalidQuery("Requested query profile is unavailable")
    }
    guard request.grouping == nil else {
      throw QueryTableError.unsupported("The local transport executes ungrouped queries only")
    }
    let reference = Date(timeIntervalSince1970: Double(request.now) / 1000)
    let matching = try filtered(request.source.whereTerms, now: reference)
    // Distinct values read the source population only; their result stage
    // returns nothing, so it may differ from the source.
    if let distinct = request.distinct {
      guard !request.rows, request.metrics.isEmpty else {
        throw QueryTableError.invalidQuery("A distinct request cannot also request rows or metrics")
      }
      return QueryResultV3(
        answering: request, schema: schema, distinct: try distinctValues(distinct, in: matching))
    }
    guard request.source == request.result else {
      throw QueryTableError.unsupported("The local transport executes ungrouped queries only")
    }
    for name in request.result.select where schema.field(named: name) == nil {
      throw QueryTableError.invalidQuery("Unknown field: \(name)")
    }
    let metrics = try aggregations(request.metrics, over: matching)
    guard request.rows else {
      return QueryResultV3(
        answering: request, schema: schema, total: matching.count, metrics: metrics)
    }
    let page = try sortedPage(matching, query: request.result)
    return QueryResultV3(
      answering: request, schema: schema, rows: page, total: matching.count, metrics: metrics)
  }
  private func sortedPage(_ matching: [QueryRow], query: ServerQuery) throws -> [QueryRow] {
    let sorts =
      (query.orderBy.isEmpty ? schema.defaultSort ?? [] : query.orderBy)
      + (schema.tiebreakSort ?? [])
    for term in sorts where term.extract != nil {
      throw QueryTableError.unsupported(
        "Regex extraction requires a server transport (\(term.field))")
    }
    let result = matching.enumerated().sorted { left, right in
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
    return Array(result.dropFirst(offset).prefix(count))
  }
  /// Distinct values ordered by count descending, then value; NULLs excluded.
  private func distinctValues(_ query: DistinctRequestV3, in matching: [QueryRow]) throws
    -> DistinctResultV3
  {
    guard let field = schema.field(named: query.field), field.isPushdownFilter else {
      throw QueryTableError.invalidQuery("Field cannot list values: \(query.field)")
    }
    guard (1...DistinctRequestV3.maxLimit).contains(query.limit),
      query.search.utf16.count <= DistinctRequestV3.maxSearchLength
    else { throw QueryTableError.invalidQuery("Invalid distinct limit or search") }
    let source = matching.map { field.value(in: $0) }
    var counts: [String: Int] = [:]
    for value in source {
      let members: [JSONValue]
      if case .array(let items) = value { members = items } else { members = [value] }
      for member in members where member != .null {
        let text = member.displayString
        if query.search.isEmpty || text.range(of: query.search, options: .caseInsensitive) != nil {
          counts[text, default: 0] += 1
        }
      }
    }
    let values = counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
      .map(\.key)
    return DistinctResultV3(
      values: Array(values.prefix(query.limit)), hasMore: values.count > query.limit,
      hasNull: source.contains {
        $0 == .null || (field.type == "textarray" && $0 == .array([]))
      })
  }
  private func aggregations(_ clauses: [MetricSpecV3], over matching: [QueryRow]) throws
    -> [AggregationResultEntry]
  {
    try clauses.map { a -> AggregationResultEntry in
      guard
        a.expression == nil && a.expressionY == nil && (a.whereTerms ?? []).isEmpty && a.minCount == nil
          && a.distribution == nil && a.dateGrouping == nil && (a.sort ?? []).isEmpty
          && a.groupLimit == nil && (a.scope ?? "allMatching") == "allMatching"
      else {
        throw QueryTableError.unsupported("The local transport executes plain metrics only")
      }
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
          keys: keys, value: value,
          count: records.count)
      }.map { ($0, $0.keyLabels.map { $0 ?? "" }) }  // Label each bucket once.
        .sorted { $0.1.lexicographicallyPrecedes($1.1) }.map(\.0)
      return AggregationResultEntry(
        id: a.id, buckets: buckets, scope: "allMatching", processedRows: matching.count,
        groupCount: buckets.count)
    }
  }
  private struct TimeKey: Hashable { let field, op, value: String }
  private func filtered(_ terms: [WhereTerm], now reference: Date) throws -> [QueryRow] {
    // One prepared value per predicate; parse before reading rows so invalid
    // filters also fail on an empty dataset and under negation/OR.
    var times: [TimeKey: Date] = [:]
    func key(_ p: WhereClause) -> TimeKey { TimeKey(field: p.field, op: p.op, value: p.value) }
    // The wire schema requires a branch in every OR group and a literal in every
    // conjunction; an empty one would otherwise match every row.
    guard terms.allSatisfy({ term in !term.branches.isEmpty && term.branches.allSatisfy { !$0.isEmpty } }) else {
      throw QueryTableError.invalidQuery("An OR group or conjunction is empty")
    }
    for p in terms.flatMap(\.predicates) {
      guard let f = schema.field(named: p.field), f.filterOperators.contains(p.op) else {
        throw QueryTableError.invalidQuery("Unsupported field or operator: \(p.field) \(p.op)")
      }
      if f.type == "datetime" && !p.value.isEmpty && !["is_null", "is_not_null"].contains(p.op) {
        if p.value.hasPrefix("+") || p.value.hasPrefix("-") {
          guard let offset = RelativeTime.parseDuration(p.value) else {
            throw QueryTableError.invalidQuery("Invalid signed duration")
          }
          times[key(p)] = try RelativeTime.timestamp(reference, offset: offset)
        } else {
          guard let date = RelativeTime.absoluteDate(p.value) else {
            throw QueryTableError.invalidQuery("Invalid datetime")
          }
          times[key(p)] = date
        }
      }
      if p.op.contains("regex") {
        throw QueryTableError.unsupported("Regex matching requires a server transport")
      }
    }
    return rows.filter { row in
      terms.allSatisfy { term in
        term.branches.contains { $0.allSatisfy { matches($0, row: row, time: times[key($0)]) } }
      }
    }
  }
  private func matches(_ clause: WhereClause, row: QueryRow, time: Date?) -> Bool {
    guard let field = schema.field(named: clause.field) else { return false }
    let value = field.value(in: row)
    let empty = value == .null || value == .string("") || value == .array([])
    if clause.value.isEmpty && !["=", "!=", "is_null", "is_not_null"].contains(clause.op) {
      return true
    }
    if clause.op == "length_gt" || clause.op == "length_lt" || clause.op == "length_eq" {
      guard !clause.value.isEmpty,
        clause.value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
        (clause.value == "0" || !clause.value.hasPrefix("0")),
        let limit = Int(clause.value), limit >= 0, limit <= 9_007_199_254_740_991,
        case .string(let text) = value
      else { return false }
      let result = clause.op == "length_gt"
        ? text.unicodeScalars.count > limit
        : clause.op == "length_lt" ? text.unicodeScalars.count < limit : text.unicodeScalars.count == limit
      return clause.negated == true ? (!empty && !result) : result
    }
    if clause.op == "is_null" { return clause.negated == true ? false : empty }
    if clause.op == "is_not_null" { return clause.negated == true ? false : !empty }
    if value == .null || (clause.negated == true && empty) { return false }
    if let time {
      guard let date = RelativeTime.absoluteDate(value.displayString) else { return false }
      let result: Bool
      switch clause.op {
      case "=": result = date == time
      case "!=": result = date != time
      case ">": result = date > time
      case ">=": result = date >= time
      case "<": result = date < time
      case "<=": result = date <= time
      default: result = false
      }
      return clause.negated == true ? !result : result
    }
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
