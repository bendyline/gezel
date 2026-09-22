import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit
#if canImport(GezelRuntime)
import GezelRuntime
#endif

@objc(GezelRuntimePlugin)
public final class GezelRuntimePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "GezelRuntimePlugin"
    public let jsName = "GezelRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveModelSource", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelSourceResolution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listModelDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeModelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareProvider", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelProviderPreparation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importModel", returnType: CAPPluginReturnPromise)
    ]
    private var runtime: GezelNativeRuntime?
    private var listener: UUID?
    private var pickerCall: CAPPluginCall?
    public override func load() {
        runtime = try? GezelNativeRuntime.shared()
        listener = runtime?.listen { [weak self] event, data in self?.notifyListeners(event, data: data) }
    }
    deinit {
        if let listener { runtime?.removeListener(listener) }
        if pickerCall != nil { runtime?.releaseModelMutation() }
    }
    public static func adapt(_ call: CAPPluginCall) -> NativeCall {
        NativeCall(call.options as? [String: Any] ?? [:], resolve: { call.resolve($0) }, reject: { call.reject($0, $1) })
    }
    private func withRuntime(_ call: CAPPluginCall, _ action: (GezelNativeRuntime) -> Void) {
        guard let runtime else { call.reject("Native runtime initialization failed", "UNAVAILABLE"); return }
        action(runtime)
    }
    @objc public func listModels(_ call: CAPPluginCall) { withRuntime(call) { $0.listModels(Self.adapt(call)) } }
    @objc public func resolveModelSource(_ call: CAPPluginCall) { withRuntime(call) { $0.resolveModelSource(Self.adapt(call)) } }
    @objc public func cancelModelSourceResolution(_ call: CAPPluginCall) { withRuntime(call) { $0.cancelModelSourceResolution(Self.adapt(call)) } }
    @objc public func listModelDownloads(_ call: CAPPluginCall) { withRuntime(call) { $0.listModelDownloads(Self.adapt(call)) } }
    @objc public func startModelDownload(_ call: CAPPluginCall) { withRuntime(call) { $0.startModelDownload(Self.adapt(call)) } }
    @objc public func resumeModelDownload(_ call: CAPPluginCall) { withRuntime(call) { $0.resumeModelDownload(Self.adapt(call)) } }
    @objc public func cancelModelDownload(_ call: CAPPluginCall) { withRuntime(call) { $0.cancelModelDownload(Self.adapt(call)) } }
    @objc public func removeModelDownload(_ call: CAPPluginCall) { withRuntime(call) { $0.removeModelDownload(Self.adapt(call)) } }
    @objc public func providers(_ call: CAPPluginCall) { withRuntime(call) { $0.providers(Self.adapt(call)) } }
    @objc public func prepareProvider(_ call: CAPPluginCall) { withRuntime(call) { $0.prepareProvider(Self.adapt(call)) } }
    @objc public func cancelProviderPreparation(_ call: CAPPluginCall) { withRuntime(call) { $0.cancelProviderPreparation(Self.adapt(call)) } }
    @objc public func selectModel(_ call: CAPPluginCall) { withRuntime(call) { $0.selectModel(Self.adapt(call)) } }
    @objc public func removeModel(_ call: CAPPluginCall) { withRuntime(call) { $0.removeModel(Self.adapt(call)) } }
    @objc public func generate(_ call: CAPPluginCall) { withRuntime(call) { $0.generate(Self.adapt(call)) } }
    @objc public func cancel(_ call: CAPPluginCall) { withRuntime(call) { $0.cancel(Self.adapt(call)) } }
    @objc public func releaseModel(_ call: CAPPluginCall) { withRuntime(call) { $0.releaseModel(Self.adapt(call)) } }
    @objc public func importModel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let runtime = self.runtime, runtime.reserveModelMutation() else { call.reject("Finish the current operation before importing", "BUSY"); return }
            guard let controller = self.bridge?.viewController, controller.presentedViewController == nil else { runtime.releaseModelMutation(); call.reject("Document picker unavailable"); return }
            self.pickerCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
            picker.allowsMultipleSelection = false; picker.delegate = self
            controller.present(picker, animated: true)
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pickerCall else { return }; pickerCall = nil
        runtime?.releaseModelMutation(); call.resolve(["model": NSNull()])
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickerCall else { return }; pickerCall = nil
        runtime?.releaseModelMutation()
        guard let url = urls.first else { call.resolve(["model": NSNull()]); return }
        withRuntime(call) { $0.importModel(Self.adapt(call), from: url) }
    }
}
