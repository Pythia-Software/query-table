import Foundation
import QueryTableCore

enum WireCheck {
  struct Input: Decodable {
    struct Case: Decodable {
      let name: String
      let token: String
    }
    let schema: FieldSchema
    let capabilities: QueryCapabilitiesV3
    let now: Int64
    let cases: [Case]
  }
  /// A request, or the client-side refusal that replaced it.
  enum Built: Encodable {
    case request(QueryRequestV3)
    case refused(ErrorCode, String)
    init(_ build: () throws -> QueryRequestV3) throws {
      do { self = .request(try build()) } catch QueryTableError.refused(let code, let message) {
        self = .refused(code, message)
      }
    }
    func encode(to encoder: Encoder) throws {
      switch self {
      case .request(let request): try request.encode(to: encoder)
      case .refused(let code, let message):
        try ["refused": ["code": code.rawValue, "message": message]].encode(to: encoder)
      }
    }
  }
  struct Output: Encodable {
    struct Case: Encodable {
      let name: String
      let token: String
      let request: Built
      let metricsOnly: Built
      let distinct: QueryRequestV3
    }
    let cases: [Case]
  }
  static func run(input: String, output: String) throws {
    let fixture = try JSONDecoder().decode(
      Input.self, from: Data(contentsOf: URL(fileURLWithPath: input)))
    let now = Date(timeIntervalSince1970: Double(fixture.now) / 1000)
    let cases = try fixture.cases.map { item -> Output.Case in
      let query = QueryState.decodeToken(item.token)
      return Output.Case(
        name: item.name, token: try query.encodedToken(),
        request: try Built {
          try query.queryRequestV3(schema: fixture.schema, capabilities: fixture.capabilities, now: now)
        },
        metricsOnly: try Built {
          try query.queryRequestV3(
            schema: fixture.schema, capabilities: fixture.capabilities, now: now, rows: false)
        },
        distinct: .distinctValues(
          field: "name", search: "caf", limit: 30, schema: fixture.schema,
          capabilities: fixture.capabilities, now: now))
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(Output(cases: cases)).write(to: URL(fileURLWithPath: output))
  }
}
