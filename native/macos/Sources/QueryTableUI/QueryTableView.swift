import QueryTableCore
import SwiftUI

/// Embeddable macOS query editor and virtualized native table.
public struct QueryTableView: View {
  @ObservedObject private var controller: QueryTableController
  private let renderers: [String: NativeCellRenderer]
  @State private var showFilters = true
  @State private var showColumns = false
  @State private var showSort = false
  @State private var showSaved = false
  @State private var showImport = false
  @State private var showMetrics = false
  @State private var showComputed = false
  @State private var importText = ""
  @State private var saveName = ""
  @State private var autoRefresh = 0
  @State private var columnSearch = ""
  @State private var dragNamespace = UUID().uuidString

  public init(controller: QueryTableController, renderers: [String: NativeCellRenderer] = [:]) {
    self.controller = controller
    self.renderers = renderers
  }
  public var body: some View {
    VStack(spacing: 0) {
      toolbar.padding(10)
      Divider()
      if showFilters {
        filterEditor.padding(10)
        Divider()
      }
      if !controller.query.aggregations.isEmpty {
        metrics.padding(10)
        Divider()
      }
      if let error = controller.error {
        HStack {
          Image(systemName: "exclamationmark.triangle")
          Text(error).textSelection(.enabled)
          Spacer()
          Button("Retry") { controller.refresh() }
          Button {
            controller.error = nil
          } label: {
            Image(systemName: "xmark")
          }
        }.padding(8).foregroundStyle(.red)
      }
      NativeGrid(controller: controller, renderers: renderers)
        .overlay {
          if controller.rows.isEmpty && !controller.isLoading {
            ContentUnavailableView(
              "No rows", systemImage: "tablecells",
              description: Text("Change the filters or refresh to load results."))
          }
        }
      Divider()
      footer.padding(10)
    }
    .background(.background)
    .task { controller.refresh() }
    .onDisappear { controller.cancel() }
    .popover(isPresented: $showColumns) { columnEditor.padding().frame(width: 420) }
    .popover(isPresented: $showSort) { sortEditor.padding().frame(width: 620) }
    .popover(isPresented: $showSaved) { savedEditor.padding().frame(width: 360) }
    .popover(isPresented: $showMetrics) { metricEditor.padding().frame(width: 540) }
    .sheet(isPresented: $showComputed) {
      ComputedColumnEditor(
        store: controller.computedColumns, rows: controller.rows,
        sample: { dependencies, count in
          try await controller.sampleRows(dependencies: dependencies, count: count)
        }
      ) { column in
        var next = controller.query
        next.select = controller.visibleColumns
        if !next.select.contains(where: { $0.field == column.fieldName }) {
          next.select.append(SelectColumn(field: column.fieldName))
        }
        controller.setQuery(next)
        controller.refresh()
      }
    }
    .sheet(isPresented: $showImport) {
      VStack(alignment: .leading) {
        Text("Import query JSON or shared query token").font(.headline)
        TextEditor(text: $importText).font(.system(.body, design: .monospaced)).frame(
          minHeight: 200)
        HStack {
          Button("Cancel") { showImport = false }
          Spacer()
          Button("Import") {
            controller.importQuery(importText)
            showImport = false
          }.keyboardShortcut(.defaultAction)
        }
      }.padding().frame(width: 560)
    }
  }
  private var toolbar: some View {
    HStack(spacing: 10) {
      Text(controller.schema.name).font(.headline)
      Button {
        controller.undo()
      } label: {
        Image(systemName: "arrow.uturn.backward")
      }.disabled(!controller.canUndo).keyboardShortcut("z", modifiers: .command).help(
        "Undo query change")
      Button {
        controller.redo()
      } label: {
        Image(systemName: "arrow.uturn.forward")
      }.disabled(!controller.canRedo).keyboardShortcut("z", modifiers: [.command, .shift]).help(
        "Redo query change")
      Divider().frame(height: 18)
      Button("WHERE", systemImage: "line.3.horizontal.decrease.circle") { showFilters.toggle() }
      Button("SELECT", systemImage: "tablecells") { showColumns = true }
      Button("ORDER BY", systemImage: "arrow.up.arrow.down") { showSort = true }
      Button("Metrics", systemImage: "chart.bar") { showMetrics = true }
      Spacer()
      if controller.isLoading { ProgressView().controlSize(.small) }
      Button {
        controller.refresh()
      } label: {
        Image(systemName: "arrow.clockwise")
      }.help("Refresh")
      Menu {
        Picker("Auto refresh", selection: $autoRefresh) {
          Text("Off").tag(0)
          Text("Every 5 seconds").tag(5)
          Text("Every 30 seconds").tag(30)
          Text("Every minute").tag(60)
        }.onChange(of: autoRefresh) { _, value in controller.setAutoRefresh(seconds: value) }
        Button("Computed columns…") { showComputed = true }
        Button("Select visible rows") { controller.selectVisibleRows() }
        Button("Saved queries…") { showSaved = true }
        Button("Copy query JSON") { controller.copyQuery() }
        Button("Import query…") { showImport = true }
        Button("Reset query") {
          controller.setQuery(QueryState(limit: controller.schema.defaultLimit ?? 100))
        }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton).frame(width: 24)
    }.buttonStyle(.borderless)
  }
  private var filterEditor: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("WHERE").font(.caption.bold()).foregroundStyle(.secondary)
        if controller.query.whereTerms.isEmpty { Text("All rows").foregroundStyle(.secondary) }
        Spacer()
        Button("Add filter", systemImage: "plus") { controller.addFilter() }.disabled(
          !controller.schema.fields.contains(where: \.isPushdownFilter))
        if !controller.query.whereTerms.isEmpty {
          Button("Clear") { controller.edit { $0.whereTerms = [] } }
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(controller.query.whereTerms.enumerated()), id: \.offset) { index, term in
            HStack(alignment: .top) {
              VStack(spacing: 4) {
                Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                  .draggable("query-table.where.\(dragNamespace).\(index)")
                  .help("Drag here to reorder; drop on OR to combine filters")
                  .dropDestination(for: String.self) { items, _ in
                    dropFilter(items, at: index, group: false)
                  }
                Text(index == 0 ? "" : "AND").font(.caption.bold())
              }.frame(width: 30)
              VStack(spacing: 6) {
                ForEach(Array(term.predicates.enumerated()), id: \.offset) { child, clause in
                  HStack {
                    if child > 0 { Text("OR").font(.caption.bold()).frame(width: 24) }
                    PredicateEditor(controller: controller, clause: clause) { updated in
                      replacePredicate(term: index, child: child, clause: updated)
                    }
                    Button {
                      removePredicate(term: index, child: child)
                    } label: {
                      Image(systemName: "minus.circle")
                    }.help("Remove condition")
                  }
                }
              }
              Button("OR") {
                guard let first = term.predicates.first else { return }
                controller.edit { $0.whereTerms[index] = .any(term.predicates + [first]) }
              }.help("Add alternative, or drop another filter to combine with OR")
                .dropDestination(for: String.self) { items, _ in
                  dropFilter(items, at: index, group: true)
                }
              Menu {
                Button("Move up") { controller.moveFilter(from: index, to: index - 1) }.disabled(
                  index == 0)
                Button("Move down") { controller.moveFilter(from: index, to: index + 1) }.disabled(
                  index == controller.query.whereTerms.count - 1)
                if index > 0 {
                  Button("Combine with previous using OR") {
                    controller.groupFilter(from: index, with: index - 1)
                  }
                }
                if term.predicates.count > 1 {
                  Button("Split alternatives into AND filters") {
                    controller.ungroupFilter(at: index)
                  }
                }
              } label: {
                Image(systemName: "ellipsis")
              }.menuStyle(.borderlessButton).frame(width: 20)
            }
          }
        }
      }.frame(
        maxHeight: min(
          CGFloat(controller.query.whereTerms.reduce(0) { $0 + $1.predicates.count }) * 40, 240))
    }
  }
  private func dropFilter(_ items: [String], at index: Int, group: Bool) -> Bool {
    let prefix = "query-table.where.\(dragNamespace)."
    guard let item = items.first, item.hasPrefix(prefix),
      let source = Int(item.dropFirst(prefix.count)),
      controller.query.whereTerms.indices.contains(source), source != index
    else { return false }
    if group {
      controller.groupFilter(from: source, with: index)
    } else {
      controller.moveFilter(from: source, to: index)
    }
    return true
  }
  private func replacePredicate(term: Int, child: Int, clause: WhereClause) {
    guard controller.query.whereTerms.indices.contains(term) else { return }
    controller.edit { query in
      var predicates = query.whereTerms[term].predicates
      guard predicates.indices.contains(child) else { return }
      predicates[child] = clause
      query.whereTerms[term] = predicates.count == 1 ? .predicate(clause) : .any(predicates)
    }
  }
  private func removePredicate(term: Int, child: Int) {
    controller.edit { query in
      var predicates = query.whereTerms[term].predicates
      predicates.remove(at: child)
      if predicates.isEmpty {
        query.whereTerms.remove(at: term)
      } else {
        query.whereTerms[term] =
          predicates.count == 1 ? .predicate(predicates[0]) : .any(predicates)
      }
    }
  }
  private func matchesColumn(_ name: String) -> Bool {
    let search = columnSearch.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !search.isEmpty else { return true }
    guard let field = controller.schema.field(named: name) else {
      return [name, controller.computedColumns.labels[name] ?? ""].contains {
        $0.localizedCaseInsensitiveContains(search)
      }
    }
    return
      ([field.name, field.label, field.type, field.group ?? "", field.alias ?? ""]
      + (field.aliases ?? [])).contains { $0.localizedCaseInsensitiveContains(search) }
  }
  private var availableColumns: [FieldDefinition] {
    controller.schema.fields.filter {
      $0.isSelectable && !controller.visibleColumns.map(\.field).contains($0.name)
        && matchesColumn($0.name)
    }
  }
  private var columnGroups: [String] {
    Array(Set(availableColumns.map { $0.group ?? "Fields" })).sorted()
  }
  private func showColumn(_ name: String) {
    var query = controller.query
    query.select = controller.visibleColumns + [SelectColumn(field: name)]
    controller.setQuery(query)
  }
  private var columnEditor: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("SELECT · visible columns").font(.headline)
      TextField("Search fields, aliases, types, and groups", text: $columnSearch).textFieldStyle(
        .roundedBorder)
      Text("Drag headers to reorder. Drag a header edge to resize.").font(.caption).foregroundStyle(
        .secondary)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          Text("VISIBLE · \(controller.visibleColumns.count)").font(.caption.bold())
            .foregroundStyle(.secondary)
          ForEach(
            Array(controller.visibleColumns.enumerated()).filter {
              matchesColumn($0.element.field)
            }, id: \.element.field
          ) { index, column in
            HStack {
              Text(
                controller.schema.field(named: column.field)?.label ?? controller.computedColumns
                  .labels[column.field] ?? column.field)
              Spacer()
              Button {
                moveColumn(index, by: -1)
              } label: {
                Image(systemName: "arrow.up")
              }.disabled(index == 0).help("Move column left")
              Button {
                moveColumn(index, by: 1)
              } label: {
                Image(systemName: "arrow.down")
              }.disabled(index == controller.visibleColumns.count - 1).help("Move column right")
              Button {
                var query = controller.query
                query.select = controller.visibleColumns.filter { $0.field != column.field }
                controller.setQuery(query)
              } label: {
                Image(systemName: "eye.slash")
              }.disabled(controller.visibleColumns.count == 1).help("Hide column")
            }
          }
          ForEach(columnGroups, id: \.self) { group in
            Divider()
            Text(group.uppercased()).font(.caption.bold()).foregroundStyle(.secondary)
            ForEach(availableColumns.filter { ($0.group ?? "Fields") == group }, id: \.name) {
              field in
              HStack {
                Button {
                  showColumn(field.name)
                } label: {
                  Label(field.label, systemImage: "plus.circle")
                }
                Spacer()
                Text(field.type).font(.caption).foregroundStyle(.secondary)
              }.help(field.name)
            }
          }
          let hiddenComputed = controller.computedColumns.definitions.filter {
            !controller.visibleColumns.map(\.field).contains($0.fieldName)
              && matchesColumn($0.fieldName)
          }
          if !hiddenComputed.isEmpty {
            Divider()
            Text("COMPUTED COLUMNS").font(.caption.bold()).foregroundStyle(.secondary)
            ForEach(hiddenComputed) { column in
              Button {
                showColumn(column.fieldName)
              } label: {
                Label(column.label, systemImage: "function")
              }
            }
          }
          if !columnSearch.isEmpty && availableColumns.isEmpty
            && !controller.visibleColumns.contains(where: { matchesColumn($0.field) })
            && hiddenComputed.isEmpty
          {
            Text("No matching columns").foregroundStyle(.secondary)
          }
        }
      }.frame(maxHeight: 360)
      Button("Restore default columns") { controller.edit { $0.select = [] } }
    }
  }
  private func moveColumn(_ index: Int, by delta: Int) {
    var query = controller.query
    query.select = controller.visibleColumns
    query.select.swapAt(index, index + delta)
    controller.setQuery(query, fetch: false)
  }
  private var sortEditor: some View {
    VStack(alignment: .leading) {
      Text("ORDER BY · priority order").font(.headline)
      Text("Click a column header to cycle sorting; Shift-click adds another sort.").font(.caption)
        .foregroundStyle(.secondary)
      if controller.query.orderBy.isEmpty, !controller.effectiveSort.isEmpty {
        Text(
          "Schema default: "
            + controller.effectiveSort.map {
              "\(controller.schema.field(named: $0.field)?.label ?? $0.field) \($0.dir)"
            }.joined(separator: ", ")
        ).font(.caption)
      }
      ForEach(Array(controller.query.orderBy.enumerated()), id: \.offset) { index, sort in
        HStack {
          Text("\(index + 1)")
          Picker("Field", selection: sortBinding(index, \.field)) {
            ForEach(controller.schema.fields.filter(\.isSortable), id: \.name) {
              Text($0.label).tag($0.name)
            }
          }.labelsHidden()
          Picker("Direction", selection: sortBinding(index, \.dir)) {
            Text("Ascending").tag("asc")
            Text("Descending").tag("desc")
          }.labelsHidden()
          Picker(
            "Nulls",
            selection: Binding(
              get: { sort.nulls ?? "last" },
              set: { value in controller.edit { $0.orderBy[index].nulls = value } })
          ) {
            Text("Nulls last").tag("last")
            Text("Nulls first").tag("first")
          }.labelsHidden()
          Button {
            controller.edit { $0.orderBy.swapAt(index, index - 1) }
          } label: {
            Image(systemName: "arrow.up")
          }.disabled(index == 0)
          Button {
            controller.edit { $0.orderBy.remove(at: index) }
          } label: {
            Image(systemName: "minus.circle")
          }
        }
        TextField(
          "Optional extraction regex",
          text: Binding(
            get: { sort.extract?.regex ?? "" },
            set: { value in
              controller.edit {
                $0.orderBy[index].extract = value.isEmpty ? nil : RegexExtraction(regex: value)
              }
            })
        ).textFieldStyle(.roundedBorder)
      }
      HStack {
        Button("Add sort") {
          if let field = controller.schema.fields.first(where: \.isSortable) {
            controller.edit { $0.orderBy.append(OrderByClause(field: field.name)) }
          }
        }
        Button("Restore default sort") { controller.edit { $0.orderBy = [] } }
      }
    }
  }
  private func sortBinding(_ index: Int, _ key: WritableKeyPath<OrderByClause, String>) -> Binding<
    String
  > {
    Binding(
      get: { controller.query.orderBy[index][keyPath: key] },
      set: { value in controller.edit { $0.orderBy[index][keyPath: key] = value } })
  }
  private var savedEditor: some View {
    VStack(alignment: .leading) {
      Text("Saved queries").font(.headline)
      HStack {
        TextField("Name", text: $saveName)
        Button("Save") {
          controller.saveQuery(name: saveName)
          saveName = ""
        }.disabled(saveName.trimmingCharacters(in: .whitespaces).isEmpty)
      }
      ForEach(controller.savedQueries) { saved in
        HStack {
          Button(saved.name) {
            controller.setQuery(saved.query)
            showSaved = false
          }
          Spacer()
          Button {
            controller.setDefaultSaved(id: controller.defaultSavedID == saved.id ? nil : saved.id)
          } label: {
            Image(systemName: controller.defaultSavedID == saved.id ? "star.fill" : "star")
          }.help("Use as default view")
          Button {
            controller.deleteSaved(id: saved.id)
          } label: {
            Image(systemName: "trash")
          }
        }
      }
      if controller.savedQueries.isEmpty {
        Text("Save a query to return to its filters and layout.").foregroundStyle(.secondary)
      }
    }
  }
  private func measureFields(for op: String) -> [FieldDefinition] {
    controller.schema.fields.filter { field in
      guard field.source.kind == "backend", field.aggregate?.measure != false else { return false }
      let ops =
        field.aggregate?.ops
        ?? (field.type == "number"
          ? ["count_distinct", "sum", "avg", "min", "max"]
          : ["datetime", "enum", "text"].contains(field.type)
            ? ["count_distinct", "min", "max"] : field.type == "bool" ? ["count_distinct"] : [])
      return ops.contains(op)
    }
  }
  private var groupFields: [FieldDefinition] {
    controller.schema.fields.filter {
      $0.source.kind == "backend"
        && ($0.aggregate?.groupable ?? ["text", "enum", "bool"].contains($0.type))
    }
  }
  private var metricEditor: some View {
    VStack(alignment: .leading) {
      Text("Metrics · entire filtered dataset").font(.headline)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(controller.query.aggregations.enumerated()), id: \.element.id) {
            index, metric in
            VStack(alignment: .leading) {
              HStack {
                Picker(
                  "Operation",
                  selection: Binding(
                    get: { metric.op },
                    set: { value in
                      controller.edit {
                        $0.aggregations[index].op = value
                        if value == "count" {
                          $0.aggregations[index].field = nil
                        } else if !measureFields(for: value).contains(where: {
                          $0.name == metric.field
                        }) {
                          $0.aggregations[index].field = measureFields(for: value).first?.name
                        }
                      }
                    })
                ) {
                  ForEach(
                    ["count", "count_distinct", "sum", "avg", "min", "max"].filter {
                      $0 == "count" || !measureFields(for: $0).isEmpty
                    }, id: \.self
                  ) { Text($0).tag($0) }
                }.labelsHidden()
                if metric.op != "count" {
                  Picker(
                    "Measure",
                    selection: Binding(
                      get: { metric.field ?? "" },
                      set: { value in controller.edit { $0.aggregations[index].field = value } })
                  ) {
                    ForEach(measureFields(for: metric.op), id: \.name) {
                      Text($0.label).tag($0.name)
                    }
                  }.labelsHidden()
                }
                Button {
                  controller.edit { $0.aggregations.remove(at: index) }
                } label: {
                  Image(systemName: "minus.circle")
                }
              }
              TextField(
                "Optional label",
                text: Binding(
                  get: { metric.label ?? "" },
                  set: { value in
                    controller.edit { $0.aggregations[index].label = value.isEmpty ? nil : value }
                  }))
              ForEach(Array(metric.groupBy.enumerated()), id: \.offset) { groupIndex, name in
                HStack {
                  Text("Group \(groupIndex + 1)")
                  Picker(
                    "Group field",
                    selection: Binding(
                      get: { name },
                      set: { value in
                        controller.edit { $0.aggregations[index].groupBy[groupIndex] = value }
                      })
                  ) {
                    ForEach(
                      groupFields.filter { $0.name == name || !metric.groupBy.contains($0.name) },
                      id: \.name
                    ) { Text($0.label).tag($0.name) }
                  }.labelsHidden()
                  Button {
                    controller.edit {
                      $0.aggregations[index].groupBy.swapAt(groupIndex, groupIndex - 1)
                    }
                  } label: {
                    Image(systemName: "arrow.up")
                  }.disabled(groupIndex == 0)
                  Button {
                    controller.edit { $0.aggregations[index].groupBy.remove(at: groupIndex) }
                  } label: {
                    Image(systemName: "minus.circle")
                  }
                }
              }
              Menu("Add grouping") {
                ForEach(groupFields.filter { !metric.groupBy.contains($0.name) }, id: \.name) {
                  field in
                  Button(field.label) {
                    controller.edit { $0.aggregations[index].groupBy.append(field.name) }
                  }
                }
              }.disabled(groupFields.allSatisfy { metric.groupBy.contains($0.name) })
            }
            Divider()
          }
        }
      }.frame(maxHeight: 420)
      Button("Add metric") {
        controller.edit {
          $0.aggregations.append(AggregationClause(id: UUID().uuidString, op: "count"))
        }
      }
    }
  }
  private var metrics: some View {
    VStack(alignment: .leading) {
      if let error = controller.metricError { Text(error).foregroundStyle(.red) }
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 12) {
          ForEach(controller.metrics, id: \.id) { metric in
            MetricPanel(
              metric: metric,
              definition: controller.query.aggregations.first(where: { $0.id == metric.id }),
              schema: controller.schema)
          }
        }
      }
    }.fixedSize(horizontal: false, vertical: true)
  }
  private var footer: some View {
    let start = controller.query.offset + 1
    let end = controller.query.offset + controller.rows.count
    let summary = controller.rows.isEmpty
      ? "0 of \(formatRowCount(controller.total)) rows"
      : "\(formatRowCount(start))–\(formatRowCount(end)) of \(formatRowCount(controller.total)) rows"
    let exactSummary = controller.rows.isEmpty
      ? "0 of \(exactRowCount(controller.total)) rows"
      : "\(exactRowCount(start))–\(exactRowCount(end)) of \(exactRowCount(controller.total)) rows"
    HStack {
      Text(summary).monospacedDigit().help(summary == exactSummary ? summary : exactSummary)
      if !controller.selectedIDs.isEmpty {
        Text("· \(controller.selectedIDs.count) selected")
        Button("Clear selection") { controller.selectedIDs = [] }
      }
      Spacer()
      Text("LIMIT").font(.caption)
      TextField(
        "Limit",
        value: Binding(
          get: { controller.query.limit }, set: { value in controller.edit { $0.limit = value } }),
        format: .number
      ).frame(width: 70)
      Button {
        controller.edit(resetOffset: false) { $0.offset = max(0, $0.offset - $0.limit) }
      } label: {
        Image(systemName: "chevron.left")
      }.disabled(controller.query.offset == 0)
      Text("OFFSET").font(.caption)
      TextField(
        "Offset",
        value: Binding(
          get: { controller.query.offset },
          set: { value in controller.edit(resetOffset: false) { $0.offset = value } }),
        format: .number
      ).frame(width: 80)
      Button {
        controller.edit(resetOffset: false) { $0.offset += $0.limit }
      } label: {
        Image(systemName: "chevron.right")
      }.disabled(controller.query.offset + controller.rows.count >= controller.total)
    }.font(.caption).textFieldStyle(.roundedBorder)
  }
}

