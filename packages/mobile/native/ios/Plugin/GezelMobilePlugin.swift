import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit
import GezelLlama
import os

private final class NativeChatStream {
    weak var plugin: GezelMobilePlugin?
    let requestId: String
    var text = ""
    init(plugin: GezelMobilePlugin, requestId: String) {
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

@objc(GezelMobilePlugin)
public final class GezelMobilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "GezelMobilePlugin"
    public let jsName = "GezelMobile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareProvider", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeModel", returnType: CAPPluginReturnPromise)
    ]
    private let storageQueue = DispatchQueue(label: "com.bendyline.gezel.mobile.storage")
    private let inferenceQueue = DispatchQueue(label: "com.bendyline.gezel.mobile.inference", qos: .userInitiated)
    private let operationLock = NSLock()
    private var activeId: String?
    private var activeNativeId: UInt64 = 0
    private var nextNativeId: UInt64 = 0
    private var cancelled = false
    private var cancelWaiters: [CAPPluginCall] = []
    private var modelMutation = false
    private var pickerCall: CAPPluginCall?
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
    private var releaseWaiters: [CAPPluginCall] = []
    private var store: MobileStore?
    private var storeError: Error?
    private let engine = gezel_llama_create()
    private var loadedModelId: String?
    private var loadedContextSize = 0

