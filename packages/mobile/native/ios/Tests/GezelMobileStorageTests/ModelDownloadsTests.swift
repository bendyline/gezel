import Foundation
import CryptoKit
import XCTest
@testable import GezelMobileStorage

private final class DownloadProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((DownloadProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {}
    func respond(_ data: Data, status: Int = 200, fields: [String:String] = [:], fail: Bool = false) {
        var headers = ["Content-Length": String(data.count), "ETag": "\"fixed\""]
        headers.merge(fields) { _, new in new }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        if fail {
            // URLProtocol's response disposition is asynchronous. Fail only after
            // its delivered prefix has crossed the URLSession delegate boundary.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                self.client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            }
        }
        else { client?.urlProtocolDidFinishLoading(self) }
    }
}

final class ModelDownloadsTests: XCTestCase {
    var root: URL!
    var store: MobileStore!
    var manager: ModelDownloads!
    let bytes = Data(("GGUF" + String(repeating: "x", count: 131068)).utf8)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = try MobileStore(root: root)
        manager = try makeManager()
    }
    override func tearDownWithError() throws {
        manager.suspend(); DownloadProtocol.handler = nil
        try FileManager.default.removeItem(at: root)
    }
    func makeManager() throws -> ModelDownloads {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DownloadProtocol.self]
        return try ModelDownloads(store: store, configuration: config)
    }
    func source() -> MobileModelSource {
        MobileModelSource(catalogId: "fixture", catalogVersion: "1.0.0", sourceId: "q4", huggingfaceRepo: "example/model", revision: String(repeating: "a", count: 40), filename: "fixture.gguf", sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), sizeBytes: Int64(bytes.count))
    }
    func wait(_ id: String, state: String) throws -> MobileModelDownload {
        for _ in 0..<500 {
            if let record = try manager.list().first(where: { $0.id == id }), record.state == state { return record }
            Thread.sleep(forTimeInterval: 0.01)
        }
        XCTFail("Expected \(state): \(try manager.list())")
        throw ModelDownloadError("Download did not settle")
    }
    func failAfterPrefix() throws -> MobileModelDownload {
        let bytes = self.bytes
        DownloadProtocol.handler = { $0.respond(bytes.prefix(65536), fields: ["Content-Length": String(bytes.count)], fail: true) }
        let record = try manager.start(source: source(), name: "Fixture")
        let failed = try wait(record.id, state: "failed")
        XCTAssertEqual(failed.downloadedBytes, 65536, "Prefix lost: \(failed)")
        return failed
    }
    func testVerifiedActivationAndDismissalPreserveInstalledModelWithoutSelectingIt() throws {
        let bytes = self.bytes; DownloadProtocol.handler = { $0.respond(bytes) }
        let record = try manager.start(source: source(), name: "Fixture")
        XCTAssertEqual(try wait(record.id, state: "complete").modelId, record.id)
        let reopened = try MobileStore(root: root)
        XCTAssertEqual(try reopened.listModels().models.first?.source, source())
        XCTAssertNil(try reopened.listModels().selectedModelId)
        let dismissed = expectation(description: "dismiss")
        manager.remove(id: record.id) { result in if case .failure(let error) = result { XCTFail(error.localizedDescription) }; dismissed.fulfill() }
        wait(for: [dismissed], timeout: 3)
        XCTAssertTrue(try manager.list().isEmpty)
        XCTAssertEqual(try reopened.listModels().models.count, 1)
    }
    func testInterruptedTransferResumesExactRangeAcrossManagerRestart() throws {
        let partial = try failAfterPrefix()
        XCTAssertEqual(partial.downloadedBytes, 65536)
        XCTAssertTrue(try store.listModels().models.isEmpty)
        manager = try makeManager()
        let bytes = self.bytes
        DownloadProtocol.handler = { request in
            XCTAssertEqual(request.request.value(forHTTPHeaderField: "Range"), "bytes=65536-")
            XCTAssertEqual(request.request.value(forHTTPHeaderField: "If-Range"), "\"fixed\"")
            request.respond(bytes.dropFirst(65536), status: 206, fields: ["Content-Range":"bytes 65536-\(bytes.count-1)/\(bytes.count)"])
        }
        _ = try manager.resume(id: partial.id)
        XCTAssertEqual(try wait(partial.id, state: "complete").downloadedBytes, Int64(bytes.count))
    }
    func testChangedETagCannotAppendOrActivate() throws {
        let partial = try failAfterPrefix(); let bytes = self.bytes
        DownloadProtocol.handler = { $0.respond(bytes.dropFirst(65536), status: 206, fields: ["ETag":"\"changed\"", "Content-Range":"bytes 65536-\(bytes.count-1)/\(bytes.count)"]) }
        _ = try manager.resume(id: partial.id)
        let failed = try wait(partial.id, state: "failed")
        XCTAssertTrue(failed.error!.contains("resume identity"))
        XCTAssertEqual(failed.downloadedBytes, 65536)
        XCTAssertTrue(try store.listModels().models.isEmpty)
    }
    func testServerIgnoringRangeRestartsAndChecksWholeFile() throws {
        let partial = try failAfterPrefix(); let bytes = self.bytes
        DownloadProtocol.handler = { $0.respond(bytes, fields: ["ETag":"\"new\""]) }
        _ = try manager.resume(id: partial.id)
        _ = try wait(partial.id, state: "complete")
        XCTAssertEqual(try Data(contentsOf: store.downloadModelURL(id: partial.id)), bytes)
    }
    func testBadHashNeverActivatesAndDiscardsUntrustedPartial() throws {
        let bytes = self.bytes; DownloadProtocol.handler = { $0.respond(bytes) }
        var invalid = source(); invalid.sha256 = String(repeating: "0", count: 64)
        let record = try manager.start(source: invalid, name: "Fixture")
        let failed = try wait(record.id, state: "failed")
        XCTAssertTrue(failed.error!.contains("SHA-256")); XCTAssertEqual(failed.downloadedBytes, 0)
        XCTAssertTrue(try store.listModels().models.isEmpty)
    }
    func testLengthMismatchNeverActivates() throws {
        let bytes = self.bytes; DownloadProtocol.handler = { $0.respond(bytes, fields: ["Content-Length":"999"]) }
        let record = try manager.start(source: source(), name: "Fixture")
        XCTAssertTrue(try wait(record.id, state: "failed").error!.contains("length"))
        XCTAssertTrue(try store.listModels().models.isEmpty)
    }
    func testSuspensionPausesAndDoesNotResumeOnReopen() throws {
        let started = expectation(description: "started")
        DownloadProtocol.handler = { _ in started.fulfill() }
        let record = try manager.start(source: source(), name: "Fixture")
        wait(for: [started], timeout: 3)
        let wrong = expectation(description: "wrong id")
        manager.cancel(id: UUID().uuidString.lowercased()) { wrong.fulfill() }
        wait(for: [wrong], timeout: 1)
        XCTAssertEqual(try manager.list().first?.state, "queued")
        manager.suspend()
        _ = try wait(record.id, state: "paused")
        DownloadProtocol.handler = { _ in XCTFail("Restart must not resume") }
        manager = try makeManager()
        XCTAssertEqual(try manager.list().first?.state, "paused")
    }
    func testRecoversCrashAfterRenameBeforeInventoryCommitWithoutNetwork() throws {
        let partial = try failAfterPrefix()
        let part = root.appendingPathComponent("model-downloads/\(partial.id)/model.part")
        try bytes.write(to: part)
        try FileManager.default.moveItem(at: part, to: store.downloadModelURL(id: partial.id))
        DownloadProtocol.handler = { _ in XCTFail("Complete candidate must verify offline") }
        _ = try manager.resume(id: partial.id)
        _ = try wait(partial.id, state: "complete")
        _ = try manager.resume(id: partial.id)
        XCTAssertEqual(try store.listModels().models.count, 1)
    }
    func testSourceResolutionUsesHEADAndCanCancelBeforeHeaders() throws {
        let resolved = expectation(description: "source")
        DownloadProtocol.handler = { request in
            XCTAssertEqual(request.request.httpMethod, "HEAD")
            request.respond(Data(), fields: ["Content-Length":"1234"])
        }
        var identity = source(); identity.sizeBytes = nil
        manager.resolve(identity) { result in XCTAssertEqual(try? result.get().sizeBytes, 1234); resolved.fulfill() }
        wait(for: [resolved], timeout: 3)
        let pending = expectation(description: "pending"), cancelled = expectation(description: "cancelled")
        DownloadProtocol.handler = { _ in pending.fulfill() }
        manager.resolve(identity) { result in
            if case .success = result { XCTFail("Cancelled metadata must not become a source") }
            cancelled.fulfill()
        }
        wait(for: [pending], timeout: 3); manager.cancelSourceResolution()
        wait(for: [cancelled], timeout: 3)
    }
    func testWrongRangeAndInvalidGGUFNeverActivate() throws {
        let partial = try failAfterPrefix(); let bytes = self.bytes
        DownloadProtocol.handler = { $0.respond(bytes.dropFirst(65536), status: 206, fields: ["Content-Range":"bytes 0-65535/131072"]) }
        _ = try manager.resume(id: partial.id)
        XCTAssertTrue(try wait(partial.id, state: "failed").error!.contains("byte range"))
        let invalid = Data("this is not a GGUF model".utf8)
        var source = source(); source.sizeBytes = Int64(invalid.count)
        source.sha256 = SHA256.hash(data: invalid).map { String(format: "%02x", $0) }.joined()
        DownloadProtocol.handler = { $0.respond(invalid) }
        let record = try manager.start(source: source, name: "Invalid")
        XCTAssertTrue(try wait(record.id, state: "failed").error!.contains("GGUF"))
        XCTAssertTrue(try store.listModels().models.isEmpty)
    }
    func testRestartNormalizesUnfinishedStateAndRejectsDanglingPartialLink() throws {
        let partial = try failAfterPrefix()
        let folder = root.appendingPathComponent("model-downloads/\(partial.id)")
        let journal = folder.appendingPathComponent("download.json")
        var raw = try JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as! [String:Any]
        raw["state"] = "downloading"
        try JSONSerialization.data(withJSONObject: raw).write(to: journal)
        DownloadProtocol.handler = { _ in XCTFail("Reopening cannot initiate a transfer") }
        manager = try makeManager()
        XCTAssertEqual(try manager.list().first?.state, "paused")
        let file = folder.appendingPathComponent("model.part")
        try FileManager.default.removeItem(at: file)
        let outside = root.appendingPathComponent("must-not-be-created")
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
        XCTAssertThrowsError(try manager.resume(id: partial.id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
    }
    func testSourceIdentityAndRedirectsAreConfined() throws {
        var invalid = source(); invalid.filename = "../model.gguf"; XCTAssertThrowsError(try invalid.validate(exact: true))
        invalid = source(); invalid.revision = "main"; XCTAssertThrowsError(try invalid.validate(exact: true))
        for value in ["http://huggingface.co/file", "https://evil.test/file", "https://huggingface.co.evil.test/file", "https://user@hf.co/file", "https://hf.co:444/file"] { XCTAssertThrowsError(try MobileModelSource.validateURL(URL(string: value)!)) }
        XCTAssertNoThrow(try MobileModelSource.validateURL(URL(string: "https://cas-bridge.xethub.hf.co/file")!))
    }
}
