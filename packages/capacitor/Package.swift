// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Offline speech is optional: without a staged runtime, GezelSpeech reports itself unavailable.
let speech = FileManager.default.fileExists(
    atPath: Context.packageDirectory + "/native/speech-ios/GezelSpeech.xcframework/Info.plist")

let package = Package(
    name: "BendylineGezelCapacitor",
    platforms: [.iOS("16.4")],
    products: [.library(name: "BendylineGezelCapacitor", targets: ["GezelCapacitor"])],
    dependencies: [
        .package(name: "GezelRuntime", path: "native/ios"),
        // Matches the @capacitor/core peer range. An app pins this package exactly to
        // its own Capacitor, so an exact version here would refuse every other one.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.5.2")
    ],
    targets: [.target(name: "GezelCapacitor", dependencies: [
        .product(name: "GezelRuntime", package: "GezelRuntime"),
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "Cordova", package: "capacitor-swift-pm")
    ] + (speech ? ["GezelSpeech"] : []), path: "ios/Sources/GezelCapacitor")]
        + (speech ? [.binaryTarget(name: "GezelSpeech", path: "native/speech-ios/GezelSpeech.xcframework")] : []),
    swiftLanguageModes: [.v5]
)
