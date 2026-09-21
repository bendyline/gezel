import Foundation

public struct MobileModelSource: Codable, Equatable, Sendable {
    public var catalogId: String
    public var catalogVersion: String
    public var sourceId: String
    public var huggingfaceRepo: String
    public var revision: String
    public var filename: String
    public var sha256: String
    public var sizeBytes: Int64?

    public func validate(exact: Bool) throws {
        let fields = [(catalogId,160),(catalogVersion,80),(sourceId,160),(huggingfaceRepo,200),(filename,400)]
        guard fields.allSatisfy({ !$0.0.isEmpty && $0.0.utf16.count <= $0.1 && !$0.0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }),
              huggingfaceRepo.range(of: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*$", options: .regularExpression) != nil,
              revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              filename.hasSuffix(".gguf"), !filename.contains("\\"),
              filename.components(separatedBy: "/").allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw ModelDownloadError("A catalog model must pin a repository, immutable revision, GGUF filename and SHA-256")
        }
        if exact {
            guard let sizeBytes, (4...MobileStore.maximumModelBytes).contains(sizeBytes) else { throw ModelDownloadError("An exact model length between 4 bytes and 4 GiB is required") }
        }
    }
    public func url() throws -> URL {
        try validate(exact: false)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let path = filename.components(separatedBy: "/").map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
        guard let result = URL(string: "https://huggingface.co/\(huggingfaceRepo)/resolve/\(revision)/\(path)") else { throw ModelDownloadError("Invalid model source") }
        return result
    }
    static func validateURL(_ url: URL) throws {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil,
              url.port == nil || url.port == 443, let host = url.host,
              host == "huggingface.co" || host.hasSuffix(".huggingface.co") || host == "hf.co" || host.hasSuffix(".hf.co") else {
            throw ModelDownloadError("Model download redirected outside its trusted HTTPS source")
        }
    }
}
public struct ModelDownloadError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
