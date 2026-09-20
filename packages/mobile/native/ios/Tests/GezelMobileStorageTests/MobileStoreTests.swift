import Foundation
import XCTest
@testable import GezelMobileStorage

final class MobileStoreTests: XCTestCase {
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    func testStateRoundTripsAcrossReopenAndInvalidWritePreservesPriorState() throws {
        let store = try MobileStore(root: root)
        XCTAssertNil(try store.readState())
        let state = "{\"version\":1,\"messages\":[{\"content\":\"hello\"}]}"
        try store.writeState(state)
        XCTAssertThrowsError(try store.writeState("unfinished {"))
        XCTAssertEqual(try MobileStore(root: root).readState(), state)
    }

    func testOversizedPersistedStateIsRejectedBeforeReading() throws {
        let store = try MobileStore(root: root)
        let file = root.appendingPathComponent("state.json")
        XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil))
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(MobileStore.maximumStateBytes + 1))
        try handle.close()
        XCTAssertThrowsError(try store.readState()) { error in
            guard case MobileStoreError.stateTooLarge = error else { return XCTFail("Wrong error: \(error)") }
        }
    }

    func testImportedModelsAreCopiedAndSelectedByOpaqueId() throws {
        let source = root.appendingPathComponent("tiny.gguf")
        try Data("GGUFfixture".utf8).write(to: source)
        let store = try MobileStore(root: root.appendingPathComponent("app"))
        let model = try store.importModel(from: source)
        try FileManager.default.removeItem(at: source)
        let reopened = try MobileStore(root: root.appendingPathComponent("app"))
        XCTAssertEqual(try reopened.listModels().selectedModelId, model.id)
        let (selected, url) = try reopened.selectedModelURL()
        XCTAssertEqual(selected, model)
        XCTAssertEqual(try Data(contentsOf: url), Data("GGUFfixture".utf8))
        XCTAssertThrowsError(try reopened.selectModel(id: "../../outside"))
    }

    func testInterruptedImportIsDiscardedAndBadMagicRejected() throws {
        let models = root.appendingPathComponent("models")
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        let partial = models.appendingPathComponent("interrupted.partial")
        try Data("partial".utf8).write(to: partial)
        let store = try MobileStore(root: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
        let bad = root.appendingPathComponent("bad.gguf")
        try Data("not a model".utf8).write(to: bad)
        XCTAssertThrowsError(try store.importModel(from: bad))
        XCTAssertTrue(try store.listModels().models.isEmpty)
    }

    func testModelSymlinksCannotEscapeThePrivateStore() throws {
        let source = root.appendingPathComponent("tiny.gguf")
        try Data("GGUFfixture".utf8).write(to: source)
        let app = root.appendingPathComponent("app")
        let store = try MobileStore(root: app)
        let model = try store.importModel(from: source)
        let target = app.appendingPathComponent("models/\(model.id).gguf")
        try FileManager.default.removeItem(at: target)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: source)
        XCTAssertThrowsError(try store.selectedModelURL())
    }

    func testRemovalClearsSelectionWithoutChoosingAnotherModel() throws {
        let source = root.appendingPathComponent("tiny.gguf")
        try Data("GGUFfixture".utf8).write(to: source)
        let app = root.appendingPathComponent("app")
        let store = try MobileStore(root: app)
        let first = try store.importModel(from: source)
        let second = try store.importModel(from: source)
        try store.removeModel(id: first.id)
        let library = try MobileStore(root: app).listModels()
        XCTAssertEqual(library.models.map(\.id), [second.id])
        XCTAssertNil(library.selectedModelId)
        XCTAssertThrowsError(try store.selectedModelURL())
        XCTAssertFalse(FileManager.default.fileExists(atPath: app.appendingPathComponent("models/\(first.id).gguf").path))
        _ = try store.importModel(from: source)
        XCTAssertNil(try store.listModels().selectedModelId)
        XCTAssertThrowsError(try store.removeModel(id: "../../outside"))
    }

    func testInterruptedRemovalRecoversAccordingToAtomicInventory() throws {
        let source = root.appendingPathComponent("tiny.gguf")
        try Data("GGUFfixture".utf8).write(to: source)
        let app = root.appendingPathComponent("app")
        let store = try MobileStore(root: app)
        let model = try store.importModel(from: source)
        let original = app.appendingPathComponent("models/\(model.id).gguf")
        let tombstone = app.appendingPathComponent("models/\(model.id).deleting")
        try FileManager.default.moveItem(at: original, to: tombstone)
        let reopened = try MobileStore(root: app)
        XCTAssertEqual(try reopened.selectedModelURL().0.id, model.id)
        try reopened.removeModel(id: model.id)
        try Data("GGUFleftover".utf8).write(to: tombstone)
        _ = try MobileStore(root: app)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tombstone.path))
    }

    func testMalformedAndOversizedLibrariesArePreservedAndRejected() throws {
        let store = try MobileStore(root: root)
        let file = root.appendingPathComponent("models.json")
        let id = UUID().uuidString.lowercased()
        let valid: [String: Any] = ["id": id, "name": "model.gguf", "sizeBytes": 4]
        var badModels: [[String: Any]] = []
        var bad = valid; bad["id"] = id.uppercased(); badModels.append(bad)
        bad = valid; bad["name"] = String(repeating: "x", count: 201); badModels.append(bad)
        bad = valid; bad["sizeBytes"] = MobileStore.maximumModelBytes + 1; badModels.append(bad)
        for model in badModels {
            let data = try JSONSerialization.data(withJSONObject: ["models": [model]])
            try data.write(to: file)
            XCTAssertThrowsError(try store.listModels())
            XCTAssertEqual(try Data(contentsOf: file), data)
        }
        for object: [String: Any] in [
            ["models": [valid, valid]],
            ["models": [valid], "selectedModelId": UUID().uuidString.lowercased()],
            ["models": (0..<101).map { _ in ["id": UUID().uuidString.lowercased(), "name": "model", "sizeBytes": 4] as [String: Any] }]
        ] {
            try JSONSerialization.data(withJSONObject: object).write(to: file)
            XCTAssertThrowsError(try store.listModels())
        }
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 1024 * 1024 + 1)
        try handle.close()
        XCTAssertThrowsError(try store.listModels())
    }
}
