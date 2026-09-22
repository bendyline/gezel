import Foundation

public struct MobileModel: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let sizeBytes: Int64
    public var source: MobileModelSource? = nil
}

public struct MobileModelLibrary: Codable, Equatable, Sendable {
    public var models: [MobileModel]
    public var selectedModelId: String?
}

public enum MobileStoreError: LocalizedError {
    case invalidState, stateTooLarge, invalidModel, unknownModel, invalidLibrary, libraryFull, insufficientDisk

    public var errorDescription: String? {
        switch self {
        case .invalidState: return "The saved conversation must be valid JSON."
        case .stateTooLarge: return "The saved conversation exceeds the 16 MB limit."
        case .invalidModel: return "Choose a GGUF model file."
        case .unknownModel: return "This model is no longer available. Import it again."
        case .invalidLibrary: return "The saved model library is invalid."
        case .libraryFull: return "The model library is full. Remove a model before importing another."
        case .insufficientDisk: return "There is not enough free space to copy this model."
        }
    }
}

/// Owns the app container's model inventory and copied models. Callers only exchange
/// opaque model IDs; no renderer-supplied path is ever resolved below this root.
open class MobileModelStore: @unchecked Sendable {
    public static let maximumStateBytes = 16 * 1024 * 1024
    public static let maximumModelBytes: Int64 = 4 * 1024 * 1024 * 1024
    private static let maximumLibraryBytes = 1024 * 1024
    private let root: URL
    private let modelsRoot: URL
    private let lock = NSRecursiveLock()
    private let fm = FileManager.default

    public init(root: URL, recoverModels: Bool = true) throws {
        self.root = root
        self.modelsRoot = root.appendingPathComponent("models", isDirectory: true)
        try fm.createDirectory(at: modelsRoot, withIntermediateDirectories: true)
        var modelDirectory = modelsRoot
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try modelDirectory.setResourceValues(values)
        // Product storage adapters may coexist with an already-running host.
        guard recoverModels else { return }
        // A killed import can leave only an unpublished temporary copy.
        for file in try fm.contentsOfDirectory(at: modelsRoot, includingPropertiesForKeys: nil)
        where file.pathExtension == "partial" {
            try? fm.removeItem(at: file)
        }
        // A removal first renames its file, then atomically changes inventory.
        // Restore or discard the tombstone based on which commit survived.
        if let library = try? readLibrary() {
            for file in try fm.contentsOfDirectory(at: modelsRoot, includingPropertiesForKeys: nil)
            where file.pathExtension == "deleting" {
                let id = file.deletingPathExtension().lastPathComponent
                guard Self.canonicalID(id) else { continue }
                if library.models.contains(where: { $0.id == id }) {
                    let original = modelsRoot.appendingPathComponent("\(id).gguf")
                    if !fm.fileExists(atPath: original.path) { try fm.moveItem(at: file, to: original) }
                } else { try? fm.removeItem(at: file) }
            }
        }
    }

    private static func canonicalID(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString.lowercased() == id
    }

