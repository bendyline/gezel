import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit
#if canImport(GezelRuntime)
import GezelRuntime
#endif
#if canImport(GezelCapacitor)
import GezelCapacitor
#endif

@objc(GezelMobilePlugin)
public final class GezelMobilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "GezelMobilePlugin"
    public let jsName = "GezelMobile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "previewAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishHtmlPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeHtmlPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readProductFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeProductFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listProductFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdirProductDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeProductPath", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renameProductPath", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveModelSource", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelSourceResolution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listModelDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareProvider", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelProviderPreparation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeModel", returnType: CAPPluginReturnPromise)
    ]
    private let storageQueue = DispatchQueue(label: "com.bendyline.gezel.mobile.storage")
    private var store: MobileStore?
    private var storeError: Error?
    private var runtime: GezelNativeRuntime!
    private var listener: UUID?
    private var pickerCall: CAPPluginCall?
    private var exportPickerCall: CAPPluginCall?
    private var exportURL: URL?
    private var exportToken: String?
    private var exportExpected = 0
    private var exportSaving = false
    public override func load() {
        do {
            runtime = try GezelNativeRuntime.shared()
            listener = runtime.listen { [weak self] event, data in self?.notifyListeners(event, data: data) }
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            store = try MobileStore(root: support.appendingPathComponent("Gezel", isDirectory: true), recoverModels: false)
        } catch { storeError = error }
    }
    deinit { if let listener { runtime?.removeListener(listener) } }
    private func reserveModelMutation() -> Bool { runtime?.reserveModelMutation() == true }
    private func releaseModelMutation() { runtime?.releaseModelMutation() }
    private func modelJSON(_ model: MobileModel) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(model))) as? [String: Any] ?? [:]
    }
    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return true }
        if PreviewSnapshots.reserved(url) {
            return NSNumber(value: navigationAction.targetFrame?.isMainFrame != false)
        }
        if navigationAction.targetFrame?.isMainFrame == false { return true }
        return NSNumber(value: !PreviewSnapshots.packaged(url))
    }

    @objc public func previewAvailability(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["available": (self.bridge?.viewController as? MainViewController)?.previewSnapshots.available == true]) }
    }
    @objc public func publishHtmlPreview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let snapshots = (self.bridge?.viewController as? MainViewController)?.previewSnapshots, let html = call.getString("html") else { call.reject("A preview page is required"); return }
            do { call.resolve(try snapshots.publish(html)) } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc public func removeHtmlPreview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("id") { (self.bridge?.viewController as? MainViewController)?.previewSnapshots.remove(id) }
            call.resolve()
        }
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

    @objc public func readProductFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("A product path is required"); return }
        withStore(call) { store in
            ["data": try store.productFiles.read(path)?.base64EncodedString() as Any? ?? NSNull()]
        }
    }

    @objc public func writeProductFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let encoded = call.getString("data"),
              encoded.utf8.count <= ((ProductFiles.maximumFileBytes + 2) / 3) * 4 else { call.reject("A product path and valid base64 file up to 16 MiB are required"); return }
        withStore(call) { store in
            guard let data = Data(base64Encoded: encoded), data.base64EncodedString() == encoded else { throw ProductFileError.notFile }
            try store.productFiles.write(path, data: data)
            return [:]
        }
    }

    @objc public func listProductFiles(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("A product path is required"); return }
        withStore(call) { store in
            ["entries": try store.productFiles.list(path).map { entry in
                ["name": entry.name, "isDirectory": entry.isDirectory, "size": entry.size, "mtime": entry.mtime] as [String: Any]
            }]
        }
    }

    @objc public func mkdirProductDirectory(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("A product path is required"); return }
        withStore(call) { store in try store.productFiles.mkdir(path); return [:] }
    }

    @objc public func removeProductPath(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("A product path is required"); return }
        withStore(call) { store in try store.productFiles.remove(path); return [:] }
    }

    @objc public func renameProductPath(_ call: CAPPluginCall) {
        guard let from = call.getString("from"), let to = call.getString("to") else { call.reject("Source and destination product paths are required"); return }
        withStore(call) { store in try store.productFiles.rename(from, to: to); return [:] }
    }


    private func clearExport() {
        if let url = exportURL { try? FileManager.default.removeItem(at: url) }
        exportURL = nil; exportToken = nil; exportExpected = 0; exportSaving = false
        releaseModelMutation()
    }
    private func requireExport(_ token: String?) throws -> URL {
        guard let token, token == exportToken, let url = exportURL else {
            throw MobileInferenceError(code: "INVALID_EXPORT", message: "Export expired or unavailable")
        }
        return url
    }
    @objc public func beginExport(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), name.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,150}$", options: .regularExpression) != nil,
              name.hasSuffix(".zip"), call.getString("mimeType") == "application/zip",
              let size = call.getInt("sizeBytes"), (1...(72 * 1024 * 1024)).contains(size) else {
            call.reject("Invalid ZIP export or archive exceeds 72 MiB"); return
        }
        guard store != nil else { call.reject("Storage is unavailable"); return }
        guard reserveModelMutation() else { call.reject("Finish the current operation before exporting", "BUSY"); return }
        withStore(call) { _ in
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("gezel-export", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                for old in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) { try FileManager.default.removeItem(at: old) }
                let free = try FileManager.default.attributesOfFileSystem(forPath: folder.path)[.systemFreeSize] as? NSNumber
                guard (free?.int64Value ?? 0) > Int64(size + 64 * 1024 * 1024) else {
                    throw MobileInferenceError(code: "STORAGE_LIMIT", message: "Not enough storage for this export")
                }
                let url = folder.appendingPathComponent(name)
                try Data().write(to: url, options: .atomic)
                self.exportURL = url; self.exportToken = UUID().uuidString; self.exportExpected = size
                return ["token": self.exportToken!]
            } catch { self.clearExport(); throw error }
        }
    }
    @objc public func appendExport(_ call: CAPPluginCall) {
        withStore(call) { _ in
            let url = try self.requireExport(call.getString("token"))
            guard !self.exportSaving else { throw MobileInferenceError(code: "BUSY", message: "Export is already being saved") }
            guard let encoded = call.getString("data"), encoded.utf8.count <= 349528,
                  let bytes = Data(base64Encoded: encoded), bytes.count <= 256 * 1024,
                  bytes.base64EncodedString() == encoded, let offset = call.getInt("offset") else {
                throw MobileInferenceError(code: "INVALID_EXPORT", message: "Invalid export chunk")
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            let current = try handle.seekToEnd()
            guard current == UInt64(max(0, offset)), offset >= 0, offset + bytes.count <= self.exportExpected else {
                throw MobileInferenceError(code: "INVALID_EXPORT", message: "Invalid export chunk position")
            }
            try handle.write(contentsOf: bytes); try handle.synchronize()
            return [:]
        }
    }
    @objc public func cancelExport(_ call: CAPPluginCall) {
        withStore(call) { _ in
            if let token = call.getString("token"), token == self.exportToken { self.clearExport() }
            return [:]
        }
    }
    @objc public func saveExport(_ call: CAPPluginCall) {
        storageQueue.async {
            do {
                let url = try self.requireExport(call.getString("token"))
                guard !self.exportSaving else { throw MobileInferenceError(code: "BUSY", message: "Export is already being saved") }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
                guard size == self.exportExpected else { throw MobileInferenceError(code: "INVALID_EXPORT", message: "Export is incomplete") }
                self.exportSaving = true
                DispatchQueue.main.async {
                    guard let controller = self.bridge?.viewController, controller.presentedViewController == nil else {
                        self.storageQueue.async { self.clearExport() }; call.reject("Document picker is unavailable"); return
                    }
                    self.exportPickerCall = call
                    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
                    picker.delegate = self
                    controller.present(picker, animated: true)
                }
            } catch { DispatchQueue.main.async { call.reject(error.localizedDescription) } }
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
        if let call = exportPickerCall {
            exportPickerCall = nil
            storageQueue.async { self.clearExport(); DispatchQueue.main.async { call.reject("Export cancelled", "CANCELLED") } }
            return
        }
        pickerCall?.resolve(["model": NSNull()])
        pickerCall = nil
        releaseModelMutation()
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if let call = exportPickerCall {
            exportPickerCall = nil
            storageQueue.async { self.clearExport(); DispatchQueue.main.async { call.resolve() } }
            return
        }
        guard let call = pickerCall else { return }
        pickerCall = nil
        guard let url = urls.first else { releaseModelMutation(); call.resolve(["model": NSNull()]); return }
        releaseModelMutation()
        guard let runtime else { call.reject("Native runtime unavailable", "UNAVAILABLE"); return }
        runtime.importModel(GezelRuntimePlugin.adapt(call), from: url)
    }

    @objc public func listModels(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.listModels(GezelRuntimePlugin.adapt(call)) }
    @objc public func resolveModelSource(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.resolveModelSource(GezelRuntimePlugin.adapt(call)) }
    @objc public func cancelModelSourceResolution(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.cancelModelSourceResolution(GezelRuntimePlugin.adapt(call)) }
    @objc public func listModelDownloads(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.listModelDownloads(GezelRuntimePlugin.adapt(call)) }
    @objc public func startModelDownload(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.startModelDownload(GezelRuntimePlugin.adapt(call)) }
    @objc public func resumeModelDownload(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.resumeModelDownload(GezelRuntimePlugin.adapt(call)) }
    @objc public func cancelModelDownload(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.cancelModelDownload(GezelRuntimePlugin.adapt(call)) }
    @objc public func removeModelDownload(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.removeModelDownload(GezelRuntimePlugin.adapt(call)) }
    @objc public func providers(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.providers(GezelRuntimePlugin.adapt(call)) }
    @objc public func prepareProvider(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.prepareProvider(GezelRuntimePlugin.adapt(call)) }
    @objc public func cancelProviderPreparation(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.cancelProviderPreparation(GezelRuntimePlugin.adapt(call)) }
    @objc public func selectModel(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.selectModel(GezelRuntimePlugin.adapt(call)) }
    @objc public func removeModel(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.removeModel(GezelRuntimePlugin.adapt(call)) }
    @objc public func generate(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.generate(GezelRuntimePlugin.adapt(call)) }
    @objc public func cancel(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.cancel(GezelRuntimePlugin.adapt(call)) }
    @objc public func releaseModel(_ call: CAPPluginCall) { guard let runtime else { call.reject("Native runtime is unavailable", "UNAVAILABLE"); return }; runtime.releaseModel(GezelRuntimePlugin.adapt(call)) }
}
