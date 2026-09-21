import Foundation
import XCTest

final class EvalDataPreservationTests: XCTestCase {
    var root: URL!
    let fm = FileManager.default
    override func setUpWithError() throws {
        root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: root.appendingPathComponent("product/empty"), withIntermediateDirectories: true)
        try put("product/config.json", Data("original config".utf8))
        try put("product/projects/alpha/workspace/blob.bin", Data([0, 255, 17, 0, 128]))
        try put("product/.transactions/pending.json", Data("hidden journal".utf8))
        try put("models.json", Data("original selected model".utf8))
        try put("models.json.bak", Data("original recovery bytes".utf8))
        try put("models/user.gguf", Data("untouched model weights".utf8))
    }
    override func tearDownWithError() throws { try fm.removeItem(at: root) }
    func put(_ path: String, _ bytes: Data) throws {
        let file = root.appendingPathComponent(path)
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: file)
    }
    func testRestoresEveryProductByteAndInventoryFilePresenceAfterAnEval() throws {
        let original = try EvalDataPreservation.tree(root.appendingPathComponent("product"))
        let preservation = try EvalDataPreservation.begin(root: root)
        XCTAssertTrue(try fm.contentsOfDirectory(at: preservation.product, includingPropertiesForKeys: nil).isEmpty)
        try put("product/eval-only.txt", Data("temporary eval output".utf8))
        try put("models.json", Data("changed selection".utf8))
        try fm.removeItem(at: root.appendingPathComponent("models.json.bak"))
        try put("models.json.new", Data("new temporary inventory".utf8))
        let receipt = try preservation.restoreAndVerify()
        XCTAssertTrue(receipt.passed)
        XCTAssertEqual(receipt.productFiles, 3)
        XCTAssertEqual(receipt.modelInventoryFiles, 3)
        XCTAssertEqual(receipt.productSHA256.count, 64)
        XCTAssertEqual(receipt.modelInventorySHA256.count, 64)
        XCTAssertEqual(receipt.productSHA256, receipt.restoredProductSHA256)
        XCTAssertEqual(receipt.modelInventorySHA256, receipt.restoredModelInventorySHA256)
        XCTAssertEqual(try EvalDataPreservation.tree(preservation.product), original)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("models.json")), Data("original selected model".utf8))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("models.json.bak")), Data("original recovery bytes".utf8))
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("models.json.new").path))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("models/user.gguf")), Data("untouched model weights".utf8))
        XCTAssertFalse(fm.fileExists(atPath: preservation.backup.path))
    }
    func testBackupContainsDurableInventoryAndBlocksAnotherRunAfterInterruption() throws {
        let preservation = try EvalDataPreservation.begin(root: root)
        let saved = try JSONDecoder().decode(EvalDataPreservation.Snapshot.self,
            from: Data(contentsOf: preservation.backup.appendingPathComponent("snapshot.json")))
        XCTAssertEqual(saved, preservation.original)
        XCTAssertNotNil(saved.inventory.first(where: { $0.name == "models.json" })?.bytes)
        XCTAssertTrue(fm.fileExists(atPath: preservation.backup.appendingPathComponent("product/config.json").path))
        XCTAssertThrowsError(try EvalDataPreservation.begin(root: root))
        XCTAssertTrue(fm.fileExists(atPath: preservation.backup.path))
    }
    func testDamagedBackupIsRetainedAndNeverReplacesTheCurrentProduct() throws {
        let preservation = try EvalDataPreservation.begin(root: root)
        try put("product/eval-only.txt", Data("current output".utf8))
        try Data("corrupted original".utf8).write(to: preservation.backup.appendingPathComponent("product/config.json"))
        XCTAssertThrowsError(try preservation.restoreAndVerify())
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("product/eval-only.txt").path))
        XCTAssertTrue(fm.fileExists(atPath: preservation.backup.path))
    }
    func testFullTreeSnapshotDetectsChangedBytesAddedDeletedFilesAndEmptyDirectories() throws {
        let product = root.appendingPathComponent("product")
        let original = try EvalDataPreservation.tree(product)
        try put("product/config.json", Data("changed config".utf8))
        XCTAssertNotEqual(try EvalDataPreservation.tree(product), original)
        try put("product/config.json", Data("original config".utf8))
        try fm.removeItem(at: product.appendingPathComponent("empty"))
        XCTAssertNotEqual(try EvalDataPreservation.tree(product), original)
        try fm.createDirectory(at: product.appendingPathComponent("empty"), withIntermediateDirectories: false)
        try put("product/unexpected.txt", Data())
        XCTAssertNotEqual(try EvalDataPreservation.tree(product), original)
    }
    func testExistingLegacyBackupAndSymlinksRefuseIsolationWithoutTouchingUserData() throws {
        let previous = root.appendingPathComponent("product-smoke-backup-previous")
        try fm.createDirectory(at: previous, withIntermediateDirectories: false)
        XCTAssertThrowsError(try EvalDataPreservation.begin(root: root))
        try fm.removeItem(at: previous)
        try fm.createSymbolicLink(at: root.appendingPathComponent("product/link"), withDestinationURL: root.appendingPathComponent("models/user.gguf"))
        XCTAssertThrowsError(try EvalDataPreservation.begin(root: root))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("product/config.json")), Data("original config".utf8))
    }
}