    private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    public func downloadsDirectory() throws -> URL {
        try synchronized {
            let folder = root.appendingPathComponent("model-downloads", isDirectory: true)
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            guard try folder.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw MobileStoreError.invalidModel }
            var target = folder; var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
            try target.setResourceValues(attributes)
            return folder
        }
    }
    public func downloadModelURL(id: String) throws -> URL {
        guard Self.canonicalID(id) else { throw MobileStoreError.invalidModel }
        return modelsRoot.appendingPathComponent("\(id).gguf")
    }
    /// The manager hashes the confined source before calling this atomic publication boundary.
    public func publishDownloadedModel(id: String, name: String, source: MobileModelSource, file: URL) throws -> MobileModel {
        try synchronized {
            try source.validate(exact: true)
            var library = try readLibrary()
            if let existing = library.models.first(where: { $0.id == id }) {
                guard existing.source == source else { throw MobileStoreError.invalidModel }
                _ = try checkedModelURL(existing)
                return existing
            }
            guard library.models.count < 100 else { throw MobileStoreError.libraryFull }
            guard !name.isEmpty, name.utf16.count <= 200, !name.contains("\0") else { throw MobileStoreError.invalidModel }
            let target = try downloadModelURL(id: id)
            let partial = try downloadsDirectory().appendingPathComponent(id).appendingPathComponent("model.part")
            guard file == target || file == partial else { throw MobileStoreError.invalidModel }
            let values = try file.resourceValues(forKeys: [.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, Int64(values.fileSize ?? 0) == source.sizeBytes else { throw MobileStoreError.invalidModel }
            let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
            guard try input.read(upToCount: 4) == Data("GGUF".utf8) else { throw MobileStoreError.invalidModel }
            let model = MobileModel(id: id, name: name, sizeBytes: source.sizeBytes!, source: source)
            if file != target { try fm.moveItem(at: file, to: target) }
            library.models.append(model)
            // A surviving file before the inventory commit is rehashed by the
            // durable download id on resume. It is never selected implicitly.
            try writeLibrary(library)
            return model
        }
    }

    public func listModels() throws -> MobileModelLibrary {
        try synchronized { try readLibrary() }
    }

    public func selectModel(id: String) throws -> MobileModel {
        try synchronized {
            var library = try readLibrary()
            guard let model = library.models.first(where: { $0.id == id }) else { throw MobileStoreError.unknownModel }
            _ = try checkedModelURL(model)
            library.selectedModelId = id
            try writeLibrary(library)
            return model
        }
    }

    public func modelURL(id: String) throws -> (MobileModel, URL) {
        try synchronized {
            guard let model = try readLibrary().models.first(where: { $0.id == id }) else {
                throw MobileStoreError.unknownModel
            }
            return (model, try checkedModelURL(model))
        }
    }

    public func selectedModelURL() throws -> (MobileModel, URL) {
        try synchronized {
            let library = try readLibrary()
            guard let model = library.models.first(where: { $0.id == library.selectedModelId }) else {
                throw MobileStoreError.unknownModel
            }
            return (model, try checkedModelURL(model))
        }
    }

    /// The caller obtains the URL from the native document picker, and owns
    /// its security-scoped access for this synchronous copy's duration.
    public func importModel(from source: URL) throws -> MobileModel {
        try synchronized {
            guard source.pathExtension.lowercased() == "gguf" else { throw MobileStoreError.invalidModel }
            var library = try readLibrary()
            guard library.models.count < 100 else { throw MobileStoreError.libraryFull }
            let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            let sourceSize = Int64(values.fileSize ?? 0)
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  (4...Self.maximumModelBytes).contains(sourceSize) else { throw MobileStoreError.invalidModel }
            let available = try fm.attributesOfFileSystem(forPath: modelsRoot.path)[.systemFreeSize] as? NSNumber
            guard let available, available.int64Value >= sourceSize + 64 * 1024 * 1024 else { throw MobileStoreError.insufficientDisk }
            let file = try FileHandle(forReadingFrom: source)
            defer { try? file.close() }
            let magic = try file.read(upToCount: 4)
            guard magic == Data("GGUF".utf8) else { throw MobileStoreError.invalidModel }
            let id = UUID().uuidString.lowercased()
            let partial = modelsRoot.appendingPathComponent("\(id).partial")
            let target = modelsRoot.appendingPathComponent("\(id).gguf")
            defer { try? fm.removeItem(at: partial) }
            guard fm.createFile(atPath: partial.path, contents: nil) else { throw MobileStoreError.insufficientDisk }
            let output = try FileHandle(forWritingTo: partial)
            defer { try? output.close() }
            try output.write(contentsOf: magic!)
            var bytes: Int64 = 4
            while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                bytes += Int64(chunk.count)
                guard bytes <= Self.maximumModelBytes, bytes <= sourceSize else { throw MobileStoreError.invalidModel }
                try output.write(contentsOf: chunk)
            }
            guard bytes == sourceSize else { throw MobileStoreError.invalidModel }
            try output.synchronize()
            try output.close()
            let model = MobileModel(id: id, name: String(decoding: source.lastPathComponent.utf16.prefix(200), as: UTF16.self), sizeBytes: bytes)
            library.models.append(model)
            if library.models.count == 1 { library.selectedModelId = id }
            try fm.moveItem(at: partial, to: target)
            do { try writeLibrary(library) }
            catch {
                try? fm.removeItem(at: target)
                throw error
            }
            return model
        }
    }

    public func removeModel(id: String) throws {
        try synchronized {
            var library = try readLibrary()
            guard let index = library.models.firstIndex(where: { $0.id == id }) else { throw MobileStoreError.unknownModel }
            let original = modelsRoot.appendingPathComponent("\(id).gguf")
            let tombstone = modelsRoot.appendingPathComponent("\(id).deleting")
            let exists = (try? original.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]))
            if let exists {
                guard exists.isRegularFile == true || exists.isSymbolicLink == true else { throw MobileStoreError.invalidModel }
                try fm.moveItem(at: original, to: tombstone)
            }
            library.models.remove(at: index)
            if library.selectedModelId == id { library.selectedModelId = nil }
            do { try writeLibrary(library) }
            catch {
                if exists != nil { try? fm.moveItem(at: tombstone, to: original) }
                throw error
            }
            // Inventory is already committed; an interrupted/unavailable delete
            // is finished on next startup without resurrecting a removed model.
            if exists != nil { try? fm.removeItem(at: tombstone) }
        }
    }

    private func validateLibrary(_ library: MobileModelLibrary) throws {
        guard library.models.count <= 100,
              Set(library.models.map(\.id)).count == library.models.count,
              library.models.allSatisfy({ Self.canonicalID($0.id) && !$0.name.isEmpty && $0.name.utf16.count <= 200 && !$0.name.contains("\0") && (4...Self.maximumModelBytes).contains($0.sizeBytes) }),
              library.selectedModelId == nil || library.models.contains(where: { $0.id == library.selectedModelId })
        else { throw MobileStoreError.invalidLibrary }
        for model in library.models { if let source = model.source { try source.validate(exact: true); guard source.sizeBytes == model.sizeBytes else { throw MobileStoreError.invalidLibrary } } }
    }

    private func readLibrary() throws -> MobileModelLibrary {
        let file = root.appendingPathComponent("models.json")
        guard fm.fileExists(atPath: file.path) else { return MobileModelLibrary(models: [], selectedModelId: nil) }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        guard try handle.seekToEnd() <= Self.maximumLibraryBytes else { throw MobileStoreError.invalidLibrary }
        try handle.seek(toOffset: 0)
        let data = try handle.read(upToCount: Self.maximumLibraryBytes + 1) ?? Data()
        guard data.count <= Self.maximumLibraryBytes else { throw MobileStoreError.invalidLibrary }
        let library = try JSONDecoder().decode(MobileModelLibrary.self, from: data)
        try validateLibrary(library)
        return library
    }

    private func writeLibrary(_ library: MobileModelLibrary) throws {
        try validateLibrary(library)
        let data = try JSONEncoder().encode(library)
        guard data.count <= Self.maximumLibraryBytes else { throw MobileStoreError.invalidLibrary }
        try data.write(to: root.appendingPathComponent("models.json"), options: .atomic)
    }

    private func checkedModelURL(_ model: MobileModel) throws -> URL {
        guard Self.canonicalID(model.id) else { throw MobileStoreError.invalidLibrary }
        let url = modelsRoot.appendingPathComponent("\(model.id).gguf")
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, Int64(values.fileSize ?? 0) == model.sizeBytes else { throw MobileStoreError.unknownModel }
        return url
    }
}
