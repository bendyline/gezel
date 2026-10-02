import Foundation
import UIKit
import GezelLlama
import os

private final class NativeChatStream {
    weak var plugin: GezelNativeRuntime?
    let requestId: String
    var text = ""
    /** Set on the first chunk, which is when decoding began. */
    var generating = false
    init(plugin: GezelNativeRuntime, requestId: String) {
        self.plugin = plugin
        self.requestId = requestId
    }
}

private func receiveLlamaChunk(_ bytes: UnsafePointer<CChar>?, _ length: Int, _ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let bytes, let context else { return 1 }
    let stream = Unmanaged<NativeChatStream>.fromOpaque(context).takeUnretainedValue()
    guard let plugin = stream.plugin, !plugin.isCancelled(stream.requestId) else { return 1 }
    let delta = String(decoding: UnsafeRawBufferPointer(start: bytes, count: length), as: UTF8.self)
    stream.text.append(delta)
    let first = !stream.generating
    stream.generating = true
    DispatchQueue.main.async {
        if first { plugin.notifyListeners("enginePhase", data: ["requestId": stream.requestId, "phase": "generating"]) }
        plugin.notifyListeners("chatDelta", data: ["requestId": stream.requestId, "delta": delta])
    }
    return 0
}

/**
 * Chat chunks travel to JavaScript in small batches: one bridge event per token
 * costs more than the token, and the order must hold. Touched only on the
 * inference thread; flushed about every 24 ms while tokens stream, and once
 * more when the request ends.
 */
private final class NativeChatBatch {
    weak var plugin: GezelNativeRuntime?
    let requestId: String
    private var pending: [String] = []
    private var flushedAt = DispatchTime.now().uptimeNanoseconds
    var generating = false
    init(plugin: GezelNativeRuntime, requestId: String) {
        self.plugin = plugin
        self.requestId = requestId
    }
    func add(_ chunk: String) {
        pending.append(chunk)
        if DispatchTime.now().uptimeNanoseconds - flushedAt >= 24_000_000 { flush() }
    }
    func flush() {
        flushedAt = DispatchTime.now().uptimeNanoseconds
        guard !pending.isEmpty, let plugin else { return }
        let chunks = pending, requestId = requestId
        pending.removeAll()
        DispatchQueue.main.async { plugin.notifyListeners("chatChunk", data: ["requestId": requestId, "chunks": chunks]) }
    }
}

private func receiveLlamaJSON(_ bytes: UnsafePointer<CChar>?, _ length: Int, _ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let bytes, let context else { return 1 }
    let batch = Unmanaged<NativeChatBatch>.fromOpaque(context).takeUnretainedValue()
    guard let plugin = batch.plugin, !plugin.isCancelled(batch.requestId) else { return 1 }
    if !batch.generating {
        batch.generating = true
        plugin.notifyPhase(batch.requestId, "generating")
    }
    batch.add(String(decoding: UnsafeRawBufferPointer(start: bytes, count: length), as: UTF8.self))
    return plugin.isCancelled(batch.requestId) ? 1 : 0
}

#if canImport(GezelModelStorage)
import GezelModelStorage
#endif

/// One process-owned provider/model/lifecycle host shared by native and Capacitor clients.
public final class GezelNativeRuntime: @unchecked Sendable {
    private static let sharedLock = NSLock()
    private static var sharedRuntime: GezelNativeRuntime?
    private static var sharedRoot: URL?
    public static func shared(root: URL) throws -> GezelNativeRuntime {
        sharedLock.lock(); defer { sharedLock.unlock() }
        let canonical = root.standardizedFileURL.resolvingSymlinksInPath()
        if let existing = sharedRuntime {
            guard sharedRoot == canonical else { throw MobileInferenceError(code: "ALREADY_CONFIGURED", message: "The process runtime already owns another model root") }
            return existing
        }
        let runtime = GezelNativeRuntime(root: canonical)
        sharedRoot = canonical; sharedRuntime = runtime
        return runtime
    }
    public static func shared() throws -> GezelNativeRuntime {
        sharedLock.lock(); let existing = sharedRuntime; sharedLock.unlock()
        if let existing { return existing }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try shared(root: support.appendingPathComponent("Gezel", isDirectory: true))
    }
    private var listeners: [UUID: (String, [String: Any]) -> Void] = [:]
    public func listen(_ callback: @escaping (String, [String: Any]) -> Void) -> UUID {
        operationLock.lock(); defer { operationLock.unlock() }
        let id = UUID(); listeners[id] = callback; return id
    }
    public func removeListener(_ id: UUID) {
        operationLock.lock(); defer { operationLock.unlock() }; listeners.removeValue(forKey: id)
    }
    /**
     * Model-loading and prompt-processing progress for the status pill, polled
     * from the cancellation timer. Reports only changes.
     */
    fileprivate func reportProgress(_ requestId: String, last: inout (phase: UInt32, value: UInt32)) {
        guard let engine else { return }
        var progress = gezel_llama_progress()
        progress.struct_size = UInt32(MemoryLayout<gezel_llama_progress>.size)
        progress.abi_version = gezel_llama_abi_version()
        guard gezel_llama_get_progress(engine, &progress) == 0 else { return }
        let value: UInt32
        switch progress.phase {
        case 1: value = UInt32(progress.load_fraction * 1000)
        case 2: value = progress.processed_tokens
        default: return
        }
        guard progress.phase != last.phase || value != last.value else { return }
        last = (progress.phase, value)
        var data: [String: Any] = ["requestId": requestId]
        if progress.phase == 1 {
            data["phase"] = "loading_model"
            data["progress"] = min(1.0, Double(progress.load_fraction))
        } else {
            data["phase"] = "prefill"
            data["promptTokens"] = Int(progress.prompt_tokens)
            data["processedTokens"] = Int(progress.processed_tokens)
            data["reusedTokens"] = Int(progress.reused_tokens)
            if progress.prompt_tokens > 0 {
                data["progress"] = min(1.0, Double(progress.processed_tokens) / Double(progress.prompt_tokens))
            }
        }
        DispatchQueue.main.async {
            guard !self.isCancelled(requestId) else { return }
            self.notifyListeners("enginePhase", data: data)
        }
    }

    /** Engine phase for the status pill, ordered with `chatDelta` on the main queue. */
    fileprivate func notifyPhase(_ requestId: String, _ phase: String) {
        DispatchQueue.main.async {
            self.notifyListeners("enginePhase", data: ["requestId": requestId, "phase": phase])
        }
    }

