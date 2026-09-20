import QueryTableCore
import QueryTableFormula
import SwiftUI

public struct ComputedPreviewGroup: Identifiable {
  public let id: JSONValue
  public let inputs: [JSONValue]
  public let result: FormulaResult
  public var count: Int
}
public struct ComputedPreview {
  public let dependencies: [String]
  public let groups: [ComputedPreviewGroup]
  public let sampled: Int
  public let total: Int
  public let nulls: Int
  public let errors: Int
}

/// Local catalogue with optional persistence. Applications can import/export its
/// wire-compatible definitions to connect their own authorized catalogue service.
@MainActor
public final class ComputedColumnController: ObservableObject {
  @Published public private(set) var definitions: [ComputedColumn] = []
  public private(set) var catalogueVersion: UInt64 = 0
  public let schema: FieldSchema
  private let engine = FormulaEngine()
  private let persistence: UserDefaults?
  private var key: String { "query-table.native.\(schema.name).computed" }
  public var labels: [String: String] {
    Dictionary(uniqueKeysWithValues: definitions.map { ($0.fieldName, $0.label) })
  }
  private var fields: [FormulaField] {
    schema.fields.filter { $0.isSelectable && $0.source.kind == "backend" }.map {
      FormulaField(name: $0.name, type: $0.type)
    }
  }
  public init(schema: FieldSchema, persistence: UserDefaults? = nil) {
    self.schema = schema
    self.persistence = persistence
    if let data = persistence?.data(forKey: "query-table.native.\(schema.name).computed"),
      data.count <= 12_000_000,
      let definitions = try? JSONDecoder().decode([ComputedColumn].self, from: data),
      definitions.count <= 1_000, Set(definitions.map(\.id)).count == definitions.count,
      definitions.allSatisfy({ (try? $0.validate()) != nil })
    {
      self.definitions = definitions
    }
  }
  public func compile(source: String, editingID: String? = nil) async throws -> FormulaPlan {
    let version = catalogueVersion
    let plan = try await engine.compile(
      source: source, fields: fields, definitions: definitions, editingID: editingID)
    try requireCurrent(version)
    return plan
  }
  public func exportCatalogue() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try encoder.encode(definitions)
  }
  public func importCatalogue(_ data: Data) throws {
    guard data.count <= 12_000_000 else { throw FormulaEngineError.limitExceeded }
    let columns = try JSONDecoder().decode([ComputedColumn].self, from: data)
    guard columns.count <= 1_000, Set(columns.map(\.id)).count == columns.count else {
      throw FormulaEngineError.invalidDefinition
    }
    for column in columns { try column.validate() }
    try replaceCatalogue(columns)
  }
  public func save(
    id: String? = nil, label: String, source: String, expectedRevision: String? = nil
  ) async throws -> ComputedColumn {
    let current = definitions.first { $0.id == id }
    guard current != nil || definitions.count < 1_000 else {
      throw FormulaEngineError.limitExceeded
    }
    guard current?.revision == expectedRevision else {
      throw FormulaEngineError.diagnostic("This definition changed. Reload it before saving again.")
    }
    let column = ComputedColumn(
      id: id ?? UUID().uuidString, label: label, source: source, revision: UUID().uuidString)
    try column.validate()
    _ = try await compile(source: source, editingID: column.id)
    // Actor suspension may allow a competing edit while compilation runs.
    guard definitions.first(where: { $0.id == column.id })?.revision == expectedRevision else {
      throw FormulaEngineError.diagnostic("This definition changed. Reload it before saving again.")
    }
    guard current != nil || definitions.count < 1_000 else {
      throw FormulaEngineError.limitExceeded
    }
    try replaceCatalogue(definitions.filter { $0.id != column.id } + [column])
    return column
  }
  private func replaceCatalogue(_ columns: [ComputedColumn]) throws {
    let data = try JSONEncoder().encode(columns)
    catalogueVersion &+= 1
    definitions = columns
    persistence?.set(data, forKey: key)
  }
  private func requireCurrent(_ version: UInt64) throws {
    try Task.checkCancellation()
    guard version == catalogueVersion else { throw CancellationError() }
  }
  public func dependencies(for selected: [SelectColumn]) async throws -> [String] {
    let version = catalogueVersion
    try requireCurrent(version)
    var dependencies = Set<String>()
    for column in definitions where selected.contains(where: { $0.field == column.fieldName }) {
      try Task.checkCancellation()
      // Unavailable definitions produce individual error cells, not a failed fetch.
      do {
        dependencies.formUnion(
          try await compile(source: column.expression.source, editingID: column.id).dependencies)
      } catch is CancellationError { throw CancellationError() } catch { continue }
    }
    try requireCurrent(version)
    return dependencies.sorted()
  }
  public func preview(source: String, editingID: String? = nil, rows: [QueryRow]) async throws
    -> [FormulaResult]
  {
    let version = catalogueVersion
    let plan = try await compile(source: source, editingID: editingID)
    let results = try await engine.evaluate(
      plan: plan, rows: inputs(rows, dependencies: plan.dependencies))
    try requireCurrent(version)
    return results
  }
  public func sample(
    source: String, editingID: String? = nil, count: Int,
    sampler: ([String], Int) async throws -> FetchRowsResult
  ) async throws -> ComputedPreview {
    let version = catalogueVersion
    let plan = try await compile(source: source, editingID: editingID)
    let response = try await sampler(plan.dependencies, max(1, min(10_000, count)))
    try requireCurrent(version)
    let sampleRows = Array(response.rows.prefix(max(1, min(10_000, count))))
    let inputRows = inputs(sampleRows, dependencies: plan.dependencies)
    let results = try await engine.evaluate(plan: plan, rows: inputRows)
    try requireCurrent(version)
    var groups: [JSONValue: ComputedPreviewGroup] = [:]
    var nulls = 0
    var errors = 0
    for (i, result) in results.enumerated() {
      let values = plan.dependencies.map { inputRows[i][$0] ?? .null }
      let key = JSONValue.array([
        .array(values), result.value, result.error.map(JSONValue.string) ?? .null,
      ])
      if groups[key] != nil {
        groups[key]?.count += 1
      } else {
        groups[key] = ComputedPreviewGroup(id: key, inputs: values, result: result, count: 1)
      }
      if result.error != nil { errors += 1 } else if result.value == .null { nulls += 1 }
    }
    return ComputedPreview(
      dependencies: plan.dependencies, groups: groups.values.sorted { $0.count > $1.count },
      sampled: results.count, total: response.total, nulls: nulls, errors: errors)
  }
  private func inputs(_ rows: [QueryRow], dependencies: [String]) -> [QueryRow] {
    let required = Set(dependencies)
    let fields = schema.fields.filter {
      required.contains($0.name) && $0.isSelectable && $0.source.kind == "backend"
    }
    return rows.map { row in
      Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0.value(in: row)) })
    }
  }
  public func evaluate(
    rows: [QueryRow], selected: [SelectColumn], expectedCatalogueVersion: UInt64? = nil
  ) async throws -> [QueryRow] {
    let version = expectedCatalogueVersion ?? catalogueVersion
    try requireCurrent(version)
    var output = rows
    for selectedColumn in selected where selectedColumn.field.hasPrefix("@computed/") {
      try Task.checkCancellation()
      do {
        guard let column = definitions.first(where: { $0.fieldName == selectedColumn.field }) else {
          throw FormulaEngineError.diagnostic("Computed column unavailable.")
        }
        let plan = try await compile(source: column.expression.source, editingID: column.id)
        let results = try await engine.evaluate(
          plan: plan, rows: inputs(rows, dependencies: plan.dependencies))
        try requireCurrent(version)
        for i in output.indices {
          output[i][selectedColumn.field] =
            results[i].error.map { .object(["computedError": .string($0)]) } ?? results[i].value
        }
      } catch is CancellationError { throw CancellationError() } catch {
        for i in output.indices {
          output[i][selectedColumn.field] = .object([
            "computedError": .string(error.localizedDescription)
          ])
        }
      }
    }
    return output
  }
}

