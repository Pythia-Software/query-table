import Foundation
import QueryTableCore

enum HTTPCheck {
  enum Failure: Error { case invalidRequest, incorrectResponse }
  static func run() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CheckProtocol.self]
    let transport = HTTPQueryTransport(
      endpoint: URL(string: "https://example.invalid/query")!,
      capabilities: QueryCapabilitiesV3(profile: "qt-sqlite-v1"),
      session: URLSession(configuration: config),
      prepareRequest: { request in
        var request = request
        request.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
        return request
      }
    )
    func request(limit: Int) -> QueryRequestV3 {
      QueryRequestV3(
        profile: "qt-sqlite-v1", now: 1_772_964_000_000,
        source: ServerQuery(select: ["id"], limit: limit))
    }
    let result = try await transport.fetchQueryV3(request(limit: 5))
    guard result.total == 1, result.rows.first?["id"] == .number(1) else {
      throw Failure.incorrectResponse
    }
    do {
      _ = try await transport.fetchQueryV3(request(limit: 403))
      throw Failure.incorrectResponse
    } catch HTTPQueryTransport.Failure.httpStatus(403) {}
    do {
      _ = try await transport.fetchQueryV3(request(limit: 422))
      throw Failure.incorrectResponse
    } catch QueryTableError.server(let detail, let status) {
      guard status == 422, detail.code == .resourceLimit, detail.field == "k", detail.metricId == "m",
        detail.message == "too many groups"
      else { throw Failure.incorrectResponse }
    }
    do {
      _ = try await transport.fetchQueryV3(request(limit: 409))
      throw Failure.incorrectResponse
    } catch let error as QueryTableError {
      guard error.code == .unknown, error.errorDescription == "later" else { throw Failure.incorrectResponse }
    }
    do {
      _ = try await transport.fetchQueryV3(request(limit: 7))
      throw Failure.incorrectResponse
    } catch QueryTableError.invalidResponse(_) {}
  }
}

private final class CheckProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard request.httpMethod == "POST",
        request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture"
      else {
        throw HTTPCheck.Failure.invalidRequest
      }
      var body = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
          let count = stream.read(&bytes, maxLength: bytes.count)
          if count <= 0 { break }
          body.append(bytes, count: count)
        }
      }
      let object = try JSONSerialization.jsonObject(with: body) as? [String: Any]
      let source = object?["source"] as? [String: Any]
      guard object?["version"] as? Int == 3, let now = object?["now"] as? Int,
        let limit = source?["limit"] as? Int, source?["where"] != nil, source?["w"] == nil,
        object?["rows"] as? Bool == true, object?["diagnostics"] == nil
      else {
        throw HTTPCheck.Failure.invalidRequest
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: limit == 403 ? 403 : limit == 422 || limit == 409 ? limit : 200, httpVersion: "HTTP/1.1",
        headerFields: nil)!
      // limit 7 answers with a mismatched clock, which the transport must reject.
      let echoed = limit == 7 ? now + 1 : now
      // 422 answers with a QueryErrorBody; 409 with a code this build does not know.
      let reply =
        limit == 422
        ? #"{"error":{"code":"resource_limit","message":"too many groups","field":"k","metricId":"m"}}"#
        : limit == 409 ? #"{"error":{"code":"from_the_future","message":"later"}}"# :
        #"{"version":3,"now":"# + String(echoed)
        + #","sourceTotal":1,"rows":[{"id":1}],"total":1,"schema":{"name":"runs","idField":"id","fields":[{"name":"id","type":"number"}]},"metrics":[],"execution":{"profile":"qt-sqlite-v1","planToken":"","resolvedRevisions":null,"fields":null}}"#
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(reply.utf8))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
