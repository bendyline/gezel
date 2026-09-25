// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GezelModelStorage",
    platforms: [.iOS("16.4"), .macOS(.v13)],
    products: [.library(name: "GezelModelStorage", targets: ["GezelModelStorage"])],
    targets: [.target(name: "GezelModelStorage")]
)
