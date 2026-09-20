// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "QueryTable",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "QueryTableCore", targets: ["QueryTableCore"]),
    .library(name: "QueryTableUI", targets: ["QueryTableUI"]),
    .library(name: "QueryTableFormula", targets: ["QueryTableFormula"]),
    .executable(name: "QueryTableDemo", targets: ["QueryTableDemo"]),
    .executable(name: "QueryTableChecks", targets: ["QueryTableChecks"]),
  ],
  targets: [
    .target(name: "QueryTableCore", path: "native/macos/Sources/QueryTableCore"),
    .target(
      name: "QueryTableFormula", dependencies: ["QueryTableCore"],
      path: "native/macos/Sources/QueryTableFormula", resources: [.process("Resources")]),
    .target(
      name: "QueryTableUI", dependencies: ["QueryTableCore", "QueryTableFormula"],
      path: "native/macos/Sources/QueryTableUI"),
    .executableTarget(
      name: "QueryTableDemo", dependencies: ["QueryTableUI", "QueryTableCore"],
      path: "native/macos/Sources/QueryTableDemo", resources: [.process("Resources")]),
    .executableTarget(
      name: "QueryTableChecks",
      dependencies: ["QueryTableUI", "QueryTableFormula", "QueryTableCore"],
      path: "native/macos/Sources/QueryTableChecks"),
    .testTarget(
      name: "QueryTableCoreTests", dependencies: ["QueryTableCore"],
      path: "native/macos/Tests/QueryTableCoreTests"),
    .testTarget(
      name: "QueryTableHTTPTests", dependencies: ["QueryTableCore"],
      path: "native/macos/Tests/QueryTableHTTPTests"),
    .testTarget(
      name: "QueryTableFormulaTests", dependencies: ["QueryTableFormula"],
      path: "native/macos/Tests/QueryTableFormulaTests"),
    .testTarget(
      name: "QueryTableUITests", dependencies: ["QueryTableUI"],
      path: "native/macos/Tests/QueryTableUITests"),
  ]
)
