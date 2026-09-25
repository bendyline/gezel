// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GezelMobileStorage",
    platforms: [.iOS("16.4"), .macOS(.v13)],
    products: [.library(name: "GezelMobileStorage", targets: ["GezelMobileStorage"])],
    dependencies: [.package(path: "../../../../native/runtime/models")],
    targets: [
        .target(name: "GezelMobileStorage", dependencies: [.product(name: "GezelModelStorage", package: "models")]),
        .testTarget(name: "GezelMobileStorageTests", dependencies: ["GezelMobileStorage", .product(name: "GezelModelStorage", package: "models")])
    ]
)