public struct ComputedColumnEditor: View {
  @ObservedObject private var store: ComputedColumnController
  private let onSave: (ComputedColumn) -> Void
  private let rows: [QueryRow]
  private let sampler: (([String], Int) async throws -> FetchRowsResult)?
  @Environment(\.dismiss) private var dismiss
  @State private var editingID: String?
  @State private var revision: String?
  @State private var label = ""
  @State private var source = ""
  @State private var diagnostic = ""
  @State private var preview: ComputedPreview?
  @State private var sampleCount = 100
  @State private var previewTask: Task<Void, Never>?
  @State private var saveTask: Task<Void, Never>?
  @State private var busy = false
  public init(
    store: ComputedColumnController, rows: [QueryRow] = [],
    sample: (([String], Int) async throws -> FetchRowsResult)? = nil,
    onSave: @escaping (ComputedColumn) -> Void
  ) {
    self.store = store
    self.rows = rows
    self.sampler = sample
    self.onSave = onSave
  }
  public var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Computed column").font(.title2.bold())
      Picker("Definition", selection: $editingID) {
        Text("New column").tag(String?.none)
        ForEach(store.definitions) { Text($0.label).tag(Optional($0.id)) }
      }.disabled(busy).onChange(of: editingID) { _, id in
        let column = store.definitions.first { $0.id == id }
        previewTask?.cancel()
        label = column?.label ?? ""
        source = column?.expression.source ?? ""
        revision = column?.revision
        preview = nil
        diagnostic = ""
      }
      TextField("Column name", text: $label).disabled(busy)
      Text("Formula · qt-expr").font(.headline)
      TextEditor(text: $source).font(.system(.body, design: .monospaced)).frame(minHeight: 100)
        .border(.quaternary)
        .accessibilityLabel("Formula expression")
        .onChange(of: source) { _, _ in
          previewTask?.cancel()
          preview = nil
        }
        .disabled(busy)
      Menu("Insert field") {
        ForEach(store.schema.fields.filter { $0.isSelectable && $0.source.kind == "backend" }) {
          field in
          Button(field.label) {
            source += "[" + field.name.replacingOccurrences(of: "]", with: "]]") + "]"
          }
        }
        ForEach(store.definitions.filter { $0.id != editingID }) { column in
          Button(column.label) { source += "[\(column.fieldName)]" }
        }
      }.disabled(busy)
      Text("Examples: [amount] * 1.2 · UPPER([name]) · IF([active], \"Yes\", \"No\")").font(
        .caption
      ).foregroundStyle(.secondary)
      Text("Regex functions are unavailable in the native evaluator.").font(.caption)
        .foregroundStyle(.secondary)
      HStack {
        Text("Sample rows")
        TextField("Sample rows", value: $sampleCount, format: .number.grouping(.never)).frame(
          width: 90
        ).disabled(busy)
        Text(
          sampler == nil
            ? "From loaded rows" : "First matching rows, independent of the current page"
        ).font(.caption).foregroundStyle(.secondary)
      }
      if !diagnostic.isEmpty {
        Text(diagnostic).font(.callout).foregroundStyle(.red).textSelection(.enabled)
      }
      if let preview {
        Text(
          "Sampled \(preview.sampled) of \(preview.total) matching rows · \(preview.nulls) null · \(preview.errors) errors"
        ).font(.caption)
        Text(
          "Inputs: "
            + (preview.dependencies.isEmpty
              ? "constant expression" : preview.dependencies.joined(separator: ", "))
        ).font(.caption).foregroundStyle(.secondary)
        ScrollView {
          VStack(alignment: .leading, spacing: 5) {
            ForEach(preview.groups.prefix(200)) { group in
              HStack(alignment: .top) {
                Text("\(group.count)×").frame(width: 45, alignment: .trailing).foregroundStyle(
                  .secondary)
                Text(
                  group.inputs.map { $0 == .null ? "null" : $0.displayString }.joined(
                    separator: " · ")
                ).frame(maxWidth: .infinity, alignment: .leading)
                Text(
                  group.result.error
                    ?? (group.result.value == .null ? "null" : group.result.value.displayString)
                ).foregroundStyle(group.result.error == nil ? Color.primary : Color.red).frame(
                  maxWidth: .infinity, alignment: .leading)
              }.font(.system(.caption, design: .monospaced))
            }
            if preview.groups.count > 200 {
              Text("Showing the 200 most frequent groups.").font(.caption).foregroundStyle(
                .secondary)
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: 180)
      }
      HStack {
        Button("Cancel") {
          previewTask?.cancel()
          saveTask?.cancel()
          dismiss()
        }.keyboardShortcut(.cancelAction)
        Spacer()
        if busy { Button("Stop preview") { previewTask?.cancel() }.disabled(previewTask == nil) }
        Button("Validate & Preview") {
          busy = true
          diagnostic = ""
          previewTask?.cancel()
          sampleCount = max(1, min(10_000, sampleCount))
          previewTask = Task { @MainActor in
            defer {
              busy = false
              previewTask = nil
            }
            do {
              let fetch =
                sampler ?? { _, count in
                  FetchRowsResult(rows: Array(rows.prefix(count)), total: rows.count)
                }
              let result = try await store.sample(
                source: source, editingID: editingID, count: sampleCount, sampler: fetch)
              try Task.checkCancellation()
              preview = result
            } catch is CancellationError { diagnostic = "Preview cancelled." } catch {
              diagnostic = error.localizedDescription
              preview = nil
            }
          }
        }.disabled(busy)
        Button("Save column") {
          busy = true
          diagnostic = ""
          saveTask = Task { @MainActor in
            defer {
              busy = false
              saveTask = nil
            }
            do {
              let column = try await store.save(
                id: editingID, label: label, source: source, expectedRevision: revision)
              onSave(column)
              dismiss()
            } catch { diagnostic = error.localizedDescription }
          }
        }.keyboardShortcut(.defaultAction).disabled(
          busy || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || source.isEmpty)
      }
    }.padding(24).frame(width: 650)
      .onReceive(store.$definitions.dropFirst()) { _ in
        previewTask?.cancel()
        preview = nil
      }
      .onDisappear {
        previewTask?.cancel()
        saveTask?.cancel()
      }
  }
}
