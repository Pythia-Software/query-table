import Foundation
import JavaScriptCore
import QueryTableCore

public struct FormulaField: Codable, Sendable {
  public var name: String
  public var type: String
  public init(name: String, type: String) {
    self.name = name
    self.type = type
  }
}

/// Wire-compatible with the React computed-column catalogue.
public struct ComputedColumn: Codable, Sendable, Identifiable {
  public struct Expression: Codable, Sendable {
    public var language: String = "qt-expr"
    public var version: Int = 1
    public var source: String
  }
  public var id: String
  public var label: String
  public var expression: Expression
  public var revision: String
  public var fieldName: String { "@computed/" + id }
  public init(id: String, label: String, source: String, revision: String = "local:1") {
    self.id = id
    self.label = label
    self.expression = Expression(source: source)
    self.revision = revision
  }
  public func validate() throws {
    guard id.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil,
      !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf16.count <= 200,
      !revision.isEmpty, revision.utf16.count <= 256,
      expression.language == "qt-expr", expression.version == 1,
      !expression.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      expression.source.utf16.count <= 10_000
    else {
      throw FormulaEngineError.invalidDefinition
    }
  }
}

public struct FormulaPlan: Sendable {
  fileprivate var ast: JSONValue
  public var dependencies: [String]
  public var type: String
}

public struct FormulaResult: Decodable, Sendable {
  public var value: JSONValue
  public var error: String?
}

public enum FormulaEngineError: Error, LocalizedError, Sendable {
  case unavailable, invalidDefinition, limitExceeded
  case diagnostic(String)
  public var errorDescription: String? {
    switch self {
    case .unavailable: return "The bundled formula runtime could not be loaded."
    case .invalidDefinition:
      return "Invalid computed column definition or unsupported formula version."
    case .limitExceeded: return "Formula input exceeds native evaluation limits."
    case .diagnostic(let message): return message
    }
  }
}

/// Evaluates the same qt-expr parser and runtime as React without executing user JavaScript.
/// Work runs off the main actor. Cancellation is checked between bounded rows. Regex
/// operations are rejected because public JavaScriptCore has no execution watchdog.
public actor FormulaEngine {
  private var context: JSContext?
  public init() {}

  public func compile(
    source: String, fields: [FormulaField], definitions: [ComputedColumn] = [],
    editingID: String? = nil
  ) throws -> FormulaPlan {
    try Task.checkCancellation()
    guard source.utf16.count <= 10_000, fields.count <= 10_000, definitions.count <= 1_000 else {
      throw FormulaEngineError.limitExceeded
    }
    for definition in definitions { try definition.validate() }
    guard Set(definitions.map(\.id)).count == definitions.count else {
      throw FormulaEngineError.diagnostic("Duplicate computed column IDs.")
    }
    struct Request: Encodable {
      let action = "compile"
      let source: String
      let fields: [FormulaField]
      let definitions: [ComputedColumn]
      let editingID: String?
    }
    struct Compiled: Decodable {
      let ast: JSONValue
      let dependencies: [String]
      let type: String
    }
    let compiled: Compiled = try invoke(
      Request(source: source, fields: fields, definitions: definitions, editingID: editingID))
    return FormulaPlan(ast: compiled.ast, dependencies: compiled.dependencies, type: compiled.type)
  }

  /// Every row is capped at 1 MB and the batch at 10,000 rows. Dependencies are
  /// projected before encoding, so large unrelated row payloads are never evaluated.
  public func evaluate(plan: FormulaPlan, rows: [QueryRow]) throws -> [FormulaResult] {
    guard rows.count <= 10_000 else { throw FormulaEngineError.limitExceeded }
    struct Plan: Encodable { let ast: JSONValue }
    struct Request: Encodable {
      let action = "evaluate"
      let plan: Plan
      let row: QueryRow
    }
    return try rows.map { row in
      try Task.checkCancellation()
      var inputs: QueryRow = [:]
      for name in plan.dependencies { inputs[name] = row[name] ?? .null }
      return try invoke(Request(plan: Plan(ast: plan.ast), row: inputs))
    }
  }

  private func invoke<Input: Encodable, Output: Decodable>(_ input: Input) throws -> Output {
    let data = try JSONEncoder().encode(input)
    guard data.count <= 1_048_576 else { throw FormulaEngineError.limitExceeded }
    if context == nil {
      guard let url = Bundle.module.url(forResource: "formula-runtime", withExtension: "js"),
        let script = try? String(contentsOf: url, encoding: .utf8),
        let newContext = JSContext()
      else { throw FormulaEngineError.unavailable }
      newContext.evaluateScript(script)
      guard newContext.exception == nil else { throw FormulaEngineError.unavailable }
      context = newContext
    }
    guard let context else { throw FormulaEngineError.unavailable }
    context.exception = nil
    guard
      let result = context.objectForKeyedSubscript("qtFormula")?.call(withArguments: [
        String(decoding: data, as: UTF8.self)
      ]),
      context.exception == nil, let json = result.toString(), let response = json.data(using: .utf8)
    else {
      throw FormulaEngineError.diagnostic(
        context.exception?.toString() ?? "Formula evaluation failed.")
    }
    let envelope = try JSONDecoder().decode(FormulaEnvelope<Output>.self, from: response)
    if let error = envelope.error { throw FormulaEngineError.diagnostic(error) }
    guard let value = envelope.result else { throw FormulaEngineError.unavailable }
    return value
  }
}

private struct FormulaEnvelope<Value: Decodable>: Decodable {
  var result: Value?
  var error: String?
}
