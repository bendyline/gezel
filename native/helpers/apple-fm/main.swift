import Foundation
import FoundationModels

// gezel-apple-fm: Apple's on-device model for the gezel daemon, as JSON lines
// on stdio. The daemon owns conversations, prompts and tool execution; this
// process turns one request into one generation and calls back for each tool.
// The model code is shared with the iOS runtime (native/runtime/ios/Sources/
// GezelRuntime/Apple*.swift), so both hosts build the same transcripts.
//
// daemon -> helper: hello | generate | tool_result | cancel | count
// helper -> daemon: hello | delta | tool_call | done | error | count

let helperVersion = "1"
let usage = """
gezel-apple-fm \(helperVersion): serves Apple's on-device model to the gezel daemon.

Usage:
  gezel-apple-fm              Serve JSON-lines requests on stdin/stdout until stdin closes.
  gezel-apple-fm --self-test  Check tool-schema translation without running the model.
  gezel-apple-fm --help       Show this help.

Requires macOS 26 or later with Apple Intelligence enabled; earlier systems
answer every request as unavailable.
"""

final class Wire: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }
}

final class Requests: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [String: Task<Void, Never>] = [:]
    private var calls: [String: (request: String, continuation: CheckedContinuation<NativeToolReply, Error>)] = [:]

    func start(_ id: String, _ task: Task<Void, Never>) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard tasks[id] == nil else { return false }
        tasks[id] = task
        return true
    }
    func finish(_ id: String) {
        lock.lock(); tasks.removeValue(forKey: id); lock.unlock()
    }
    func park(_ callId: String, request: String, _ continuation: CheckedContinuation<NativeToolReply, Error>) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard tasks[request] != nil else { return false }
        calls[callId] = (request, continuation)
        return true
    }
    func resume(_ callId: String, with result: Result<NativeToolReply, Error>) -> Bool {
        lock.lock(); let entry = calls.removeValue(forKey: callId); lock.unlock()
        entry?.continuation.resume(with: result)
        return entry != nil
    }
    /// Stops one request (or all) and releases every tool call it parked.
    func cancel(_ id: String?) {
        lock.lock()
        let stopping = tasks.filter { id == nil || $0.key == id }
        let parked = calls.filter { entry in stopping.keys.contains(entry.value.request) }
        for key in parked.keys { calls.removeValue(forKey: key) }
        lock.unlock()
        parked.values.forEach { $0.continuation.resume(throwing: CancellationError()) }
        stopping.values.forEach { $0.cancel() }
    }
}

let wire = Wire()
let requests = Requests()

func fail(_ id: String, _ error: Error) {
    if error is CancellationError {
        wire.send(["type": "done", "id": id, "stopReason": "cancelled"]); return
    }
    let coded = error as? MobileInferenceError
    wire.send(["type": "error", "id": id, "code": coded?.code ?? "INFERENCE_FAILED",
               "message": coded?.message ?? error.localizedDescription])
}

func turns(_ raw: Any?) throws -> [MobileChatTurn] {
    guard let messages = raw as? [[String: Any]], !messages.isEmpty, messages.count <= 128 else {
        throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "A conversation is required.")
    }
    return try messages.map { message in
        guard let role = message["role"] as? String, ["system", "user", "assistant"].contains(role),
              let content = message["content"] as? String, !content.contains("\0") else {
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid conversation message.")
        }
        return MobileChatTurn(role: role, content: content)
    }
}

@available(macOS 26.0, *)
func generate(_ message: [String: Any], id: String) {
    let task = Task {
        defer { requests.finish(id) }
        do {
            let reason = try await AppleFoundationProvider.generate(
                turns: try turns(message["messages"]),
                maxTokens: message["maxTokens"] as? Int ?? AppleFoundationProvider.maximumOutputTokens,
                contextSize: message["contextSize"] as? Int ?? 4096,
                tools: message["tools"] as? [[String: Any]] ?? [],
                invoke: { name, arguments in
                    let callId = UUID().uuidString
                    return try await withTaskCancellationHandler {
                        try await withCheckedThrowingContinuation { continuation in
                            guard requests.park(callId, request: id, continuation) else {
                                continuation.resume(throwing: CancellationError()); return
                            }
                            wire.send(["type": "tool_call", "id": id, "callId": callId, "name": name, "arguments": arguments])
                        }
                    } onCancel: {
                        _ = requests.resume(callId, with: .failure(CancellationError()))
                    }
                },
                onDelta: { wire.send(["type": "delta", "id": id, "text": $0]) })
            wire.send(["type": "done", "id": id, "stopReason": reason])
        } catch {
            fail(id, error)
        }
    }
    if !requests.start(id, task) {
        task.cancel()
        wire.send(["type": "error", "id": id, "code": "BUSY", "message": "This request is already running."])
    }
}

