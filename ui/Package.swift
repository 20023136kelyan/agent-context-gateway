// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "BifrostMenuApp",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "BifrostMenuCore",
      path: "Sources/BifrostMenuCore"
    ),
    .executableTarget(
      name: "BifrostMenuApp",
      dependencies: ["BifrostMenuCore"],
      path: "Sources/BifrostMenuApp"
    ),
    .testTarget(
      name: "BifrostMenuAppTests",
      dependencies: ["BifrostMenuCore"],
      path: "Tests/BifrostMenuAppTests"
    ),
  ]
)
