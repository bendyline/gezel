import Foundation

public struct ProductFileEntry: Sendable {
    public let name: String
    public let isDirectory: Bool
    public let size: Int64
    public let mtime: Double
}

public enum ProductFileError: LocalizedError {
    case invalidPath, unsafeFile, missingDirectory, notFile, tooLarge, destinationExists, tooManyEntries
    public var errorDescription: String? {
        switch self {
        case .invalidPath: return "Use a relative path inside Gezel's product files."
        case .unsafeFile: return "Symbolic links and special files are not allowed in product storage."
        case .missingDirectory: return "The product directory does not exist."
        case .notFile: return "This path is not a regular product file."
        case .tooLarge: return "Product files are limited to 16 MiB."
        case .destinationExists: return "The destination already exists."
        case .tooManyEntries: return "The directory contains too many entries."
        }
    }
}

/// A separate private product tree; legacy state and models are outside its authority.
public final class ProductFiles: @unchecked Sendable {
    public static let maximumFileBytes = 16 * 1024 * 1024
    private let root: URL
    private let fm = FileManager.default
    private let lock = NSRecursiveLock()

    public init(root: URL) throws {
        self.root = root.deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(root.lastPathComponent, isDirectory: true)
        if let attributes = try attributes(self.root), attributes[.type] as? FileAttributeType != .typeDirectory {
            throw ProductFileError.unsafeFile
        }
        try fm.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    private func attributes(_ url: URL) throws -> [FileAttributeKey: Any]? {
        do { return try fm.attributesOfItem(atPath: url.path) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) { return nil }
    }

    private func resolve(_ path: String, rootAllowed: Bool = false) throws -> URL {
        if path.isEmpty {
            guard rootAllowed else { throw ProductFileError.invalidPath }
            guard let attributes = try attributes(root), attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw ProductFileError.unsafeFile
            }
            return root
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.utf8.count <= 4096, parts.count <= 128, !path.contains("\\"), !path.contains("\0"),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else {
            throw ProductFileError.invalidPath
        }
        var current = try resolve("", rootAllowed: true)
        for (index, part) in parts.enumerated() {
            current.appendPathComponent(String(part))
            if let attributes = try attributes(current) {
                let type = attributes[.type] as? FileAttributeType
                guard type == .typeRegular || type == .typeDirectory else { throw ProductFileError.unsafeFile }
                if index < parts.count - 1 && type != .typeDirectory { throw ProductFileError.missingDirectory }
            }
        }
        return current
    }

    public func read(_ path: String) throws -> Data? {
        try synchronized {
            let url = try resolve(path)
            guard let attributes = try attributes(url) else { return nil }
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw ProductFileError.notFile }
            guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= Self.maximumFileBytes else { throw ProductFileError.tooLarge }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let bytes = try handle.read(upToCount: Self.maximumFileBytes + 1) ?? Data()
            guard bytes.count <= Self.maximumFileBytes else { throw ProductFileError.tooLarge }
            return bytes
        }
    }

    public func write(_ path: String, data: Data) throws {
        try synchronized {
            guard data.count <= Self.maximumFileBytes else { throw ProductFileError.tooLarge }
            let url = try resolve(path)
            if let attributes = try attributes(url), attributes[.type] as? FileAttributeType != .typeRegular {
                throw ProductFileError.notFile
            }
            guard (try attributes(url.deletingLastPathComponent()))?[.type] as? FileAttributeType == .typeDirectory else {
                throw ProductFileError.missingDirectory
            }
            try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        }
    }

    public func list(_ path: String) throws -> [ProductFileEntry] {
        try synchronized {
            let url = try resolve(path, rootAllowed: true)
            guard (try attributes(url))?[.type] as? FileAttributeType == .typeDirectory else { throw ProductFileError.missingDirectory }
            let children = try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
            guard children.count <= 10000 else { throw ProductFileError.tooManyEntries }
            return try children.map { child in
                let relative = path.isEmpty ? child.lastPathComponent : "\(path)/\(child.lastPathComponent)"
                _ = try resolve(relative)
                guard let attributes = try attributes(child) else { throw ProductFileError.unsafeFile }
                let directory = attributes[.type] as? FileAttributeType == .typeDirectory
                return ProductFileEntry(name: child.lastPathComponent, isDirectory: directory,
                    size: directory ? 0 : (attributes[.size] as? NSNumber)?.int64Value ?? 0,
                    mtime: ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000)
            }.sorted { $0.name < $1.name }
        }
    }

    public func mkdir(_ path: String) throws {
        try synchronized {
            let url = try resolve(path, rootAllowed: true)
            if let attributes = try attributes(url), attributes[.type] as? FileAttributeType != .typeDirectory {
                throw ProductFileError.notFile
            }
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private func checkTree(_ path: String, count: inout Int) throws {
        let url = try resolve(path)
        guard let attributes = try attributes(url) else { return }
        count += 1
        guard count <= 10000 else { throw ProductFileError.tooManyEntries }
        if attributes[.type] as? FileAttributeType == .typeDirectory {
            for child in try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) {
                try checkTree("\(path)/\(child.lastPathComponent)", count: &count)
            }
        }
    }

    public func remove(_ path: String) throws {
        try synchronized {
            let url = try resolve(path)
            var count = 0
            try checkTree(path, count: &count)
            if try attributes(url) != nil { try fm.removeItem(at: url) }
        }
    }

    public func rename(_ from: String, to: String) throws {
        try synchronized {
            let source = try resolve(from), destination = try resolve(to)
            guard !to.hasPrefix(from + "/") else { throw ProductFileError.invalidPath }
            guard try attributes(destination) == nil else { throw ProductFileError.destinationExists }
            guard (try attributes(destination.deletingLastPathComponent()))?[.type] as? FileAttributeType == .typeDirectory else {
                throw ProductFileError.missingDirectory
            }
            var count = 0
            try checkTree(from, count: &count)
            try fm.moveItem(at: source, to: destination)
        }
    }
}
