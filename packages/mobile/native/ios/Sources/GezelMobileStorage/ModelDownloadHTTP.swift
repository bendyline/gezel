import Foundation

/// Bounded redirect policy; URLSession retains ordinary system TLS validation.
final class ModelDownloadHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    typealias Headers = @Sendable (HTTPURLResponse) throws -> Void
    typealias Chunk = @Sendable (Data) throws -> Void
    typealias Completion = @Sendable (Error?) -> Void
    private let headers: Headers
    private let chunk: Chunk
    private let completion: Completion
    private var failure: Error?
    private var redirects = 0
    private var session: URLSession?
    private var task: URLSessionDataTask?
    init(url: URL, method: String, fields: [String:String], configuration: URLSessionConfiguration,
         queue: DispatchQueue, headers: @escaping Headers, chunk: @escaping Chunk, completion: @escaping Completion) throws {
        try MobileModelSource.validateURL(url)
        self.headers = headers; self.chunk = chunk; self.completion = completion
        super.init()
        let operations = OperationQueue(); operations.maxConcurrentOperationCount = 1; operations.underlyingQueue = queue
        let configuration = configuration.copy() as! URLSessionConfiguration
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil; configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 24 * 60 * 60
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        fields.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        task = session!.dataTask(with: request)
    }
    func start() { task?.resume() }
    func cancel() { task?.cancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        do {
            guard let url = request.url, redirects < 5 else { throw ModelDownloadError("Model source redirected too many times") }
            try MobileModelSource.validateURL(url); redirects += 1
            completionHandler(request)
        } catch { failure = error; completionHandler(nil); task.cancel() }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        do {
            guard let response = response as? HTTPURLResponse else { throw ModelDownloadError("Invalid model source response") }
            try headers(response); completionHandler(.allow)
        } catch { failure = error; completionHandler(.cancel) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do { try chunk(data) } catch { failure = error; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        completion(failure ?? error)
        session.invalidateAndCancel(); self.session = nil; self.task = nil
    }
}
