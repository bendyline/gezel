// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GezelMobileStorage",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "GezelMobileStorage", targets: ["GezelMobileStorage"])],
    targets: [
        .target(name: "GezelMobileStorage"),
        .testTarget(name: "GezelMobileStorageTests", dependencies: ["GezelMobileStorage"])
    ]
)
