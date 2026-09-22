// swift-tools-version: 6.0
import Foundation
import PackageDescription

guard let distribution = ProcessInfo.processInfo.environment["GEZEL_CAPACITOR_PACKAGE"] else {
    fatalError("Set GEZEL_CAPACITOR_PACKAGE to an extracted local npm package, outside the Gezel checkout")
}
let package = Package(
    name: "RuntimeConsumer",
    platforms: [.iOS("16.4")],
    products: [.library(name: "RuntimeConsumer", targets: ["RuntimeConsumer"])],
    dependencies: [.package(name: "BendylineGezelCapacitor", path: distribution)],
    targets: [
        .target(name: "RuntimeConsumer", dependencies: [.product(name: "BendylineGezelCapacitor", package: "BendylineGezelCapacitor")]),
        .testTarget(name: "RuntimeConsumerTests", dependencies: ["RuntimeConsumer"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v5]
)
