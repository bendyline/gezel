import Foundation
import FoundationModels

struct MobileChatTurn: Sendable {
    let role: String
    let content: String
}

public struct MobileInferenceError: LocalizedError {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}

enum AppleFoundationProvider {
    static let maximumOutputTokens = 1024

    static func availability() -> (reason: String?, contextTokens: Int) {
        guard #available(iOS 26.0, *) else {
            return ("Apple on-device AI requires iOS 26 or later.", 4096)
        }
        // Explicitly choose the on-device model, including on SDKs that also
        // expose cloud models. Never substitute a different model/provider.
        let model = SystemLanguageModel.default
        let reportedContext = min(4096, model.contextSize)
        // An unavailable system model can report no context at all (including
        // on the simulator). Keep its descriptor valid for the shared provider
        // list; the availability reason still prevents inference.
        let context = reportedContext > maximumOutputTokens ? reportedContext : 4096
        switch model.availability {
        case .available:
            guard reportedContext > maximumOutputTokens else {
                return ("Apple's on-device model did not report a usable context window.", context)
            }
            return (nil, context)
        case .unavailable(.deviceNotEligible):
            return ("This device does not support Apple Intelligence.", context)
        case .unavailable(.appleIntelligenceNotEnabled):
            return ("Enable Apple Intelligence in Settings to use Apple on-device AI.", context)
        case .unavailable(.modelNotReady):
            // The SDK does not expose download progress or a download command.
            return ("Apple's on-device model is not ready. iOS manages its download and preparation.", context)
        case .unavailable:
            return ("Apple on-device AI is currently unavailable on this device.", context)
        }
    }

    static func requireContextBudget(promptTokens: Int, maxTokens: Int, contextSize: Int, modelContext: Int) throws {
        let limit = min(contextSize, min(modelContext, 4096))
        guard (512...4096).contains(contextSize), (1...maximumOutputTokens).contains(maxTokens),
              modelContext > 0, promptTokens >= 0, promptTokens <= limit - maxTokens - 256 else {
            throw MobileInferenceError(code: "CONTEXT_LIMIT", message: "This conversation exceeds Apple on-device AI's context budget. Start a new conversation.")
        }
    }

    @available(iOS 26.0, *)
    static func generate(
        turns: [MobileChatTurn], maxTokens: Int, contextSize: Int,
        onDelta: (String) throws -> Void
    ) async throws -> String {
        let readiness = availability()
        if let reason = readiness.reason { throw MobileInferenceError(code: "UNAVAILABLE", message: reason) }
        guard (1...maximumOutputTokens).contains(maxTokens), turns.count <= 64,
              turns.reduce(0, { $0 + $1.content.utf8.count }) <= 32_768,
              let final = turns.last, final.role == "user" else {
            throw MobileInferenceError(code: "CONTEXT_LIMIT", message: "This conversation is too long for Apple on-device AI. Start a new conversation.")
        }
        var entries: [Transcript.Entry] = []
        var instructions: [String] = []
        var sawConversation = false
        for turn in turns.dropLast() {
            let segment = Transcript.Segment.text(.init(content: turn.content))
            switch turn.role {
            case "system":
                guard !sawConversation else {
                    throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "System instructions must precede the conversation.")
                }
                instructions.append(turn.content)
            case "user":
                sawConversation = true
                entries.append(.prompt(.init(segments: [segment])))
            case "assistant":
                sawConversation = true
                entries.append(.response(.init(assetIDs: [], segments: [segment])))
            default:
                throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Unsupported conversation role.")
            }
        }
        if !instructions.isEmpty {
            entries.insert(.instructions(.init(segments: [.text(.init(content: instructions.joined(separator: "\n\n")))], toolDefinitions: [])), at: 0)
        }
        let model = SystemLanguageModel.default
        let finalEntry = Transcript.Entry.prompt(.init(segments: [.text(.init(content: final.content))]))
        let promptTokens: Int
        if #available(iOS 26.4, *) {
            promptTokens = try await model.tokenCount(for: entries + [finalEntry])
        } else {
            // Older systems expose no tokenizer. UTF-8 bytes plus entry overhead
            // conservatively bound this adapter's admission; no history is cut.
            promptTokens = turns.reduce(0, { $0 + $1.content.utf8.count + 32 })
        }
        try requireContextBudget(promptTokens: promptTokens, maxTokens: maxTokens, contextSize: contextSize, modelContext: readiness.contextTokens)
        try Task.checkCancellation()
        // Fresh state on every turn. All prior messages come from the durable
        // app transcript; no hidden provider session can drift after restart.
        let session = LanguageModelSession(model: model, tools: [], transcript: Transcript(entries: entries))
        let stream = session.streamResponse(to: final.content, options: GenerationOptions(samplingMode: .greedy, maximumResponseTokens: maxTokens))
        var text = ""
        var reachedTokenLimit = false
        func awaitProviderRelease() async {
            // A cancellation request is not a release barrier. Keep the plugin
            // busy until the SDK reports its session is no longer responding.
            while session.isResponding {
                await Task.detached { try? await Task.sleep(nanoseconds: 50_000_000) }.value
            }
        }
        do {
            for try await snapshot in stream {
                try Task.checkCancellation()
                let next = snapshot.content
                guard next.utf8.count <= 65_536 else {
                    throw MobileInferenceError(code: "RESOURCE_LIMIT", message: "Apple on-device AI exceeded this app's response size limit.")
                }
                guard next.hasPrefix(text) else {
                    throw MobileInferenceError(code: "INFERENCE_FAILED", message: "Apple on-device AI revised text that had already been streamed.")
                }
                let delta = String(next.dropFirst(text.count))
                if !delta.isEmpty { try onDelta(delta) }
                text = next
                if #available(iOS 27.0, *) {
                    reachedTokenLimit = snapshot.usage.output.totalTokenCount >= maxTokens
                }
            }
        } catch {
            withUnsafeCurrentTask { $0?.cancel() }
            await awaitProviderRelease()
            throw error
        }
        await awaitProviderRelease()
        try Task.checkCancellation()
        // iOS 26 exposes no terminal stop reason/token usage for a text stream.
        // Its normal completion is reported as stop; the SDK still enforces
        // maximumResponseTokens, and the host enforces the byte/time budgets.
        return reachedTokenLimit ? "length" : "stop"
    }
}
