import Capacitor
import Foundation
import Network
import UIKit

/// HTTPS to other devices' gezel servers on the local network, and Bonjour
/// discovery of them (`_gezel._tcp`).
///
/// A server's certificate is self-signed and names 127.0.0.1, so a request
/// never checks hostnames: it trusts exactly the certificate the page pinned,
/// or — only to read a server's `/v1/identity` before anything is pinned — any
/// certificate. Requests go only to `https://` IP-literal addresses, so the
/// page cannot use this as a general proxy. A response body streams to the
/// page as `remoteChunk` events and ends with one `remoteEnd`.
@objc(GezelRemotePlugin)
public final class GezelRemotePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GezelRemotePlugin"
    public let jsName = "GezelRemote"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceName", returnType: CAPPluginReturnPromise)
    ]
    static let certificateRefused = "REMOTE_CERTIFICATE_REFUSED"
    static let unreachable = "REMOTE_UNREACHABLE"
    private static let maxBodyBytes = 32 * 1024 * 1024
    private static let maxRequests = 16
    private let lock = NSLock()
    private var requests: [String: RemoteRequest] = [:]

    @objc func request(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, id.count <= 64,
              let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme == "https", let host = url.host, Self.isIPLiteral(host) else {
            call.reject("A server request needs an https:// IP address")
            return
        }
        let body = call.getString("body")?.data(using: .utf8)
        if let body, body.count > Self.maxBodyBytes { call.reject("This request is too large"); return }
        var pinned: Data?
        if let pem = call.getString("pinnedCertPem") {
            guard let der = Self.der(fromPem: pem) else { call.reject("The pinned certificate is unreadable"); return }
            pinned = der
        }
        var request = URLRequest(url: url)
        request.httpMethod = call.getString("method") ?? "GET"
        for (name, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        request.httpBody = body
        let connectTimeout = Double(call.getInt("connectTimeoutMs") ?? 5_000) / 1000
        let remote = RemoteRequest(id: id, pinned: pinned, call: call, plugin: self)
        lock.lock()
        if requests.count >= Self.maxRequests || requests[id] != nil {
            lock.unlock()
            call.reject("Too many requests to other devices are open")
            return
        }
        requests[id] = remote
        lock.unlock()
        remote.start(request, connectTimeout: max(1, min(connectTimeout, 30)))
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = call.getString("id") { take(id)?.cancel() }
        call.resolve()
    }

    @objc func deviceName(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["name": UIDevice.current.name]) }
    }

    @objc func browse(_ call: CAPPluginCall) {
        let waitMs = max(200, min(call.getInt("waitMs") ?? 1_500, 10_000))
        BonjourBrowse(waitMs: waitMs) { servers in call.resolve(["servers": servers]) }.start()
    }

    fileprivate func take(_ id: String) -> RemoteRequest? {
        lock.lock()
        defer { lock.unlock() }
        return requests.removeValue(forKey: id)
    }

    fileprivate func emit(_ event: String, _ data: [String: Any]) {
        notifyListeners(event, data: data)
    }

    static func isIPLiteral(_ host: String) -> Bool {
        let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
        return IPv4Address(bare) != nil || IPv6Address(bare) != nil
    }

    static func der(fromPem pem: String) -> Data? {
        let body = pem
            .components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }
}

/// One request: its own ephemeral session, so its TLS handshake — where the
/// pin is checked and reachability is proven — always runs.
private final class RemoteRequest: NSObject, URLSessionDataDelegate {
    let id: String
    let pinned: Data?
    private var call: CAPPluginCall?
    private weak var plugin: GezelRemotePlugin?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let queue: OperationQueue
    private var handshook = false
    private var certificateRefused = false
    private var cancelled = false
    private var finished = false

    init(id: String, pinned: Data?, call: CAPPluginCall, plugin: GezelRemotePlugin) {
        self.id = id
        self.pinned = pinned
        self.call = call
        self.plugin = plugin
        queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        super.init()
    }