@available(macOS 26.0, *)
func count(_ message: [String: Any], id: String) {
    Task {
        do {
            guard #available(macOS 26.4, *) else {
                throw MobileInferenceError(code: "UNSUPPORTED", message: "Token counting needs macOS 26.4 or later.")
            }
            let tokens = try await AppleFoundationProvider.countTokens(
                turns: try turns(message["messages"]), tools: message["tools"] as? [[String: Any]] ?? [])
            wire.send(["type": "count", "id": id, "tokens": tokens])
        } catch { fail(id, error) }
    }
}

func hello() {
    var reply: [String: Any] = [
        "type": "hello", "version": helperVersion,
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "maxOutputTokens": AppleFoundationProvider.maximumOutputTokens,
    ]
    let readiness = AppleFoundationProvider.availability()
    reply["available"] = readiness.reason == nil
    reply["contextTokens"] = readiness.contextTokens
    if let reason = readiness.reason { reply["reason"] = reason }
    wire.send(reply)
}

/// Schema translation needs the framework but not the model, so this passes on
/// build machines where Apple Intelligence is unavailable.
func selfTest() -> Int32 {
    guard #available(macOS 26.0, *) else {
        print("gezel-apple-fm self-test skipped: FoundationModels needs macOS 26 or later.")
        return 0
    }
    let spec: [String: Any] = [
        "name": "replace_in_file", "description": "Replace text in a file.",
        "parameters": ["kind": "object", "properties": [
            ["name": "path", "optional": false, "schema": ["kind": "string"]],
            ["name": "occurrence", "optional": true, "schema": ["kind": "anyOf", "choices": [
                ["kind": "integer"], ["kind": "string", "choices": ["all"]]]]],
            ["name": "tags", "optional": true, "schema": ["kind": "array", "items": ["kind": "string"], "maxItems": 5]],
            ["name": "input", "optional": true, "schema": ["kind": "json"]],
        ]],
    ]
    do {
        let tool = try AppleBridgedTool(spec) { _, _ in NativeToolReply(output: "", endTurn: false) }
        _ = Transcript.ToolDefinition(tool: tool)
        print("gezel-apple-fm self-test passed: \(tool.name) schema translated.")
        return 0
    } catch {
        print("gezel-apple-fm self-test failed: \(error.localizedDescription)")
        return 1
    }
}

let arguments = CommandLine.arguments.dropFirst()
if arguments.contains("--help") { print(usage); exit(0) }
if arguments.contains("--self-test") { exit(selfTest()) }

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = message["type"] as? String else { continue }
    let id = message["id"] as? String ?? ""
    switch type {
    case "hello": hello()
    case "generate", "count":
        guard !id.isEmpty else { continue }
        guard #available(macOS 26.0, *) else {
            fail(id, MobileInferenceError(code: "UNAVAILABLE", message: "Apple on-device AI requires macOS 26 or later.")); continue
        }
        if type == "generate" { generate(message, id: id) } else { count(message, id: id) }
    case "cancel": requests.cancel(id.isEmpty ? nil : id)
    case "tool_result":
        guard let callId = message["callId"] as? String else { continue }
        let result: Result<NativeToolReply, Error> = if let error = message["error"] as? String {
            .failure(MobileInferenceError(code: "TOOL_FAILED", message: String(error.prefix(2_000))))
        } else {
            .success(NativeToolReply(output: message["output"] as? String ?? "", endTurn: message["endTurn"] as? Bool ?? false))
        }
        _ = requests.resume(callId, with: result)
    default: continue
    }
}
// The daemon closed our input: it is gone, so nothing may keep generating.
requests.cancel(nil)
exit(0)
