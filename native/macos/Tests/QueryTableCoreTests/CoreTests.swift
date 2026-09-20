import XCTest

@testable import QueryTableCore

final class CoreTests: XCTestCase {
  func testMalformedTokenMembersPreserveOtherFilters() throws {
    let raw =
      #"{"w":[{"field":"name","op":"=","value":"Alpha","negated":"invalid"},null,{"field":"amount","op":">"},{"any":[{"field":"amount","op":">","value":"5"},false,{"field":4,"op":"=","value":"x"}]}]}"#
    let query = QueryState.decodeToken(Data(raw.utf8).base64EncodedString())
    let expected: [WhereTerm] = [
      .predicate(.init(field: "name", op: "=", value: "Alpha")),
      .predicate(.init(field: "amount", op: ">", value: "5")),
    ]
    XCTAssertEqual(query.whereTerms, expected)
    XCTAssertEqual(query.serverQuery(schema: schema).whereTerms, expected)
  }

  let schema = FieldSchema(
    name: "items", idField: "id",
    fields: [
      FieldDefinition(name: "id", label: "ID", type: "number"),
      FieldDefinition(
        name: "name", label: "Name", type: "text", select: SelectConfig(default: true),
        aliases: ["title"]),
      FieldDefinition(name: "amount", label: "Amount", type: "number"),
      FieldDefinition(name: "tags", label: "Tags", type: "textarray"),
    ])
  let rows: [QueryRow] = [
    [
      "id": .number(1), "name": .string("Alpha"), "amount": .number(10),
      "tags": .array([.string("x")]),
    ],
    ["id": .number(2), "name": .string("Beta"), "amount": .number(20), "tags": .array([])],
    ["id": .number(3), "name": .null, "amount": .null, "tags": .null],
  ]
  func testReactCompactWireFixture() throws {
    // The exact compact shape emitted by packages/core/src/encode.ts.
    let compact =
      #"{"s":[["title",240],["amount"]],"w":[{"any":[{"field":"name","op":"contains","value":"café 日本","negated":true},{"field":"amount","op":">","value":"10"}]}],"o":[{"field":"name","dir":"desc","nulls":"first","extract":{"regex":"(.*)"}}],"l":25,"f":50,"g":[{"id":"sum","op":"sum","field":"amount","groupBy":["name"],"label":"Total"}]}"#
    let token = Data(compact.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let q = QueryState.decodeToken(token)
    XCTAssertEqual(q.whereTerms.first?.predicates.first?.value, "café 日本")
    XCTAssertEqual(q.select.first?.width, 240)
    XCTAssertEqual(q.aggregations.first?.op, "sum")
    XCTAssertEqual(QueryState.decodeToken(try q.encodedToken()), q)
    XCTAssertEqual(q.orderBy.first?.extract?.regex, "(.*)")
  }
  func testLegacyAndMalformedTokens() {
    let legacy = Data(#"{"c":["name"],"o":{"field":"name","dir":"asc"}}"#.utf8)
      .base64EncodedString()
    XCTAssertEqual(QueryState.decodeToken(legacy).select, [SelectColumn(field: "name")])
    XCTAssertEqual(QueryState.decodeToken(legacy).orderBy.count, 1)
    XCTAssertEqual(QueryState.decodeToken("not valid"), QueryState())
  }
  func testSchemaProjectionAndReadPath() throws {
    let doc =
      #"{"name":"x","idField":"id","fields":[{"name":"id","label":"ID","type":"text","bindings":{"postgres":{"column":"id"}}},{"name":"display","label":"Display","type":"text","source":{"kind":"backend","path":"nested.name"},"select":{"default":true}}]}"#
    let s = try FieldSchema.load(data: Data(doc.utf8))
    XCTAssertEqual(s.fields.first?.source.kind, "backend")
    XCTAssertEqual(s.selectedFields(QueryState()).map(\.name), ["display"])
    XCTAssertEqual(
      s.fields[1].value(in: ["nested": .object(["name": .string("Ada")])]), .string("Ada"))
    XCTAssertEqual(QueryState().serverQuery(schema: s).select, ["display", "id"])
  }
  func testMixedORNeverPartiallyPushesDown() {
    var s = schema
    s.fields.append(
      FieldDefinition(
        name: "local", label: "Local", type: "text", source: FieldSource(kind: "derived"),
        filter: FilterConfig(enabled: true)))
    let q = QueryState(whereTerms: [
      .any([
        WhereClause(field: "name", op: "=", value: "a"),
        WhereClause(field: "local", op: "=", value: "b"),
      ])
    ])
    XCTAssertTrue(q.serverQuery(schema: s).whereTerms.isEmpty)
  }
  func testPredicateBudgetAndComputedSelectOnly() {
    let predicates = (0..<70).map { WhereClause(field: "name", op: "=", value: String($0)) }
    let q = QueryState(
      whereTerms: [.any(predicates), .any(predicates)],
      aggregations: [.init(id: "bad", op: "sum", field: "@computed/a")]
    ).normalized()
    XCTAssertEqual(q.whereTerms.flatMap(\.predicates).count, 100)
    XCTAssertTrue(q.aggregations.isEmpty)
  }
  func testLocalNullExclusiveNegationAndPaging() async throws {
    let adapter = LocalQueryTransport(schema: schema, rows: rows)
    let query = ServerQuery(whereTerms: [
      .predicate(.init(field: "name", op: "contains", value: "Alpha", negated: true))
    ])
    let result = try await adapter.fetchRows(query: query)
    XCTAssertEqual(result.rows.map { $0["id"] }, [.number(2)])
    let page = try await adapter.fetchRows(
      query: ServerQuery(orderBy: [.init(field: "amount", dir: "desc")], limit: 1, offset: 1))
    XCTAssertEqual(page.total, 3)
    XCTAssertEqual(page.rows.first?["id"], .number(1))
    let empty = try await adapter.fetchRows(
      query: ServerQuery(whereTerms: [.predicate(.init(field: "tags", op: "is_null"))]))
    XCTAssertEqual(empty.total, 2)
  }
  func testMetricsUseEntireFilteredSet() async throws {
    let adapter = LocalQueryTransport(schema: schema, rows: rows)
    let q = QueryState(limit: 1, aggregations: [.init(id: "total", op: "sum", field: "amount")])
    let result = try await adapter.fetchAggregations(query: q.aggregationQuery(schema: schema))
    XCTAssertEqual(result.metrics.first?.buckets.first?.value, .number(30))
    XCTAssertEqual(result.metrics.first?.buckets.first?.count, 3)
    let distinct = try await adapter.fetchDistinctValues(
      query: .init(field: "name", search: "a", limit: 1))
    XCTAssertEqual(distinct.values.count, 1)
    XCTAssertTrue(distinct.hasMore)
    XCTAssertEqual(distinct.hasNull, true)
  }
  func testLocalCaseSemanticsEmptyDraftAndCountMeasure() async throws {
    let adapter = LocalQueryTransport(schema: schema, rows: rows)
    let exact = try await adapter.fetchRows(
      query: .init(whereTerms: [.predicate(.init(field: "name", op: "=", value: "alpha"))]))
    XCTAssertEqual(exact.total, 0)
    let membership = try await adapter.fetchRows(
      query: .init(whereTerms: [.predicate(.init(field: "tags", op: "includes", value: "X"))]))
    XCTAssertEqual(membership.total, 1)
    let draft = try await adapter.fetchRows(
      query: .init(whereTerms: [
        .predicate(.init(field: "name", op: "contains", value: "", negated: true))
      ]))
    XCTAssertEqual(draft.total, 3)
    let metric = try await adapter.fetchAggregations(
      query: .init(aggregations: [.init(id: "c", op: "count", field: "amount")]))
    XCTAssertEqual(metric.metrics[0].buckets[0].value, .number(2))
  }

  func testNumericIdentityPreservesInt64AndFractionalPrecision() throws {
    let values = try JSONDecoder().decode(
      [JSONValue].self, from: Data("[9223372036854775807,9223372036854775806,1.0001,1.0002]".utf8))
    XCTAssertEqual(values[0], .integer(Int64.max))
    XCTAssertEqual(values[0].displayString, "9223372036854775807")
    XCTAssertNotEqual(values[0].identityKey, values[1].identityKey)
    XCTAssertNotEqual(values[2].identityKey, values[3].identityKey)
    XCTAssertNotEqual(JSONValue.number(1).identityKey, JSONValue.string("1").identityKey)
    XCTAssertEqual(
      try JSONDecoder().decode([JSONValue].self, from: JSONEncoder().encode(values)), values)
  }
  func testLocalTiebreakAndWireProjection() async throws {
    var s = schema
    s.tiebreakSort = [.init(field: "id", dir: "desc")]
    s.defaultSort = [.init(field: "amount", dir: "asc")]
    let rows: [QueryRow] = [
      ["id": .number(1), "amount": .number(5)], ["id": .number(2), "amount": .number(5)],
    ]
    let result = try await LocalQueryTransport(schema: s, rows: rows).fetchRows(query: .init())
    XCTAssertEqual(result.rows.first?["id"], .number(2))
    XCTAssertTrue(QueryState().serverQuery(schema: s).orderBy.isEmpty)
    XCTAssertEqual(
      QueryState(orderBy: [.init(field: "amount")]).serverQuery(schema: s).orderBy.count, 1)
  }
  func testOperatorMatrixMatchesTypeScript() {
    XCTAssertEqual(
      FieldDefinition(name: "x", label: "X", type: "enum").filterOperators,
      ["=", "!=", "is_null", "is_not_null"])
    XCTAssertEqual(
      FieldDefinition(name: "x", label: "X", type: "textarray").filterOperators,
      ["includes", "is_null", "is_not_null"])
    XCTAssertEqual(
      FieldDefinition(name: "x", label: "X", type: "text", filter: .init(ops: ["contains"]))
        .filterOperators, ["contains"])
  }

}
