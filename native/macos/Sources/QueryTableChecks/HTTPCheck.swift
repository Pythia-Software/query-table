import Foundation
import QueryTableCore

enum HTTPCheck {
  enum Failure: Error { case invalidRequest, incorrectResponse }
  static func run() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CheckProtocol.self]
    let transport = HTTPQueryTransport(
      endpoints: .init(rows: URL(string: "https://example.invalid/rows")!),
      session: URLSession(configuration: config),
      prepareRequest: { request in
        var request = request
        request.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
        return request
      }
    )
    let result = try await transport.fetchRows(query: .init(limit: 5))
    guard result.total == 1, result.rows.first?["id"] == .number(1) else {
      throw Failure.incorrectResponse
    }
    do {
      _ = try await transport.fetchRows(query: .init(limit: 403))
      throw Failure.incorrectResponse
    } catch HTTPQueryTransport.Failure.httpStatus(403) {}
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
      guard let limit = object?["limit"] as? Int, object?["where"] != nil, object?["w"] == nil
      else {
        throw HTTPCheck.Failure.invalidRequest
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: limit == 403 ? 403 : 200, httpVersion: "HTTP/1.1",
        headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(#"{"rows":[{"id":1}],"total":1}"#.utf8))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
