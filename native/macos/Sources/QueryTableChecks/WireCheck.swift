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
  struct Output: Encodable {
    struct Case: Encodable {
      let name: String
      let token: String
      let request: QueryRequestV3
      let metricsOnly: QueryRequestV3
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
        request: query.queryRequestV3(
          schema: fixture.schema, capabilities: fixture.capabilities, now: now),
        metricsOnly: query.queryRequestV3(
          schema: fixture.schema, capabilities: fixture.capabilities, now: now, rows: false),
        distinct: .distinctValues(
          field: "name", search: "caf", limit: 30, schema: fixture.schema,
          capabilities: fixture.capabilities, now: now))
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(Output(cases: cases)).write(to: URL(fileURLWithPath: output))
  }
}
