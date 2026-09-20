import QueryTableCore
import XCTest

@testable import QueryTableFormula

final class FormulaTests: XCTestCase {
  func testTypedArithmeticAndNullPropagation() async throws {
    let engine = FormulaEngine()
    let plan = try await engine.compile(
      source: "[price] * 2", fields: [.init(name: "price", type: "number")])
    XCTAssertEqual(plan.dependencies, ["price"])
    XCTAssertEqual(plan.type, "number")
    let results = try await engine.evaluate(
      plan: plan, rows: [["price": .number(12)], [:], ["price": .string("bad")]])
    XCTAssertEqual(results[0].value, .number(24))
    XCTAssertEqual(results[1].value, .null)
    XCTAssertNotNil(results[2].error)
  }

  func testNestedComputedDependenciesAndCycles() async throws {
    let engine = FormulaEngine()
    let definitions = [ComputedColumn(id: "double", label: "Double", source: "[price] * 2")]
    let plan = try await engine.compile(
      source: "[@computed/double] + 1", fields: [.init(name: "price", type: "number")],
      definitions: definitions)
    XCTAssertEqual(plan.dependencies, ["price"])
    let result = try await engine.evaluate(plan: plan, rows: [["price": .number(3)]])
    XCTAssertEqual(result[0].value, .number(7))
    do {
      _ = try await engine.compile(
        source: "[@computed/loop]", fields: [],
        definitions: [.init(id: "loop", label: "Loop", source: "[@computed/loop]")])
      XCTFail("Cycle should fail")
    } catch { XCTAssertTrue(error.localizedDescription.contains("Circular")) }
  }

  func testRegexRejectedAndUserJavaScriptNeverExecuted() async throws {
    let engine = FormulaEngine()
    for source in ["REGEX_TEST(\"a\", \"a\")", "globalThis.foo = 1"] {
      do {
        _ = try await engine.compile(source: source, fields: [])
        XCTFail("Unsafe or unsupported input should fail")
      } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
    }
  }

  func testUnicodeAndDateSemantics() async throws {
    let engine = FormulaEngine()
    let plan = try await engine.compile(
      source: "LEFT([text], 1)", fields: [.init(name: "text", type: "text")])
    let result = try await engine.evaluate(plan: plan, rows: [["text": .string("😀hello")]])
    XCTAssertEqual(result[0].value, .string("😀"))
  }

  func testDefinitionValidationAndWireShape() throws {
    let definition = ComputedColumn(id: "tax", label: "Tax", source: "[price] * 0.1")
    try definition.validate()
    let data = try JSONEncoder().encode(definition)
    let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let expression = try XCTUnwrap(raw["expression"] as? [String: Any])
    XCTAssertEqual(expression["language"] as? String, "qt-expr")
    XCTAssertEqual(expression["version"] as? Int, 1)
    XCTAssertThrowsError(try ComputedColumn(id: "bad id", label: "Label", source: "1").validate())
  }

  func testJoinAllocationIsBoundedBeforeBuildingResult() async throws {
    let engine = FormulaEngine()
    let plan = try await engine.compile(
      source: "JOIN([items], [separator])",
      fields: [.init(name: "items", type: "textarray"), .init(name: "separator", type: "text")])
    let results = try await engine.evaluate(
      plan: plan,
      rows: [
        [
          "items": .array(Array(repeating: .string("a"), count: 10_000)),
          "separator": .string(String(repeating: "x", count: 100_000)),
        ]
      ])
    XCTAssertEqual(results[0].value, .null)
    XCTAssertTrue(results[0].error?.contains("100,000") == true)
  }
}