    func start(_ request: URLRequest, connectTimeout: TimeInterval) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        // Idle time between packets; a server writes a heartbeat every 15 s.
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
        // No handshake in time: the server isn't there. A server that is there
        // but slow to answer keeps its request.
        DispatchQueue.global().asyncAfter(deadline: .now() + connectTimeout) { [weak self] in
            self?.queue.addOperation {
                guard let self, !self.handshook, !self.finished else { return }
                self.task?.cancel()
            }
        }
    }

    func cancel() {
        queue.addOperation {
            self.cancelled = true
            self.task?.cancel()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        handshook = true
        guard let pinned else {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate]
        guard let leaf = chain?.first, SecCertificateCopyData(leaf) as Data == pinned else {
            certificateRefused = true
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse, let call else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value }
        }
        self.call = nil
        call.resolve(["status": http.statusCode, "headers": headers])
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        plugin?.emit("remoteChunk", ["id": id, "data": data.base64EncodedString()])
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finished = true
        session.finishTasksAndInvalidate()
        _ = plugin?.take(id)
        if let call {
            self.call = nil
            if certificateRefused {
                call.reject("The server presented a certificate other than the one this device trusts", GezelRemotePlugin.certificateRefused)
            } else if cancelled {
                call.reject("The request was stopped", "REMOTE_CANCELLED")
            } else if !handshook {
                call.reject("The server didn't answer", GezelRemotePlugin.unreachable)
            } else {
                call.reject(error?.localizedDescription ?? "The request failed", GezelRemotePlugin.unreachable)
            }
            return
        }
        if cancelled {
            plugin?.emit("remoteEnd", ["id": id, "error": "The request was stopped", "code": "REMOTE_CANCELLED"])
        } else if let error {
            plugin?.emit("remoteEnd", ["id": id, "error": error.localizedDescription, "code": GezelRemotePlugin.unreachable])
        } else {
            plugin?.emit("remoteEnd", ["id": id])
        }
    }
}

/// gezel servers announcing `_gezel._tcp` nearby, each resolved to an IPv4
/// address and port, with the fingerprint and name from its TXT record.
private final class BonjourBrowse {
    private let waitMs: Int
    private let done: ([[String: Any]]) -> Void
    private let queue = DispatchQueue(label: "com.bendyline.gezel.remote.browse")
    private var browser: NWBrowser?
    private var connections: [NWConnection] = []
    private var found: [String: [String: Any]] = [:]
    private var finished = false
    private var retainSelf: BonjourBrowse?

    init(waitMs: Int, done: @escaping ([[String: Any]]) -> Void) {
        self.waitMs = waitMs
        self.done = done
    }

    func start() {
        retainSelf = self
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_gezel._tcp", domain: nil), using: NWParameters())
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            for result in results { self?.resolve(result) }
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.finish() }
        }
        browser.start(queue: queue)
        queue.asyncAfter(deadline: .now() + .milliseconds(waitMs)) { [weak self] in
            // Give addresses still resolving a moment, then answer.
            self?.queue.asyncAfter(deadline: .now() + .milliseconds(750)) { self?.finish() }
        }
    }

    private func resolve(_ result: NWBrowser.Result) {
        guard case let .service(name, _, _, _) = result.endpoint, found[name] == nil, !finished else { return }
        var fingerprint: String?
        var display = name
        if case let .bonjour(txt) = result.metadata {
            fingerprint = txt["fp"]?.lowercased()
            if let advertised = txt["name"], !advertised.isEmpty { display = advertised }
        }
        found[name] = [:]
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: result.endpoint, using: parameters)
        connections.append(connection)
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                if case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint {
                    var address = "\(host)"
                    if let scope = address.firstIndex(of: "%") { address = String(address[..<scope]) }
                    var server: [String: Any] = ["name": String(display.prefix(80)), "host": address, "port": Int(port.rawValue)]
                    if let fingerprint { server["fingerprint"] = fingerprint }
                    self.found[name] = server
                }
                connection.cancel()
            case .failed, .waiting:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        browser?.cancel()
        for connection in connections { connection.cancel() }
        let servers = found.values.filter { $0["host"] != nil }
        retainSelf = nil
        done(Array(servers))
    }
}
