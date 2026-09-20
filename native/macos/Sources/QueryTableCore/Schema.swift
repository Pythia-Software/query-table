import Foundation

public struct FieldSource: Codable, Equatable, Sendable {
  public var kind: String
  public var path: String?
  public var synthetic: Bool?
  public var dependencies: [String]?
  public var computedId: String?
  public init(
    kind: String = "backend", path: String? = nil, synthetic: Bool? = nil,
    dependencies: [String]? = nil, computedId: String? = nil
  ) {
    self.kind = kind
    self.path = path
    self.synthetic = synthetic
    self.dependencies = dependencies
    self.computedId = computedId
  }
}
public struct FilterValues: Codable, Equatable, Sendable {
  public var source: String
  public var options: [String]?
  public init(source: String = "autocomplete", options: [String]? = nil) {
    self.source = source
    self.options = options
  }
}
public struct FilterConfig: Codable, Equatable, Sendable {
  public var enabled: Bool?
  public var pushdown: Bool?
  public var ops: [String]?
  public var values: FilterValues?
  public init(
    enabled: Bool? = nil, pushdown: Bool? = nil, ops: [String]? = nil, values: FilterValues? = nil
  ) {
    self.enabled = enabled
    self.pushdown = pushdown
    self.ops = ops
    self.values = values
  }
}
public struct SortConfig: Codable, Equatable, Sendable {
  public var enabled: Bool?
  public var field: String?
  public init(enabled: Bool? = nil, field: String? = nil) {
    self.enabled = enabled
    self.field = field
  }
}
public struct SelectConfig: Codable, Equatable, Sendable {
  public var enabled: Bool?
  public var `default`: Bool?
  public var width: Double?
  public var align: String?
  public init(
    enabled: Bool? = nil, default: Bool? = nil, width: Double? = nil, align: String? = nil
  ) {
    self.enabled = enabled
    self.default = `default`
    self.width = width
    self.align = align
  }
}
public struct AggregateConfig: Codable, Equatable, Sendable {
  public var measure: Bool?
  public var groupable: Bool?
  public var ops: [String]?
  public init(measure: Bool? = nil, groupable: Bool? = nil, ops: [String]? = nil) {
    self.measure = measure
    self.groupable = groupable
    self.ops = ops
  }
}
public struct FieldDefinition: Codable, Equatable, Sendable, Identifiable {
  public var name: String
  public var label: String
  public var type: String
  public var source: FieldSource
  public var filter: FilterConfig?
  public var sort: SortConfig?
  public var select: SelectConfig?
  public var aggregate: AggregateConfig?
  public var group: String?
  public var alias: String?
  public var aliases: [String]?
  public var render: String?
  public var id: String { name }
  public init(
    name: String, label: String, type: String, source: FieldSource = .init(),
    filter: FilterConfig? = nil, sort: SortConfig? = nil, select: SelectConfig? = nil,
    aggregate: AggregateConfig? = nil, group: String? = nil, alias: String? = nil,
    aliases: [String]? = nil, render: String? = nil
  ) {
    self.name = name
    self.label = label
    self.type = type
    self.source = source
    self.filter = filter
    self.sort = sort
    self.select = select
    self.aggregate = aggregate
    self.group = group
    self.alias = alias
    self.aliases = aliases
    self.render = render
  }
  enum CodingKeys: String, CodingKey {
    case name, label, type, source, filter, sort, select, aggregate, group, alias, aliases, render
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    label = try c.decode(String.self, forKey: .label)
    type = try c.decode(String.self, forKey: .type)
    if let shorthand = try? c.decode(String.self, forKey: .source) {
      source = FieldSource(kind: shorthand)
    } else if let explicit = try c.decodeIfPresent(FieldSource.self, forKey: .source) {
      source = explicit
    } else {
      let raw = try JSONValue(from: decoder)
      if case .object(let o) = raw {
        source = FieldSource(kind: o["bindings"] == nil ? "derived" : "backend")
      } else {
        source = FieldSource(kind: "derived")
      }
    }
    filter = try c.decodeIfPresent(FilterConfig.self, forKey: .filter)
    sort = try c.decodeIfPresent(SortConfig.self, forKey: .sort)
    select = try c.decodeIfPresent(SelectConfig.self, forKey: .select)
    aggregate = try c.decodeIfPresent(AggregateConfig.self, forKey: .aggregate)
    group = try c.decodeIfPresent(String.self, forKey: .group)
    alias = try c.decodeIfPresent(String.self, forKey: .alias)
    aliases = try c.decodeIfPresent([String].self, forKey: .aliases)
    render = try c.decodeIfPresent(String.self, forKey: .render)
  }
  public var isFilterable: Bool {
    source.computedId == nil && (filter?.enabled ?? (source.kind == "backend"))
  }
  public var isPushdownFilter: Bool {
    isFilterable && (filter?.pushdown ?? (source.kind == "backend"))
  }
  public var isSortable: Bool {
    source.computedId == nil && (sort?.enabled ?? (source.kind == "backend"))
  }
  public var isSelectable: Bool { select?.enabled ?? true }
  public var filterOperators: [String] {
    if let ops = filter?.ops { return ops }
    let ops: [String]
    switch type {
    case "number", "datetime": ops = ["=", "!=", ">", ">=", "<", "<="]
    case "textarray": ops = ["includes"]
    case "bool", "enum": ops = ["=", "!="]
    default:
      ops = [
        "=", "!=", "contains", "starts_with", "ends_with", "matches_regex", "not_matches_regex",
      ]
    }
    return ops + ["is_null", "is_not_null"]
  }
  public func value(in row: QueryRow) -> JSONValue {
    let path = source.path ?? name
    if let direct = row[path] { return direct }
    var current = JSONValue.object(row)
    for part in path.split(separator: ".") {
      guard case .object(let object) = current, let next = object[String(part)] else {
        return .null
      }
      current = next
    }
    return current
  }
}
public struct FieldSchema: Codable, Equatable, Sendable {
  public var name: String
  public var idField: String
  public var fields: [FieldDefinition]
  public var defaultSort: [OrderByClause]?
  public var tiebreakSort: [OrderByClause]?
  public var defaultSelect: [SelectColumn]?
  public var defaultLimit: Int?
  public init(
    name: String, idField: String, fields: [FieldDefinition], defaultSort: [OrderByClause]? = nil,
    defaultSelect: [SelectColumn]? = nil, defaultLimit: Int? = nil,
    tiebreakSort: [OrderByClause]? = nil
  ) {
    self.name = name
    self.idField = idField
    self.fields = fields
    self.defaultSort = defaultSort
    self.defaultSelect = defaultSelect
    self.defaultLimit = defaultLimit
    self.tiebreakSort = tiebreakSort
  }
  public static func load(data: Data) throws -> FieldSchema {
    let s = try JSONDecoder().decode(Self.self, from: data)
    guard !s.fields.isEmpty, Set(s.fields.map(\.name)).count == s.fields.count else {
      throw QueryTableError.invalidQuery("Schema fields must be nonempty and unique")
    }
    return s
  }
  public func field(named token: String) -> FieldDefinition? {
    if let exact = fields.first(where: { $0.name == token }) { return exact }
    let key = token.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return fields.first {
      ([$0.name] + [$0.alias].compactMap { $0 } + ($0.aliases ?? [])).contains {
        $0.lowercased() == key
      }
    }
  }
  public func selectedFields(_ query: QueryState) -> [FieldDefinition] {
    let defaults = fields.filter { $0.select?.default == true }
    let cols =
      query.select.isEmpty
      ? defaultSelect
        ?? (defaults.isEmpty ? fields.filter(\.isSelectable) : defaults).map {
          SelectColumn(field: $0.name)
        } : query.select
    var seen = Set<String>()
    return cols.compactMap { c in
      guard let f = field(named: c.field), f.isSelectable, seen.insert(f.name).inserted else {
        return nil
      }
      return f
    }
  }
  public var initialQuery: QueryState {
    QueryState(orderBy: defaultSort ?? [], limit: defaultLimit ?? 100)
  }
}
