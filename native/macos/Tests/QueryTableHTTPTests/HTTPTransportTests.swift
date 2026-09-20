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
  private func transport() -> HTTPQueryTransport {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return HTTPQueryTransport(
      endpoints: .init(rows: URL(string: "https://example.invalid/rows")!),
      session: URLSession(configuration: configuration),
      prepareRequest: { request in
        var request = request
        request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
        return request
      }
    )
  }

  func testReadableJSONAndAuthentication() async throws {
    StubProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
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
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
      XCTAssertEqual(json["limit"] as? Int, 25)
      XCTAssertNotNil(json["where"])
      XCTAssertNil(json["w"])
      return (200, Data(#"{"rows":[{"id":1,"name":"Native"}],"total":1}"#.utf8))
    }
    let result = try await transport().fetchRows(
      query: ServerQuery(select: ["id", "name"], whereTerms: [], orderBy: [], limit: 25, offset: 0))
    XCTAssertEqual(result.total, 1)
    XCTAssertEqual(result.rows.first?["name"], .string("Native"))
  }

  func testHTTPFailureIsNotDecodedAsRows() async {
    StubProtocol.handler = { _ in (403, Data("private server error details".utf8)) }
    do {
      _ = try await transport().fetchRows(
        query: ServerQuery(select: [], whereTerms: [], orderBy: [], limit: 25, offset: 0))
      XCTFail("Should throw for HTTP 403")
    } catch {
      XCTAssertEqual(error.localizedDescription, "The query request failed (HTTP 403).")
    }
  }

  func testMissingOptionalEndpointIsExplicit() async {
    do {
      _ = try await transport().fetchDistinctValues(
        query: DistinctValuesQuery(field: "name", search: ""))
      XCTFail("Should report missing endpoint")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("autocomplete"))
    }
  }
}