private struct PredicateEditor: View {
  @ObservedObject var controller: QueryTableController
  let clause: WhereClause
  var changed: (WhereClause) -> Void
  @State private var suggestions: [String] = []
  @State private var more = false
  private var field: FieldDefinition? { controller.schema.field(named: clause.field) }
  private var allowedOps: [String] { field?.filterOperators ?? ["="] }
  private func positiveOp(_ op: String) -> String {
    guard let positive = QueryPredicateOperations.positiveOperators[op],
      allowedOps.contains(positive)
    else { return op }
    return positive
  }
  private var isExcluded: Bool { clause.negated == true || positiveOp(clause.op) != clause.op }
  private var operatorChoices: [String] {
    var seen = Set<String>()
    return allowedOps.map(positiveOp).filter { seen.insert($0).inserted }
  }
  private func binding<T>(_ key: WritableKeyPath<WhereClause, T>) -> Binding<T> {
    Binding(
      get: { clause[keyPath: key] },
      set: { value in
        var copy = clause
        copy[keyPath: key] = value
        changed(copy)
      })
  }
  var body: some View {
    HStack {
      Picker(
        "Filter field",
        selection: Binding(
          get: { clause.field },
          set: { name in
            var copy = clause
            copy.field = name
            copy.op = controller.schema.field(named: name)?.filterOperators.first ?? "="
            copy.value = ""
            copy.negated = nil
            changed(copy)
          })
      ) {
        ForEach(controller.schema.fields.filter(\.isFilterable), id: \.name) { field in
          Text(field.label + (field.isPushdownFilter ? "" : " · local filtering unavailable")).tag(
            field.name
          ).disabled(!field.isPushdownFilter)
        }
      }.labelsHidden().frame(minWidth: 100, maxWidth: 190)
      Picker(
        "Operator",
        selection: Binding(
          get: { positiveOp(clause.op) },
          set: { op in
            var next = WhereClause(field: clause.field, op: op, value: clause.value)
            if isExcluded { next = QueryPredicateOperations.negate(next, allowedOps: allowedOps) }
            changed(next)
          })
      ) {
        ForEach(operatorChoices, id: \.self) {
          Text($0.replacingOccurrences(of: "_", with: " ")).tag($0)
        }
      }.labelsHidden().frame(width: 140)
      if clause.op != "is_null" && clause.op != "is_not_null" {
        if field?.filter?.values?.source == "static", let options = field?.filter?.values?.options {
          let choices = Array(Set(options + (clause.value.isEmpty ? [] : [clause.value]))).sorted()
          Picker("Value", selection: binding(\.value)) {
            if !choices.contains("") { Text("Choose value").tag("") }
            ForEach(choices, id: \.self) { Text($0).tag($0) }
          }.labelsHidden()
        } else if field?.type == "bool" {
          Picker("Value", selection: binding(\.value)) {
            Text("Choose").tag("")
            Text("true").tag("true")
            Text("false").tag("false")
          }.labelsHidden()
        } else {
          TextField(
            field?.type == "datetime"
              ? "ISO date or timestamp" : field?.type == "number" ? "Number" : "Value",
            text: binding(\.value)
          ).textFieldStyle(.roundedBorder)
          if !suggestions.isEmpty {
            Menu {
              ForEach(suggestions, id: \.self) { value in
                Button(value) {
                  var copy = clause
                  copy.value = value
                  changed(copy)
                }
              }
              if more { Text("Keep typing for more values") }
            } label: {
              Image(systemName: "chevron.down")
            }.menuStyle(.borderlessButton).frame(width: 18)
          }
        }
      } else {
        Spacer()
      }
      Toggle(
        "NOT",
        isOn: Binding(
          get: { isExcluded },
          set: { value in
            if value != isExcluded {
              changed(QueryPredicateOperations.negate(clause, allowedOps: allowedOps))
            }
          })
      ).toggleStyle(.checkbox)
        .disabled(!QueryPredicateOperations.canNegate(clause, allowedOps: allowedOps))
        .help("Negate this predicate using its complementary operator")
    }
    .task(id: clause.field + "\u{0}" + clause.value) {
      suggestions = []
      more = false
      if field?.filter?.values?.source == "freeform" { return }
      if let options = field?.filter?.values?.options {
        suggestions = options.filter {
          clause.value.isEmpty || $0.localizedCaseInsensitiveContains(clause.value)
        }
        return
      }
      do {
        try await Task.sleep(nanoseconds: 200_000_000)
        let result = try await controller.adapter.fetchDistinctValues(
          query: DistinctValuesQuery(field: clause.field, search: clause.value, limit: 30))
        try Task.checkCancellation()
        suggestions = result.values
        more = result.hasMore
      } catch { /* Optional autocomplete falls back to freeform input. */  }
    }
  }
}
