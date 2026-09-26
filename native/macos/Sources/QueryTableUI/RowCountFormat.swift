import Foundation

func formatRowCount(_ count: Int, maximumSignificantDigits: Int = 3) -> String {
  if abs(count) < 10_000 {
    return count.formatted(.number.grouping(.automatic))
  }
  let precision = min(4, max(1, maximumSignificantDigits))
  return count.formatted(
    .number.notation(.compactName).precision(.significantDigits(1...precision)))
}

func exactRowCount(_ count: Int) -> String {
  count.formatted(.number.grouping(.automatic))
}
