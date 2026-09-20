import QueryTableCore
import SwiftUI

/// Bounded native presentations keep large aggregate results responsive.
struct MetricPanel: View {
  let metric: AggregationResultEntry
  let definition: AggregationClause?
  let schema: FieldSchema
  private let bucketLimit = 200
  private var axes: [String] { definition?.groupBy ?? [] }
  private var title: String {
    definition?.label
      ?? [definition?.op, definition?.field.flatMap { schema.field(named: $0)?.label ?? $0 }]
      .compactMap { $0 }.joined(separator: " ")
  }
  private func number(_ value: JSONValue) -> Double? {
    switch value {
    case .number(let value): return value.isFinite ? value : nil
    case .integer(let value): return Double(value)
    default: return nil
    }
  }
  private func display(_ value: JSONValue) -> String {
    if case .number(let number) = value {
      return number.formatted(.number.precision(.fractionLength(0...2)))
    }
    return value == .null ? "—" : value.displayString
  }
  private func label(_ key: String?) -> String { key ?? "NULL" }
  private var ranked: [AggregationBucket] {
    metric.buckets.sorted { a, b in
      if let av = number(a.value), let bv = number(b.value), av != bv { return av > bv }
      let aKey: String = a.keys.first.flatMap { $0 } ?? ""
      let bKey: String = b.keys.first.flatMap { $0 } ?? ""
      return aKey.localizedStandardCompare(bKey) == .orderedAscending
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.caption.bold())
      if metric.buckets.isEmpty {
        Text("No matching groups").foregroundStyle(.secondary)
      } else if axes.isEmpty {
        Text(display(metric.buckets[0].value)).font(.title.monospacedDigit()).textSelection(
          .enabled)
        Text("\(metric.buckets[0].count) matching rows").font(.caption2).foregroundStyle(.secondary)
      } else if axes.count == 1 {
        bars
      } else if axes.count == 2 {
        pivot
      } else {
        flatTable
      }
    }
    .padding(12)
    .frame(width: axes.isEmpty ? 190 : axes.count == 1 ? 340 : 520, alignment: .topLeading)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
  }
  private var bars: some View {
    let buckets = Array(ranked.prefix(bucketLimit))
    let minimum = min(0, buckets.compactMap { number($0.value) }.min() ?? 0)
    let maximum = max(0, buckets.compactMap { number($0.value) }.max() ?? 0)
    let range = max(maximum - minimum, 1)
    return VStack(alignment: .leading, spacing: 4) {
      Text(schema.field(named: axes[0])?.label ?? axes[0]).font(.caption2).foregroundStyle(
        .secondary)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(Array(buckets.enumerated()), id: \.offset) { _, bucket in
            VStack(alignment: .leading, spacing: 3) {
              HStack {
                Text(label(bucket.keys.first ?? nil)).lineLimit(1).help(
                  label(bucket.keys.first ?? nil))
                Spacer()
                Text(display(bucket.value)).monospacedDigit().bold()
                Text("n=\(bucket.count)").foregroundStyle(.secondary)
              }.font(.caption)
              if let value = number(bucket.value) {
                GeometryReader { geometry in
                  let baseline = CGFloat(-minimum / range) * geometry.size.width
                  let endpoint = CGFloat((value - minimum) / range) * geometry.size.width
                  ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.12))
                    Rectangle().fill(.secondary.opacity(0.45)).frame(width: 1).offset(x: baseline)
                    RoundedRectangle(cornerRadius: 2).fill(
                      value < 0 ? Color.orange : Color.accentColor
                    )
                    .frame(width: max(abs(endpoint - baseline), value == 0 ? 0 : 1)).offset(
                      x: min(endpoint, baseline))
                  }
                }.frame(height: 8).accessibilityHidden(true)
              }
            }.accessibilityElement(children: .combine)
          }
        }
      }.frame(height: min(170, CGFloat(buckets.count) * 42))
      if metric.buckets.count > bucketLimit {
        Text("Showing the first \(bucketLimit) ranked groups of \(metric.buckets.count).").font(
          .caption2
        ).foregroundStyle(.secondary)
      }
    }
  }
  private func axisValues(_ index: Int) -> [String?] {
    var seen = Set<String?>()
    return metric.buckets.compactMap { bucket -> [String?]? in
      guard bucket.keys.indices.contains(index), seen.insert(bucket.keys[index]).inserted else {
        return nil
      }
      return [bucket.keys[index]]
    }.flatMap { $0 }.sorted { label($0).localizedStandardCompare(label($1)) == .orderedAscending }
  }
  private var pivot: some View {
    let allRows = axisValues(0)
    let allColumns = axisValues(1)
    let rowValues = Array(allRows.prefix(100))
    let columnValues = Array(allColumns.prefix(20))
    let lookup = Dictionary(
      metric.buckets.filter { $0.keys.count == 2 }.map { ($0.keys, $0) },
      uniquingKeysWith: { first, _ in first })
    return VStack(alignment: .leading, spacing: 4) {
      Text(
        "\(schema.field(named: axes[0])?.label ?? axes[0]) × \(schema.field(named: axes[1])?.label ?? axes[1])"
      ).font(.caption2).foregroundStyle(.secondary)
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
          Section {
            ForEach(Array(rowValues.enumerated()), id: \.offset) { _, row in
              HStack(spacing: 0) {
                Text(label(row)).fontWeight(.medium).frame(width: 120, alignment: .leading).padding(
                  5)
                ForEach(Array(columnValues.enumerated()), id: \.offset) { _, column in
                  let bucket = lookup[[row, column]]
                  Text(bucket.map { display($0.value) } ?? "—")
                    .monospacedDigit().frame(width: 90, alignment: .trailing).padding(5)
                    .background(bucket == nil ? Color.clear : Color.accentColor.opacity(0.06))
                    .help(bucket.map { "\($0.count) matching rows" } ?? "No matching rows")
                }
              }
              Divider()
            }
          } header: {
            HStack(spacing: 0) {
              Text(schema.field(named: axes[0])?.label ?? axes[0]).frame(
                width: 120, alignment: .leading
              ).padding(5)
              ForEach(Array(columnValues.enumerated()), id: \.offset) { _, column in
                Text(label(column)).frame(width: 90, alignment: .trailing).padding(5)
              }
            }.fontWeight(.semibold).background(.background)
          }
        }.font(.caption).textSelection(.enabled)
      }.frame(height: min(170, CGFloat(rowValues.count + 1) * 29))
      if allRows.count > 100 || allColumns.count > 20 {
        Text(
          "Showing \(rowValues.count) of \(allRows.count) rows × \(columnValues.count) of \(allColumns.count) columns."
        ).font(.caption2).foregroundStyle(.secondary)
      }
    }
  }
  private var flatTable: some View {
    let buckets = Array(metric.buckets.prefix(bucketLimit))
    return VStack(alignment: .leading, spacing: 4) {
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
          Section {
            ForEach(Array(buckets.enumerated()), id: \.offset) { _, bucket in
              HStack(spacing: 0) {
                ForEach(Array(axes.enumerated()), id: \.offset) { index, _ in
                  Text(label(bucket.keys.indices.contains(index) ? bucket.keys[index] : nil)).frame(
                    width: 120, alignment: .leading
                  ).padding(5)
                }
                Text(display(bucket.value)).monospacedDigit().frame(width: 90, alignment: .trailing)
                  .padding(5)
                Text("\(bucket.count)").monospacedDigit().frame(width: 70, alignment: .trailing)
                  .padding(5)
              }
              Divider()
            }
          } header: {
            HStack(spacing: 0) {
              ForEach(Array(axes.enumerated()), id: \.offset) { _, name in
                Text(schema.field(named: name)?.label ?? name).frame(
                  width: 120, alignment: .leading
                ).padding(5)
              }
              Text("Value").frame(width: 90, alignment: .trailing).padding(5)
              Text("Rows").frame(width: 70, alignment: .trailing).padding(5)
            }.fontWeight(.semibold).background(.background)
          }
        }.font(.caption).textSelection(.enabled)
      }.frame(height: min(170, CGFloat(buckets.count + 1) * 29))
      if metric.buckets.count > bucketLimit {
        Text("Showing \(bucketLimit) of \(metric.buckets.count) groups.").font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }
}
