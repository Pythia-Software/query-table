import Foundation
import QueryTableCore

/// Shorthand v3 requests for the executable checks.
extension QueryTransport {
  func rows(_ stage: ServerQuery, now: Date = Date()) async throws -> QueryResultV3 {
    try await fetchQueryV3(
      QueryRequestV3(
        profile: queryCapabilities.profile, now: QueryRequestV3.epochMilliseconds(now),
        source: stage))
  }
  func metrics(
    _ metrics: [AggregationClause], whereTerms: [WhereTerm] = [], now: Date = Date()
  ) async throws -> [AggregationResultEntry] {
    try await fetchQueryV3(
      QueryRequestV3(
        profile: queryCapabilities.profile, now: QueryRequestV3.epochMilliseconds(now),
        source: ServerQuery(whereTerms: whereTerms), rows: false, metrics: metrics)
    ).metrics
  }
}
