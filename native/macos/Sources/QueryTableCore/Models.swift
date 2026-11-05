import Foundation

public enum JSONValue: Codable, Equatable, Hashable, Sendable {
  case string(String)
  case number(Double)
  case integer(Int64)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Int64.self),
      v > 9_007_199_254_740_991 || v < -9_007_199_254_740_991
    {
      self = .integer(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .integer(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
  /// JSON scalar identity preserves type and every digit; unlike display labels it is safe for selection keys.
  public var identityKey: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: (try? encoder.encode(self)) ?? Data("null".utf8), as: UTF8.self)
  }
  public var displayString: String {
    switch self {
    case .null: return ""
    case .string(let v): return v
    case .number(let v): return NSNumber(value: v).stringValue
    case .integer(let v): return String(v)
    case .bool(let v): return v ? "true" : "false"
    case .array(let v): return v.map(\.displayString).joined(separator: ", ")
    case .object:
      return String(data: (try? JSONEncoder().encode(self)) ?? Data(), encoding: .utf8) ?? ""
    }
  }
}
public typealias QueryRow = [String: JSONValue]
public struct SelectColumn: Codable, Equatable, Sendable {
  public var field: String
  public var width: Double?
  public init(field: String, width: Double? = nil) {
    self.field = field
    self.width = width
  }
}
// WhereClause, OrderByClause and RegexExtraction are generated into
// Wire.generated.swift. WhereTerm is the schema's escape hatch (x-swift-type):
// the native client edits flat OR groups, so it keeps `.predicate`/`.any`.

