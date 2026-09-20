import AppKit
import Combine
import QueryTableCore

public struct SavedQuerySnapshot: Codable, Identifiable {
  public let id: UUID
  public var name: String
  public var query: QueryState
}

/// Owns one table's interaction state. Persistence is opt-in and namespaced by schema.
@MainActor
public final class QueryTableController: ObservableObject {
  public let schema: FieldSchema
  public let adapter: any QueryTransport
  public let computedColumns: ComputedColumnController
  @Published public private(set) var query: QueryState
  @Published public private(set) var rows: [QueryRow] = []
  @Published public private(set) var total = 0
  @Published public private(set) var isLoading = false
  @Published public var error: String?
  @Published public var selectedIDs: Set<String> = []
  @Published public private(set) var savedQueries: [SavedQuerySnapshot] = []
  @Published public private(set) var defaultSavedID: UUID?
  @Published public private(set) var canUndo = false
  @Published public private(set) var canRedo = false
  @Published public private(set) var metrics: [AggregationResultEntry] = []
  @Published public private(set) var metricError: String?
  private var metricTask: Task<Void, Never>?
  private var catalogueSubscription: AnyCancellable?
  private var history: [QueryState] = []
  private var future: [QueryState] = []
  private var task: Task<Void, Never>?
  private var refreshTimer: Task<Void, Never>?
  private var generation = 0
  private let persistence: UserDefaults?
  private var storageKey: String { "query-table.native.\(schema.name)" }

  public init(
    schema: FieldSchema, adapter: any QueryTransport, initialQuery: QueryState? = nil,
    persistence: UserDefaults? = nil
  ) {
    self.schema = schema
    self.adapter = adapter
    self.persistence = persistence
    self.computedColumns = ComputedColumnController(schema: schema, persistence: persistence)
    self.query = (initialQuery ?? QueryState(limit: schema.defaultLimit ?? 100)).normalized()
    if let data = persistence?.data(forKey: "query-table.native.\(schema.name).saved"),
      let snapshots = try? JSONDecoder().decode([SavedQuerySnapshot].self, from: data)
    {
      self.savedQueries = Array(snapshots.prefix(100))
    }
    if let value = persistence?.string(forKey: "query-table.native.\(schema.name).default"),
      let id = UUID(uuidString: value), savedQueries.contains(where: { $0.id == id })
    {
      defaultSavedID = id
    }
    if initialQuery == nil {
      if let saved = savedQueries.first(where: { $0.id == defaultSavedID }) {
        query = saved.query.normalized()
      } else if let data = persistence?.data(forKey: "query-table.native.\(schema.name).last"),
        let last = try? JSONDecoder().decode(QueryState.self, from: data)
      {
        query = last.normalized()
      }
    }
    catalogueSubscription = computedColumns.$definitions.dropFirst().receive(on: RunLoop.main).sink
    { [weak self] _ in self?.refresh(debounce: true) }
  }

  public var effectiveSort: [OrderByClause] {
    query.orderBy.isEmpty ? schema.defaultSort ?? [] : query.orderBy
  }

  public var visibleColumns: [SelectColumn] {
    let candidates: [SelectColumn]
    if !query.select.isEmpty {
      candidates = query.select
    } else if let defaults = schema.defaultSelect {
      candidates = defaults
    } else {
      let defaults = schema.fields.filter { $0.isSelectable && $0.select?.default == true }
      candidates = (defaults.isEmpty ? schema.fields.filter(\.isSelectable) : defaults).map {
        SelectColumn(field: $0.name, width: $0.select?.width)
      }
    }
    var seen = Set<String>()
    return candidates.compactMap { column in
      if column.field.hasPrefix("@computed/") {
        return seen.insert(column.field).inserted ? column : nil
      }
      guard let field = schema.field(named: column.field), field.isSelectable,
        seen.insert(field.name).inserted
      else { return nil }
      return SelectColumn(field: field.name, width: column.width)
    }
  }

  public func setQuery(_ next: QueryState, resetOffset: Bool = false, fetch: Bool = true) {
    var next = next.normalized()
    next.limit = max(1, next.limit)
    next.offset = max(0, next.offset)
    if resetOffset { next.offset = 0 }
    guard next != query else { return }
    history.append(query)
    if history.count > 100 { history.removeFirst() }
    future.removeAll()
    query = next
    updateHistory()
    if fetch { refresh(debounce: true) }
  }

  public func edit(resetOffset: Bool = true, _ change: (inout QueryState) -> Void) {
    var next = query
    change(&next)
    setQuery(next, resetOffset: resetOffset)
  }

