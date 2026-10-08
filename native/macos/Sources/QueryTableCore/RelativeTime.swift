import Foundation

/// Local mirror of the server's signed elapsed duration coercion.
public enum RelativeTime {
  public static let maximumDurationMilliseconds: Int64 = 8_640_000_000_000_000

  /// Returns the signed sum in milliseconds, or nil for unsupported syntax.
  public static func parseDuration(_ value: String) -> Int64? {
    let pattern = #"^[+-](?:[0-9]+(?:ms|s|m|h|d|w))+$"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
      match.range.length == value.utf16.count,
      let components = try? NSRegularExpression(pattern: #"([0-9]+)(ms|s|m|h|d|w)"#)
    else { return nil }
    let units: [String: Int64] = ["ms": 1, "s": 1000, "m": 60000, "h": 3600000, "d": 86400000, "w": 604800000]
    var total: Int64 = 0
    for part in components.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
      guard let amountRange = Range(part.range(at: 1), in: value),
        let unitRange = Range(part.range(at: 2), in: value),
        let amount = UInt64(value[amountRange]), let unit = units[String(value[unitRange])],
        amount <= UInt64((maximumDurationMilliseconds - total) / unit)
      else { return nil }
      total += Int64(amount) * unit
    }
    return value.first == "-" ? -total : total
  }

  static func timestamp(_ now: Date, offset: Int64) throws -> Date {
    let milliseconds = now.timeIntervalSince1970 * 1000 + Double(offset)
    guard milliseconds.isFinite, abs(milliseconds) <= Double(maximumDurationMilliseconds) else {
      throw QueryTableError.invalidQuery("Relative time exceeds datetime limits")
    }
    return now.addingTimeInterval(Double(offset) / 1000)
  }

  static func absoluteDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) { return date }
    let date = ISO8601DateFormatter()
    date.formatOptions = [.withFullDate]
    return date.date(from: value)
  }
}