    public override func load() {
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            store = try MobileStore(root: support.appendingPathComponent("Gezel", isDirectory: true))
        } catch { storeError = error }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.operationLock.lock(); self.backgrounded = true; self.operationLock.unlock()
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
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
        if let thermalObserver { NotificationCenter.default.removeObserver(thermalObserver) }
        // Inference closures retain this plugin until its blocking native call
        // returns; no active operation can outlive this engine pointer.
        gezel_llama_destroy(engine)
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return true }
        // Only packaged app pages receive the native bridge. External content
        // and imported/generated HTML never navigate this privileged webview.
        return NSNumber(value: !(url.scheme == "capacitor" && url.host == "localhost"))
    }

    private func withStore(_ call: CAPPluginCall, completion: (() -> Void)? = nil, _ action: @escaping (MobileStore) throws -> [String: Any]) {
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

    @objc public func readState(_ call: CAPPluginCall) {
        withStore(call) { store in
            let data = try store.readState()
            return ["data": data.map { $0 as Any } ?? NSNull()]
        }
    }

    @objc public func writeState(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else { call.reject("State data is required"); return }
        withStore(call) { try $0.writeState(data); return [:] }
    }

    private func modelJSON(_ model: MobileModel) -> [String: Any] {
        ["id": model.id, "name": model.name, "sizeBytes": model.sizeBytes]
    }

    @objc public func listModels(_ call: CAPPluginCall) {
        withStore(call) { store in
            let library = try store.listModels()
            var result: [String: Any] = ["models": library.models.map(self.modelJSON)]
            if let selected = library.selectedModelId { result["selectedModelId"] = selected }
            return result
        }
    }

    private func reserveModelMutation() -> Bool {
        operationLock.lock(); defer { operationLock.unlock() }
        guard activeId == nil, !modelMutation, !releasing else { return false }
        modelMutation = true
        return true
    }

    private func releaseModelMutation() {
        operationLock.lock(); modelMutation = false; operationLock.unlock()
    }

    @objc public func selectModel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Model ID is required"); return }
        guard reserveModelMutation() else { call.reject("Wait for the current conversation or import to finish", "BUSY"); return }
        withStore(call, completion: { self.releaseModelMutation() }) { store in
            return ["model": self.modelJSON(try store.selectModel(id: id))]
        }
    }

    @objc public func importModel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.reserveModelMutation() else { call.reject("Wait for the current conversation or import to finish", "BUSY"); return }
            guard let controller = self.bridge?.viewController else {
                self.releaseModelMutation(); call.reject("Document picker is unavailable"); return
            }
            self.pickerCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            controller.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerCall?.resolve(["model": NSNull()])
        pickerCall = nil
        releaseModelMutation()
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickerCall else { return }
        pickerCall = nil
        guard let url = urls.first else { releaseModelMutation(); call.resolve(["model": NSNull()]); return }
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

    @objc public func cancel(_ call: CAPPluginCall) {
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

    @objc public func generate(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty, requestId.utf8.count <= 128,
              let messages = call.getArray("messages", JSObject.self), !messages.isEmpty, messages.count <= 128 else {
            call.reject("A request ID and conversation are required"); return
        }
        let providerId = call.getString("providerId") ?? "llama-cpp"
        guard ["llama-cpp", "apple-foundation-models"].contains(providerId) else {
            call.reject("This provider is not available on iOS", "UNAVAILABLE"); return
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
        let maxTokens = call.getInt("maxTokens") ?? 256
        let outputLimit = providerId == "llama-cpp" ? 256 : AppleFoundationProvider.maximumOutputTokens
        let contextSize = call.getInt("contextSize") ?? 2048
        guard inputBytes <= 1_000_000, (1...outputLimit).contains(maxTokens), (512...8192).contains(contextSize), turns.last?.role == "user" else {
            call.reject("Conversation or token budget is outside the supported range"); return
        }
        operationLock.lock()
        guard !backgrounded else { operationLock.unlock(); call.reject("Reopen the app to start a conversation", "BACKGROUND"); return }
        guard activeId == nil, !modelMutation, !releasing else { operationLock.unlock(); call.reject("Another conversation is running", "BUSY"); return }
        activeId = requestId; cancelled = false; activeFailure = nil
        if providerId == "apple-foundation-models" {
            appleTask = Task {
                await self.runAppleGeneration(call, requestId: requestId, turns: turns, maxTokens: maxTokens)
            }
            operationLock.unlock()
        } else {
            operationLock.unlock()
            inferenceQueue.async {
                self.runGeneration(call, requestId: requestId, turns: turns, maxTokens: maxTokens, contextSize: contextSize)
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
        guard additionalBytes <= 512 * 1024 * 1024 else {
            throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "The simulator supports only small test models. Use a physical device to assess model memory requirements.")
        }
        #else
        if UInt64(os_proc_available_memory()) < additionalBytes {
            throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "There is not enough available memory for this model. Choose a smaller model or close other apps.")
        }
        #endif
    }

    @objc public func providers(_ call: CAPPluginCall) {
        storageQueue.async {
            let restriction = self.resourceReason()
            var llamaReason = restriction
            if llamaReason == nil {
                if self.engine == nil { llamaReason = "The native inference engine could not initialize." }
                else {
                    do {
                        guard let store = self.store else { throw self.storeError ?? MobileStoreError.unknownModel }
                        _ = try store.selectedModelURL()
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
                descriptor("llama-cpp", "Imported GGUF model", llamaReason, 2048, 256),
                descriptor("apple-foundation-models", "Apple on-device AI", restriction ?? apple.reason, apple.contextTokens, AppleFoundationProvider.maximumOutputTokens)
            ]
            DispatchQueue.main.async { call.resolve(["providers": result]) }
        }
    }

    @objc public func prepareProvider(_ call: CAPPluginCall) {
        if call.getString("providerId") == "apple-foundation-models" {
            call.reject("iOS manages Apple on-device model downloads. Enable Apple Intelligence in Settings and wait for preparation to finish.", "OS_MANAGED")
        } else {
            call.reject("This provider cannot be prepared on iOS. Import and select a GGUF to use an imported model.", "UNAVAILABLE")
        }
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

    @objc public func releaseModel(_ call: CAPPluginCall) { requestRelease(call) }

    private func requestRelease(_ call: CAPPluginCall?) {
        operationLock.lock()
        releasing = true
        if let call { releaseWaiters.append(call) }
        operationLock.unlock()
        cancelActive(nil)
        scheduleReleaseIfIdle()
    }

    private func scheduleReleaseIfIdle() {
        operationLock.lock()
        guard releasing, activeId == nil, !releaseScheduled else { operationLock.unlock(); return }
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

    @objc public func removeModel(_ call: CAPPluginCall) {
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

    private func finishGeneration(_ call: CAPPluginCall, terminal: Result<[String: Any], Error>) {
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

    private func runAppleGeneration(_ call: CAPPluginCall, requestId: String, turns: [MobileChatTurn], maxTokens: Int) async {
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
            let reason = try await AppleFoundationProvider.generate(turns: turns, maxTokens: maxTokens) { delta in
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

    private func runGeneration(_ call: CAPPluginCall, requestId: String, turns: [MobileChatTurn], maxTokens: Int, contextSize: Int) {
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
            let (model, url) = try store.selectedModelURL()
            var nativeError = gezel_llama_error()
            if loadedModelId != model.id || loadedContextSize != contextSize {
                try unloadLlama()
                try checkResources(additionalBytes: UInt64(model.sizeBytes) + 256 * 1024 * 1024)
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
            let reason = stopped ? "cancelled" : (result.finish_reason == 2 ? "length" : "stop")
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
}
