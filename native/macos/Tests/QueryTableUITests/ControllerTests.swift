import QueryTableCore
import XCTest

@testable import QueryTableUI

@MainActor
final class ControllerTests: XCTestCase {
  func testDefaultColumnsMatchProjectionIncludingExplicitEmptyDefaults() {
    for defaults: [SelectColumn]? in [nil, [], [.init(field: "name")]] {
      var schema = self.schema
      schema.defaultSelect = defaults
      for selected: [SelectColumn] in [[], [.init(field: "name", width: 180)]] {
        let query = QueryState(select: selected)
        let controller = QueryTableController(
          schema: schema,
          adapter: LocalQueryTransport(schema: schema, rows: []), initialQuery: query)
        XCTAssertEqual(
          controller.visibleColumns.map(\.field), schema.selectedFields(query).map(\.name))
        XCTAssertEqual(
          Set(query.serverQuery(schema: schema).select),
          Set(controller.visibleColumns.map(\.field) + [schema.idField]))
        if defaults == [] && selected.isEmpty { XCTAssertTrue(controller.visibleColumns.isEmpty) }
      }
    }
  }

  private let schema = FieldSchema(
    name: "controller-tests", idField: "id",
    fields: [
      .init(name: "id", label: "ID", type: "number"),
      .init(name: "name", label: "Name", type: "text", select: .init(default: true)),
    ])

  func testHistoryAndSelectionSurvivePaging() async throws {
    let rows: [QueryRow] = [
      ["id": .number(1), "name": .string("One")], ["id": .number(2), "name": .string("Two")],
    ]
    let controller = QueryTableController(
      schema: schema, adapter: LocalQueryTransport(schema: schema, rows: rows),
      initialQuery: QueryState(limit: 1))
    controller.refresh()
    try await settle(controller)
    controller.selectedIDs = [controller.rowID(rows[0])]
    controller.edit(resetOffset: false) { $0.offset = 1 }
    try await settle(controller)
    XCTAssertEqual(controller.rows.first?["id"], .number(2))
    XCTAssertEqual(controller.selectedIDs, [controller.rowID(rows[0])])
    controller.undo()
    try await settle(controller)
    XCTAssertEqual(controller.query.offset, 0)
    XCTAssertTrue(controller.canRedo)
  }

  func testSavedQueriesDefaultToMemoryAndRejectDuplicateNames() {
    let adapter = LocalQueryTransport(schema: schema, rows: [])
    let first = QueryTableController(schema: schema, adapter: adapter)
    first.saveQuery(name: "One")
    first.saveQuery(name: " One ")
    XCTAssertEqual(first.savedQueries.count, 1)
    XCTAssertNotNil(first.error)
    let second = QueryTableController(schema: schema, adapter: adapter)
    XCTAssertTrue(second.savedQueries.isEmpty)
  }

  func testExplicitPersistenceIsNamespaced() throws {
    let suite = "query-table.tests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let adapter = LocalQueryTransport(schema: schema, rows: [])
    let first = QueryTableController(schema: schema, adapter: adapter, persistence: defaults)
    first.saveQuery(name: "Stored")
    let second = QueryTableController(schema: schema, adapter: adapter, persistence: defaults)
    XCTAssertEqual(second.savedQueries.map(\.name), ["Stored"])
    let other = FieldSchema(name: "another-dataset", idField: "id", fields: schema.fields)
    XCTAssertTrue(
      QueryTableController(schema: other, adapter: adapter, persistence: defaults).savedQueries
        .isEmpty)
  }

  private func settle(_ controller: QueryTableController) async throws {
    for _ in 0..<500 {
      if !controller.isLoading { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("Controller did not settle")
  }
}
