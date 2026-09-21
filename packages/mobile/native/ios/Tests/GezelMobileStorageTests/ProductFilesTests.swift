import Foundation
import XCTest
@testable import GezelMobileStorage

final class ProductFilesTests: XCTestCase {
    var root: URL!
    var files: ProductFiles!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        files = try ProductFiles(root: root.appendingPathComponent("product"))
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    func testBinaryFilesAndDirectoryPublishSurviveReopen() throws {
        try files.mkdir(".transactions/draft/projects")
        let bytes = Data([0, 255, 1, 2])
        try files.write(".transactions/draft/projects/project.json", data: bytes)
        try files.rename(".transactions/draft/projects", to: "projects")
        XCTAssertEqual(try ProductFiles(root: root.appendingPathComponent("product")).read("projects/project.json"), bytes)
        let entries = try files.list("projects")
        XCTAssertEqual(entries.map(\.name), ["project.json"])
        XCTAssertEqual(entries.first?.size, 4)
        XCTAssertFalse(entries.first!.isDirectory)
        XCTAssertGreaterThan(entries.first!.mtime, 0)
        try files.remove("projects")
        XCTAssertNil(try files.read("projects/project.json"))
    }

    func testRejectsEscapesLinksAndRootMutationWithoutChangingSibling() throws {
        let outside = root.appendingPathComponent("outside")
        try Data("keep".utf8).write(to: outside)
        for path in ["", "../outside", "/outside", "documents/../outside", "documents//x", "a\\b", "a\0b", "./x"] {
            XCTAssertThrowsError(try files.write(path, data: Data()))
            XCTAssertThrowsError(try files.remove(path))
        }
        try files.mkdir("documents")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("product/documents/link"), withDestinationURL: outside)
        XCTAssertThrowsError(try files.read("documents/link"))
        XCTAssertThrowsError(try files.write("documents/link", data: Data()))
        XCTAssertThrowsError(try files.remove("documents"))
        XCTAssertThrowsError(try files.rename("documents", to: "renamed"))
        XCTAssertEqual(try Data(contentsOf: outside), Data("keep".utf8))
    }

    func testFailedReplacementAndRenamePreserveOriginal() throws {
        try files.write("config.json", data: Data("old".utf8))
        XCTAssertThrowsError(try files.write("config.json", data: Data(count: ProductFiles.maximumFileBytes + 1)))
        try files.write("other.json", data: Data("other".utf8))
        XCTAssertThrowsError(try files.rename("config.json", to: "other.json"))
        XCTAssertEqual(try files.read("config.json"), Data("old".utf8))
        XCTAssertEqual(try files.read("other.json"), Data("other".utf8))
        XCTAssertThrowsError(try files.rename("config.json", to: ""))
        try files.mkdir("")
        XCTAssertEqual(try files.list("").count, 2)
    }

    func testSymlinkedRootAndOversizedExistingFileAreRejected() throws {
        let link = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.appendingPathComponent("product"))
        XCTAssertThrowsError(try ProductFiles(root: link))
        try files.write("oversized", data: Data())
        let handle = try FileHandle(forWritingTo: root.appendingPathComponent("product/oversized"))
        try handle.truncate(atOffset: UInt64(ProductFiles.maximumFileBytes + 1))
        try handle.close()
        XCTAssertThrowsError(try files.read("oversized"))
    }
}
