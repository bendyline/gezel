import Foundation
import XCTest
import GezelModelStorage

final class StorageRootTests: XCTestCase {
    private let fm = FileManager.default
    private var temporary: URL!

    override func setUpWithError() throws {
        temporary = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: temporary, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try fm.removeItem(at: temporary) }

    func testLinkedStorageDirectoriesRejectBeforeCleanup() throws {
        for linkRoot in [true, false] {
            for recover in [true, false] {
                let base = temporary.appendingPathComponent(UUID().uuidString, isDirectory: true)
                let outside = base.appendingPathComponent("outside", isDirectory: true)
                let sentinelParent = linkRoot ? outside.appendingPathComponent("models", isDirectory: true) : outside
                try fm.createDirectory(at: sentinelParent, withIntermediateDirectories: true)
                let root = base.appendingPathComponent("gezel", isDirectory: true)
                if !linkRoot { try fm.createDirectory(at: root, withIntermediateDirectories: true) }
                let sentinel = sentinelParent.appendingPathComponent("keep.partial")
                let bytes = Data([1, 2, 3])
                try bytes.write(to: sentinel)
                try fm.createSymbolicLink(at: linkRoot ? root : root.appendingPathComponent("models"), withDestinationURL: outside)
                XCTAssertThrowsError(try MobileModelStore(root: root, recoverModels: recover))
                XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
            }
        }
    }

    func testDanglingLinksDoNotCreateOutsideDirectories() throws {
        for linkRoot in [true, false] {
            let base = temporary.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try fm.createDirectory(at: base, withIntermediateDirectories: true)
            let root = base.appendingPathComponent("gezel", isDirectory: true)
            if !linkRoot { try fm.createDirectory(at: root, withIntermediateDirectories: true) }
            let outside = base.appendingPathComponent("missing", isDirectory: true)
            try fm.createSymbolicLink(at: linkRoot ? root : root.appendingPathComponent("models"), withDestinationURL: outside)
            XCTAssertThrowsError(try MobileModelStore(root: root))
            XCTAssertFalse(fm.fileExists(atPath: outside.path))
        }
    }

    func testTrustedParentAliasAndOrdinaryRecoveryStillWork() throws {
        let parent = temporary.appendingPathComponent("app-files", isDirectory: true)
        try fm.createDirectory(at: parent, withIntermediateDirectories: true)
        let alias = temporary.appendingPathComponent("alias", isDirectory: true)
        try fm.createSymbolicLink(at: alias, withDestinationURL: parent)
        let requested = alias.appendingPathComponent("gezel", isDirectory: true)
        let expected = parent.appendingPathComponent("gezel", isDirectory: true).resolvingSymlinksInPath()
        XCTAssertEqual(try MobileModelStore.validatedRoot(requested).path, expected.path)
        _ = try MobileModelStore(root: requested)
        let partial = expected.appendingPathComponent("models/interrupted.partial")
        try Data([7]).write(to: partial)
        _ = try MobileModelStore(root: requested, recoverModels: false)
        XCTAssertTrue(fm.fileExists(atPath: partial.path))
        _ = try MobileModelStore(root: requested)
        XCTAssertFalse(fm.fileExists(atPath: partial.path))
    }
}
