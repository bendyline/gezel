import Foundation
import CryptoKit

public struct MobileModelDownload: Codable, Sendable {
    public let id: String
    public let name: String
    public let source: MobileModelSource
    public var state: String
    public var downloadedBytes: Int64
    public var error: String?
    public var modelId: String?
    var etag: String?
    public func json() throws -> [String: Any] {
        var result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String:Any]
        result.removeValue(forKey: "etag")
        return result
    }
}

/// Foreground streaming acquisition, independent of inference and product files.
public final class ModelDownloads: @unchecked Sendable {
    private let store: MobileStore
    private let root: URL
    private let configuration: URLSessionConfiguration
    private let queue = DispatchQueue(label: "com.bendyline.gezel.model-download")
    private let sourceQueue = DispatchQueue(label: "com.bendyline.gezel.model-source")
    private let journalLock = NSRecursiveLock()
    private var sourcePending = false
    private var sourceCancelled = false
    private var sourceTransfer: ModelDownloadHTTP?
    private let cancellationLock = NSLock()
    private var cancelled = false
    private var cancelIdentity: String?
    private var activeId: String?
    private var transfer: ModelDownloadHTTP?
    private var output: FileHandle?
    private var current: MobileModelDownload?
    private var offset: Int64 = 0
    private var checkpoint: Int64 = 0
    private var cancelCallbacks: [@Sendable () -> Void] = []
    private let fm = FileManager.default

