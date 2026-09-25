import CryptoKit
import Foundation

/// Test-only isolation. The AppTests target compiles this same helper; no app
/// plugin or production endpoint can create or restore an evaluation backup.
struct EvalDataPreservation {
    struct Tree: Codable, Equatable {
        var files: [String: String] = [:]
        var directories: [String] = []
    }
    struct InventoryFile: Codable, Equatable {
        let name: String
        let bytes: Data?
    }
    struct Snapshot: Codable, Equatable {
        let product: Tree
        let inventory: [InventoryFile]
    }
    struct Receipt: Codable {
        let passed: Bool
        let productFiles: Int
        let productDirectories: Int
        let modelInventoryFiles: Int
        let productSHA256: String
        let restoredProductSHA256: String
        let modelInventorySHA256: String
        let restoredModelInventorySHA256: String
    }
    let root: URL
    let backup: URL
    let original: Snapshot
    var product: URL { root.appendingPathComponent("product", isDirectory: true) }
    private static let inventoryNames = ["models.json", "models.json.bak", "models.json.new"]
    private static var fm: FileManager { FileManager() }

    private static func fail(_ message: String) -> NSError {
        NSError(domain: "MobileEvalPreservation", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private static func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    static func tree(_ root: URL) throws -> Tree {
        var snapshot = Tree()
        func walk(_ directory: URL, relative: String) throws {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw fail("Product preservation requires an ordinary directory: \(directory.path)")
            }
            for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                let path = relative.isEmpty ? file.lastPathComponent : relative + "/" + file.lastPathComponent
                let kind = try file.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
                guard kind.isSymbolicLink != true else { throw fail("Refusing to follow a linked product file: \(path)") }
                if kind.isDirectory == true {
                    snapshot.directories.append(path)
                    try walk(file, relative: path)
                } else {
                    guard kind.isRegularFile == true else { throw fail("Unsupported product file: \(path)") }
                    let handle = try FileHandle(forReadingFrom: file)
                    defer { try? handle.close() }
                    var hash = SHA256()
                    while let bytes = try handle.read(upToCount: 65_536), !bytes.isEmpty { hash.update(data: bytes) }
                    snapshot.files[path] = hash.finalize().map { String(format: "%02x", $0) }.joined()
                }
            }
        }
        try walk(root, relative: "")
        return snapshot
    }
    private static func inventory(_ root: URL) throws -> [InventoryFile] {
        try inventoryNames.map { name in
            let file = root.appendingPathComponent(name)
            guard (try? fm.destinationOfSymbolicLink(atPath: file.path)) == nil else { throw fail("Refusing a linked model inventory: \(name)") }
            let exists = fm.fileExists(atPath: file.path)
            if exists {
                let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw fail("Invalid model inventory file: \(name)") }
            }
            return InventoryFile(name: name, bytes: exists ? try Data(contentsOf: file) : nil)
        }
    }
    static func begin(root: URL) throws -> EvalDataPreservation {
        let unresolved = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("product-eval-backup-") || $0.lastPathComponent.hasPrefix("product-smoke-backup-") }
        guard unresolved == nil else { throw fail("Recover the preserved product backup before another eval: \(unresolved!.path)") }
        let product = root.appendingPathComponent("product", isDirectory: true)
        let snapshot = Snapshot(product: try tree(product), inventory: try inventory(root))
        let backup = root.appendingPathComponent("product-eval-backup-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: backup, withIntermediateDirectories: false)
        var moved = false
        do {
            // Keep inventory originals durable too: a force-killed quality run
            // must not lose them with the XCTest process's memory.
            try encoded(snapshot).write(to: backup.appendingPathComponent("snapshot.json"), options: .atomic)
            try Data("Preserved eval data. product/ contains the original product; snapshot.json contains original inventory bytes and file digests. Stop the app before recovery.\n".utf8)
                .write(to: backup.appendingPathComponent("README.txt"), options: .atomic)
            try fm.moveItem(at: product, to: backup.appendingPathComponent("product", isDirectory: true))
            moved = true
            try fm.createDirectory(at: product, withIntermediateDirectories: false)
            return EvalDataPreservation(root: root, backup: backup, original: snapshot)
        } catch {
            if moved { try fm.moveItem(at: backup.appendingPathComponent("product"), to: product) }
            try fm.removeItem(at: backup)
            throw error
        }
    }
    func restoreAndVerify() throws -> Receipt {
        let savedProduct = backup.appendingPathComponent("product", isDirectory: true)
        guard try Data(contentsOf: backup.appendingPathComponent("snapshot.json")) == Self.encoded(original),
              try Self.tree(savedProduct) == original.product else {
            throw Self.fail("Preserved eval backup differs from its original digests; backup retained at \(backup.path)")
        }
        // Retain the original until the restored copy and inventory are proven.
        let staged = backup.appendingPathComponent("restoring-product", isDirectory: true)
        try Self.fm.copyItem(at: savedProduct, to: staged)
        guard try Self.tree(staged) == original.product else { throw Self.fail("Staged product restore failed verification") }
        if Self.fm.fileExists(atPath: product.path) { try Self.fm.removeItem(at: product) }
        try Self.fm.moveItem(at: staged, to: product)
        for entry in original.inventory {
            let file = root.appendingPathComponent(entry.name)
            if (try? Self.fm.destinationOfSymbolicLink(atPath: file.path)) != nil { try Self.fm.removeItem(at: file) }
            if let bytes = entry.bytes { try bytes.write(to: file, options: .atomic) }
            else if Self.fm.fileExists(atPath: file.path) { try Self.fm.removeItem(at: file) }
        }
        let restoredProduct = try Self.tree(product)
        let restoredInventory = try Self.inventory(root)
        guard restoredProduct == original.product, restoredInventory == original.inventory else {
            throw Self.fail("Original product bytes and model inventory were not restored; backup retained at \(backup.path)")
        }
        let receipt = Receipt(passed: true, productFiles: original.product.files.count,
                              productDirectories: original.product.directories.count,
                              modelInventoryFiles: original.inventory.count,
                              productSHA256: Self.digest(try Self.encoded(original.product)),
                              restoredProductSHA256: Self.digest(try Self.encoded(restoredProduct)),
                              modelInventorySHA256: Self.digest(try Self.encoded(original.inventory)),
                              restoredModelInventorySHA256: Self.digest(try Self.encoded(restoredInventory)))
        try Self.fm.removeItem(at: backup)
        return receipt
    }
}
