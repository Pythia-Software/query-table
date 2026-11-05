import Foundation
import XCTest

@testable import QueryTableCore

/// The XCTest twin of QueryTableChecks' WireFixtureCheck: every golden fixture
/// of schema/fixtures/wire decodes into the generated wire types and
/// re-encodes to the same JSON (compared with sorted keys, since JSONEncoder
/// does not keep key order).
final class WireFixtureTests: XCTestCase {
  private let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().appendingPathComponent("../../../../schema/fixtures/wire")
    .standardizedFileURL

  private func canonical<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  private func assertRoundTrips<T: Codable>(_ type: T.Type, kind: String, minimum: Int) throws {
    let folder = directory.appendingPathComponent(kind)
    let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
      .filter { $0.hasSuffix(".json") }
    XCTAssertGreaterThanOrEqual(names.count, minimum)
    for name in names {
      let data = try Data(contentsOf: folder.appendingPathComponent(name))
      XCTAssertEqual(
        try canonical(JSONDecoder().decode(T.self, from: data)),
        try canonical(JSONDecoder().decode(JSONValue.self, from: data)), "\(kind)/\(name)")
    }
  }

  func testRequestFixturesRoundTrip() throws {
    try assertRoundTrips(QueryRequestV3.self, kind: "requests", minimum: 6)
  }

  func testResultFixturesRoundTrip() throws {
    try assertRoundTrips(QueryResultV3.self, kind: "results", minimum: 3)
  }
}