    fileprivate func notifyListeners(_ event: String, data: [String: Any]) {
        operationLock.lock(); let callbacks = Array(listeners.values); operationLock.unlock()
        for callback in callbacks { callback(event, data) }
    }
    private let storageQueue = DispatchQueue(label: "com.bendyline.gezel.mobile.storage")
    private let inferenceQueue = DispatchQueue(label: "com.bendyline.gezel.mobile.inference", qos: .userInitiated)
    private let operationLock = NSLock()
    private var activeId: String?
    private var activeNativeId: UInt64 = 0
    private var nextNativeId: UInt64 = 0
    private var cancelled = false
    private var cancelWaiters: [NativeCall] = []
    private var modelMutation = false
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    private var backgrounded = false
    private var memoryObserver: NSObjectProtocol?
    private var thermalObserver: NSObjectProtocol?
    private var lastMemoryWarning: TimeInterval = -.infinity
    private var appleTask: Task<Void, Never>?
    /// Native tool calls parked until the app's tool loop completes them.
    private var pendingToolCalls: [String: CheckedContinuation<NativeToolReply, Error>] = [:]
    /// Awake-time start of the model's current stretch of generation. Time the
    /// app spends executing a tool is not the model's and is not charged.
    private var modelSegmentStart: TimeInterval = 0
    private var activeFailure: MobileInferenceError?
    private var releasing = false
    private var releaseScheduled = false
    private var releaseWaiters: [NativeCall] = []
    private var downloads: ModelDownloads?
    private var store: MobileModelStore?
    private var storeError: Error?
    private let engine = gezel_llama_create()
    // Written and read under sizingLock: the model listing runs on the storage
    // queue and fits windows against what the inference queue holds.
    private var loadedModelId: String?
    private var loadedPath: String?
    private var loadedContextSize = 0
    /// Serializes the bridge's dry-run sizing with model loads, and guards the
    /// loaded-model fields and `allocations`.
    private let sizingLock = NSLock()
    /// Bytes per model file and window from the bridge's dry run, or -1 when
    /// llama.cpp cannot load the file at that window. Imported files never
    /// change in place, so an entry cannot go stale.
    private var allocations: [String: Int64] = [:]
    private var fittedWindows: [String: Int] = [:]
    /// The bridge's own buffers beside llama.cpp's: the hybrid/windowed state
    /// checkpoint, token vectors and the reply text.
    private static let bridgeBufferBytes: Int64 = 128 * 1024 * 1024
    /// Windows offered above the 4K floor, largest first. Phones and small
    /// desktops aim for 8K-16K; the floor is what the phone prompt was sized for.
    private static let contextLadder = [16384, 8192]
    private static let floorContext = 4096
    /// Room a larger window must leave in the process allowance, so the chosen
    /// window is not the one that barely fits.
    private static let ladderSpareBytes: Int64 = 256 * 1024 * 1024

