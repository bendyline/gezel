import Foundation
#if canImport(GezelModelStorage)
@_exported import GezelModelStorage
#endif

public final class MobileStore: MobileModelStore, @unchecked Sendable {
    public let productFiles: ProductFiles
    private let root: URL
    private let fm = FileManager.default
    private let stateLock = NSLock()
    public override init(root: URL, recoverModels: Bool = true) throws {
        self.root = root
        self.productFiles = try ProductFiles(root: root.appendingPathComponent("product", isDirectory: true))
        try super.init(root: root, recoverModels: recoverModels)
    }
    private func withStateLock<T>(_ body: () throws -> T) rethrows -> T {
        stateLock.lock(); defer { stateLock.unlock() }
        return try body()
    }
    public func readState() throws -> String? {
        try withStateLock {
            let file = root.appendingPathComponent("state.json")
            guard fm.fileExists(atPath: file.path) else { return nil }
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maximumStateBytes else { throw MobileStoreError.stateTooLarge }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: Self.maximumStateBytes + 1) ?? Data()
            try validateState(data)
            guard let text = String(data: data, encoding: .utf8) else { throw MobileStoreError.invalidState }
            return text
        }
    }

    public func writeState(_ text: String) throws {
        try withStateLock {
            let data = Data(text.utf8)
            try validateState(data)
            try data.write(to: root.appendingPathComponent("state.json"), options: .atomic)
        }
    }

    private func validateState(_ data: Data) throws {
        guard data.count <= Self.maximumStateBytes else { throw MobileStoreError.stateTooLarge }
        guard (try? JSONSerialization.jsonObject(with: data)) != nil else { throw MobileStoreError.invalidState }
    }

}
