import Foundation
import QueryTableCore
import QueryTableFormula
import QueryTableUI

private enum CheckFailure: Error { case failed(String) }

/// Executable checks are available even on Macs with only Command Line Tools,
/// which do not ship XCTest. CI also runs the full XCTest suites under Xcode.
@main
struct QueryTableChecks {
  @MainActor static func main() async throws {
    if let index = CommandLine.arguments.firstIndex(of: "--wire-fixture"),
      CommandLine.arguments.count > index + 2
    {
      try WireCheck.run(
        input: CommandLine.arguments[index + 1], output: CommandLine.arguments[index + 2])
      return
    }
    var count = 0
    func check(_ condition: Bool, _ message: String) throws {
      guard condition else { throw CheckFailure.failed(message) }
      count += 1
      print("PASS \(message)")
    }
    try await RelativeTimeCheck.run(check: check)
    try WireFixtureCheck.run(check: check)
    let schema = FieldSchema(
      name: "checks", idField: "id",
      fields: [
        FieldDefinition(name: "id", label: "ID", type: "number"),
        FieldDefinition(
          name: "name", label: "Name", type: "text", select: SelectConfig(default: true)),
        FieldDefinition(
          name: "amount", label: "Amount", type: "number", select: SelectConfig(default: true)),
        FieldDefinition(name: "status", label: "Status", type: "enum"),
      ], defaultLimit: 25)
    let rows: [QueryRow] = [
      [
        "id": .number(1), "name": .string("Alpha"), "amount": .number(20),
        "status": .string("PASS"),
      ],
      [
        "id": .number(2), "name": .string("Beta"), "amount": .number(40), "status": .string("FAIL"),
      ],
      ["id": .number(3), "name": .string("Gamma"), "amount": .null, "status": .string("PASS")],
    ]
    let local = LocalQueryTransport(schema: schema, rows: rows)
    let malformed =
      #"{"w":[{"field":"status","op":"=","value":"PASS","negated":"invalid"},null,{"field":"amount","op":">"},{"any":[{"field":"name","op":"=","value":"Alpha"},false,{"field":4,"op":"=","value":"x"}]}]}"#
    let recovered = QueryState.decodeToken(Data(malformed.utf8).base64EncodedString())
    let recoveredResult = try await local.rows(recovered.serverQuery(schema: schema))
    try check(
      recovered.whereTerms.count == 2 && recoveredResult.total == 1
        && recoveredResult.rows.first?["id"] == .number(1),
      "Malformed token members preserve valid AND and OR filters")
    for defaults: [SelectColumn]? in [nil, [], [.init(field: "name")]] {
      var columnSchema = schema
      columnSchema.defaultSelect = defaults
      for selected: [SelectColumn] in [[], [.init(field: "name", width: 180)]] {
        let query = QueryState(select: selected)
        let table = QueryTableController(
          schema: columnSchema,
          adapter: ProjectionTransport(schema: columnSchema, rows: rows), initialQuery: query)
        table.refresh()
        try await waitUntil { !table.isLoading }
        let visible = table.visibleColumns.map(\.field)
        let expected = columnSchema.selectedFields(query).map(\.name)
        try check(
          visible == expected && table.error == nil
            && table.rows.allSatisfy { row in visible.allSatisfy { row[$0] != nil } }
            && (defaults != [] || !selected.isEmpty || visible.isEmpty),
          "Displayed columns match enforced projection (defaults: \(String(describing: defaults)), explicit: \(!selected.isEmpty))"
        )
      }
    }
    let query = QueryState(
      select: [.init(field: "name", width: 180)],
      whereTerms: [
        .any([
          .init(field: "status", op: "=", value: "PASS"),
          .init(field: "amount", op: ">", value: "30"),
        ])
      ],
      orderBy: [.init(field: "amount", dir: "desc", nulls: "last")], limit: 1
    )
    try check(
      QueryState.decodeToken(try query.encodedToken()) == query, "Compact query token round trip")
    let server = query.serverQuery(schema: schema)
    try check(server.select == ["id", "name"], "Projection retains stable row ID")
    let first = try await local.rows(server)
    try check(
      first.total == 3 && first.rows.first?["id"] == .number(2),
      "OR filtering, sorting and total before pagination")
    let negated = try await local.rows(
      .init(whereTerms: [
        .predicate(.init(field: "amount", op: ">", value: "30", negated: true))
      ]))
    try check(
      negated.rows.count == 1 && negated.rows[0]["id"] == .number(1),
      "Negation excludes NULL values")
    let branches = WhereTerm.group(OrGroup(any: [
      .all(WhereConjunction(all: [
        .init(field: "status", op: "=", value: "PASS"), .init(field: "amount", op: ">", value: "30"),
      ])),
      .literal(.init(field: "name", op: "=", value: "Beta")),
    ]))
    let branched = try await local.rows(.init(whereTerms: [branches]))
    try check(
      branched.rows.map { $0["id"] } == [.number(2)],
      "OR of AND branches matches a row only when every literal of one branch matches")
    let longerNames = try await local.rows(.init(whereTerms: [
      .predicate(.init(field: "name", op: "length_gt", value: "4"))
    ]))
    let shorterNames = try await local.rows(.init(whereTerms: [
      .predicate(.init(field: "name", op: "length_lt", value: "5"))
    ]))
    try check(
      longerNames.total == 2 && shorterNames.rows.map { $0["id"] } == [.number(2)],
      "String length filters use strict comparisons")
    let namesWithEmpty = LocalQueryTransport(
      schema: schema,
      rows: rows + [
        ["id": .number(4), "name": .string("")],
        ["id": .number(5), "name": .null],
      ])
    let negatedLength = try await namesWithEmpty.rows(.init(whereTerms: [
      .predicate(.init(field: "name", op: "length_gt", value: "5", negated: true))
    ]))
    try check(
      negatedLength.rows.map { $0["id"] } == [.number(1), .number(2), .number(3)],
      "Negated string length filters exclude empty and NULL values")
    let emptyOnly = try await namesWithEmpty.rows(.init(whereTerms: [
      .predicate(.init(field: "name", op: "length_eq", value: "0"))
    ]))
    let nonemptyOnly = try await namesWithEmpty.rows(.init(whereTerms: [
      .predicate(.init(field: "name", op: "length_gt", value: "0"))
    ]))
    try check(
      emptyOnly.rows.map { $0["id"] } == [.number(4)] && nonemptyOnly.total == 3,
      "Zero-length filters distinguish empty strings from NULL")
    let nonemptyClause = WhereClause(field: "name", op: "length_gt", value: "0")
    try check(
      QueryPredicateOperations.negate(
        nonemptyClause, allowedOps: ["length_gt", "length_eq"])
        == WhereClause(field: "name", op: "length_eq", value: "0"),
      "Zero-length negation chooses the empty-string filter")
    let suggestions = try await local.fetchQueryV3(
      .distinctValues(
        field: "status", search: "pa", schema: schema, capabilities: local.queryCapabilities))
    try check(
      suggestions.distinct?.values == ["PASS"] && suggestions.rows.isEmpty,
      "Autocomplete searches distinct values through the v3 distinct section")
    // The TypeScript builder filters the population in source only.
    let filteredSuggestions = try await local.fetchQueryV3(
      QueryRequestV3(
        profile: local.queryCapabilities.profile, now: 0,
        source: ServerQuery(
          whereTerms: [.predicate(.init(field: "amount", op: ">", value: "30"))], limit: 1),
        result: ServerQuery(limit: 1), rows: false,
        distinct: DistinctRequestV3(field: "status", search: "", limit: 10)))
    try check(
      filteredSuggestions.distinct?.values == ["FAIL"],
      "Distinct values read a filtered source whose result stage differs")
    let stale = QueryTableController(
      schema: schema, adapter: ProjectionTransport(schema: schema, rows: [rows[0]]))
    var wrongRow: Error?
    do { _ = try await stale.fetchRow(id: .number(2)) } catch { wrongRow = error }
    try check(wrongRow != nil, "Row lookup rejects a response for a different identity")
    let nestedSchema = FieldSchema(
      name: "nested", idField: "id",
      fields: [
        .init(name: "id", label: "ID", type: "number", source: .init(path: "meta.id")),
        .init(name: "name", label: "Name", type: "text"),
      ])
    let nestedRows: [QueryRow] = [["meta": .object(["id": .number(1)]), "name": .string("a")]]
    let nestedTable = QueryTableController(
      schema: nestedSchema, adapter: LocalQueryTransport(schema: nestedSchema, rows: nestedRows))
    nestedTable.refresh()
    try await waitUntil { !nestedTable.isLoading }
    let nestedRow = try await nestedTable.fetchRow(id: .number(1))
    try check(
      nestedTable.error == nil && nestedTable.rows.count == 1 && nestedRow != nil,
      "An identity at a nested source path validates and looks up")
    let oneRow = QueryCapabilitiesV3(profile: local.queryCapabilities.profile, maxRows: 1)
    let tightLookup = QueryRequestV3.rowLookup(id: .number(2), select: ["name"], schema: schema, capabilities: oneRow)
    try check(tightLookup.source.limit == 1, "Row lookup stays within a one-row budget")
    let metrics = try await local.metrics([.init(id: "total", op: "sum", field: "amount")])
    try check(metrics.first?.buckets.first?.value == .number(60), "Metric covers full dataset")
    let lookup = QueryRequestV3.rowLookup(
      id: .number(2), select: ["name"], schema: schema, capabilities: local.queryCapabilities)
    let found = try await local.fetchQueryV3(lookup)
    try found.validate(for: lookup, schema: schema)
    try check(
      found.rows.map { $0["id"] } == [.number(2)] && lookup.source.limit == 2,
      "Row refresh is a rows request filtered by identity")
    let rejected = QueryState(orderBy: [.init(field: "missing")]).queryRequestV3(
      schema: schema, capabilities: local.queryCapabilities)
    try check(
      rejected.diagnostics == ["The query contains unsupported result ordering."],
      "Unsupported state becomes a request diagnostic")
    try await HTTPCheck.run()
    try check(true, "HTTP transport posts v3 JSON with authentication and rejects error status and mismatched responses")

    let engine = FormulaEngine()
    let plan = try await engine.compile(
      source: "[amount] * 2", fields: [.init(name: "amount", type: "number")])
    let results = try await engine.evaluate(plan: plan, rows: rows)
    try check(
      results.map(\.value) == [.number(40), .number(80), .null],
      "Formula arithmetic and null propagation")
    let unicode = try await engine.compile(source: "LEFT(\"😀hello\", 1)", fields: [])
    let unicodeResult = try await engine.evaluate(plan: unicode, rows: [[:]])
    try check(unicodeResult[0].value == .string("😀"), "Formula preserves Unicode semantics")
    let nested = try await engine.compile(
      source: "[@computed/double] + 1", fields: [.init(name: "amount", type: "number")],
      definitions: [.init(id: "double", label: "Double", source: "[amount] * 2")])
    let nestedResult = try await engine.evaluate(plan: nested, rows: [rows[0]])
    try check(
      nestedResult[0].value == .number(41) && nested.dependencies == ["amount"],
      "Computed dependency expansion")
    let catalogue = ComputedColumnController(schema: schema)
    let preview = try await catalogue.sample(source: "[amount] * 2", count: 100) {
      dependencies, _ in
      guard dependencies == ["amount"] else {
        throw CheckFailure.failed("Preview must request hidden inputs")
      }
      return .init(rows: [["amount": .number(3)], ["amount": .number(3)]], total: 10)
    }
    try check(
      preview.sampled == 2 && preview.total == 10 && preview.groups.first?.count == 2,
      "Formula samples group repeated inputs and report scope")
    _ = try await catalogue.save(label: "Double", source: "[amount] * 2")
    let restored = ComputedColumnController(schema: schema)
    try restored.importCatalogue(catalogue.exportCatalogue())
    try check(
      restored.definitions.count == 1
        && restored.definitions[0].expression.source == "[amount] * 2",
      "Computed catalogue round trip")
    let identities = try JSONDecoder().decode(
      [JSONValue].self, from: Data("[9223372036854775807,9223372036854775806,1.0001,1.0002]".utf8))
    try check(
      Set(identities.map(\.identityKey)).count == 4,
      "Large integer and fractional identities remain distinct")
    do {
      _ = try await engine.compile(source: "REGEX_TEST(\"x\", \"x\")", fields: [])
      throw CheckFailure.failed("Regex should be rejected")
    } catch is FormulaEngineError {
      try check(true, "Unsupported native regex reports a diagnostic")
    }

    let controller = QueryTableController(schema: schema, adapter: local)
    controller.refresh()
    try await waitUntil { !controller.isLoading }
    try check(
      controller.rows.count == 3 && controller.error == nil, "Controller fetches through adapter")
    controller.edit { $0.whereTerms = [branches, .predicate(.init(field: "name", op: "=", value: "Alpha"))] }
    controller.groupFilter(from: 1, with: 0)
    controller.groupFilter(from: 0, with: 1)
    controller.ungroupFilter(at: 0)
    try check(
      controller.query.whereTerms.first == branches && controller.query.whereTerms.count == 2,
      "The editor never flattens OR groups with AND branches")
    controller.edit { $0.whereTerms = [] }
    try await waitUntil { !controller.isLoading }
    controller.addFilter(field: "status", value: "PASS")
    try await waitUntil { !controller.isLoading }
    try check(
      controller.total == 2 && controller.canUndo,
      "Query edits fetch filtered rows and record history")
    controller.undo()
    try await waitUntil { !controller.isLoading }
    try check(controller.total == 3 && controller.canRedo, "Undo restores previous query")
    controller.redo()
    try await waitUntil { !controller.isLoading }
    try check(controller.total == 2, "Redo restores filter")
    controller.saveQuery(name: "Passing runs")
    controller.saveQuery(name: "Passing runs")
    try check(
      controller.savedQueries.count == 1 && controller.error != nil,
      "Saved query names reject duplicates")

    let nullPredicate = WhereClause(field: "amount", op: "is_null")
    let notNull = QueryPredicateOperations.negate(nullPredicate)
    let nonnullRows = try await local.rows(.init(whereTerms: [.predicate(notNull)]))
    try check(
      notNull.op == "is_not_null" && notNull.negated == nil && nonnullRows.total == 2,
      "NOT NULL control uses the complementary operator")
    let grouped = QueryTableController(
      schema: schema, adapter: local,
      initialQuery: QueryState(whereTerms: [
        .predicate(.init(field: "status", op: "=", value: "PASS")),
        .predicate(.init(field: "name", op: "=", value: "Beta")),
      ]))
    grouped.groupFilter(from: 1, with: 0)
    try await waitUntil { !grouped.isLoading }
    try check(grouped.total == 3, "Merging filters into OR changes the matching set")
    grouped.ungroupFilter(at: 0)
    try await waitUntil { !grouped.isLoading }
    try check(grouped.total == 0, "Splitting an OR group restores AND behavior")

    var aliasSchema = schema
    aliasSchema.fields[1].aliases = ["title"]
    let aliases = QueryTableController(
      schema: aliasSchema, adapter: local,
      initialQuery: QueryState(select: [.init(field: "title"), .init(field: "name")]))
    try check(
      aliases.visibleColumns.map(\.field) == ["name"],
      "Column aliases cannot duplicate native identifiers")

    let suite = "query-table.checks.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let persisted = QueryTableController(
      schema: schema, adapter: local, initialQuery: QueryState(limit: 7), persistence: defaults)
    persisted.saveQuery(name: "Default")
    persisted.setDefaultSaved(id: persisted.savedQueries[0].id)
    persisted.setQuery(QueryState(limit: 9), fetch: false)
    let defaultView = QueryTableController(schema: schema, adapter: local, persistence: defaults)
    let explicitView = QueryTableController(
      schema: schema, adapter: local, initialQuery: QueryState(limit: 11), persistence: defaults)
    try check(
      defaultView.query.limit == 7 && explicitView.query.limit == 11,
      "Explicit query takes precedence over saved default and last view")

