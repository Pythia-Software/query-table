import AppKit
import QueryTableCore
import SwiftUI

/// A native cell factory, keyed by schema renderer name or field name.
public typealias NativeCellRenderer =
  @MainActor (_ value: JSONValue, _ row: QueryRow, _ field: FieldDefinition) -> NSView

struct NativeGrid: NSViewRepresentable {
  @ObservedObject var controller: QueryTableController
  var renderers: [String: NativeCellRenderer]
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    let table = MenuTable()
    table.delegate = context.coordinator
    table.dataSource = context.coordinator
    table.allowsMultipleSelection = true
    table.allowsColumnReordering = true
    table.allowsColumnResizing = true
    table.usesAlternatingRowBackgroundColors = true
    table.columnAutoresizingStyle = .noColumnAutoresizing
    table.rowHeight = 29
    table.copyAction = { [weak coordinator = context.coordinator] in coordinator?.copySelection() }
    table.contextMenuProvider = { [weak coordinator = context.coordinator] row, column in
      coordinator?.menu(row: row, column: column)
    }
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.autohidesScrollers = true
    context.coordinator.table = table
    return scroll
  }
  func updateNSView(_ view: NSScrollView, context: Context) {
    let coordinator = context.coordinator
    coordinator.parent = self
    guard let table = coordinator.table else { return }
    coordinator.updating = true
    let columns = controller.visibleColumns
    if table.tableColumns.map({ $0.identifier.rawValue }) != columns.map(\.field) {
      table.tableColumns.forEach { table.removeTableColumn($0) }
      for column in columns {
        let native = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.field))
        native.minWidth = 40
        native.maxWidth = 2000
        native.width =
          column.width ?? controller.schema.field(named: column.field)?.select?.width ?? 160
        table.addTableColumn(native)
      }
    }
    for column in table.tableColumns {
      let field = column.identifier.rawValue
      let label =
        controller.schema.field(named: field)?.label ?? controller.computedColumns.labels[field]
        ?? field
      if let index = controller.effectiveSort.firstIndex(where: { $0.field == field }) {
        column.title =
          "\(label) \(controller.effectiveSort[index].dir == "asc" ? "↑" : "↓") \(index + 1)"
      } else {
        column.title = label
      }
      if let width = columns.first(where: { $0.field == field })?.width,
        abs(column.width - width) > 1
      {
        column.width = width
      }
    }
    table.reloadData()
    let selection = IndexSet(
      controller.rows.indices.filter {
        controller.selectedIDs.contains(controller.rowID(controller.rows[$0]))
      })
    table.selectRowIndexes(selection, byExtendingSelection: false)
    coordinator.updating = false
  }

  @MainActor final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    var parent: NativeGrid
    weak var table: NSTableView?
    var updating = false
    init(_ parent: NativeGrid) { self.parent = parent }
    func numberOfRows(in tableView: NSTableView) -> Int { parent.controller.rows.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int)
      -> NSView?
    {
      guard parent.controller.rows.indices.contains(row),
        let key = tableColumn?.identifier.rawValue,
        let field = parent.controller.schema.field(named: key)
          ?? (key.hasPrefix("@computed/")
            ? FieldDefinition(
              name: key, label: parent.controller.computedColumns.labels[key] ?? key, type: "text",
              source: FieldSource(kind: "derived")) : nil)
      else { return nil }
      let record = parent.controller.rows[row]
      let value = field.value(in: record)
      if let renderer = parent.renderers[field.render ?? ""] ?? parent.renderers[key] {
        return renderer(value, record, field)
      }
      let identifier = NSUserInterfaceItemIdentifier("query-table-cell")
      let cell =
        tableView.makeView(withIdentifier: identifier, owner: nil) as? NSTableCellView
        ?? NSTableCellView()
      cell.identifier = identifier
      if cell.textField == nil {
        let text = NSTextField(labelWithString: "")
        text.translatesAutoresizingMaskIntoConstraints = false
        text.lineBreakMode = .byTruncatingTail
        cell.addSubview(text)
        cell.textField = text
        NSLayoutConstraint.activate([
          text.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
          text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
          text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
      }
      if case .object(let object) = value, let error = object["computedError"] {
        cell.textField?.stringValue = "⚠ " + error.displayString
      } else {
        cell.textField?.stringValue = value == .null ? "NULL" : value.displayString
      }
      cell.textField?.textColor = value == .null ? .tertiaryLabelColor : .labelColor
      cell.textField?.alignment =
        field.select?.align == "right" || field.type == "number"
        ? .right : field.select?.align == "center" ? .center : .left
      cell.toolTip = value.displayString
      return cell
    }
    func tableView(_ tableView: NSTableView, didClick tableColumn: NSTableColumn) {
      parent.controller.cycleSort(
        field: tableColumn.identifier.rawValue, additive: NSEvent.modifierFlags.contains(.shift))
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
      guard !updating, let table else { return }
      let visible = Set(parent.controller.rows.map { parent.controller.rowID($0) })
      var selected = parent.controller.selectedIDs.subtracting(visible)
      for index in table.selectedRowIndexes where parent.controller.rows.indices.contains(index) {
        selected.insert(parent.controller.rowID(parent.controller.rows[index]))
      }
      parent.controller.selectedIDs = selected
    }
    func tableViewColumnDidMove(_ notification: Notification) { saveColumns() }
    func tableViewColumnDidResize(_ notification: Notification) { saveColumns() }
    private func saveColumns() {
      guard !updating, let table else { return }
      var next = parent.controller.query
      next.select = table.tableColumns.map {
        SelectColumn(field: $0.identifier.rawValue, width: $0.width)
      }
      parent.controller.setQuery(next, fetch: false)
    }
    func menu(row: Int, column: Int) -> NSMenu? {
      guard let table, parent.controller.rows.indices.contains(row),
        table.tableColumns.indices.contains(column)
      else { return nil }
      let fieldName = table.tableColumns[column].identifier.rawValue
      let field = fieldDefinition(fieldName)
      let value = field.value(in: parent.controller.rows[row])
      let menu = NSMenu()
      func action(_ title: String, _ body: @escaping @MainActor () -> Void) {
        menu.addItem(ActionMenuItem(title: title, action: body))
      }
      action("Copy cell") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value.displayString, forType: .string)
      }
      action("Copy selected rows on this page (TSV)") { [weak self] in self?.copySelection() }
      if field.isPushdownFilter {
        let allowed = field.filterOperators
        func filterAction(_ title: String, value: String, op: String, negated: Bool? = nil) {
          guard allowed.contains(op) else { return }
          action(title) { [weak self] in
            self?.parent.controller.addFilter(
              field: fieldName, value: value, op: op, negated: negated)
          }
        }
        if value == .null || value == .array([]) {
          filterAction("Filter to empty / NULL", value: "", op: "is_null")
          filterAction("Exclude empty / NULL", value: "", op: "is_not_null")
        } else if case .array(let values) = value {
          for item in values {
            filterAction(
              "Includes \(item.displayString)", value: item.displayString, op: "includes")
            filterAction(
              "Excludes \(item.displayString)", value: item.displayString, op: "includes",
              negated: true)
          }
        } else {
          filterAction("Filter to this value", value: value.displayString, op: "=")
          filterAction("Exclude this value", value: value.displayString, op: "!=")
        }
      }
      if field.isSortable {
        action("Add to sort") { [weak self] in
          self?.parent.controller.cycleSort(field: fieldName, additive: true)
        }
      }
      return menu
    }
    private func fieldDefinition(_ name: String) -> FieldDefinition {
      parent.controller.schema.field(named: name)
        ?? FieldDefinition(
          name: name, label: parent.controller.computedColumns.labels[name] ?? name, type: "text",
          source: FieldSource(kind: "derived"))
    }
    func copySelection() {
      let controller = parent.controller
      let fields = controller.visibleColumns.map { fieldDefinition($0.field) }
      func escape(_ text: String) -> String {
        text.contains(where: { "\t\n\"".contains($0) })
          ? "\"" + text.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : text
      }
      var lines = [fields.map { escape($0.label) }.joined(separator: "\t")]
      lines += controller.rows.filter { controller.selectedIDs.contains(controller.rowID($0)) }.map
      { row in fields.map { escape($0.value(in: row).displayString) }.joined(separator: "\t") }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }
  }
}

private final class MenuTable: NSTableView {
  var copyAction: (() -> Void)?
  @objc func copy(_ sender: Any?) { copyAction?() }
  var contextMenuProvider: ((Int, Int) -> NSMenu?)?
  override func menu(for event: NSEvent) -> NSMenu? {
    let point = convert(event.locationInWindow, from: nil)
    return contextMenuProvider?(row(at: point), column(at: point))
  }
}
@MainActor private final class ActionMenuItem: NSMenuItem {
  let body: @MainActor () -> Void
  init(title: String, action: @escaping @MainActor () -> Void) {
    self.body = action
    super.init(title: title, action: #selector(run), keyEquivalent: "")
    target = self
  }
  required init(coder: NSCoder) { fatalError("Not available") }
  @objc private func run() { body() }
}
