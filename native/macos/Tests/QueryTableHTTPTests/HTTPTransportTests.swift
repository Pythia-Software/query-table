import XCTest

@testable import QueryTableCore

private final class StubProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (Int, Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (status, data) = try Self.handler!(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

final class HTTPTransportTests: XCTestCase {
  private let capabilities = QueryCapabilitiesV3(profile: "qt-postgres-v1")
  private func transport() -> HTTPQueryTransport {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return HTTPQueryTransport(
      endpoint: URL(string: "https://example.invalid/query")!,
      capabilities: capabilities,
      session: URLSession(configuration: configuration),
      prepareRequest: { request in
        var request = request
        request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
        return request
      }
    )
  }
  private func body(_ request: URLRequest) -> Data {
    var body = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 1024)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        body.append(buffer, count: count)
      }
    }
    return body
  }
  private func response(
    now: Int64, rows: String = #"[{"id":1,"name":"Native"}]"#, total: Int = 1,
    profile: String = "qt-postgres-v1", extra: String = ""
  ) -> Data {
    Data(
      (#"{"version":3,"now":"# + String(now) + #","sourceTotal":"# + String(total)
        + #","rows":"# + rows + #","total":"# + String(total)
        + #","schema":{"name":"items","idField":"id","fields":[{"name":"id","type":"number"},{"name":"name","type":"text"}]},"metrics":[],"execution":{"profile":""#
        + profile + #"","planToken":"","resolvedRevisions":{},"fields":{}}"# + extra + "}").utf8)
  }
  private let request = QueryRequestV3(
    profile: "qt-postgres-v1", now: 1_772_964_000_000,
    source: ServerQuery(select: ["id", "name"], limit: 25))

  func testReadableV3JSONAndAuthentication() async throws {
    StubProtocol.handler = { [self] request in
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.url?.path, "/query")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
      let json = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body(request)) as? [String: Any])
      XCTAssertEqual(json["version"] as? Int, 3)
      XCTAssertEqual(json["profile"] as? String, "qt-postgres-v1")
      XCTAssertEqual(json["now"] as? Int, 1_772_964_000_000)
      XCTAssertNil(json["planToken"])
      XCTAssertNil(json["distinct"])
      let source = try XCTUnwrap(json["source"] as? [String: Any])
      XCTAssertEqual(source["limit"] as? Int, 25)
      XCTAssertNotNil(source["where"])
      XCTAssertNil(source["w"])
      return (200, response(now: 1_772_964_000_000))
    }
    let result = try await transport().fetchQueryV3(request)
    XCTAssertEqual(result.total, 1)
    XCTAssertEqual(result.rows.first?["name"], .string("Native"))
  }

  func testDistinctSection() async throws {
    let schema = FieldSchema(
      name: "items", idField: "id",
      fields: [.init(name: "id", label: "ID", type: "number"), .init(name: "name", label: "Name", type: "text")])
    let distinct = QueryRequestV3.distinctValues(
      field: "name", search: "na", limit: 30, schema: schema, capabilities: capabilities,
      now: Date(timeIntervalSince1970: 1_772_964_000))
    StubProtocol.handler = { [self] request in
      let json = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body(request)) as? [String: Any])
      XCTAssertEqual(json["rows"] as? Bool, false)
      XCTAssertEqual((json["metrics"] as? [Any])?.count, 0)
      let section = try XCTUnwrap(json["distinct"] as? [String: Any])
      XCTAssertEqual(section["field"] as? String, "name")
      XCTAssertEqual(section["search"] as? String, "na")
      XCTAssertEqual(section["limit"] as? Int, 30)
      return (
        200,
        response(
          now: 1_772_964_000_000, rows: "[]", total: 0,
          extra: #","distinct":{"values":["Native"],"hasMore":false,"hasNull":true}"#)
      )
    }
    let result = try await transport().fetchQueryV3(distinct)
    XCTAssertEqual(result.distinct, DistinctResultV3(values: ["Native"], hasNull: true))
  }

  func testMismatchedResponsesAreRejected() async {
    for reply in [
      response(now: 1),
      response(now: 1_772_964_000_000, profile: "qt-sqlite-v1"),
      response(now: 1_772_964_000_000, total: -1),
      response(now: 1_772_964_000_000, rows: #"[{"id":1},{"id":1}]"#, total: 2),
    ] {
      StubProtocol.handler = { _ in (200, reply) }
      do {
        _ = try await transport().fetchQueryV3(request)
        XCTFail("Should reject a mismatched response")
      } catch {}
    }
  }

  func testHTTPFailureIsNotDecodedAsRows() async {
    StubProtocol.handler = { _ in (403, Data("private server error details".utf8)) }
    do {
      _ = try await transport().fetchQueryV3(request)
      XCTFail("Should throw for HTTP 403")
    } catch {
      XCTAssertEqual(error.localizedDescription, "The query request failed (HTTP 403).")
    }
  }
}
