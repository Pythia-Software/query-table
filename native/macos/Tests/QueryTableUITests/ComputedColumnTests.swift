import Combine
import QueryTableCore
import QueryTableFormula
import XCTest

@testable import QueryTableUI

@MainActor
final class ComputedColumnTests: XCTestCase {
  private let schema = FieldSchema(
    name: "computed-tests", idField: "id",
    fields: [
      .init(name: "id", label: "ID", type: "number"),
      .init(name: "name", label: "Name", type: "text", select: .init(default: true)),
      .init(
        name: "amount", label: "Amount", type: "number", source: .init(path: "payload.amount"),
        select: .init(default: false)),
    ])

  func testPreviewFetchesHiddenDependenciesAndGroupsInputsAndResults() async throws {
    let store = ComputedColumnController(schema: schema)
    let doubled = try await store.save(id: "double", label: "Double", source: "[amount] * 2")
    let preview = try await store.sample(source: "[\(doubled.fieldName)] + 1", count: 50) {
      dependencies, count in
      XCTAssertEqual(dependencies, ["amount"])
      XCTAssertEqual(count, 50)
      return FetchRowsResult(
        rows: [
          ["payload": .object(["amount": .number(3)])],
          ["payload": .object(["amount": .number(3)])],
          ["payload": .object(["amount": .null])],
          ["payload": .object(["amount": .string("invalid")])],
        ], total: 1000)
    }
    XCTAssertEqual(preview.sampled, 4)
    XCTAssertEqual(preview.total, 1000)
    XCTAssertEqual(preview.nulls, 1)
    XCTAssertEqual(preview.errors, 1)
    XCTAssertEqual(preview.groups.count, 3)
    XCTAssertEqual(preview.groups.first?.count, 2)
    XCTAssertEqual(preview.groups.first?.inputs, [.number(3)])
    XCTAssertEqual(preview.groups.first?.result.value, .number(7))
  }

  func testRevisionConflictAndAtomicPublication() async throws {
    let store = ComputedColumnController(schema: schema)
    let first = try await store.save(id: "value", label: "Value", source: "1")
    var publications: [[String]] = []
    let observation = store.$definitions.dropFirst().sink { publications.append($0.map(\.id)) }
    let second = try await store.save(
      id: first.id, label: first.label, source: "2", expectedRevision: first.revision)
    XCTAssertNotEqual(first.revision, second.revision)
    XCTAssertEqual(
      publications, [["value"]],
      "Updating must never publish a temporary catalogue with the column missing")
    do {
      _ = try await store.save(
        id: first.id, label: first.label, source: "3", expectedRevision: first.revision)
      XCTFail("A stale editor must not overwrite a newer revision")
    } catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
    XCTAssertEqual(store.definitions.first?.expression.source, "2")
    withExtendedLifetime(observation) {}
  }

  func testCatalogueRoundTripAndInvalidImportLeavesExistingDefinitions() async throws {
    let store = ComputedColumnController(schema: schema)
    _ = try await store.save(id: "value", label: "Value", source: "1")
    let data = try store.exportCatalogue()
    let restored = ComputedColumnController(schema: schema)
    try restored.importCatalogue(data)
    XCTAssertEqual(try restored.exportCatalogue(), data)
    let duplicate = try JSONEncoder().encode(store.definitions + store.definitions)
    XCTAssertThrowsError(try restored.importCatalogue(duplicate))
    XCTAssertEqual(try restored.exportCatalogue(), data)
  }

  func testCatalogueChangeDuringSamplingRejectsStaleResults() async throws {
    let store = ComputedColumnController(schema: schema)
    let column = try await store.save(id: "value", label: "Value", source: "[amount]")
    do {
      _ = try await store.sample(source: "[\(column.fieldName)]", count: 10) { _, _ in
        // A service push arrives while the backend sample is in flight.
        let replacement = ComputedColumn(
          id: "value", label: "Value", source: "2", revision: "remote:2")
        try store.importCatalogue(JSONEncoder().encode([replacement]))
        return FetchRowsResult(rows: [["payload": .object(["amount": .number(1)])]], total: 1)
      }
      XCTFail("A stale compiled plan must not publish a preview after catalogue replacement")
    } catch is CancellationError {}
  }

  func testRowsFetchedForOldCatalogueCannotUseNewDefinitions() async throws {
    let store = ComputedColumnController(schema: schema)
    let column = try await store.save(id: "value", label: "Value", source: "1")
    let version = store.catalogueVersion
    _ = try await store.save(
      id: column.id, label: column.label, source: "[amount]", expectedRevision: column.revision)
    do {
      _ = try await store.evaluate(
        rows: [["id": .number(1)]], selected: [.init(field: column.fieldName)],
        expectedCatalogueVersion: version)
      XCTFail("Old projection lacks the new formula's hidden input")
    } catch is CancellationError {}
  }

  func testUnavailableDefinitionIsAnErrorCellWithoutDiscardingRows() async throws {
    let store = ComputedColumnController(schema: schema)
    let rows: [QueryRow] = [["id": .number(1)]]
    let result = try await store.evaluate(rows: rows, selected: [.init(field: "@computed/missing")])
    XCTAssertEqual(result[0]["id"], .number(1))
    XCTAssertEqual(
      result[0]["@computed/missing"],
      .object(["computedError": .string("Computed column unavailable.")]))
  }
}