    private init(root: URL) {
        do {
            store = try MobileModelStore(root: root)
            downloads = try ModelDownloads(store: store!)
        } catch { storeError = error }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.operationLock.lock(); self.backgrounded = true; self.operationLock.unlock()
            self.downloads?.suspend()
            self.requestRelease(nil)
            self.notifyListeners("appBackground", data: [:])
        }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.operationLock.lock(); self.backgrounded = false; self.operationLock.unlock()
        }
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.operationLock.lock()
            self.lastMemoryWarning = ProcessInfo.processInfo.systemUptime
            self.activeFailure = MobileInferenceError(code: "RESOURCE_LIMIT", message: "The device is low on memory. The current model has been released.")
            self.operationLock.unlock()
            self.requestRelease(nil)
        }
        // Only .critical stops a reply mid-generation. At .serious iOS asks apps
        // to scale back and already throttles the clocks itself; aborting there
        // ended every reply of a charging iPhone 14 Pro Max about 20 s in, so
        // no task could finish (2026-09-30).
        thermalObserver = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, ProcessInfo.processInfo.thermalState == .critical else { return }
            self.operationLock.lock()
            self.activeFailure = MobileInferenceError(code: "RESOURCE_LIMIT", message: "The device is too warm for local inference. Let it cool down before trying again.")
            self.operationLock.unlock()
            self.requestRelease(nil)
        }

    }

    deinit {
        downloads?.suspend()
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
        if let thermalObserver { NotificationCenter.default.removeObserver(thermalObserver) }
        // Inference closures retain this runtime until its blocking native call
        // returns; no active operation can outlive this engine pointer.
        gezel_llama_destroy(engine)
    }

    private func withStore(_ call: NativeCall, completion: (() -> Void)? = nil, _ action: @escaping (MobileModelStore) throws -> [String: Any]) {
        storageQueue.async {
            let result = Result {
                guard let store = self.store else { throw self.storeError ?? MobileStoreError.invalidState }
                return try action(store)
            }
            completion?()
            DispatchQueue.main.async {
                switch result {
                case .success(let data): call.resolve(data)
                case .failure(let error): call.reject(error.localizedDescription)
                }
            }
        }
    }

    private func modelJSON(_ model: MobileModel) -> [String: Any] {
        var result: [String:Any] = ["id": model.id, "name": model.name, "sizeBytes": model.sizeBytes]
        if let source = model.source, let data = try? JSONEncoder().encode(source), let json = try? JSONSerialization.jsonObject(with: data) { result["source"] = json }
        return result
    }

    public func listModels(_ call: NativeCall) {
        withStore(call) { store in
            let library = try store.listModels()
            var models = library.models.map(self.modelJSON)
            // The window the phone can hold for each model, which the product
            // runtime uses unless the person chose one. Every model is sized,
            // not only the selected one: a conversation keeps the model it
            // started with, and a Gemma 4 E2B thread sized as if it were the
            // selected Qwen 3.5 2B asked for a 16K window it could not hold
            // (2026-09-30). Dry runs are cached per file and window.
            for (index, model) in library.models.enumerated() {
                if let located = try? store.modelURL(id: model.id),
                   let context = self.fitContext(id: model.id, path: located.1.path) {
                    models[index]["contextTokens"] = context
                }
            }
            var result: [String: Any] = ["models": models]
            if let selected = library.selectedModelId { result["selectedModelId"] = selected }
            if let budget = self.memoryBudget() { result["memoryBudgetBytes"] = budget }
            return result
        }
    }

    /// What one model may use here: the process allowance plus what a loaded
    /// model already holds. Settings hides catalog downloads that cannot fit
    /// it, such as Gemma 4 E4B on a 6 GB iPhone. The simulator has no allowance.
    private func memoryBudget() -> Int64? {
        #if targetEnvironment(simulator)
        return nil
        #else
        sizingLock.lock()
        let heldPath = loadedPath, heldContext = loadedContextSize
        sizingLock.unlock()
        var available = Int64(os_proc_available_memory())
        if let heldPath { available += max(0, allocation(path: heldPath, contextSize: heldContext)) }
        return available > 0 ? available : nil
        #endif
    }

    private func loadOptions(contextSize: Int) -> gezel_llama_load_options {
        var options = gezel_llama_default_load_options()
        options.context_tokens = UInt32(contextSize)
        #if !targetEnvironment(simulator)
        options.gpu_layers = -1
        #endif
        return options
    }

    /// Bytes a load at this window takes, from the bridge's dry run, or -1 when
    /// llama.cpp cannot load the file at it. Unlike Android, iOS charges the
    /// memory-mapped weights too: Metal wraps them, and whether the process
    /// footprint then counts those pages has not been measured.
    private func allocation(path: String, contextSize: Int) -> Int64 {
        guard let engine else { return -1 }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value ?? 0
        let key = "\(path)\n\(size)\n\(contextSize)"
        sizingLock.lock(); defer { sizingLock.unlock() }
        if let known = allocations[key] { return known }
        var options = loadOptions(contextSize: contextSize)
        var estimate = gezel_llama_memory_estimate()
        estimate.struct_size = UInt32(MemoryLayout<gezel_llama_memory_estimate>.size)
        estimate.abi_version = gezel_llama_abi_version()
        var error = gezel_llama_error()
        let status = path.withCString { gezel_llama_estimate_memory(engine, $0, &options, &estimate, &error) }
        let bytes = status == 0
            ? Int64(estimate.model_bytes + estimate.context_bytes + estimate.compute_bytes) + Self.bridgeBufferBytes
            : -1
        allocations[key] = bytes
        return bytes
    }

    /// Admission charge. A file the dry run cannot size keeps the old flat floor
    /// (weights, 256 MiB, 64 KiB per token); its load then reports the real error.
    private func requiredBytes(path: String, sizeBytes: Int64, contextSize: Int) -> UInt64 {
        let bytes = allocation(path: path, contextSize: contextSize)
        return bytes >= 0 ? UInt64(bytes) : UInt64(sizeBytes) + 256 * 1024 * 1024 + UInt64(contextSize) * 64 * 1024
    }

    /// 16K or 8K when the process allowance holds that window with room to
    /// spare, else the 4K floor, which admission still checks. A loaded model
    /// keeps its window, so a listing never makes the next turn reload it;
    /// memory another loaded model holds counts as free, since loading this one
    /// releases it.
    /// Logs a model's window only when it changes; the listing is polled.
    private func noteFittedWindow(id: String, context: Int, bytes: Int64, available: Int64) {
        sizingLock.lock()
        let changed = fittedWindows[id] != context
        fittedWindows[id] = context
        sizingLock.unlock()
        if changed { NSLog("GezelRuntime window %ld for %@: needs %lld bytes, %lld available", context, id, bytes, available) }
    }

    private func fitContext(id: String, path: String) -> Int? {
        guard engine != nil else { return nil }
        sizingLock.lock()
        let heldId = loadedModelId, heldPath = loadedPath, heldContext = loadedContextSize
        sizingLock.unlock()
        if heldId == id { return heldContext }
        #if targetEnvironment(simulator)
        // The simulator reports no allowance; checkResources keeps it small.
        return nil
        #else
        var available = Int64(os_proc_available_memory())
        if let heldPath { available += max(0, allocation(path: heldPath, contextSize: heldContext)) }
        for context in Self.contextLadder {
            let bytes = allocation(path: path, contextSize: context)
            if bytes >= 0, bytes + Self.ladderSpareBytes <= available {
                noteFittedWindow(id: id, context: context, bytes: bytes, available: available)
                return context
            }
        }
        noteFittedWindow(id: id, context: Self.floorContext, bytes: allocation(path: path, contextSize: Self.floorContext), available: available)
        return Self.floorContext
        #endif
    }

    private func downloadSource(_ call: NativeCall) throws -> MobileModelSource {
        guard let raw = call.getObject("source") else { throw ModelDownloadError("A verified model source is required") }
        return try JSONDecoder().decode(MobileModelSource.self, from: JSONSerialization.data(withJSONObject: raw))
    }
    private func reserveDownloadAdmission() -> Bool {
        operationLock.lock(); defer { operationLock.unlock() }
        guard activeId == nil, !modelMutation, !releasing, !backgrounded, downloads != nil else { return false }
        modelMutation = true; return true
    }
    public func resolveModelSource(_ call: NativeCall) {
        guard reserveDownloadAdmission() else { call.reject("Open the app and finish the current operation before checking a model", "BUSY"); return }
        do {
            let source = try downloadSource(call)
            operationLock.lock()
            guard !backgrounded else { operationLock.unlock(); throw ModelDownloadError("Open the app to check a model source") }
            downloads!.resolve(source) { result in
                DispatchQueue.main.async {
                    self.releaseModelMutation()
                    do { call.resolve(["source": try JSONSerialization.jsonObject(with: JSONEncoder().encode(result.get()))]) }
                    catch { call.reject(error.localizedDescription) }
                }
            }
            operationLock.unlock()
        } catch { releaseModelMutation(); call.reject(error.localizedDescription) }
    }
    public func cancelModelSourceResolution(_ call: NativeCall) { downloads?.cancelSourceResolution(); call.resolve() }
    public func listModelDownloads(_ call: NativeCall) {
        withStore(call) { _ in guard let downloads = self.downloads else { throw ModelDownloadError("Model storage is unavailable") }; return ["downloads": try downloads.list().map { try $0.json() }] }
    }
    public func startModelDownload(_ call: NativeCall) {
        guard reserveDownloadAdmission() else { call.reject("Finish the current operation before downloading a model", "BUSY"); return }
        withStore(call, completion: { self.releaseModelMutation() }) { _ in
            // The lifecycle observers take operationLock on the main thread.
            // Holding it across this call would stall them: starting or
            // resuming waits on the downloads queue, and that queue may be
            // part way through hashing a multi-gigabyte file. Read the flag
            // under the lock and let go before the slow part.
            self.operationLock.lock()
            let backgrounded = self.backgrounded
            self.operationLock.unlock()
            guard !backgrounded, let name = call.getString("name") else { throw ModelDownloadError("Open the app and choose a model to download") }
            return ["download": try self.downloads!.start(source: self.downloadSource(call), name: name).json()]
        }
    }
    public func resumeModelDownload(_ call: NativeCall) {
        guard reserveDownloadAdmission() else { call.reject("Finish the current operation before resuming a model", "BUSY"); return }
        withStore(call, completion: { self.releaseModelMutation() }) { _ in
            // The lifecycle observers take operationLock on the main thread.
            // Holding it across this call would stall them: starting or
            // resuming waits on the downloads queue, and that queue may be
            // part way through hashing a multi-gigabyte file. Read the flag
            // under the lock and let go before the slow part.
            self.operationLock.lock()
            let backgrounded = self.backgrounded
            self.operationLock.unlock()
            guard !backgrounded, let id = call.getString("id") else { throw ModelDownloadError("Open the app and choose a download to resume") }
            return ["download": try self.downloads!.resume(id: id).json()]
        }
    }
    public func cancelModelDownload(_ call: NativeCall) {
        guard let id = call.getString("id"), let downloads else { call.reject("Download ID is required"); return }
        downloads.cancel(id: id) { DispatchQueue.main.async { call.resolve() } }
    }
    public func removeModelDownload(_ call: NativeCall) {
        guard let id = call.getString("id"), let downloads else { call.reject("Download ID is required"); return }
        downloads.remove(id: id) { result in DispatchQueue.main.async {
            do { try result.get(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }}
    }

    public func reserveModelMutation() -> Bool {
        operationLock.lock(); defer { operationLock.unlock() }
        guard activeId == nil, !modelMutation, !releasing, !backgrounded else { return false }
        modelMutation = true
        return true
    }

    public func releaseModelMutation() {
        operationLock.lock(); modelMutation = false; operationLock.unlock()
        scheduleReleaseIfIdle()
    }

    public func selectModel(_ call: NativeCall) {
        guard let id = call.getString("id") else { call.reject("Model ID is required"); return }
        guard reserveModelMutation() else { call.reject("Wait for the current conversation or import to finish", "BUSY"); return }
        withStore(call, completion: { self.releaseModelMutation() }) { store in
            return ["model": self.modelJSON(try store.selectModel(id: id))]
        }
    }

    fileprivate func isCancelled(_ id: String) -> Bool {
        operationLock.lock(); defer { operationLock.unlock() }
        return activeId != id || cancelled
    }

    private func cancelActive(_ id: String?) {
        operationLock.lock()
        var task: Task<Void, Never>?
        var parked: [CheckedContinuation<NativeToolReply, Error>] = []
        if let activeId, id == nil || id == activeId {
            cancelled = true
            gezel_llama_cancel(engine, activeNativeId)
            task = appleTask
            parked = Array(pendingToolCalls.values); pendingToolCalls.removeAll()
        }
        operationLock.unlock()
        parked.forEach { $0.resume(throwing: CancellationError()) }
        task?.cancel()
    }

    public func cancel(_ call: NativeCall) {
        guard let id = call.getString("requestId") else { call.reject("Request ID is required"); return }
        operationLock.lock()
        guard activeId == id else { operationLock.unlock(); call.resolve(); return }
        cancelled = true
        cancelWaiters.append(call)
        gezel_llama_cancel(engine, activeNativeId)
        let task = appleTask
        let parked = Array(pendingToolCalls.values); pendingToolCalls.removeAll()
        operationLock.unlock()
        parked.forEach { $0.resume(throwing: CancellationError()) }
        task?.cancel()
    }

    private func beginModelSegment() {
        operationLock.lock(); defer { operationLock.unlock() }
        modelSegmentStart = ProcessInfo.processInfo.systemUptime
    }

    /// Model time in the current stretch; zero while the app executes a tool.
    private func modelSegmentSeconds() -> TimeInterval {
        operationLock.lock(); defer { operationLock.unlock() }
        return pendingToolCalls.isEmpty ? ProcessInfo.processInfo.systemUptime - modelSegmentStart : 0
    }

    /// Completes a native tool call with the app tool loop's result.
    public func completeToolCall(_ call: NativeCall) {
        guard let requestId = call.getString("requestId"), let callId = call.getString("callId") else {
            call.reject("A request and tool call ID are required", "INVALID_ARGUMENT"); return
        }
        let result: Result<NativeToolReply, Error>
        if let error = call.getString("error") {
            result = .failure(MobileInferenceError(code: "TOOL_FAILED", message: String(error.prefix(2_000))))
        } else if let output = call.getString("output"), output.utf8.count <= 262_144, !output.contains("\0") {
            result = .success(NativeToolReply(output: output, endTurn: call.getBool("endTurn") ?? false))
        } else {
            call.reject("Invalid tool result", "INVALID_ARGUMENT"); return
        }
        operationLock.lock()
        let continuation = activeId == requestId ? pendingToolCalls.removeValue(forKey: callId) : nil
        if continuation != nil { modelSegmentStart = ProcessInfo.processInfo.systemUptime }
        operationLock.unlock()
        guard let continuation else { call.reject("This tool call is no longer running", "NOT_RUNNING"); return }
        continuation.resume(with: result)
        call.resolve()
    }

    /// Parks one native tool call until the app completes it, announcing it to JavaScript.
    private func awaitToolCall(requestId: String, name: String, arguments: String) async throws -> NativeToolReply {
        let callId = UUID().uuidString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NativeToolReply, Error>) in
                operationLock.lock()
                guard activeId == requestId, !cancelled else {
                    operationLock.unlock(); continuation.resume(throwing: CancellationError()); return
                }
                pendingToolCalls[callId] = continuation
                operationLock.unlock()
                DispatchQueue.main.async {
                    self.notifyListeners("toolCall", data: ["requestId": requestId, "callId": callId, "name": name, "arguments": arguments])
                }
            }
        } onCancel: {
            operationLock.lock(); let continuation = pendingToolCalls.removeValue(forKey: callId); operationLock.unlock()
            continuation?.resume(throwing: CancellationError())
        }
    }

    private func nextOperation(_ requestId: String) -> UInt64? {
        operationLock.lock(); defer { operationLock.unlock() }
        guard activeId == requestId, !cancelled else { return nil }
        nextNativeId = nextNativeId >= UInt64(Int64.max) ? 1 : nextNativeId + 1
        activeNativeId = nextNativeId
        return activeNativeId
    }

    public func generate(_ call: NativeCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty, requestId.utf8.count <= 128,
              let messages = call.getArray("messages", [String: Any].self), !messages.isEmpty, messages.count <= 128 else {
            call.reject("A request ID and conversation are required"); return
        }
        let providerId = call.getString("providerId") ?? "llama-cpp"
        guard ["llama-cpp", "apple-foundation-models"].contains(providerId) else {
            call.reject("This provider is not available on iOS", "UNAVAILABLE"); return
        }
        if providerId == "apple-foundation-models", let modelId = call.getString("modelId"), modelId != providerId {
            call.reject("The requested model is not available from Apple on-device AI", "MODEL_UNAVAILABLE"); return
        }
        if providerId == "apple-foundation-models", let reason = AppleFoundationProvider.availability().reason {
            call.reject(reason, "UNAVAILABLE"); return
        }
        var turns: [MobileChatTurn] = []
        var inputBytes = 0
        for message in messages {
            guard let role = message["role"] as? String, ["system", "user", "assistant"].contains(role),
                  let content = message["content"] as? String, !content.contains("\0") else {
                call.reject("Invalid conversation message"); return
            }
            inputBytes += content.utf8.count
            turns.append(MobileChatTurn(role: role, content: content))
        }
        let modelId = call.getString("modelId")
        if providerId == "llama-cpp", modelId?.isEmpty != false {
            call.reject("Choose a model for this conversation"); return
        }
        guard ["maxTokens", "contextSize"].allSatisfy({ !call.contains($0) || call.getInt($0) != nil }) else {
            call.reject("Token budgets must be integers", "INVALID_REQUEST"); return
        }
        var tools: [[String: Any]] = []
        if call.contains("tools") {
            guard providerId == "apple-foundation-models", let specs = call.getArray("tools", [String: Any].self), (1...64).contains(specs.count) else {
                call.reject("Native tool calling is only available from Apple on-device AI", "UNSUPPORTED"); return
            }
            tools = specs
        }
        guard let sampling = LlamaSampling(call.getObject("sampling")) else {
            call.reject("Sampling settings are outside the supported range", "INVALID_REQUEST"); return
        }
        let maxTokens = call.getInt("maxTokens") ?? 1024
        let outputLimit = providerId == "llama-cpp" ? 4096 : AppleFoundationProvider.maximumOutputTokens
        let contextSize = call.getInt("contextSize") ?? 4096
        guard inputBytes <= 1_000_000, (1...outputLimit).contains(maxTokens), (512...(providerId == "llama-cpp" ? 16384 : AppleFoundationProvider.availability().contextTokens)).contains(contextSize), maxTokens + 128 < contextSize, turns.last?.role == "user" else {
            call.reject("Conversation or token budget is outside the supported range"); return
        }
        operationLock.lock()
        guard !backgrounded else { operationLock.unlock(); call.reject("Reopen the app to start a conversation", "BACKGROUND"); return }
        guard activeId == nil, !modelMutation, !releasing, !backgrounded else { operationLock.unlock(); call.reject("Another conversation is running", "BUSY"); return }
        activeId = requestId; cancelled = false; activeFailure = nil
        if providerId == "apple-foundation-models" {
            appleTask = Task {
                await self.runAppleGeneration(call, requestId: requestId, turns: turns, maxTokens: maxTokens, contextSize: contextSize, tools: tools)
            }
            operationLock.unlock()
        } else {
            operationLock.unlock()
            inferenceQueue.async {
                self.runGeneration(call, requestId: requestId, modelId: modelId!, turns: turns, maxTokens: maxTokens, contextSize: contextSize, sampling: sampling)
            }
        }
    }

    /**
     * An OpenAI-shaped chat request for an imported llama.cpp model, served by
     * llama.cpp's own chat layer exactly as desktop's llama-server serves it:
     * the model's template renders the tools and its parser returns structured
     * tool calls. Every object llama-server would stream reaches JavaScript as a
     * `chatChunk` event (batched, in order), including its error body.
     */
    public func chat(_ call: NativeCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty, requestId.utf8.count <= 128,
              let requestJson = call.getString("requestJson") else {
            call.reject("A request ID and chat request are required"); return
        }
        guard let modelId = call.getString("modelId"), !modelId.isEmpty else {
            call.reject("Choose a model for this conversation"); return
        }
        guard !call.contains("contextSize") || call.getInt("contextSize") != nil else {
            call.reject("Token budgets must be integers", "INVALID_REQUEST"); return
        }
        let contextSize = call.getInt("contextSize") ?? 4096
        guard (512...16384).contains(contextSize) else {
            call.reject("Context size is outside the supported range"); return
        }
        // The JSON text crosses unchanged. Re-encoding a dictionary reorders its
        // keys from one request to the next, and with them the tool definitions
        // at the top of the prompt, so no cached prefix ever matched.
        func object(_ text: String) -> Data? {
            let data = Data(text.utf8)
            return (try? JSONSerialization.jsonObject(with: data)) is [String: Any] ? data : nil
        }
        guard requestJson.utf8.count <= 1024 * 1024, let body = object(requestJson) else {
            call.reject("Chat request is too large or not a JSON object"); return
        }
        guard let config = call.getString("chatConfigJson").map(object) ?? Data("{}".utf8) else {
            call.reject("Invalid chat settings"); return
        }
        guard engine != nil else { call.reject("The native inference engine could not initialize.", "UNAVAILABLE"); return }
        operationLock.lock()
        guard !backgrounded else { operationLock.unlock(); call.reject("Reopen the app to start a conversation", "BACKGROUND"); return }
        guard activeId == nil, !modelMutation, !releasing else { operationLock.unlock(); call.reject("Another conversation is running", "BUSY"); return }
        activeId = requestId; cancelled = false; activeFailure = nil
        operationLock.unlock()
        inferenceQueue.async {
            self.runChat(call, requestId: requestId, modelId: modelId, contextSize: contextSize, body: body, config: config)
        }
    }

    /// The `configure_chat` settings the loaded model holds; inference queue only.
    private var appliedChatConfig: Data?

    private func runChat(_ call: NativeCall, requestId: String, modelId: String, contextSize: Int, body: Data, config: Data) {
        let batch = NativeChatBatch(plugin: self, requestId: requestId)
        let cancellation = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        cancellation.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
        var ticks = 0
        var lastProgress: (phase: UInt32, value: UInt32) = (UInt32.max, UInt32.max)
        cancellation.setEventHandler { [weak self] in
            guard let self else { return }
            if self.isCancelled(requestId) {
                self.cancelActive(requestId)
                return
            }
            ticks += 1
            if ticks % 5 == 0 { self.reportProgress(requestId, last: &lastProgress) }
        }
        cancellation.resume()
        func nativeFailure(_ status: Int32, _ error: inout gezel_llama_error) -> NSError {
            NSError(domain: "GezelLlama", code: Int(status), userInfo: [NSLocalizedDescriptionKey: errorText(&error)])
        }
        func perform() throws -> [String: Any] {
            guard let engine, let store else { throw storeError ?? MobileStoreError.unknownModel }
            let (model, url) = try store.modelURL(id: modelId)
            var nativeError = gezel_llama_error()
            if loadedModelId != model.id || loadedContextSize != contextSize {
                try unloadLlama()
                appliedChatConfig = nil
                guard awaitCooling(requestId) else { return ["status": "cancelled"] }
                try checkResources(additionalBytes: requiredBytes(path: url.path, sizeBytes: model.sizeBytes, contextSize: contextSize))
                guard let operation = nextOperation(requestId) else { return ["status": "cancelled"] }
                var options = loadOptions(contextSize: contextSize)
                options.request_id = operation
                notifyPhase(requestId, "loading_model")
                sizingLock.lock()
                let status = url.path.withCString { gezel_llama_load(engine, $0, &options, &nativeError) }
                if status == 0 { loadedModelId = model.id; loadedPath = url.path; loadedContextSize = contextSize }
                sizingLock.unlock()
                guard status == 0 else {
                    if isCancelled(requestId) { return ["status": "cancelled"] }
                    throw nativeFailure(status, &nativeError)
                }
            }
            if config != appliedChatConfig {
                let status = config.withUnsafeBytes { raw in
                    gezel_llama_configure_chat(engine, raw.bindMemory(to: CChar.self).baseAddress, raw.count, &nativeError)
                }
                guard status == 0 else { throw nativeFailure(status, &nativeError) }
                appliedChatConfig = config
            }
            guard awaitCooling(requestId) else { return ["status": "cancelled"] }
            try checkResources(additionalBytes: 64 * 1024 * 1024)
            guard let operation = nextOperation(requestId) else { return ["status": "cancelled"] }
            var options = gezel_llama_default_chat_options()
            options.request_id = operation
            options.timeout_ms = 600_000
            var result = gezel_llama_result()
            notifyPhase(requestId, "prefill")
            let status = body.withUnsafeBytes { raw in
                gezel_llama_chat(engine, raw.bindMemory(to: CChar.self).baseAddress, raw.count, &options, receiveLlamaJSON,
                    Unmanaged.passUnretained(batch).toOpaque(), &result, &nativeError)
            }
            // Invalid options, busy and not-loaded end before a request starts,
            // so no error body reached the batch; every other failure sent one.
            if (1...3).contains(status) { throw nativeFailure(status, &nativeError) }
            if status == 0 { return ["status": "ok"] }
            if isCancelled(requestId) || status == 7 { return ["status": "cancelled"] }
            return ["status": status == 8 ? "timeout" : "error"]
        }
        var terminal: Result<[String: Any], Error>
        do { terminal = .success(try perform()) }
        catch {
            terminal = isCancelled(requestId) ? .success(["status": "cancelled"]) : .failure(error)
        }
        cancellation.cancel()
        batch.flush()
        finishGeneration(call, terminal: terminal)
    }

    private func errorText(_ error: inout gezel_llama_error) -> String {
        withUnsafePointer(to: &error.message) { pointer in
            String(cString: UnsafeRawPointer(pointer).assumingMemoryBound(to: CChar.self))
        }
    }

    private func resourceReason() -> String? {
        operationLock.lock()
        let hidden = backgrounded
        let recentlyWarned = ProcessInfo.processInfo.systemUptime - lastMemoryWarning < 10
        operationLock.unlock()
        if hidden { return "Reopen the app to use on-device AI." }
        if recentlyWarned { return "The device is low on memory. Wait before loading a model again." }
        if ProcessInfo.processInfo.thermalState == .critical { return "The device is too warm for local inference. Let it cool down first." }
        return nil
    }

    private static func gigabytes(_ bytes: UInt64) -> String {
        String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
    }

    /// How long a request waits for a critically hot device to cool before it is refused.
    private static let coolingWaitSeconds: TimeInterval = 600
    /// How long a request pauses at .serious before it proceeds anyway.
    private static let seriousPauseSeconds: TimeInterval = 15

    /// A critically hot device waits the heat out instead of failing the turn:
    /// the same work, delayed, is what the person asked for. Bounded, so a
    /// device that never cools still gets the refusal from `checkResources`.
    /// At .serious, where iOS asks apps to scale back, each request only pauses
    /// briefly so the device sheds some heat between steps, then proceeds.
    /// False when the request was cancelled meanwhile.
    private func awaitCooling(_ requestId: String) -> Bool {
        let started = ProcessInfo.processInfo.systemUptime
        var announced = false
        while true {
            let waited = ProcessInfo.processInfo.systemUptime - started
            switch ProcessInfo.processInfo.thermalState {
            case .critical: if waited >= Self.coolingWaitSeconds { return !isCancelled(requestId) }
            case .serious: if waited >= Self.seriousPauseSeconds { return !isCancelled(requestId) }
            default: return !isCancelled(requestId)
            }
            if isCancelled(requestId) { return false }
            if !announced { notifyPhase(requestId, "cooling"); announced = true }
            Thread.sleep(forTimeInterval: 2)
        }
    }

    private func checkResources(additionalBytes: UInt64) throws {
        if let reason = resourceReason() { throw MobileInferenceError(code: "RESOURCE_LIMIT", message: reason) }
        #if targetEnvironment(simulator)
        // Simulator processes have no iOS dirty-memory allowance (the OS
        // query returns zero). Keep this developer path deliberately small;
        // it provides no evidence about a physical phone's memory admission.
        guard additionalBytes <= 1024 * 1024 * 1024 else {
            throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "The simulator supports only small test models. Use a physical device to assess model memory requirements.")
        }
        #else
        let available = UInt64(os_proc_available_memory())
        if available < additionalBytes {
            NSLog("GezelRuntime admission refused: needs %llu bytes, %llu available", additionalBytes, available)
            throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "There is not enough available memory for this model: it needs about \(Self.gigabytes(additionalBytes)), and \(Self.gigabytes(available)) is free. Choose a smaller model or close other apps.")
        }
        #endif
    }

    public func providers(_ call: NativeCall) {
        storageQueue.async {
            let restriction = self.resourceReason()
            var llamaReason = restriction
            if llamaReason == nil {
                if self.engine == nil { llamaReason = "The native inference engine could not initialize." }
                else {
                    do {
                        guard let store = self.store else { throw self.storeError ?? MobileStoreError.unknownModel }
                        guard !(try store.listModels().models.isEmpty) else { throw MobileStoreError.unknownModel }
                    } catch { llamaReason = error.localizedDescription }
                }
            }
            let apple = AppleFoundationProvider.availability()
            func descriptor(_ id: String, _ name: String, _ reason: String?, _ context: Int, _ output: Int) -> [String: Any] {
                var value: [String: Any] = [
                    "id": id, "name": name, "locality": "on-device",
                    "availability": reason == nil ? "available" : "unavailable",
                    "contextTokens": context, "maxOutputTokens": output,
                    // structuredChat: llama.cpp's own chat layer, as desktop's llama-server runs it.
                    "capabilities": ["text": true, "tools": id == "apple-foundation-models", "structuredOutput": false, "images": false, "foregroundOnly": true, "structuredChat": id == "llama-cpp"]
                ]
                if let reason { value["reason"] = reason }
                return value
            }
            let result = [
                descriptor("llama-cpp", "Imported GGUF model", llamaReason, 16384, 4096),
                descriptor("apple-foundation-models", "Apple on-device AI", restriction ?? apple.reason, apple.contextTokens, AppleFoundationProvider.maximumOutputTokens)
            ]
            DispatchQueue.main.async { call.resolve(["providers": result]) }
        }
    }

    public func prepareProvider(_ call: NativeCall) {
        if call.getString("providerId") == "apple-foundation-models" {
            call.reject("iOS manages Apple on-device model downloads. Enable Apple Intelligence in Settings and wait for preparation to finish.", "OS_MANAGED")
        } else {
            call.reject("This provider cannot be prepared on iOS. Import and select a GGUF to use an imported model.", "UNAVAILABLE")
        }
    }

    /// Nothing on iOS prepares a provider — `prepareProvider` always refuses,
    /// because the OS owns Apple's model downloads — so there is never a
    /// preparation in flight to stop. The method exists because the shared
    /// host contract declares it, and a host call that simply fails on one
    /// platform is worse than one that truthfully does nothing.
    public func cancelProviderPreparation(_ call: NativeCall) {
        call.resolve()
    }

    /// Called only on inferenceQueue, with generation admission already held.
    private func unloadLlama() throws {
        if let engine {
            var error = gezel_llama_error()
            let status = gezel_llama_unload(engine, &error)
            guard status == 0 else { throw MobileInferenceError(code: "BUSY", message: errorText(&error)) }
        }
        sizingLock.lock()
        loadedModelId = nil; loadedPath = nil; loadedContextSize = 0
        sizingLock.unlock()
    }

    public func releaseModel(_ call: NativeCall) { requestRelease(call) }

    private func requestRelease(_ call: NativeCall?) {
        operationLock.lock()
        releasing = true
        if let call { releaseWaiters.append(call) }
        operationLock.unlock()
        cancelActive(nil)
        scheduleReleaseIfIdle()
    }

    private func scheduleReleaseIfIdle() {
        operationLock.lock()
        guard releasing, activeId == nil, !modelMutation, !releaseScheduled else { operationLock.unlock(); return }
        releaseScheduled = true
        operationLock.unlock()
        inferenceQueue.async {
            let result = Result { try self.unloadLlama() }
            self.operationLock.lock()
            self.releasing = false; self.releaseScheduled = false
            let waiters = self.releaseWaiters
            self.releaseWaiters.removeAll()
            self.operationLock.unlock()
            DispatchQueue.main.async {
                for call in waiters {
                    switch result {
                    case .success: call.resolve()
                    case .failure(let error): call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    public func removeModel(_ call: NativeCall) {
        guard let id = call.getString("id") else { call.reject("Model ID is required"); return }
        guard reserveModelMutation() else { call.reject("Wait for the current conversation or import to finish", "BUSY"); return }
        inferenceQueue.async {
            do { try self.unloadLlama() }
            catch {
                self.releaseModelMutation()
                DispatchQueue.main.async { call.reject(error.localizedDescription) }
                return
            }
            self.withStore(call, completion: { self.releaseModelMutation() }) { store in
                try store.removeModel(id: id)
                return [:]
            }
        }
    }

    private func failActive(_ id: String, error: MobileInferenceError) {
        operationLock.lock()
        guard activeId == id else { operationLock.unlock(); return }
        activeFailure = error
        operationLock.unlock()
        cancelActive(id)
    }

    private func finishGeneration(_ call: NativeCall, terminal: Result<[String: Any], Error>) {
        operationLock.lock()
        let result: Result<[String: Any], Error> = activeFailure.map { .failure($0) } ?? terminal
        activeId = nil; activeNativeId = 0; appleTask = nil; activeFailure = nil
        let parked = Array(pendingToolCalls.values); pendingToolCalls.removeAll()
        let waiting = cancelWaiters
        cancelWaiters.removeAll()
        operationLock.unlock()
        parked.forEach { $0.resume(throwing: CancellationError()) }
        scheduleReleaseIfIdle()
        DispatchQueue.main.async {
            switch result {
            case .success(let data): call.resolve(data)
            case .failure(let error): call.reject(error.localizedDescription, (error as? MobileInferenceError)?.code)
            }
            waiting.forEach { $0.resolve() }
        }
    }

    private func runAppleGeneration(_ call: NativeCall, requestId: String, turns: [MobileChatTurn], maxTokens: Int, contextSize: Int, tools: [[String: Any]]) async {
        var text = ""
        beginModelSegment()
        // A minute of the model's own time between tool results. Polling, rather
        // than one armed timer, lets a completed tool call restart the minute.
        let timeout = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                if self.modelSegmentSeconds() > 60 {
                    self.failActive(requestId, error: MobileInferenceError(code: "TIMEOUT", message: "Apple on-device AI exceeded the one-minute response limit."))
                    return
                }
            }
        }
        defer { timeout.cancel() }
        let terminal: Result<[String: Any], Error>
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                inferenceQueue.async { continuation.resume(with: Result { try self.unloadLlama() }) }
            }
            try checkResources(additionalBytes: 256 * 1024 * 1024)
            if isCancelled(requestId) { throw CancellationError() }
            guard #available(iOS 26.0, *) else { throw MobileInferenceError(code: "UNAVAILABLE", message: "Apple on-device AI requires iOS 26 or later.") }
            notifyPhase(requestId, "prefill")
            var generating = false
            let reason = try await AppleFoundationProvider.generate(
                turns: turns, maxTokens: maxTokens, contextSize: contextSize, tools: tools,
                invoke: { [weak self] name, arguments in
                    guard let self else { throw CancellationError() }
                    return try await self.awaitToolCall(requestId: requestId, name: name, arguments: arguments)
                }
            ) { delta in
                if self.isCancelled(requestId) { throw CancellationError() }
                text.append(delta)
                if !generating {
                    generating = true
                    self.notifyPhase(requestId, "generating")
                }
                DispatchQueue.main.async {
                    self.notifyListeners("chatDelta", data: ["requestId": requestId, "delta": delta])
                }
            }
            terminal = .success(["text": text, "stopReason": reason])
        } catch {
            terminal = isCancelled(requestId) || error is CancellationError
                ? .success(["text": text, "stopReason": "cancelled"])
                : .failure(error)
        }
        finishGeneration(call, terminal: terminal)
    }

    private func runGeneration(_ call: NativeCall, requestId: String, modelId: String, turns: [MobileChatTurn], maxTokens: Int, contextSize: Int, sampling: LlamaSampling) {
        let stream = NativeChatStream(plugin: self, requestId: requestId)
        // Reassert cancellation while a blocking call runs, including the tiny
        // interval between assigning its ID and entering the native function.
        let cancellation = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        cancellation.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
        var ticks = 0
        var lastProgress: (phase: UInt32, value: UInt32) = (UInt32.max, UInt32.max)
        cancellation.setEventHandler { [weak self] in
            guard let self else { return }
            if self.isCancelled(requestId) {
                self.cancelActive(requestId)
                return
            }
            // Every fifth tick (~250 ms) is plenty for a status pill.
            ticks += 1
            if ticks % 5 == 0 { self.reportProgress(requestId, last: &lastProgress) }
        }
        cancellation.resume()
        var terminal: Result<[String: Any], Error>
        func perform() throws -> [String: Any] {
            guard let engine, let store else { throw storeError ?? MobileStoreError.unknownModel }
            let (model, url) = try store.modelURL(id: modelId)
            var nativeError = gezel_llama_error()
            if loadedModelId != model.id || loadedContextSize != contextSize {
                try unloadLlama()
                // Native allocation and memory warnings still enforce the
                // model's actual working set.
                try checkResources(additionalBytes: requiredBytes(path: url.path, sizeBytes: model.sizeBytes, contextSize: contextSize))
                guard let operation = nextOperation(requestId) else {
                    return ["text": "", "stopReason": "cancelled"]
                }
                var options = loadOptions(contextSize: contextSize)
                options.request_id = operation
                notifyPhase(requestId, "loading_model")
                sizingLock.lock()
                let status = url.path.withCString { gezel_llama_load(engine, $0, &options, &nativeError) }
                if status == 0 { loadedModelId = model.id; loadedPath = url.path; loadedContextSize = contextSize }
                sizingLock.unlock()
                guard status == 0 else {
                    if isCancelled(requestId) { return ["text": "", "stopReason": "cancelled"] }
                    throw NSError(domain: "GezelLlama", code: Int(status), userInfo: [NSLocalizedDescriptionKey: errorText(&nativeError)])
                }
            }
            try checkResources(additionalBytes: 64 * 1024 * 1024)
            guard let operation = nextOperation(requestId) else {
                return ["text": "", "stopReason": "cancelled"]
            }
            var options = gezel_llama_default_generation_options()
            options.request_id = operation
            options.max_tokens = UInt32(maxTokens)
            sampling.apply(to: &options)
            // The library's default deadline is a flat minute covering prompt
            // processing as well as decoding, which a long reply on a phone
            // passes routinely. Scale it with the reply actually asked for, and
            // keep a ceiling so a wedged decode still ends.
            options.timeout_ms = UInt32(min(600_000, 30_000 + maxTokens * 250))
            let strings = turns.flatMap { [strdup($0.role), strdup($0.content)] }
            defer { strings.forEach { free($0) } }
            let nativeTurns = turns.indices.map { index in
                gezel_llama_message(role: UnsafePointer(strings[index * 2]), content: UnsafePointer(strings[index * 2 + 1]))
            }
            var result = gezel_llama_result()
            notifyPhase(requestId, "prefill")
            let status = nativeTurns.withUnsafeBufferPointer { buffer in
                gezel_llama_generate(engine, buffer.baseAddress, buffer.count, &options, receiveLlamaChunk,
                    Unmanaged.passUnretained(stream).toOpaque(), &result, &nativeError)
            }
            let stopped = isCancelled(requestId) || result.finish_reason == 3
            guard status == 0 || stopped else {
                throw NSError(domain: "GezelLlama", code: Int(status), userInfo: [NSLocalizedDescriptionKey: errorText(&nativeError)])
            }
            // 2 is the token ceiling and 4 the deadline: both mean the reply was
            // cut short rather than finished, which is what "length" tells the
            // product. Treating a timeout as "stop" would present a truncated
            // answer as a complete one.
            let truncated = result.finish_reason == 2 || result.finish_reason == 4
            let reason = stopped ? "cancelled" : (truncated ? "length" : "stop")
            return ["text": stream.text, "stopReason": reason]
        }
        do { terminal = .success(try perform()) }
        catch {
            terminal = isCancelled(requestId)
                ? .success(["text": stream.text, "stopReason": "cancelled"])
                : .failure(error)
        }
        cancellation.cancel()
        finishGeneration(call, terminal: terminal)
    }
    public func importModel(_ call: NativeCall, from url: URL) {
        guard reserveModelMutation() else { call.reject("Finish the current operation before importing", "BUSY"); return }
        withStore(call, completion: { self.releaseModelMutation() }) { store in
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            var result: Result<MobileModel, Error>?
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
                result = Result { try store.importModel(from: coordinated) }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw MobileStoreError.invalidModel }
            return ["model": self.modelJSON(try result.get())]
        }
    }
}

