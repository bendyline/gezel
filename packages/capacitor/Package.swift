// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BendylineGezelCapacitor",
    platforms: [.iOS("16.4")],
    products: [.library(name: "BendylineGezelCapacitor", targets: ["GezelCapacitor"])],
    dependencies: [
        .package(name: "GezelRuntime", path: "native/ios"),
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2")
    ],
    targets: [.target(name: "GezelCapacitor", dependencies: [
        .product(name: "GezelRuntime", package: "GezelRuntime"),
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "Cordova", package: "capacitor-swift-pm")
    ], path: "ios/Sources/GezelCapacitor")],
    swiftLanguageModes: [.v5]
)
