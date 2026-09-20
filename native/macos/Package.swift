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
    .target(name: "QueryTableCore"),
    .target(
      name: "QueryTableFormula", dependencies: ["QueryTableCore"],
      resources: [.process("Resources")]),
    .target(name: "QueryTableUI", dependencies: ["QueryTableCore", "QueryTableFormula"]),
    .executableTarget(
      name: "QueryTableDemo", dependencies: ["QueryTableUI", "QueryTableCore"],
      resources: [.process("Resources")]),
    .executableTarget(
      name: "QueryTableChecks",
      dependencies: ["QueryTableUI", "QueryTableFormula", "QueryTableCore"]),
    .testTarget(name: "QueryTableCoreTests", dependencies: ["QueryTableCore"]),
    .testTarget(name: "QueryTableHTTPTests", dependencies: ["QueryTableCore"]),
    .testTarget(name: "QueryTableFormulaTests", dependencies: ["QueryTableFormula"]),
    .testTarget(name: "QueryTableUITests", dependencies: ["QueryTableUI"]),
  ]
)
