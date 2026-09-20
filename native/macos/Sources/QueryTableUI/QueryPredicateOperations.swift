import QueryTableCore

/// Shared by native predicate controls and available for host context-menu actions.
public enum QueryPredicateOperations {
  public static let complements: [String: String] = [
    "=": "!=", "!=": "=", ">": "<=", "<=": ">", ">=": "<", "<": ">=", "is_null": "is_not_null",
    "is_not_null": "is_null", "matches_regex": "not_matches_regex",
    "not_matches_regex": "matches_regex",
  ]
  public static let positiveOperators: [String: String] = [
    "!=": "=", "<=": ">", "<": ">=", "is_not_null": "is_null", "not_matches_regex": "matches_regex",
  ]

  /// Prefer the complementary operator. Only unmatched non-nullary operations
  /// use the backend's null-exclusive negation flag.
  public static func negate(_ clause: WhereClause, allowedOps: [String]? = nil) -> WhereClause {
    var next = clause
    if let complement = complements[clause.op], allowedOps?.contains(complement) != false {
      next.op = complement
      next.negated = nil
    } else if clause.op != "is_null" && clause.op != "is_not_null" {
      next.negated = clause.negated == true ? nil : true
    }
    return next
  }

  public static func canNegate(_ clause: WhereClause, allowedOps: [String]) -> Bool {
    guard clause.op == "is_null" || clause.op == "is_not_null" else { return true }
    return complements[clause.op].map { allowedOps.contains($0) } ?? false
  }
}