    public init(store: MobileStore, configuration: URLSessionConfiguration = .ephemeral) throws {
        self.store = store; self.root = try store.downloadsDirectory(); self.configuration = configuration
        for var record in try records() where ["queued","downloading","verifying"].contains(record.state) {
            record.state = "paused"; record.error = "Download paused when the app closed. Resume when ready."
            record.downloadedBytes = try length(candidate(record))
            try save(record)
        }
    }
    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ModelDownloadError("Invalid download identity") }
        let url = root.appendingPathComponent(id, isDirectory: true)
        try rejectLink(url)
        return url
    }
    private func rejectLink(_ file: URL) throws {
        // attributesOfItem inspects dangling links too; fileExists follows them.
        if let attributes = try? fm.attributesOfItem(atPath: file.path), attributes[.type] as? FileAttributeType == .typeSymbolicLink {
            throw ModelDownloadError("Invalid model staging link")
        }
    }
    private func partial(_ record: MobileModelDownload) throws -> URL {
        let file = try folder(record.id).appendingPathComponent("model.part")
        try rejectLink(file); return file
    }
    private func candidate(_ record: MobileModelDownload) throws -> URL {
        let file = try partial(record)
        return fm.fileExists(atPath: file.path) ? file : try store.downloadModelURL(id: record.id)
    }
    private func length(_ file: URL) throws -> Int64 {
        guard fm.fileExists(atPath: file.path) else { return 0 }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw ModelDownloadError("Invalid model staging file") }
        return Int64(values.fileSize ?? 0)
    }
    private func read(_ id: String) throws -> MobileModelDownload {
        let url = try folder(id).appendingPathComponent("download.json")
        try rejectLink(url)
        guard try length(url) <= 32 * 1024 else { throw ModelDownloadError("Invalid download record") }
        var record = try JSONDecoder().decode(MobileModelDownload.self, from: Data(contentsOf: url))
        guard record.id == id, !record.name.isEmpty, record.name.utf16.count <= 200,
              ["queued","downloading","paused","verifying","complete","failed"].contains(record.state) else { throw ModelDownloadError("Invalid download record") }
        try record.source.validate(exact: true)
        if record.state != "complete" { record.downloadedBytes = min(try length(candidate(record)), record.source.sizeBytes!) }
        return record
    }
    private func records() throws -> [MobileModelDownload] {
        journalLock.lock(); defer { journalLock.unlock() }
        let entries = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        guard entries.count <= 16 else { throw ModelDownloadError("Download library exceeds its limit") }
        return try entries.map { try read($0.lastPathComponent) }
    }
    private func save(_ record: MobileModelDownload) throws {
        journalLock.lock(); defer { journalLock.unlock() }
        let directory = try folder(record.id)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(record).write(to: directory.appendingPathComponent("download.json"), options: .atomic)
    }
    private func checkCancelled() throws {
        cancellationLock.lock(); let stopped = cancelled; cancellationLock.unlock()
        if stopped { throw ModelDownloadError("Download paused") }
    }
    public func list() throws -> [MobileModelDownload] { try records() }
    private static func exactLength(_ text: String?) throws -> Int64 {
        guard let text, text.range(of: "^[0-9]{1,12}$", options: .regularExpression) != nil, let value = Int64(text) else {
            throw ModelDownloadError("Model source omitted a valid exact length")
        }
        return value
    }
    private static func etag(_ response: HTTPURLResponse) -> String? {
        guard let value = response.value(forHTTPHeaderField: "ETag"), value.utf8.count <= 512,
              value.range(of: "^\"[^\\r\\n\"]+\"$", options: .regularExpression) != nil else { return nil }
        return value
    }
    public func resolve(_ identity: MobileModelSource, completion: @escaping @Sendable (Result<MobileModelSource,Error>) -> Void) {
        cancellationLock.lock()
        guard !sourcePending else { cancellationLock.unlock(); completion(.failure(ModelDownloadError("A model source is already being checked"))); return }
        sourcePending = true; sourceCancelled = false; cancellationLock.unlock()
        sourceQueue.async {
            let done: @Sendable (Result<MobileModelSource,Error>) -> Void = { result in
                self.cancellationLock.lock()
                let cancelled = self.sourceCancelled
                self.sourceTransfer = nil; self.sourcePending = false; self.cancellationLock.unlock()
                completion(cancelled ? .failure(ModelDownloadError("Source lookup cancelled")) : result)
            }
            do {
                try identity.validate(exact: false)
                let box = ResolvedSource(identity)
                let request = try ModelDownloadHTTP(url: identity.url(), method: "HEAD", fields: [:], configuration: self.configuration,
                    queue: self.sourceQueue, headers: { response in
                        guard response.statusCode == 200 else { throw ModelDownloadError("Model source cannot be inspected (HTTP \(response.statusCode)). Gated models must be imported from Files.") }
                        box.source.sizeBytes = try Self.exactLength(response.value(forHTTPHeaderField: "Content-Length"))
                        try box.source.validate(exact: true)
                    }, chunk: { _ in throw ModelDownloadError("Model metadata request returned unexpected bytes") }, completion: { error in
                        if let error { done(.failure(error)) } else { done(.success(box.source)) }
                    })
                self.cancellationLock.lock()
                self.sourceTransfer = request
                let cancelled = self.sourceCancelled
                self.cancellationLock.unlock()
                request.start(); if cancelled { request.cancel() }
            } catch { done(.failure(error)) }
        }
    }
    public func cancelSourceResolution() {
        cancellationLock.lock(); sourceCancelled = true; let request = sourceTransfer; cancellationLock.unlock()
        request?.cancel()
    }
    public func suspend() { cancelSourceResolution(); cancel() }
    private final class ResolvedSource: @unchecked Sendable {
        var source: MobileModelSource
        init(_ source: MobileModelSource) { self.source = source }
    }
    private func space(for remaining: Int64) throws {
        let free = try fm.attributesOfFileSystem(forPath: root.path)[.systemFreeSize] as? NSNumber
        guard (free?.int64Value ?? 0) > remaining + 64 * 1024 * 1024 else { throw ModelDownloadError("Not enough storage for this model") }
    }
    public func start(source: MobileModelSource, name: String) throws -> MobileModelDownload {
        try queue.sync {
            guard activeId == nil else { throw ModelDownloadError("A model download is already running") }
            try source.validate(exact: true)
            guard !name.isEmpty, name.utf16.count <= 200, !name.contains("\0") else { throw ModelDownloadError("Invalid model name") }
            guard try records().count < 16 else { throw ModelDownloadError("Remove a saved download before starting another") }
            try space(for: source.sizeBytes!)
            let record = MobileModelDownload(id: UUID().uuidString.lowercased(), name: name, source: source, state: "queued", downloadedBytes: 0)
            try save(record); launch(record)
            return record
        }
    }
    public func resume(id: String) throws -> MobileModelDownload {
        try queue.sync {
            guard activeId == nil else { throw ModelDownloadError("A model download is already running") }
            var record = try read(id)
            if record.state == "complete" { return record }
            try space(for: record.source.sizeBytes! - record.downloadedBytes)
            record.state = "queued"; record.error = nil; try save(record); launch(record)
            return record
        }
    }
    private func launch(_ record: MobileModelDownload) {
        cancellationLock.lock(); cancelled = false; cancelIdentity = record.id; cancellationLock.unlock()
        activeId = record.id
        queue.async { self.begin(record) }
    }
    public func cancel(id: String? = nil, completion: @escaping @Sendable () -> Void = {}) {
        // Interrupt hashing too; it deliberately checks between bounded chunks.
        cancellationLock.lock()
        guard cancelIdentity != nil, id == nil || cancelIdentity == id else { cancellationLock.unlock(); completion(); return }
        cancelled = true; cancellationLock.unlock()
        queue.async {
            if let id, self.activeId != id { completion(); return }
            guard self.activeId != nil else { completion(); return }
            self.cancelCallbacks.append(completion)
            if let transfer = self.transfer { transfer.cancel() }
            else { self.finish(ModelDownloadError("Download paused")) }
        }
    }
    public func remove(id: String, completion: @escaping @Sendable (Result<Void,Error>) -> Void) {
        cancel(id: id) {
            self.queue.async {
                do { _ = try self.read(id); try self.fm.removeItem(at: self.folder(id)); completion(.success(())) }
                catch { completion(.failure(error)) }
            }
        }
    }
    private func begin(_ input: MobileModelDownload) {
        current = input
        do {
            let record = input; let expected = record.source.sizeBytes!
            let file = try candidate(record); offset = try length(file)
            guard offset <= expected else { throw ModelDownloadError("Saved partial exceeds expected model length") }
            try checkCancelled()
            if offset == expected { try verify(file); return }
            let part = try partial(record)
            if offset > 0 && record.etag == nil { try fm.removeItem(at: part); offset = 0 }
            let priorOffset = offset, priorTag = record.etag
            let fields = offset > 0 ? ["Range":"bytes=\(offset)-", "If-Range":record.etag!] : [:]
            transfer = try ModelDownloadHTTP(url: record.source.url(), method: "GET", fields: fields, configuration: configuration, queue: queue,
                headers: { response in
                    try self.checkCancelled()
                    let tag = Self.etag(response)
                    if response.statusCode == 200 { self.offset = 0 }
                    else if response.statusCode == 206, priorOffset > 0 {
                        let expectedRange = "bytes \(priorOffset)-\(expected-1)/\(expected)"
                        guard let tag, tag == priorTag, response.value(forHTTPHeaderField: "Content-Range") == expectedRange else {
                            throw ModelDownloadError("Model source changed its resume identity or byte range; remove this download and try again")
                        }
                    } else { throw ModelDownloadError("Model download failed (HTTP \(response.statusCode))") }
                    guard try Self.exactLength(response.value(forHTTPHeaderField: "Content-Length")) == expected - self.offset else { throw ModelDownloadError("Model source length differs from the verified download source") }
                    if let encoding = response.value(forHTTPHeaderField: "Content-Encoding"), encoding.lowercased() != "identity" { throw ModelDownloadError("Compressed model transfers are not supported") }
                    if !self.fm.fileExists(atPath: part.path) { guard self.fm.createFile(atPath: part.path, contents: nil) else { throw ModelDownloadError("Cannot create model staging file") } }
                    self.output = try FileHandle(forWritingTo: part)
                    if self.offset == 0 { try self.output!.truncate(atOffset: 0) }
                    else { guard try self.output!.seekToEnd() == UInt64(self.offset) else { throw ModelDownloadError("Saved partial changed") } }
                    self.current!.etag = tag; self.checkpoint = self.offset
                    try self.update(state: "downloading")
                }, chunk: { data in
                    try self.checkCancelled()
                    guard self.offset + Int64(data.count) <= expected else { throw ModelDownloadError("Model transfer exceeded its expected length") }
                    try self.output!.write(contentsOf: data); self.offset += Int64(data.count)
                    if self.offset - self.checkpoint >= 1024 * 1024 {
                        try self.output!.synchronize(); try self.update(state: "downloading"); self.checkpoint = self.offset
                    }
                }, completion: { error in
                    do {
                        try self.output?.synchronize(); try self.output?.close(); self.output = nil; self.transfer = nil
                        if let error { throw error }
                        guard self.offset == expected else { throw ModelDownloadError("Model transfer ended early. Resume to continue.") }
                        try self.verify(part)
                    } catch { self.finish(error) }
                })
            transfer!.start()
        } catch { finish(error) }
    }
    private func update(state: String) throws {
        current!.state = state; current!.downloadedBytes = offset
        try save(current!)
    }
    private func verify(_ file: URL) throws {
        try checkCancelled(); try update(state: "verifying")
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
        var digest = SHA256()
        while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty { try checkCancelled(); digest.update(data: chunk) }
        let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
        guard hash == current!.source.sha256 else {
            try fm.removeItem(at: file); offset = 0; current!.etag = nil
            throw ModelDownloadError("Model SHA-256 verification failed. No model was installed.")
        }
        try checkCancelled()
        _ = try store.publishDownloadedModel(id: current!.id, name: current!.name, source: current!.source, file: file)
        current!.modelId = current!.id; current!.error = nil; try update(state: "complete")
        finish(nil)
    }
    private func finish(_ error: Error?) {
        try? output?.synchronize(); try? output?.close(); output = nil; transfer = nil
        if let error, var record = current {
            cancellationLock.lock(); let paused = cancelled; cancellationLock.unlock()
            record.state = paused ? "paused" : "failed"
            record.error = String((paused ? "Download paused. Resume when ready." : error.localizedDescription).prefix(1000))
            record.downloadedBytes = min((try? length(candidate(record))) ?? 0, record.source.sizeBytes!)
            try? save(record)
        }
        current = nil; activeId = nil
        cancellationLock.lock(); cancelIdentity = nil; cancellationLock.unlock()
        let callbacks = cancelCallbacks; cancelCallbacks.removeAll()
        callbacks.forEach { $0() }
    }
}
