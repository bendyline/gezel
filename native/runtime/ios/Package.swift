// swift-tools-version: 6.0
import Foundation
import PackageDescription

guard let llama = ProcessInfo.processInfo.environment["GEZEL_LLAMA_PACKAGE"] else {
    fatalError("Set GEZEL_LLAMA_PACKAGE to a staged GezelLlama Swift package, or use the self-contained staged runtime")
}
let package = Package(
    name: "GezelRuntime",
    platforms: [.iOS("16.4")],
    products: [.library(name: "GezelRuntime", targets: ["GezelRuntime"])],
    dependencies: [.package(path: "../models"), .package(name: "GezelLlama", path: llama)],
    targets: [
        .target(name: "GezelRuntime", dependencies: [
            .product(name: "GezelModelStorage", package: "models"),
            .product(name: "GezelLlama", package: "GezelLlama")
        ])
    ],
    swiftLanguageModes: [.v5]
)
