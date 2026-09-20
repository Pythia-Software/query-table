import Foundation
import QueryTableCore

enum WireCheck {
  struct Input: Decodable {
    struct Case: Decodable {
      let name: String
      let token: String
    }
    let schema: FieldSchema
    let cases: [Case]
  }
  struct Output: Encodable {
    struct Case: Encodable {
      let name: String
      let token: String
      let serverQuery: ServerQuery
    }
    let cases: [Case]
  }
  static func run(input: String, output: String) throws {
    let fixture = try JSONDecoder().decode(
      Input.self, from: Data(contentsOf: URL(fileURLWithPath: input)))
    let cases = try fixture.cases.map { item -> Output.Case in
      let query = QueryState.decodeToken(item.token)
      return Output.Case(
        name: item.name, token: try query.encodedToken(),
        serverQuery: query.serverQuery(schema: fixture.schema))
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(Output(cases: cases)).write(to: URL(fileURLWithPath: output))
  }
}