/// One conjunct of a WHERE: a literal, a flat OR group, or an OR group with
/// conjunction branches (`(a AND b) OR c`), which the native editor does not
/// build and shows read-only, so its branches are carried through unchanged.
public enum WhereTerm: Codable, Equatable, Sendable {
  case predicate(WhereClause)
  case any([WhereClause])
  case group(OrGroup)
  private enum CodingKeys: String, CodingKey { case any }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if c.contains(.any) {
      self = WhereTerm(branches: try OrGroup(from: decoder).any)
    } else {
      self = .predicate(try WhereClause(from: decoder))
    }
  }
  public func encode(to encoder: Encoder) throws {
    switch self {
    case .predicate(let v): try v.encode(to: encoder)
    case .any(let v): try OrGroup(any: v.map(WhereBranch.literal)).encode(to: encoder)
    case .group(let v): try v.encode(to: encoder)
    }
  }
  /// An OR group: flat `.any` when every branch is a literal, else `.group`.
  public init(branches: [WhereBranch]) {
    let literals = branches.compactMap { branch -> WhereClause? in
      if case .literal(let v) = branch { return v }
      return nil
    }
    self = literals.count == branches.count ? .any(literals) : .group(OrGroup(any: branches))
  }
  /// The term as alternatives of conjunctions: it matches when every literal of
  /// some branch matches. Evaluate with this, never with `predicates`.
  public var branches: [[WhereClause]] {
    switch self {
    case .predicate(let v): return [[v]]
    case .any(let v): return v.map { [$0] }
    case .group(let v):
      return v.any.map { branch -> [WhereClause] in
        switch branch {
        case .literal(let v): return [v]
        case .all(let v): return v.all
        }
      }
    }
  }
  /// Whether the native editor can edit the term as a flat list of
  /// alternatives. Conjunction branches would be flattened, widening it.
  public var isFlat: Bool {
    if case .group = self { return false }
    return true
  }
  /// Every literal of the term (each counts against the predicate budget).
  /// Flattening loses its meaning; see `branches`.
  public var predicates: [WhereClause] { branches.flatMap { $0 } }
}
public struct AggregationClause: Codable, Equatable, Sendable {
  public var id: String
  public var op: String
  public var field: String?
  public var groupBy: [String]
  public var label: String?
  public init(
    id: String = UUID().uuidString, op: String, field: String? = nil, groupBy: [String] = [],
    label: String? = nil
  ) {
    self.id = id
    self.op = op
    self.field = field
    self.groupBy = groupBy
    self.label = label
  }
}
public struct QueryState: Codable, Equatable, Sendable {
  public var select: [SelectColumn]
  public var whereTerms: [WhereTerm]
  public var orderBy: [OrderByClause]
  public var limit: Int
  public var offset: Int
  public var aggregations: [AggregationClause]
  enum CodingKeys: String, CodingKey {
    case select
    case whereTerms = "where"
    case orderBy, limit, offset, aggregations
  }
  public init(
    select: [SelectColumn] = [], whereTerms: [WhereTerm] = [], orderBy: [OrderByClause] = [],
    limit: Int = 100, offset: Int = 0, aggregations: [AggregationClause] = []
  ) {
    self.select = select
    self.whereTerms = whereTerms
    self.orderBy = orderBy
    self.limit = limit
    self.offset = offset
    self.aggregations = aggregations
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    select = try c.decodeIfPresent([SelectColumn].self, forKey: .select) ?? []
    whereTerms = try c.decodeIfPresent([WhereTerm].self, forKey: .whereTerms) ?? []
    orderBy = try c.decodeIfPresent([OrderByClause].self, forKey: .orderBy) ?? []
    limit = try c.decodeIfPresent(Int.self, forKey: .limit) ?? 100
    offset = try c.decodeIfPresent(Int.self, forKey: .offset) ?? 0
    aggregations = try c.decodeIfPresent([AggregationClause].self, forKey: .aggregations) ?? []
    self = normalized()
  }
  public func normalized() -> QueryState {
    var q = self
    q.limit = max(1, min(9_007_199_254_740_991, limit))
    q.offset = max(0, min(1_000_000, offset))
    var seen = Set<String>()
    q.select = select.prefix(200).filter {
      !$0.field.isEmpty && $0.field.count <= 256 && seen.insert($0.field).inserted
    }.map {
      SelectColumn(
        field: $0.field, width: $0.width.flatMap { $0.isFinite ? min(2000, max(24, $0)) : nil })
    }
    // The same rules as TypeScript normalizeWhereTerms, so a link selects the
    // same rows in both clients: invalid literals are dropped one by one and
    // only valid literals count against the budget of 100. A conjunction left
    // with one literal is that literal, an empty one is dropped, and a group
    // left with one branch becomes plain AND terms.
    let valid = { (p: WhereClause) in
      !p.field.isEmpty && p.field.count <= 256 && !p.field.hasPrefix("@computed/")
        && p.value.utf16.count <= 10000 && Self.filterOps.contains(p.op)
    }
    var budget = 100
    var terms: [WhereTerm] = []
    for term in whereTerms {
      guard budget > 0 else { break }
      if case .predicate(let p) = term {
        if valid(p) {
          terms.append(.predicate(p))
          budget -= 1
        }
        continue
      }
      var members: [WhereBranch] = []
      for branch in term.branches {
        guard budget > 0 else { break }
        let kept = Array(branch.filter(valid).prefix(budget))
        budget -= kept.count
        if kept.count == 1 {
          members.append(.literal(kept[0]))
        } else if kept.count > 1 {
          members.append(.all(WhereConjunction(all: kept)))
        }
      }
      if members.count > 1 {
        terms.append(WhereTerm(branches: members))
      } else if case .literal(let p) = members.first {
        terms.append(.predicate(p))
      } else if case .all(let c) = members.first {
        terms.append(contentsOf: c.all.map(WhereTerm.predicate))
      }
    }
    q.whereTerms = terms
    q.orderBy = orderBy.prefix(20).filter {
      !$0.field.isEmpty && $0.field.count <= 256 && !$0.field.hasPrefix("@computed/")
        && ["asc", "desc"].contains($0.dir)
    }.map {
      var t = $0
      if !["first", "last"].contains(t.nulls ?? "") { t.nulls = nil }
      if (t.extract?.regex.utf16.count ?? 0) > 10000 { t.extract = nil }
      return t
    }
    q.aggregations = aggregations.prefix(20).filter {
      ["count", "count_distinct", "sum", "avg", "min", "max"].contains($0.op) && !$0.id.isEmpty
        && $0.id.count <= 256 && !($0.field?.hasPrefix("@computed/") ?? false)
        && !$0.groupBy.contains { $0.hasPrefix("@computed/") }
    }.map {
      var a = $0
      a.groupBy = a.groupBy.prefix(20).filter { !$0.isEmpty && $0.count <= 256 }
      if (a.label?.count ?? 0) > 1000 { a.label = nil }
      return a
    }
    return q
  }
  public static let filterOps = [
    "=", "!=", ">", ">=", "<", "<=", "contains", "starts_with", "ends_with", "matches_regex",
    "not_matches_regex", "length_gt", "length_lt", "length_eq", "includes", "is_null", "is_not_null",
  ]
  public func encodedToken() throws -> String {
    let q = normalized()
    let e = JSONEncoder()
    var compact: [String: JSONValue] = ["l": .number(Double(q.limit))]
    func json<T: Encodable>(_ v: T) throws -> JSONValue {
      try JSONDecoder().decode(JSONValue.self, from: e.encode(v))
    }
    if !q.select.isEmpty {
      compact["s"] = .array(
        q.select.map { .array([.string($0.field)] + ($0.width.map { [.number($0)] } ?? [])) })
    }
    if !q.whereTerms.isEmpty { compact["w"] = try json(q.whereTerms) }
    if !q.orderBy.isEmpty { compact["o"] = try json(q.orderBy) }
    if q.offset != 0 { compact["f"] = .number(Double(q.offset)) }
    if !q.aggregations.isEmpty { compact["g"] = try json(q.aggregations) }
    return try e.encode(compact).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  public static func decodeToken(_ token: String) -> QueryState {
    guard token.count <= 2 * 1024 * 1024 else { return QueryState() }
    var b = token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b += String(repeating: "=", count: (4 - b.count % 4) % 4)
    guard let data = Data(base64Encoded: b),
      let c = try? JSONDecoder().decode([String: JSONValue].self, from: data)
    else { return QueryState() }
    func decode<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
      guard let v = c[key], let d = try? JSONEncoder().encode(v) else { return nil }
      return try? JSONDecoder().decode(type, from: d)
    }
    var q = QueryState()
    if case .array(let cols) = c["s"] ?? c["c"] {
      q.select = cols.compactMap { v in
        if case .string(let f) = v { return SelectColumn(field: f) }
        if case .array(let a) = v, let first = a.first, case .string(let f) = first {
          var width: Double?
          if a.count > 1, case .number(let n) = a[1] { width = n }
          return SelectColumn(field: f, width: width)
        }
        return nil
      }
    }
    // Normalize members independently, as the React token decoder does. Decoding
    // the entire array with Codable would discard valid filters when any sibling
    // (or one member of an OR group) has an invalid shape.
    func predicate(_ value: JSONValue) -> WhereClause? {
      guard case .object(let object) = value,
        case .string(let field) = object["field"],
        case .string(let op) = object["op"],
        case .string(let value) = object["value"],
        !field.isEmpty, field.utf16.count <= 256, !field.hasPrefix("@computed/"),
        Self.filterOps.contains(op), value.utf16.count <= 10_000
      else { return nil }
      return WhereClause(
        field: field, op: op, value: value,
        negated: object["negated"] == .bool(true) ? true : nil)
    }
    if case .array(let terms) = c["w"] {
      q.whereTerms = terms.compactMap { term in
        if case .object(let object) = term, case .array(let members) = object["any"] {
          let conjunctions = members.contains {
            if case .object(let member) = $0, member["all"] != nil { return true }
            return false
          }
          guard conjunctions else {
            let predicates = members.compactMap(predicate)
            return predicates.isEmpty ? nil : .any(predicates)
          }
          // Invalid literals drop one by one; normalized() applies the rest.
          let branches = members.compactMap { member -> WhereBranch? in
            if case .object(let branch) = member, case .array(let all) = branch["all"] {
              let literals = all.compactMap(predicate)
              return literals.isEmpty ? nil : .all(WhereConjunction(all: literals))
            }
            return predicate(member).map(WhereBranch.literal)
          }
          return branches.isEmpty ? nil : WhereTerm(branches: branches)
        }
        return predicate(term).map(WhereTerm.predicate)
      }
    }
    q.orderBy =
      decode("o", [OrderByClause].self) ?? decode("o", OrderByClause.self).map { [$0] } ?? []
    q.limit = decode("l", Int.self) ?? 100
    q.offset = decode("f", Int.self) ?? 0
    q.aggregations = decode("g", [AggregationClause].self) ?? []
    return q.normalized()
  }
}
