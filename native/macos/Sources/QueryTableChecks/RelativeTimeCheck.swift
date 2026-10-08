import Foundation
import QueryTableCore

/// Exercises the local mirror without XCTest (available with Command Line Tools).
enum RelativeTimeCheck {
  struct Fixtures: Decodable {
    struct Valid: Decodable { let value: String; let offsetMs: Int64 }
    let valid: [Valid]
    let invalid: [String]
  }
  @MainActor static func run(check: @MainActor (Bool, String) throws -> Void) async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: root.appendingPathComponent("schema/fixtures/relative-time.json")))
    for f in fixtures.valid {
      try check(RelativeTime.parseDuration(f.value) == f.offsetMs, "Signed duration: \(f.value)")
    }
    for value in fixtures.invalid { try check(RelativeTime.parseDuration(value) == nil, "Reject duration syntax: \(value)") }

    let schema = FieldSchema(name: "times", idField: "id", fields: [
      FieldDefinition(name: "id", label: "ID", type: "number"),
      FieldDefinition(name: "at", label: "Time", type: "datetime"),
    ])
    let reference = Date(timeIntervalSince1970: 1_772_964_000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let rows: [QueryRow] = [-3_600_001, -3_600_000, -1, 0, 3_599_999, 3_600_000].enumerated().map { id, offset in
      ["id": .number(Double(id)), "at": .string(formatter.string(from: reference.addingTimeInterval(Double(offset) / 1000)))]
    } + [["id": .number(6), "at": .null], ["id": .number(7), "at": .string("invalid")]]
    let local = LocalQueryTransport(schema: schema, rows: rows, now: { reference })
    func term(_ value: String, op: String = ">=", negated: Bool? = nil) -> WhereTerm {
      .predicate(.init(field: "at", op: op, value: value, negated: negated))
    }
    for (terms, expected) in [
      ([term("-1h"), term("+0s", op: "<")], [1,2]),
      ([term("+0s"), term("+1h", op: "<")], [3,4]),
      ([term("-1h", negated: true)], [0]),
      ([term("+1h")], [5]),
      ([term("+0s", op: "=")], [3]),
      ([.any([.init(field: "at", op: "=", value: "-1h"), .init(field: "at", op: "=", value: "+1h")])], [1,5]),
    ] as [([WhereTerm], [Int])] {
      let query = QueryState(whereTerms: terms)
      try check(QueryState.decodeToken(try query.encodedToken()) == query, "Signed duration query round trip")
      let result = try await local.fetchRows(query: query.serverQuery(schema: schema))
      try check(result.rows.map { $0["id"] } == expected.map { .number(Double($0)) }, "Existing datetime comparison / negation / OR")
    }
    let compound = try await local.fetchRows(query: .init(whereTerms: [term("-8d2h10m"), term("+8d2h10m", op: "<")]))
    try check(compound.total == 6, "Compound duration components share one sign")
    for value in ["+1h-2m", "last 7d", "now", "1h from now", "+8640000000000000ms1ms"] {
      var rejected = false
      do { _ = try await local.fetchRows(query: .init(whereTerms: [term(value, negated: true)])) }
      catch { rejected = true }
      try check(rejected, "Invalid datetime operand throws")
    }
    let mixedSchema = FieldSchema(name: "mixed", idField: "id", fields: schema.fields + [
      FieldDefinition(name: "label", label: "Label", type: "text")
    ])
    let mixed = LocalQueryTransport(schema: mixedSchema, rows: [["id": .number(1), "at": rows[3]["at"]!, "label": .string("+0s")]], now: { reference })
    let mixedResult = try await mixed.fetchRows(query: .init(whereTerms: [term("+0s", op: "="), .predicate(.init(field: "label", op: "=", value: "+0s"))]))
    try check(mixedResult.total == 1, "Duration coercion does not affect text values")
    let metric = try await local.fetchAggregations(query: .init(whereTerms: [term("-1h"), term("+0s", op: "<")], aggregations: [.init(id: "count", op: "count", groupBy: [])]))
    try check(metric.metrics.first?.buckets.first?.value == .number(2), "Local metrics mirror signed datetime operands")
  }
}
