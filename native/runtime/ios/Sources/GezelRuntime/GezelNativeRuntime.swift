import Foundation
import UIKit
import GezelLlama
import os

private final class NativeChatStream {
    weak var plugin: GezelNativeRuntime?
    let requestId: String
    var text = ""
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
    DispatchQueue.main.async {
        plugin.notifyListeners("chatDelta", data: ["requestId": stream.requestId, "delta": delta])
    }
    return 0
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
    private var activeFailure: MobileInferenceError?
    private var releasing = false
    private var releaseScheduled = false
    private var releaseWaiters: [NativeCall] = []
    private var downloads: ModelDownloads?
    private var store: MobileModelStore?
    private var storeError: Error?
    private let engine = gezel_llama_create()
    private var loadedModelId: String?
    private var loadedContextSize = 0

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
        thermalObserver = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical else { return }
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
            var result: [String: Any] = ["models": library.models.map(self.modelJSON)]
            if let selected = library.selectedModelId { result["selectedModelId"] = selected }
            return result
        }
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
        if let activeId, id == nil || id == activeId {
            cancelled = true
            gezel_llama_cancel(engine, activeNativeId)
            task = appleTask
        }
        operationLock.unlock()
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
        operationLock.unlock()
        task?.cancel()
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
        let maxTokens = call.getInt("maxTokens") ?? 1024
        let outputLimit = providerId == "llama-cpp" ? 4096 : AppleFoundationProvider.maximumOutputTokens
        let contextSize = call.getInt("contextSize") ?? 4096
        guard inputBytes <= 1_000_000, (1...outputLimit).contains(maxTokens), (512...(providerId == "llama-cpp" ? 8192 : AppleFoundationProvider.availability().contextTokens)).contains(contextSize), maxTokens + 128 < contextSize, turns.last?.role == "user" else {
            call.reject("Conversation or token budget is outside the supported range"); return
        }
        operationLock.lock()
        guard !backgrounded else { operationLock.unlock(); call.reject("Reopen the app to start a conversation", "BACKGROUND"); return }
        guard activeId == nil, !modelMutation, !releasing, !backgrounded else { operationLock.unlock(); call.reject("Another conversation is running", "BUSY"); return }
        activeId = requestId; cancelled = false; activeFailure = nil
        if providerId == "apple-foundation-models" {
            appleTask = Task {
                await self.runAppleGeneration(call, requestId: requestId, turns: turns, maxTokens: maxTokens, contextSize: contextSize)
            }
            operationLock.unlock()
        } else {
            operationLock.unlock()
            inferenceQueue.async {
                self.runGeneration(call, requestId: requestId, modelId: modelId!, turns: turns, maxTokens: maxTokens, contextSize: contextSize)
            }
        }
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
        let thermal = ProcessInfo.processInfo.thermalState
        if thermal == .serious || thermal == .critical { return "The device is too warm for local inference. Let it cool down first." }
        return nil
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
        if UInt64(os_proc_available_memory()) < additionalBytes {
            throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "There is not enough available memory for this model. Choose a smaller model or close other apps.")
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
                    "capabilities": ["text": true, "tools": false, "structuredOutput": false, "images": false, "foregroundOnly": true]
                ]
                if let reason { value["reason"] = reason }
                return value
            }
            let result = [
                descriptor("llama-cpp", "Imported GGUF model", llamaReason, 8192, 4096),
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
        loadedModelId = nil; loadedContextSize = 0
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
        let waiting = cancelWaiters
        cancelWaiters.removeAll()
        operationLock.unlock()
        scheduleReleaseIfIdle()
        DispatchQueue.main.async {
            switch result {
            case .success(let data): call.resolve(data)
            case .failure(let error): call.reject(error.localizedDescription, (error as? MobileInferenceError)?.code)
            }
            waiting.forEach { $0.resolve() }
        }
    }

    private func runAppleGeneration(_ call: NativeCall, requestId: String, turns: [MobileChatTurn], maxTokens: Int, contextSize: Int) async {
        var text = ""
        let timeout = Task {
            do { try await Task.sleep(nanoseconds: 60_000_000_000) }
            catch { return }
            self.failActive(requestId, error: MobileInferenceError(code: "TIMEOUT", message: "Apple on-device AI exceeded the one-minute response limit."))
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
            let reason = try await AppleFoundationProvider.generate(turns: turns, maxTokens: maxTokens, contextSize: contextSize) { delta in
                if self.isCancelled(requestId) { throw CancellationError() }
                text.append(delta)
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

    private func runGeneration(_ call: NativeCall, requestId: String, modelId: String, turns: [MobileChatTurn], maxTokens: Int, contextSize: Int) {
        let stream = NativeChatStream(plugin: self, requestId: requestId)
        // Reassert cancellation while a blocking call runs, including the tiny
        // interval between assigning its ID and entering the native function.
        let cancellation = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        cancellation.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
        cancellation.setEventHandler { [weak self] in
            guard let self, self.isCancelled(requestId) else { return }
            self.cancelActive(requestId)
        }
        cancellation.resume()
        var terminal: Result<[String: Any], Error>
        func perform() throws -> [String: Any] {
            guard let engine, let store else { throw storeError ?? MobileStoreError.unknownModel }
            let (model, url) = try store.modelURL(id: modelId)
            var nativeError = gezel_llama_error()
            if loadedModelId != model.id || loadedContextSize != contextSize {
                try unloadLlama()
                // Conservative floor; native allocation and memory warnings
                // still enforce the actual model's working-set requirements.
                try checkResources(additionalBytes: UInt64(model.sizeBytes) + 256 * 1024 * 1024 + UInt64(contextSize) * 64 * 1024)
                guard let operation = nextOperation(requestId) else {
                    return ["text": "", "stopReason": "cancelled"]
                }
                var options = gezel_llama_default_load_options()
                options.request_id = operation
                options.context_tokens = UInt32(contextSize)
                #if !targetEnvironment(simulator)
                options.gpu_layers = -1
                #endif
                let status = url.path.withCString { gezel_llama_load(engine, $0, &options, &nativeError) }
                guard status == 0 else {
                    loadedModelId = nil
                    if isCancelled(requestId) { return ["text": "", "stopReason": "cancelled"] }
                    throw NSError(domain: "GezelLlama", code: Int(status), userInfo: [NSLocalizedDescriptionKey: errorText(&nativeError)])
                }
                loadedModelId = model.id; loadedContextSize = contextSize
            }
            try checkResources(additionalBytes: 64 * 1024 * 1024)
            guard let operation = nextOperation(requestId) else {
                return ["text": "", "stopReason": "cancelled"]
            }
            var options = gezel_llama_default_generation_options()
            options.request_id = operation
            options.max_tokens = UInt32(maxTokens)
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
