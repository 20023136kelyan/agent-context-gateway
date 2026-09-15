// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "GatewayMenuApp",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "GatewayMenuCore",
      path: "Sources/GatewayMenuCore"
    ),
    .executableTarget(
      name: "GatewayMenuApp",
      dependencies: ["GatewayMenuCore"],
      path: "Sources/GatewayMenuApp"
    ),
    .testTarget(
      name: "GatewayMenuAppTests",
      dependencies: ["GatewayMenuCore"],
      path: "Tests/GatewayMenuAppTests"
    ),
  ]
)