  public func undo() {
    guard let previous = history.popLast() else { return }
    future.append(query)
    query = previous
    updateHistory()
    refresh()
  }
  public func redo() {
    guard let next = future.popLast() else { return }
    history.append(query)
    query = next
    updateHistory()
    refresh()
  }
  private func updateHistory() {
    canUndo = !history.isEmpty
    canRedo = !future.isEmpty
    if let data = try? JSONEncoder().encode(query) {
      persistence?.set(data, forKey: storageKey + ".last")
    }
  }

  public func refresh(debounce: Bool = false) {
    task?.cancel()
    generation += 1
    let ticket = generation
    let snapshot = query
    let columns = visibleColumns
    let catalogueVersion = computedColumns.catalogueVersion
    let adapter = self.adapter
    let schema = self.schema
    let computed = computedColumns
    isLoading = true
    error = nil
    task = Task { [weak self] in
      do {
        if debounce { try await Task.sleep(nanoseconds: 250_000_000) }
        guard
          snapshot.whereTerms.allSatisfy({
            $0.predicates.allSatisfy { schema.field(named: $0.field)?.isPushdownFilter == true }
          })
        else {
          throw QueryTableError.unsupported(
            "This query includes a filter that cannot run on the backend. Native tables currently require backend filters to preserve accurate totals and pagination."
          )
        }
        var server = snapshot.serverQuery(schema: schema)
        let dependencies = try await computed.dependencies(for: columns)
        server.select = Array(Set(server.select + dependencies)).sorted()
        let result = try await adapter.fetchRows(query: server)
        guard
          result.rows.allSatisfy({ row in
            let value =
              schema.field(named: schema.idField)?.value(in: row) ?? row[schema.idField] ?? .null
            switch value {
            case .string, .number, .integer: return true
            default: return false
            }
          })
        else {
          throw QueryTableError.invalidQuery(
            "Every row must provide a stable string or number identifier in \(schema.idField).")
        }
        let evaluated = try await computed.evaluate(
          rows: result.rows, selected: columns, expectedCatalogueVersion: catalogueVersion)
        try Task.checkCancellation()
        guard let self, ticket == self.generation else { return }
        self.rows = evaluated
        self.total = result.total
        self.isLoading = false
      } catch is CancellationError {
        // A newer request owns loading state.
      } catch {
        guard let self, ticket == self.generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
        self.isLoading = false
      }
    }
    metricTask?.cancel()
    metricError = nil
    metrics = []
    guard !snapshot.aggregations.isEmpty else { return }
    guard
      snapshot.whereTerms.allSatisfy({
        $0.predicates.allSatisfy { schema.field(named: $0.field)?.isPushdownFilter == true }
      })
    else {
      metricError = "Metrics require all filters to run on the backend."
      return
    }
    metricTask = Task { [weak self] in
      do {
        if debounce { try await Task.sleep(nanoseconds: 250_000_000) }
        let result = try await adapter.fetchAggregations(
          query: snapshot.aggregationQuery(schema: schema))
        guard let self, ticket == self.generation, !Task.isCancelled else { return }
        self.metrics = result.metrics
      } catch {
        guard let self, ticket == self.generation, !Task.isCancelled else { return }
        self.metricError = error.localizedDescription
      }
    }
  }

  public func cancel() {
    task?.cancel()
    metricTask?.cancel()
    refreshTimer?.cancel()
    generation += 1
    isLoading = false
  }

  /// Fetches an independent bounded sample with every formula input projected.
  public func sampleRows(dependencies: [String], count: Int) async throws -> FetchRowsResult {
    let snapshot = query
    guard
      snapshot.whereTerms.allSatisfy({
        $0.predicates.allSatisfy { schema.field(named: $0.field)?.isPushdownFilter == true }
      })
    else {
      throw QueryTableError.unsupported("Preview requires filters that run on the backend.")
    }
    let count = min(10_000, max(1, count))
    var server = snapshot.serverQuery(schema: schema)
    server.select = Array(Set(dependencies + [schema.idField])).sorted()
    server.offset = 0
    var rows: [QueryRow] = []
    var total = 0
    while rows.count < count {
      try Task.checkCancellation()
      server.limit = min(500, count - rows.count)
      let page = try await adapter.fetchRows(query: server)
      try Task.checkCancellation()
      total = page.total
      rows.append(contentsOf: page.rows.prefix(count - rows.count))
      if page.rows.isEmpty || rows.count >= total { break }
      server.offset += page.rows.count
    }
    return FetchRowsResult(rows: rows, total: total)
  }

  public func selectVisibleRows() { selectedIDs.formUnion(rows.map { rowID($0) }) }
  public func clearSelection() { selectedIDs = [] }
  public var selectedVisibleRows: [QueryRow] { rows.filter { selectedIDs.contains(rowID($0)) } }

