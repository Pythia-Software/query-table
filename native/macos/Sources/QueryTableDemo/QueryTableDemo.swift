import AppKit
import QueryTableCore
import QueryTableUI
import SwiftUI

@main
struct QueryTableDemo: App {
  @NSApplicationDelegateAdaptor(DemoDelegate.self) private var delegate
  @StateObject private var controller: QueryTableController

  init() {
    do {
      let url = Bundle.module.url(forResource: "runs.schema", withExtension: "json")!
      let schema = try JSONDecoder().decode(FieldSchema.self, from: Data(contentsOf: url))
      let platforms = ["macos", "linux", "windows"]
      let outcomes = ["PASS", "PASS", "PASS", "FAIL", "DIFFERENCES"]
      let jobs = ["render", "compile", "integration", "snapshot", "package", "lint"]
      let formatter = ISO8601DateFormatter()
      let rows: [QueryRow] = (1...320).map { index -> QueryRow in
        var row: QueryRow = [:]
        row["id"] = .number(Double(index))
        row["job_name"] = .string("\(jobs[index % jobs.count])-\(String(format: "%04d", index))")
        row["platform"] = .string(platforms[index % platforms.count])
        row["overall"] = .string(outcomes[index % outcomes.count])
        row["total_ms"] = .number(Double(850 + (index * 7919) % 85000))
        row["worker"] = index % 11 == 0 ? .null : .string("worker-\(index % 12 + 1)")
        let date = Date(timeIntervalSince1970: 1_789_900_000 + Double(index * 120))
        row["enqueued_at"] = .object(["Time": .string(formatter.string(from: date))])
        row["is_starred"] = .bool(index % 7 == 0)
        row["error_codes"] = .array(
          index % 5 == 3 ? [.string("E_TIMEOUT"), .string("E_RETRY")] : [])
        return row
      }
      _controller = StateObject(
        wrappedValue: QueryTableController(
          schema: schema,
          adapter: LocalQueryTransport(schema: schema, rows: rows),
          initialQuery: QueryState(
            whereTerms: [.predicate(.init(field: "platform", op: "=", value: "macos"))],
            orderBy: [.init(field: "total_ms", dir: "desc")],
            limit: 50,
            aggregations: [
              .init(id: "runs", op: "count", label: "Matching runs"),
              .init(
                id: "duration", op: "avg", field: "total_ms", groupBy: ["overall"],
              label: "Average duration (ms) by result"),
            ]
          )
        ))
    } catch {
      fatalError("Bundled demo schema is invalid: \(error)")
    }
  }

  var body: some Scene {
    WindowGroup("Query Table — Native macOS") {
      VStack(spacing: 0) {
        HStack {
          Image(systemName: "tablecells").font(.title2).foregroundStyle(.tint)
          VStack(alignment: .leading, spacing: 3) {
            Text("Build runs").font(.title2.bold())
            Text("320 sample runs · native controls · shared query protocol").foregroundStyle(
              .secondary)
          }
          Spacer()
          Text("query-table").font(.system(.caption, design: .monospaced)).foregroundStyle(
            .secondary)
        }
        .padding(20)
        .background(Color(nsColor: .windowBackgroundColor))
        Divider()
        QueryTableView(controller: controller, renderers: demoRenderers)
      }
      .frame(minWidth: 1000, minHeight: 640)
    }
    .defaultSize(width: 1280, height: 820)
  }

  private var demoRenderers: [String: NativeCellRenderer] {
    [
      "overall_pill": { value, _, _ in
        let color: Color =
          value == .string("PASS") ? .green : value == .string("FAIL") ? .red : .orange
        return NSHostingView(
          rootView: Text(value.displayString)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
            .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 8))
      },
      "duration_ms": { value, _, _ in
        let text: String
        if case .number(let milliseconds) = value {
          text = String(format: "%.2f s", milliseconds / 1000)
        } else {
          text = "—"
        }
        return NSHostingView(
          rootView: Text(text).monospacedDigit()
            .frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 8))
      },
      "tag_marker": { value, _, _ in
        NSHostingView(
          rootView: Image(systemName: value == .bool(true) ? "star.fill" : "star")
            .foregroundStyle(value == .bool(true) ? Color.orange : Color.secondary.opacity(0.35))
            .frame(maxWidth: .infinity))
      },
    ]
  }
}

/// `--snapshot path.png` renders the actual window content for repeatable visual QA.
final class DemoDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.activate(ignoringOtherApps: true)
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: "--snapshot"), args.indices.contains(index + 1) else {
      return
    }
    let path = args[index + 1]
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
      guard let content = NSApplication.shared.windows.first(where: { $0.isVisible })?.contentView,
        let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)
      else {
        fputs("Unable to render the demo window.\n", stderr)
        NSApplication.shared.terminate(nil)
        return
      }
      content.cacheDisplay(in: content.bounds, to: bitmap)
      do {
        try bitmap.representation(using: .png, properties: [:])?.write(
          to: URL(fileURLWithPath: path))
        print("Snapshot: \(path)")
      } catch { fputs("Snapshot failed: \(error)\n", stderr) }
      NSApplication.shared.terminate(nil)
    }
  }
}