/// A model's catalog sampling, resolved by the product runtime the same way the
/// desktop resolves it. Absent fields keep the bridge's defaults: greedy
/// decoding, top-k 40 / top-p 0.95 when sampling, no repetition penalty.
struct LlamaSampling {
    var temperature: Float = 0
    var topK: UInt32 = 40
    var topP: Float = 0.95
    var minP: Float = 0
    var repeatPenalty: Float = 1
    var repeatLastN: UInt32 = 64
    // An unset seed varies per reply, so a retry is not the same text again.
    var seed = UInt32.random(in: 0...UInt32(Int32.max))

    init?(_ value: [String: Any]?) {
        guard let value else { return }
        func number(_ key: String) -> Double? { (value[key] as? NSNumber)?.doubleValue }
        if let v = number("temperature") { temperature = Float(v) }
        if let v = number("topK") { guard v >= 0, v <= 1000, v == v.rounded() else { return nil }; topK = UInt32(v) }
        if let v = number("topP") { topP = Float(v) }
        if let v = number("minP") { minP = Float(v) }
        if let v = number("repetitionPenalty") { repeatPenalty = Float(v) }
        if let v = number("repetitionContext") { guard v >= 0, v <= 4096, v == v.rounded() else { return nil }; repeatLastN = UInt32(v) }
        if let v = number("seed"), v == v.rounded() { seed = UInt32(truncatingIfNeeded: Int64(v)) & UInt32(Int32.max) }
        guard (0...2).contains(temperature), topP > 0, topP <= 1, minP >= 0, minP < 1, (1...2).contains(repeatPenalty) else { return nil }
    }

    func apply(to options: inout gezel_llama_generation_options) {
        options.temperature = temperature
        options.top_k = topK
        options.top_p = topP
        options.min_p = minP
        options.repeat_penalty = repeatPenalty
        options.repeat_last_n = repeatLastN
        options.seed = seed
    }
}
