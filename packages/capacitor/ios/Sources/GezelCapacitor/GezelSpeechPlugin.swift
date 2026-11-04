import Capacitor
import CryptoKit
import Foundation
import UIKit
import os
#if canImport(GezelSpeech)
import GezelSpeech
#endif

/// Offline speech: Whisper dictation and Kokoro narration on the optional
/// GezelSpeech framework, with models the host downloads on request. One
/// request runs at a time; models stay loaded between requests and are
/// released after a quiet spell or when the app leaves the foreground.
@objc(GezelSpeechPlugin)
public final class GezelSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GezelSpeechPlugin"
    public let jsName = "GezelSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synthesize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
    ]
    private static let idleRelease: TimeInterval = 120
    private let worker = DispatchQueue(label: "com.bendyline.gezel.speech", qos: .userInitiated)
    private let downloads = DispatchQueue(label: "com.bendyline.gezel.speech.downloads", qos: .utility)
    private let lock = NSLock()
    private let models = SpeechModelStore()
    private var engine: OpaquePointer?
    private var activeId: String?
    private var downloading: String?
    private var stopped = false, backgrounded = false, downloadPaused = false
    private var waiters: [CAPPluginCall] = []
    private var idle: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    /// Null when the engine can run, else why not; the knowledge plugin's query models share it.
    static var unavailableReason: String? {
        #if canImport(GezelSpeech)
        return gezel_speech_abi() == 3 ? nil : "This app's speech engine does not match its plugin."
        #else
        return "This app was built without the offline speech engine."
        #endif
    }

    public override func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            self?.enterBackground()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.locked { self.backgrounded = false }
        })
    }
    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        models.cancel()
        #if canImport(GezelSpeech)
        if let engine { gezel_speech_destroy(engine) }
        #endif
    }
    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    @objc public func status(_ call: CAPPluginCall) {
        do {
            var result: [String: Any] = ["available": Self.unavailableReason == nil, "models": try models.list()]
            if let reason = Self.unavailableReason { result["reason"] = reason }
            if let downloading = locked({ downloading }) { result["downloading"] = downloading }
            call.resolve(result)
        } catch { call.reject("Speech models could not be read", "failed") }
    }

    @objc public func install(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), SpeechModelStore.valid(id: id), let files = call.getArray("files") as? [[String: Any]] else {
            call.reject("Invalid speech model", "invalid-input"); return
        }
        let refusal: (String, String)? = locked {
            if downloading != nil { return ("Another speech model is downloading", "busy") }
            if backgrounded { return ("Speech downloads run in the foreground", "paused") }
            downloading = id; downloadPaused = false
            return nil
        }
        if let (message, code) = refusal { call.reject(message, code); return }
        downloads.async { [self] in
            defer { locked { downloading = nil } }
            do {
                try models.install(id, files) { received, total in
                    self.notifyListeners("speechDownload", data: ["id": id, "receivedBytes": received, "totalBytes": total])
                }
                call.resolve(["id": id])
            } catch SpeechModelStore.Failure.cancelled {
                let paused = locked { downloadPaused }
                call.reject(paused ? "Download paused when the app left the foreground" : "Download cancelled", paused ? "paused" : "cancelled")
            } catch let SpeechModelStore.Failure.failed(code, message) {
                call.reject(message, code)
            } catch {
                call.reject(error.localizedDescription, "interrupted")
            }
        }
    }

    @objc public func cancelInstall(_ call: CAPPluginCall) { models.cancel(); call.resolve() }

    @objc public func remove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let refusal: String? = locked {
            if id == downloading { return "Cancel the download before removing this model" }
            return activeId == nil ? nil : "Speech is busy"
        }
        if let refusal { call.reject(refusal, "busy"); return }
        worker.async { [self] in
            releaseModels()
            do { try models.remove(id); call.resolve() }
            catch let SpeechModelStore.Failure.failed(code, message) { call.reject(message, code) }
            catch { call.reject("The speech model could not be removed", "failed") }
        }
    }

    @objc public func transcribe(_ call: CAPPluginCall) { run(call, synthesis: false) }
    @objc public func synthesize(_ call: CAPPluginCall) { run(call, synthesis: true) }

    private func run(_ call: CAPPluginCall, synthesis: Bool) {
        guard call.getString("requestId").flatMap(UUID.init(uuidString:)) != nil else {
            call.reject("A speech request identity is required", "invalid-input"); return
        }
        if let reason = Self.unavailableReason { call.reject(reason, "unavailable"); return }
        let refusal: (String, String)? = locked {
            if activeId != nil { return ("Speech is busy", "busy") }
            if backgrounded { return ("Speech runs while the app is in the foreground", "cancelled") }
            activeId = call.getString("requestId"); stopped = false
            idle?.cancel()
            return nil
        }
        if let (message, code) = refusal { call.reject(message, code); return }
        worker.async { [self] in
            let started = Date()
            var result: [String: Any]?
            var failure: (String, String)?
            do {
                result = try perform(call, synthesis: synthesis)
                result?["durationMs"] = Int(Date().timeIntervalSince(started) * 1000)
            } catch SpeechModelStore.Failure.cancelled {
                failure = ("Speech stopped", "cancelled")
            } catch let SpeechModelStore.Failure.failed(code, message) {
                failure = (message, code)
            } catch {
                failure = (error.localizedDescription, "failed")
            }
            lock.lock()
            if stopped { failure = ("Speech stopped", "cancelled") }
            activeId = nil
            let pending = waiters
            waiters.removeAll()
            let delay = backgrounded ? 0 : Self.idleRelease
            lock.unlock()
            if let failure { call.reject(failure.0, failure.1) } else { call.resolve(result ?? [:]) }
            pending.forEach { $0.resolve() }
            scheduleRelease(after: delay)
        }
    }

    private func perform(_ call: CAPPluginCall, synthesis: Bool) throws -> [String: Any] {
        #if canImport(GezelSpeech)
        let model = try models.file(call.getString("model"), call.getString("file"))
        try checkResources()
        let handle = try begin()
        if synthesis {
            let voices = try models.file(call.getString("model"), call.getString("voices"))
            guard let encoded = call.getArray("tokens") as? [Int], (3...511).contains(encoded.count),
                  encoded.allSatisfy({ (0...177).contains($0) }) else {
                throw SpeechModelStore.Failure.failed("invalid-input", "Speech phonemes are missing or invalid")
            }
            let tokens = encoded.map(Int32.init)
            let speed = Float(min(2, max(0.5, call.getDouble("speed") ?? 1)))
            var samples: UnsafeMutablePointer<Float>?
            var durations: UnsafeMutablePointer<Float>?
            var sampleCount = 0, durationCount = 0
            let status = tokens.withUnsafeBufferPointer {
                gezel_speech_kokoro(handle, model.path, voices.path, Int32(call.getInt("voice") ?? 0), $0.baseAddress, $0.count,
                                    speed, &samples, &sampleCount, &durations, &durationCount)
            }
            defer { gezel_speech_free(samples); gezel_speech_free(durations) }
            try check(status, handle)
            var pcm = Data(count: sampleCount * 2)
            pcm.withUnsafeMutableBytes { raw in
                let out = raw.bindMemory(to: Int16.self)
                for index in 0..<sampleCount {
                    let value = samples![index].isFinite ? max(-1, min(1, samples![index])) : 0
                    out[index] = Int16(value * (value < 0 ? 32768 : 32767)).littleEndian
                }
            }
            let timing = durationCount > 0 ? Array(UnsafeBufferPointer(start: durations, count: durationCount)).map(Double.init) : []
            return ["pcm": pcm.base64EncodedString(), "sampleRate": 24_000, "durations": timing]
        }
        guard let encoded = call.getString("audio"), encoded.count <= 5_120_000, let pcm = Data(base64Encoded: encoded),
              !pcm.isEmpty, pcm.count % 2 == 0 else {
            throw SpeechModelStore.Failure.failed("invalid-input", "Use up to two minutes of speech")
        }
        var json: UnsafeMutablePointer<CChar>?
        let status = pcm.withUnsafeBytes { raw in
            gezel_speech_transcribe_json(handle, model.path, raw.bindMemory(to: UInt8.self).baseAddress, pcm.count,
                                         call.getString("language"), call.getString("prompt"),
                                         call.getBool("words") == true ? 1 : 0, &json)
        }
        defer { gezel_speech_free(json) }
        try check(status, handle)
        guard let json, let value = try JSONSerialization.jsonObject(with: Data(String(cString: json).utf8)) as? [String: Any] else {
            throw SpeechModelStore.Failure.failed("failed", "Whisper returned an unreadable transcript")
        }
        return value
        #else
        throw SpeechModelStore.Failure.failed("unavailable", Self.unavailableReason ?? "")
        #endif
    }

    #if canImport(GezelSpeech)
    /// The long-lived engine, cleared of any earlier cancel; serialized with stop().
    private func begin() throws -> OpaquePointer {
        lock.lock(); defer { lock.unlock() }
        if stopped || backgrounded { throw SpeechModelStore.Failure.cancelled }
        if engine == nil { engine = gezel_speech_create() }
        guard let engine else { throw SpeechModelStore.Failure.failed("resources", "Not enough memory for speech") }
        gezel_speech_begin(engine)
        return engine
    }
    private func check(_ status: Int32, _ handle: OpaquePointer) throws {
        if status == 2 { throw SpeechModelStore.Failure.cancelled }
        if status != 0 { throw SpeechModelStore.Failure.failed("failed", String(cString: gezel_speech_error(handle))) }
    }
    #endif

    private func checkResources() throws {
        if ProcessInfo.processInfo.thermalState == .critical || ProcessInfo.processInfo.thermalState == .serious {
            throw SpeechModelStore.Failure.failed("resources", "Let this device cool before running speech")
        }
        // Zero means no limit is known (the simulator); only a real budget can refuse.
        let headroom = os_proc_available_memory()
        if headroom > 0 && headroom < 512 * 1024 * 1024 {
            throw SpeechModelStore.Failure.failed("resources", "Not enough memory for speech. Close other apps and try again.")
        }
    }

    private func releaseModels() {
        #if canImport(GezelSpeech)
        locked { if activeId == nil, let engine { gezel_speech_release(engine) } }
        #endif
    }
    private func scheduleRelease(after delay: TimeInterval) {
        let item = DispatchWorkItem { [weak self] in self?.worker.async { self?.releaseModels() } }
        locked { idle?.cancel(); idle = item }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: item)
    }
    private func stop() {
        stopped = true
        #if canImport(GezelSpeech)
        if let engine { gezel_speech_cancel(engine) }
        #endif
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        let waiting: Bool = locked {
            guard let activeId, activeId == call.getString("requestId") else { return false }
            waiters.append(call); stop()
            return true
        }
        if !waiting { call.resolve() }
    }

    @objc public func release(_ call: CAPPluginCall) { scheduleRelease(after: 0); call.resolve() }

    private func enterBackground() {
        locked {
            backgrounded = true
            if activeId != nil { stop() }
            if downloading != nil { downloadPaused = true }
        }
        models.cancel()
        scheduleRelease(after: 0)
    }
}

