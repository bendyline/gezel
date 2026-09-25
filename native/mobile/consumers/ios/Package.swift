// swift-tools-version: 6.0
import Foundation
import PackageDescription

guard let runtime = ProcessInfo.processInfo.environment["GEZEL_LLAMA_PACKAGE"] else {
    fatalError("Set GEZEL_LLAMA_PACKAGE to the staged swift/GezelLlama directory")
}
let package = Package(
    name: "GezelConsumerSmoke",
    platforms: [.iOS("16.4")],
    dependencies: [.package(path: runtime)],
    targets: [
        .executableTarget(
            name: "GezelConsumerSmoke",
            dependencies: [.product(name: "GezelLlama", package: "GezelLlama")]
        )
    ]
)
