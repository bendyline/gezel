import Capacitor
import Foundation
import UIKit
import os
#if canImport(GezelSpeech)
import GezelSpeech
#endif

/// Knowledge catalog archives on the device. Each catalog is one verified
/// `.gezk` download that the web view's reader opens in place, in byte ranges
/// served by Capacitor's file handler; nothing is extracted. JavaScript chooses
/// catalogs from its pinned snapshot; this plugin only stores what it is given.
/// Each catalog's query model downloads into the same store and runs on the
/// speech framework's ONNX Runtime (`embed`).
@objc(GezelKnowledgePlugin)
public final class GezelKnowledgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GezelKnowledgePlugin"
    public let jsName = "GezelKnowledge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "embed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    /// A sanity bound; the store refuses any download the device has no room for.
    private static let maxArchive: Int64 = 32 << 30
    private let downloads = DispatchQueue(label: "com.bendyline.gezel.knowledge.downloads", qos: .utility)
    private let encoder = DispatchQueue(label: "com.bendyline.gezel.knowledge.encoder", qos: .userInitiated)
    private let lock = NSLock()
    private let store = SpeechModelStore(folder: "gezel-knowledge/catalogs", maxFile: GezelKnowledgePlugin.maxArchive)
    private var engine: OpaquePointer?
    /// The model the encoder holds, so only a cold load checks memory.
    private var warm: String?
    private var downloading: String?
    private var backgrounded = false, paused = false
    private var observers: [NSObjectProtocol] = []

    public override func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            self?.enterBackground()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.locked { self.backgrounded = false }
        })
        // A search finishes before the reply it feeds starts, so the encoder
        // can give its memory to the chat model, which on a 6 GB iPhone needs
        // it. The runtime posts this on its inference queue and waits.
        observers.append(center.addObserver(forName: Self.modelWillRun, object: nil, queue: nil) { [weak self] _ in
            self?.releaseEncoder(wait: true)
        })
        observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil) { [weak self] _ in
            self?.releaseEncoder(wait: false)
        })
    }
    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        store.cancel()
        #if canImport(GezelSpeech)
        if let engine { gezel_speech_destroy(engine) }
        #endif
    }
    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    /// `GezelNativeRuntime.willRunModelNotification`, named rather than imported
    /// so this plugin still builds against a staged runtime that predates it.
    static let modelWillRun = Notification.Name("GezelRuntimeWillRunModel")

    /// Unloads the query model; the next search loads it again. A search in
    /// progress finishes first, since this runs on the encoder's queue.
    private func releaseEncoder(wait: Bool) {
        #if canImport(GezelSpeech)
        let release = { [self] in
            locked {
                if let engine { gezel_speech_release(engine) }
                warm = nil
            }
        }
        if wait { encoder.sync(execute: release) } else { encoder.async(execute: release) }
        #endif
    }

    @objc public func info(_ call: CAPPluginCall) {
        // Capacitor serves app files at /_capacitor_file_<absolute path>, honoring Range.
        guard var base = bridge?.config.localURL.absoluteString,
              let root = store.root.standardizedFileURL.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            call.reject("Knowledge catalogs could not be read", "failed"); return
        }
        if base.hasSuffix("/") { base.removeLast() }
        do {
            var result: [String: Any] = ["baseUrl": base + CapacitorBridge.fileStartIdentifier + root, "catalogs": try store.list()]
            if let downloading = locked({ downloading }) { result["downloading"] = downloading }
            call.resolve(result)
        } catch { call.reject("Knowledge catalogs could not be read", "failed") }
    }

    @objc public func install(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), SpeechModelStore.valid(id: id), let version = call.getString("version"),
              let url = call.getString("url"), let sha = call.getString("sha256"), let size = call.options["size"] as? NSNumber else {
            call.reject("Invalid knowledge catalog", "invalid-input"); return
        }
        let file: [String: Any] = ["name": "\(version)/catalog.gezk", "url": url, "sha256": sha, "size": size]
        download(call, id, [file]) { [store] in
            // One version per catalog: a verified update replaces the archive it supersedes.
            // Pruning only now keeps an interrupted download's partial file for resuming.
            let folder = store.root.appendingPathComponent(id, isDirectory: true)
            for entry in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
            where entry.lastPathComponent != version && (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                try? FileManager.default.removeItem(at: entry)
            }
        }
    }

    /// A catalog profile's query model, verified file by file like a catalog.
    @objc public func installModel(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), SpeechModelStore.valid(id: id), let files = call.getArray("files") as? [[String: Any]] else {
            call.reject("Invalid query model", "invalid-input"); return
        }
        download(call, id, files)
    }

    private func download(_ call: CAPPluginCall, _ id: String, _ files: [[String: Any]], then finish: @escaping () -> Void = {}) {
        let refusal: (String, String)? = locked {
            if downloading != nil { return ("Another download is running", "busy") }
            if backgrounded { return ("Knowledge downloads run in the foreground", "paused") }
            downloading = id; paused = false
            return nil
        }
        if let (message, code) = refusal { call.reject(message, code); return }
        downloads.async { [self] in
            defer { locked { downloading = nil } }
            do {
                try store.install(id, files) { received, total in
                    self.notifyListeners("knowledgeDownload", data: ["id": id, "receivedBytes": received, "totalBytes": total])
                }
                finish()
                call.resolve(["id": id])
            } catch SpeechModelStore.Failure.cancelled {
                let wasPaused = locked { paused }
                call.reject(wasPaused ? "Download paused when the app left the foreground" : "Download cancelled", wasPaused ? "paused" : "cancelled")
            } catch let SpeechModelStore.Failure.failed(code, message) {
                call.reject(message, code)
            } catch {
                call.reject(error.localizedDescription, "interrupted")
            }
        }
    }

    /// A query's unit vector from the installed model; token ids come from the profile's tokenizer.
    @objc public func embed(_ call: CAPPluginCall) {
        if let reason = GezelOfflineSpeechPlugin.unavailableReason { call.reject(reason, "unavailable"); return }
        encoder.async { [self] in
            #if canImport(GezelSpeech)
            do {
                let model = try store.file(call.getString("model"), call.getString("file"))
                guard let encoded = call.getArray("ids") as? [NSNumber], (1...8192).contains(encoded.count) else {
                    throw SpeechModelStore.Failure.failed("invalid-input", "Invalid text for the query model")
                }
                let ids = encoded.map(\.int64Value)
                lock.lock()
                if engine == nil { engine = gezel_speech_create() }
                let handle = engine, cold = warm != model.path
                lock.unlock()
                guard let handle else { throw SpeechModelStore.Failure.failed("resources", "Not enough memory for knowledge search") }
                if cold { try checkMemory(for: model) }
                gezel_speech_begin(handle)
                var vector: UnsafeMutablePointer<Float>?
                var dimensions = 0
                let status = ids.withUnsafeBufferPointer {
                    gezel_speech_embed(handle, model.path, $0.baseAddress, $0.count, &vector, &dimensions)
                }
                defer { gezel_speech_free(vector) }
                if status != 0 { throw SpeechModelStore.Failure.failed("failed", String(cString: gezel_speech_error(handle))) }
                locked { warm = model.path }
                call.resolve(["vector": UnsafeBufferPointer(start: vector, count: dimensions).map(Double.init)])
            } catch let SpeechModelStore.Failure.failed(code, message) {
                call.reject(message, code)
            } catch {
                call.reject(error.localizedDescription, "failed")
            }
            #else
            call.reject(GezelOfflineSpeechPlugin.unavailableReason ?? "", "unavailable")
            #endif
        }
    }

    private func checkMemory(for model: URL) throws {
        // Zero means no limit is known (the simulator); only a real budget can refuse.
        let headroom = os_proc_available_memory()
        let size = (try? model.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if headroom > 0 && headroom < size + 256 * 1024 * 1024 {
            throw SpeechModelStore.Failure.failed("resources", "Not enough memory for knowledge search. Close other apps and try again.")
        }
    }

    @objc public func cancelInstall(_ call: CAPPluginCall) { store.cancel(); call.resolve() }

    @objc public func remove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        if locked({ id == downloading }) { call.reject("Cancel the download before removing this catalog", "busy"); return }
        downloads.async { [self] in
            do { try store.remove(id); call.resolve() }
            catch let SpeechModelStore.Failure.failed(code, message) { call.reject(message, code) }
            catch { call.reject("The catalog could not be removed", "failed") }
        }
    }

    private func enterBackground() {
        locked {
            backgrounded = true
            if downloading != nil { paused = true }
        }
        store.cancel()
        // The query model holds hundreds of megabytes; load it again on the next search.
        releaseEncoder(wait: false)
    }
}