  public func setAutoRefresh(seconds: Int?) {
    refreshTimer?.cancel()
    guard let seconds, seconds > 0 else { return }
    refreshTimer = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(nanoseconds: UInt64(min(seconds, 86_400)) * 1_000_000_000) } catch
        { return }
        guard let self else { return }
        if !self.isLoading { self.refresh() }
      }
    }
  }

  public func rowID(_ row: QueryRow) -> String {
    let value = schema.field(named: schema.idField)?.value(in: row) ?? row[schema.idField] ?? .null
    return value.identityKey
  }

  /// Reorders AND terms without changing their meaning or refetching rows.
  public func moveFilter(from source: Int, to destination: Int) {
    guard query.whereTerms.indices.contains(source), query.whereTerms.indices.contains(destination),
      source != destination
    else { return }
    var next = query
    let term = next.whereTerms.remove(at: source)
    next.whereTerms.insert(term, at: destination)
    setQuery(next, fetch: false)
  }

  /// Combines two AND terms into one OR group, preserving each predicate.
  public func groupFilter(from source: Int, with destination: Int) {
    guard query.whereTerms.indices.contains(source), query.whereTerms.indices.contains(destination),
      source != destination
    else { return }
    edit { next in
      let clauses = next.whereTerms[destination].predicates + next.whereTerms[source].predicates
      next.whereTerms[destination] = .any(clauses)
      next.whereTerms.remove(at: source)
    }
  }

  /// Converts alternatives into separate AND terms.
  public func ungroupFilter(at index: Int) {
    guard query.whereTerms.indices.contains(index), query.whereTerms[index].predicates.count > 1
    else { return }
    edit { next in
      let terms = next.whereTerms[index].predicates.map { WhereTerm.predicate($0) }
      next.whereTerms.replaceSubrange(index...index, with: terms)
    }
  }

  public func addFilter(
    field: String? = nil, value: String = "", op: String? = nil, negated: Bool? = nil
  ) {
    guard
      let field = schema.field(named: field ?? "")
        ?? schema.fields.first(where: \.isPushdownFilter), field.isPushdownFilter
    else { return }
    edit {
      $0.whereTerms.append(
        .predicate(
          WhereClause(
            field: field.name, op: op ?? field.filterOperators.first ?? "=", value: value,
            negated: negated)))
    }
  }

  public func cycleSort(field: String, additive: Bool = false) {
    guard schema.field(named: field)?.isSortable == true else { return }
    let current = effectiveSort
    edit { query in
      let old = current.first(where: { $0.field == field })
      if !additive {
        query.orderBy = []
      } else {
        query.orderBy = current.filter { $0.field != field }
      }
      if old?.dir != "desc" {
        query.orderBy.append(OrderByClause(field: field, dir: old == nil ? "asc" : "desc"))
      }
    }
  }

  public func saveQuery(name: String) {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 200 else {
      error = "Enter a name between 1 and 200 characters."
      return
    }
    guard savedQueries.count < 100 else {
      error = "At most 100 queries can be saved."
      return
    }
    guard !savedQueries.contains(where: { $0.name == name }) else {
      error = "A saved query already has that name."
      return
    }
    savedQueries.append(SavedQuerySnapshot(id: UUID(), name: name, query: query))
    persistSaved()
  }
  public func deleteSaved(id: UUID) {
    savedQueries.removeAll { $0.id == id }
    if defaultSavedID == id { setDefaultSaved(id: nil) }
    persistSaved()
  }
  public func setDefaultSaved(id: UUID?) {
    guard id == nil || savedQueries.contains(where: { $0.id == id }) else { return }
    defaultSavedID = id
    if let id {
      persistence?.set(id.uuidString, forKey: storageKey + ".default")
    } else {
      persistence?.removeObject(forKey: storageKey + ".default")
    }
  }
  private func persistSaved() {
    guard let persistence, let data = try? JSONEncoder().encode(savedQueries) else { return }
    persistence.set(data, forKey: storageKey + ".saved")
  }
  public func copyQuery() {
    do {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      let data = try encoder.encode(query)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(String(decoding: data, as: UTF8.self), forType: .string)
    } catch { self.error = error.localizedDescription }
  }
  public func importQuery(_ text: String) {
    do {
      let next: QueryState
      if text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{") {
        next = try JSONDecoder().decode(QueryState.self, from: Data(text.utf8))
      } else {
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count <= 2 * 1024 * 1024 else {
          throw QueryTableError.invalidQuery("Query token is too large.")
        }
        var base64 = token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
          of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
          let object = try? JSONSerialization.jsonObject(with: data), object is [String: Any]
        else {
          throw QueryTableError.invalidQuery("Enter valid query JSON or a shared query token.")
        }
        next = QueryState.decodeToken(token)
      }
      setQuery(next)
    } catch { self.error = error.localizedDescription }
  }
  deinit {
    task?.cancel()
    metricTask?.cancel()
    refreshTimer?.cancel()
  }
}
