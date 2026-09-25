import XCTest
import UIKit
import Capacitor
import GezelRuntime
import RuntimeConsumer

final class RuntimeConsumerTests: XCTestCase {
    @MainActor func testPackagedEngineImportsStreamsAndReleases() async throws {
        guard let fixture = Bundle.module.url(forResource: "ios-fixture", withExtension: "gguf", subdirectory: "Fixtures") else {
            throw XCTSkip("Provide the pinned native contract fixture to run inference")
        }
        let host = try runtime()
        func invoke(_ input: [String: Any] = [:], _ action: (NativeCall) -> Void) async throws -> [String: Any] {
            try await withCheckedThrowingContinuation { continuation in
                action(NativeCall(input, resolve: { continuation.resume(returning: $0) }, reject: { message, code in
                    continuation.resume(throwing: MobileInferenceError(code: code ?? "native_error", message: message))
                }))
            }
        }
        let imported = try await invoke { host.importModel($0, from: fixture) }
        let id = try XCTUnwrap((imported["model"] as? [String: Any])?["id"] as? String)
        let request = UUID().uuidString
        var streamed = ""
        let listener = host.listen { name, data in
            if name == "chatDelta", data["requestId"] as? String == request { streamed += data["delta"] as? String ?? "" }
        }
        defer { host.removeListener(listener) }
        let result = try await invoke(["requestId": request, "providerId": "llama-cpp", "modelId": id,
                                      "contextSize": 512, "maxTokens": 8, "messages": [["role": "user", "content": "hello"]]]) { host.generate($0) }
        XCTAssertEqual(result["text"] as? String, streamed)
        XCTAssertTrue(["length", "stop"].contains(result["stopReason"] as? String ?? ""))
        _ = try await invoke { host.releaseModel($0) }
        _ = try await invoke(["id": id]) { host.removeModel($0) }
    }

    @MainActor func testOneProcessOwnsRootAndAdmission() throws {
        let host = try runtime()
        XCTAssertTrue(host === (try runtime()))
        XCTAssertThrowsError(try GezelNativeRuntime.shared(root: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        XCTAssertTrue(host.reserveModelMutation())
        XCTAssertFalse(host.reserveModelMutation())
        host.releaseModelMutation()
    }

    @MainActor func testReleaseWaitsForModelMutationAndReopensAdmission() async throws {
        let host = try runtime()
        XCTAssertTrue(host.reserveModelMutation())
        var released = false
        let complete = expectation(description: "Released")
        host.releaseModel(NativeCall(resolve: { _ in released = true; complete.fulfill() }, reject: { message, _ in XCTFail(message); complete.fulfill() }))
        // Native release cannot race a file mutation or claim early completion.
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(released)
        XCTAssertFalse(host.reserveModelMutation())
        host.releaseModelMutation()
        await fulfillment(of: [complete], timeout: 5)
        XCTAssertTrue(host.reserveModelMutation())
        host.releaseModelMutation()
    }

    @MainActor func testBackgroundRejectsAdmissionAndEmitsRemovableEvent() async throws {
        let host = try runtime()
        var backgrounds = 0
        let listener = host.listen { name, _ in if name == "appBackground" { backgrounds += 1 } }
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertFalse(host.reserveModelMutation())
        XCTAssertEqual(backgrounds, 1)
        host.removeListener(listener)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertEqual(backgrounds, 1)
        let released = expectation(description: "Released after background")
        host.releaseModel(NativeCall(resolve: { _ in released.fulfill() }, reject: { message, _ in XCTFail(message); released.fulfill() }))
        await fulfillment(of: [released], timeout: 5)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertTrue(host.reserveModelMutation())
        host.releaseModelMutation()
    }

    @MainActor func testCapacitorBridgePreservesExplicitModelRejection() throws {
        let bridge = plugin()
        bridge.load()
        var rejected: String?
        let message: JSObject = ["role": "user", "content": "Do not generate"]
        let options: JSObject = ["requestId": "invalid-model", "providerId": "apple-foundation-models", "modelId": "another-model", "messages": [message]]
        let call = CAPPluginCall(callbackId: "invalid", methodName: "generate", options: options,
            success: { _, _ in XCTFail("Unexpected model substitution") }, error: { rejected = $0?.code })!
        bridge.generate(call)
        XCTAssertEqual(rejected, "MODEL_UNAVAILABLE")
    }

    func testNativeReplyIsExactlyOnce() {
        var replies = 0
        let call = NativeCall(resolve: { _ in replies += 1 }, reject: { _, _ in replies += 1 })
        call.resolve(); call.reject("late failure"); call.resolve()
        XCTAssertEqual(replies, 1)
    }
}
