import Capacitor
import Foundation
import WebKit

final class MainViewController: CAPBridgeViewController {
    let previewSnapshots = PreviewSnapshots()
    private var schemeBoundaryReady = false
    private var messageBoundary: PackagedMainFrameMessages?

    private var instanceSettings: InstanceConfiguration?
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        instanceSettings = instanceConfiguration
        return super.webViewConfiguration(for: instanceConfiguration)
    }
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        guard let settings = instanceSettings,
              let original = configuration.urlSchemeHandler(forURLScheme: "capacitor") else {
            return super.webView(with: frame, configuration: configuration)
        }
        // WebKit cannot replace or remove a registered scheme handler. Ask the
        // same Capacitor factory for an unregistered configuration, retaining its
        // user-content controller and every configured media/privacy setting.
        let secured = super.webViewConfiguration(for: settings)
        secured.userContentController = configuration.userContentController
        secured.setURLSchemeHandler(PreviewSchemeHandler(original: original, snapshots: previewSnapshots), forURLScheme: "capacitor")
        schemeBoundaryReady = true
        return super.webView(with: frame, configuration: secured)
    }

    override func capacitorDidLoad() {
        guard let implementation = bridge as? CapacitorBridge else { return }
        let controller = implementation.webViewDelegationHandler.contentController
        let boundary = PackagedMainFrameMessages(original: implementation.webViewDelegationHandler)
        messageBoundary = boundary
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(boundary, name: "bridge")
        if let url = Bundle.main.url(forResource: "preview-isolation", withExtension: "js", subdirectory: "public"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            // Main-frame-only injection is insufficient: srcdoc creates a fresh
            // JavaScript realm. All frames must lose CSP-independent networking.
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            previewSnapshots.available = schemeBoundaryReady
        }
        bridge?.registerPluginInstance(GezelMobilePlugin())
        bridge?.registerPluginInstance(GezelSpeechPlugin())
    }
}

private final class PackagedMainFrameMessages: NSObject, WKScriptMessageHandler {
    weak var original: WebViewDelegationHandler?
    init(original: WebViewDelegationHandler) { self.original = original }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "capacitor",
              message.frameInfo.securityOrigin.host == "localhost",
              PreviewSnapshots.packaged(message.frameInfo.request.url) else { return }
        original?.userContentController(userContentController, didReceive: message)
    }
}

final class PreviewSnapshots {
    static let prefix = "/__gezel_preview/"
    static let csp = "default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"
    private struct Entry { let data: Data; let created: TimeInterval }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    var available = false
    static func packaged(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "capacitor" && url.host == "localhost" && url.port == nil && ["", "/", "/index.html"].contains(url.path)
    }
    static func reserved(_ url: URL) -> Bool { url.path.hasPrefix(prefix) }
    private func expire() {
        let now = ProcessInfo.processInfo.systemUptime
        entries = entries.filter { now - $0.value.created <= 600 }
    }
    func publish(_ html: String) throws -> [String: Any] {
        guard available else { throw PreviewError.unavailable }
        guard html.utf8.count <= 8 * 1024 * 1024 else { throw PreviewError.tooLarge }
        let data = Data(html.utf8)
        lock.lock(); defer { lock.unlock() }; expire()
        guard entries.count < 4, entries.values.reduce(data.count, { $0 + $1.data.count }) <= 16 * 1024 * 1024 else { throw PreviewError.tooLarge }
        let id = UUID().uuidString.lowercased()
        entries[id] = Entry(data: data, created: ProcessInfo.processInfo.systemUptime)
        return ["id": id, "url": "capacitor://localhost\(Self.prefix)\(id)/index.html"]
    }
    func remove(_ id: String) { lock.lock(); defer { lock.unlock() }; entries.removeValue(forKey: id) }
    func read(_ url: URL) -> Data? {
        lock.lock(); defer { lock.unlock() }; expire()
        guard url.scheme == "capacitor", url.host == "localhost", url.port == nil, url.query == nil else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count == 3, parts[0] == "__gezel_preview", parts[2] == "index.html", UUID(uuidString: String(parts[1])) != nil else { return nil }
        return entries[String(parts[1])]?.data
    }
    enum PreviewError: LocalizedError {
        case unavailable, tooLarge
        var errorDescription: String? { self == .unavailable ? "Safe page previews are unavailable in this build" : "Close another preview, or choose a page smaller than 8 MiB" }
    }
}

private final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    let original: WKURLSchemeHandler
    let snapshots: PreviewSnapshots
    init(original: WKURLSchemeHandler, snapshots: PreviewSnapshots) { self.original = original; self.snapshots = snapshots }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, PreviewSnapshots.reserved(url) else { original.webView(webView, start: urlSchemeTask); return }
        let bytes = urlSchemeTask.request.httpMethod == "GET" ? snapshots.read(url) : nil
        let response = HTTPURLResponse(url: url, statusCode: bytes == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PreviewSnapshots.csp,
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
        ])!
        urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(bytes ?? Data()); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        if let url = urlSchemeTask.request.url, PreviewSnapshots.reserved(url) { return }
        original.webView(webView, stop: urlSchemeTask)
    }
}
