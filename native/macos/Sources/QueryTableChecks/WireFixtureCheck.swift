import Foundation
import QueryTableCore

/// Decodes every golden fixture of schema/fixtures/wire into the generated
/// wire types and re-encodes it. JSONEncoder does not keep key order, so both
/// sides are compared in a canonical encoding (sorted keys, unescaped
/// slashes): a dropped, added or retyped value fails the check.
enum WireFixtureCheck {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().appendingPathComponent("../../../../schema/fixtures/wire")
    .standardizedFileURL

  static func canonical<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  /// Fixture names whose typed round trip differs from the fixture.
  static func mismatches<T: Codable>(_ type: T.Type, kind: String) throws -> (count: Int, failed: [String]) {
    let folder = directory.appendingPathComponent(kind)
    let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
      .filter { $0.hasSuffix(".json") }.sorted()
    var failed: [String] = []
    for name in names {
      let data = try Data(contentsOf: folder.appendingPathComponent(name))
      let typed = try canonical(JSONDecoder().decode(T.self, from: data))
      let untyped = try canonical(JSONDecoder().decode(JSONValue.self, from: data))
      if typed != untyped { failed.append("\(kind)/\(name)\n got: \(typed)\nwant: \(untyped)") }
    }
    return (names.count, failed)
  }

  static func run(check: (Bool, String) throws -> Void) throws {
    let requests = try mismatches(QueryRequestV3.self, kind: "requests")
    try check(
      requests.count >= 6 && requests.failed.isEmpty,
      "Wire request fixtures round-trip (\(requests.count))\(requests.failed.joined(separator: "\n"))")
    let results = try mismatches(QueryResultV3.self, kind: "results")
    try check(
      results.count >= 3 && results.failed.isEmpty,
      "Wire result fixtures round-trip (\(results.count))\(results.failed.joined(separator: "\n"))")
  }
}
