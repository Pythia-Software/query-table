import Foundation

/// An opt-in JSON-over-HTTP transport for the v3 query protocol. The host
/// supplies the endpoint (for example a Go `NewQueryV3Handler`) and the
/// capabilities from its handshake; query-table does not prescribe URL paths.
public struct HTTPQueryTransport: QueryTransport, @unchecked Sendable {
  public enum Failure: Error, LocalizedError {
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
      switch self {
      case .invalidResponse: return "The server returned a non-HTTP response."
      case .httpStatus(let status): return "The query request failed (HTTP \(status))."
      }
    }
  }

  public let endpoint: URL
  public let queryCapabilities: QueryCapabilitiesV3
  private let session: URLSession
  private let prepareRequest: @Sendable (URLRequest) async throws -> URLRequest

  /// Use `prepareRequest` for the host app's authentication or CSRF headers.
  /// Every request is one POST of readable `QueryRequestV3` JSON.
  public init(
    endpoint: URL,
    capabilities: QueryCapabilitiesV3,
    session: URLSession = .shared,
    prepareRequest: @escaping @Sendable (URLRequest) async throws -> URLRequest = { $0 }
  ) {
    self.endpoint = endpoint
    self.queryCapabilities = capabilities
    self.session = session
    self.prepareRequest = prepareRequest
  }

  /// Posts the request and validates the response envelope against it.
  public func fetchQueryV3(_ query: QueryRequestV3) async throws -> QueryResultV3 {
    try Task.checkCancellation()
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(query)
    request = try await prepareRequest(request)
    let (data, response) = try await session.data(for: request)
    try Task.checkCancellation()
    guard let response = response as? HTTPURLResponse else { throw Failure.invalidResponse }
    guard (200..<300).contains(response.statusCode) else {
      throw Failure.httpStatus(response.statusCode)
    }
    let result = try JSONDecoder().decode(QueryResultV3.self, from: data)
    try result.validate(for: query)
    return result
  }
}