    let sampleController = QueryTableController(
      schema: schema, adapter: CappedTransport(schema: schema, rows: rows), initialQuery: QueryState(offset: 2))
    let sample = try await sampleController.sampleRows(dependencies: ["amount"], count: 3)
    try check(
      sample.rows.count == 3 && sample.rows.first?["id"] == .number(1),
      "Preview starts at zero and follows server page caps")

    let delayed = ControlledTransport(schema: schema)
    let racing = QueryTableController(schema: schema, adapter: delayed)
    racing.refresh()
    try await waitUntil { await delayed.requestCount == 1 }
    racing.setQuery(QueryState(limit: 2))
    try await waitUntil { await delayed.requestCount == 2 }
    await delayed.complete(index: 1, rows: [rows[1]])
    try await waitUntil { !racing.isLoading }
    await delayed.complete(index: 0, rows: [rows[0]])
    try await Task.sleep(nanoseconds: 30_000_000)
    try check(
      racing.rows.first?["id"] == .number(2), "Late response cannot overwrite a newer query")
    print("\(count) native checks passed.")
  }

  @MainActor private static func waitUntil(_ condition: () async -> Bool) async throws {
    for _ in 0..<500 {
      if await condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    throw CheckFailure.failed("Timed out waiting for asynchronous result")
  }
}

