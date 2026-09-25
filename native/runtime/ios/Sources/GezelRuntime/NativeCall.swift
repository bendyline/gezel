import Foundation
import CoreFoundation

/// Framework-independent request/reply boundary for native and WebView hosts.
public final class NativeCall: @unchecked Sendable {
    private let input: [String: Any]
    private let success: ([String: Any]) -> Void
    private let failure: (String, String?) -> Void
    private let lock = NSLock()
    private var settled = false
    public init(_ input: [String: Any] = [:], resolve: @escaping ([String: Any]) -> Void, reject: @escaping (String, String?) -> Void) {
        self.input = input; self.success = resolve; self.failure = reject
    }
    public func contains(_ key: String) -> Bool { input[key] != nil }
    public func getString(_ key: String) -> String? { input[key] as? String }
    public func getInt(_ key: String) -> Int? {
        guard let number = input[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(Int32.min), number.doubleValue <= Double(Int32.max) else { return nil }
        return number.intValue
    }
    public func getBool(_ key: String) -> Bool? {
        guard let number = input[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    public func getObject(_ key: String) -> [String: Any]? { input[key] as? [String: Any] }
    public func getArray<T>(_ key: String, _ type: T.Type) -> [T]? { input[key] as? [T] }
    private func takeReply() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !settled else { return false }; settled = true; return true
    }
    public func resolve(_ data: [String: Any] = [:]) { if takeReply() { success(data) } }
    public func reject(_ message: String, _ code: String? = nil) { if takeReply() { failure(message, code) } }
}
