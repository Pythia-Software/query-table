import Foundation

/// An opt-in JSON-over-HTTP transport. Routes are supplied by the host because
/// query-table's transport contract does not prescribe server URL paths.
public struct HTTPQueryTransport: QueryTransport, @unchecked Sendable {
  public struct Endpoints: Sendable {
    public var rows: URL
    public var distinctValues: URL?
    public var aggregations: URL?

    public init(rows: URL, distinctValues: URL? = nil, aggregations: URL? = nil) {
      self.rows = rows
      self.distinctValues = distinctValues
      self.aggregations = aggregations
    }
  }

  public enum Failure: Error, LocalizedError {
    case unavailable(String)
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
      switch self {
      case .unavailable(let feature): return "The server has no \(feature) endpoint configured."
      case .invalidResponse: return "The server returned a non-HTTP response."
      case .httpStatus(let status): return "The query request failed (HTTP \(status))."
      }
    }
  }

  public let endpoints: Endpoints
  private let session: URLSession
  private let prepareRequest: @Sendable (URLRequest) async throws -> URLRequest

  /// Use `prepareRequest` for the host app's authentication or CSRF headers.
  /// Requests use POST with readable ServerQuery JSON, never compact URL tokens.
  public init(
    endpoints: Endpoints,
    session: URLSession = .shared,
    prepareRequest: @escaping @Sendable (URLRequest) async throws -> URLRequest = { $0 }
  ) {
    self.endpoints = endpoints
    self.session = session
    self.prepareRequest = prepareRequest
  }

  public func fetchRows(query: ServerQuery) async throws -> FetchRowsResult {
    try await post(query, to: endpoints.rows)
  }

  public func fetchDistinctValues(query: DistinctValuesQuery) async throws -> DistinctValuesResult {
    guard let url = endpoints.distinctValues else { throw Failure.unavailable("autocomplete") }
    return try await post(query, to: url)
  }

  public func fetchAggregations(query: AggregationRequest) async throws -> AggregationResult {
    guard let url = endpoints.aggregations else { throw Failure.unavailable("aggregation") }
    return try await post(query, to: url)
  }

  private func post<Request: Encodable, Response: Decodable>(_ payload: Request, to url: URL)
    async throws -> Response
  {
    try Task.checkCancellation()
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(payload)
    request = try await prepareRequest(request)
    let (data, response) = try await session.data(for: request)
    try Task.checkCancellation()
    guard let response = response as? HTTPURLResponse else { throw Failure.invalidResponse }
    guard (200..<300).contains(response.statusCode) else {
      throw Failure.httpStatus(response.statusCode)
    }
    return try JSONDecoder().decode(Response.self, from: data)
  }
}