private let checkCapabilities = QueryCapabilitiesV3(profile: "checks")

private struct ProjectionTransport: QueryTransport {
  let schema: FieldSchema
  let rows: [QueryRow]
  var queryCapabilities: QueryCapabilitiesV3 { checkCapabilities }
  func fetchQueryV3(_ request: QueryRequestV3) async throws -> QueryResultV3 {
    QueryResultV3(
      answering: request, schema: schema,
      rows: rows.map { row in row.filter { request.result.select.contains($0.key) } },
      total: rows.count)
  }
}

private struct CappedTransport: QueryTransport {
  let schema: FieldSchema
  let rows: [QueryRow]
  var queryCapabilities: QueryCapabilitiesV3 { checkCapabilities }
  func fetchQueryV3(_ request: QueryRequestV3) async throws -> QueryResultV3 {
    QueryResultV3(
      answering: request, schema: schema,
      rows: Array(rows.dropFirst(request.result.offset).prefix(1)), total: rows.count)
  }
}

private actor ControlledTransport: QueryTransport {
  private let schema: FieldSchema
  private var pending: [Int: (QueryRequestV3, CheckedContinuation<QueryResultV3, Error>)] = [:]
  private(set) var requestCount = 0
  init(schema: FieldSchema) { self.schema = schema }
  nonisolated var queryCapabilities: QueryCapabilitiesV3 { checkCapabilities }
  func fetchQueryV3(_ request: QueryRequestV3) async throws -> QueryResultV3 {
    let index = requestCount
    requestCount += 1
    return try await withCheckedThrowingContinuation { pending[index] = (request, $0) }
  }
  func complete(index: Int, rows: [QueryRow]) {
    guard let (request, continuation) = pending.removeValue(forKey: index) else { return }
    continuation.resume(
      returning: QueryResultV3(answering: request, schema: schema, rows: rows, total: rows.count))
  }
}