/// Speech model files in app-private storage excluded from backup: one folder
/// per model, declared files only, each verified against its SHA-256 before
/// the model counts as installed. JavaScript names models and files; it never
/// supplies paths.
final class SpeechModelStore: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Failure: Error { case cancelled, failed(String, String) }
    private static let marker = "installed.json"
    /// The store's folder, in Application Support and excluded from backup.
    let root: URL
    private let maxFile: Int64
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionDataTask?
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    // Transfer state for the one file in flight.
    private var output: FileHandle?
    private var expected: Int64 = 0, received: Int64 = 0, lastReport = Date.distantPast
    private var transferError: Failure?
    private var finished = DispatchSemaphore(value: 0)
    private var onBytes: ((Int64) -> Void)?

    init(folder: String = "gezel-speech/models", maxFile: Int64 = 1 << 30) {
        var url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        root = url
        self.maxFile = maxFile
    }

    static func valid(id: String) -> Bool { id.range(of: "^[a-z0-9][a-z0-9._-]{0,63}$", options: .regularExpression) != nil }
    static func valid(name: String) -> Bool {
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        return name.count <= 256 && parts.count <= 3 && parts.allSatisfy {
            String($0).range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil && !$0.hasSuffix(".part")
        }
    }
    private func folder(_ id: String?) throws -> URL {
        guard let id, Self.valid(id: id) else { throw Failure.failed("invalid-input", "Invalid speech model") }
        return root.appendingPathComponent(id, isDirectory: true)
    }
    private func inside(_ folder: URL, _ name: String) throws -> URL {
        guard Self.valid(name: name) else { throw Failure.failed("invalid-input", "Invalid speech model file") }
        let file = folder.appendingPathComponent(name).standardizedFileURL
        guard file.path.hasPrefix(folder.standardizedFileURL.path + "/") else { throw Failure.failed("invalid-input", "Invalid speech model file") }
        return file
    }
    private func installed(_ folder: URL) -> [String: String]? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(Self.marker)), data.count <= 64 * 1024,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let files = value["files"] as? [String: String], files.keys.allSatisfy(Self.valid(name:)) else { return nil }
        return files
    }
    func file(_ id: String?, _ name: String?) throws -> URL {
        let folder = try folder(id)
        guard let files = installed(folder) else { throw Failure.failed("model-missing", "Download this speech model first") }
        guard let name, files[name] != nil else { throw Failure.failed("invalid-input", "This file is not part of the installed model") }
        let file = try inside(folder, name)
        guard FileManager.default.fileExists(atPath: file.path) else { throw Failure.failed("model-missing", "The speech model is incomplete; download it again") }
        return file
    }
    func list() throws -> [[String: Any]] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return folders.compactMap { folder in
            guard Self.valid(id: folder.lastPathComponent), let files = installed(folder) else { return nil }
            return ["id": folder.lastPathComponent, "files": files.keys.sorted()]
        }
    }
    func remove(_ id: String) throws {
        let folder = try folder(id)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }
    func cancel() {
        lock.lock(); cancelled = true; let current = task; lock.unlock()
        current?.cancel()
    }

    /// Download and verify every file, resuming any partial file from where it
    /// stopped. A file that fails verification is deleted so the next attempt
    /// starts clean. Blocks the calling queue; cancel() stops it.
    func install(_ id: String, _ specs: [[String: Any]], progress: @escaping (Int64, Int64) -> Void) throws {
        lock.lock(); cancelled = false; lock.unlock()
        let folder = try folder(id)
        guard (1...64).contains(specs.count) else { throw Failure.failed("invalid-input", "Invalid speech model files") }
        var files: [(name: String, url: URL, sha: String, size: Int64)] = []
        for spec in specs {
            guard let name = spec["name"] as? String, Self.valid(name: name), let sha = spec["sha256"] as? String,
                  sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  let link = spec["url"] as? String, link.hasPrefix("https://huggingface.co/"), let url = URL(string: link),
                  let size = (spec["size"] as? NSNumber)?.int64Value, (1...maxFile).contains(size),
                  !files.contains(where: { $0.name == name }) else { throw Failure.failed("invalid-input", "Invalid speech model files") }
            files.append((name, url, sha, size))
        }
        let total = files.reduce(0) { $0 + $1.size }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: folder.appendingPathComponent(Self.marker))
        let free = (try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage ?? 0
        if free < total + 64 * 1024 * 1024 { throw Failure.failed("storage", "Not enough storage for this speech model") }
        var done: Int64 = 0
        for file in files {
            let target = try inside(folder, file.name)
            let partial = target.appendingPathExtension("part")
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            let ready = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize).map { Int64($0) == file.size } == true
                && (try? Self.digest(target)) == file.sha
            if !ready {
                try? FileManager.default.removeItem(at: target)
                let before = done
                try transfer(file.url, to: partial, size: file.size) { progress(before + $0, total) }
                guard try Self.digest(partial) == file.sha else {
                    try? FileManager.default.removeItem(at: partial)
                    throw Failure.failed("verification", "The downloaded speech model was damaged, so it was not installed")
                }
                try FileManager.default.moveItem(at: partial, to: target)
            }
            done += file.size
            progress(done, total)
        }
        let marker = try JSONSerialization.data(withJSONObject: ["files": Dictionary(uniqueKeysWithValues: files.map { ($0.name, $0.sha) })])
        try marker.write(to: folder.appendingPathComponent(Self.marker), options: .atomic)
    }

    private func transfer(_ url: URL, to partial: URL, size: Int64, report: @escaping (Int64) -> Void) throws {
        var have = (try? partial.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        if have > size { try? FileManager.default.removeItem(at: partial); have = 0 }
        if have == size { return }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if have > 0 { request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        if !FileManager.default.fileExists(atPath: partial.path) { FileManager.default.createFile(atPath: partial.path, contents: nil) }
        lock.lock()
        if cancelled { lock.unlock(); throw Failure.cancelled }
        output = try FileHandle(forWritingTo: partial)
        expected = size; received = have; transferError = nil; onBytes = report; finished = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: request)
        self.task = task
        let signal = finished
        lock.unlock()
        task.resume()
        signal.wait()
        lock.lock()
        defer { lock.unlock() }
        try? output?.synchronize()
        try? output?.close()
        output = nil; self.task = nil; onBytes = nil
        if cancelled { throw Failure.cancelled }
        if let transferError { throw transferError }
        if received != size { throw Failure.failed("interrupted", "The download ended early") }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); defer { lock.unlock() }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 206 && received > 0 {
            _ = try? output?.seekToEnd()
            completionHandler(.allow)
        } else if status == 200 {
            // A full response restarts the file.
            try? output?.truncate(atOffset: 0)
            received = 0
            completionHandler(.allow)
        } else {
            transferError = .failed(status == 408 || status == 429 || status >= 500 || status == 416 ? "interrupted" : "failed",
                                    "Speech model download failed (HTTP \(status))")
            completionHandler(.cancel)
        }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        received += Int64(data.count)
        if received > expected { transferError = .failed("verification", "The speech model is larger than expected"); lock.unlock(); dataTask.cancel(); return }
        do { try output?.write(contentsOf: data) } catch {
            transferError = .failed("storage", "Cannot save the speech model"); lock.unlock(); dataTask.cancel(); return
        }
        let now = Date(), value = received, report = now.timeIntervalSince(lastReport) > 0.25 ? onBytes : nil
        if report != nil { lastReport = now }
        lock.unlock()
        report?(value)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        if let error, transferError == nil, !cancelled { transferError = .failed("interrupted", error.localizedDescription) }
        let signal = finished
        lock.unlock()
        signal.signal()
    }

    static func digest(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
