import Foundation
import FoundationModels

/// One argument shape from `MobileNativeToolSchema` (core/src/mobile/inference.ts).
/// Core normalizes JSON Schema into this ordered form because Foundation-decoded
/// dictionaries lose key order, and property order steers Apple's decoder.
indirect enum NativeToolNode {
    case string(description: String?, choices: [String]?)
    case integer(description: String?)
    case number(description: String?)
    case boolean(description: String?)
    case json(description: String?)
    case array(description: String?, items: NativeToolNode, minItems: Int?, maxItems: Int?)
    case object(description: String?, properties: [(name: String, optional: Bool, schema: NativeToolNode)])
    case anyOf(description: String?, choices: [NativeToolNode])

    static let maximumDepth = 8

    init(_ value: Any?, depth: Int = 0) throws {
        guard depth <= Self.maximumDepth, let node = value as? [String: Any], let kind = node["kind"] as? String else {
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool argument schema.")
        }
        let description = try Self.text(node["description"], limit: 1_000)
        switch kind {
        case "string":
            var choices: [String]?
            if let raw = node["choices"] {
                guard let values = raw as? [String], (1...64).contains(values.count),
                      values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 200 }) else {
                    throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool argument choices.")
                }
                choices = values
            }
            self = .string(description: description, choices: choices)
        case "integer": self = .integer(description: description)
        case "number": self = .number(description: description)
        case "boolean": self = .boolean(description: description)
        case "json": self = .json(description: description)
        case "array":
            self = .array(description: description, items: try NativeToolNode(node["items"], depth: depth + 1),
                          minItems: node["minItems"] as? Int, maxItems: node["maxItems"] as? Int)
        case "object":
            guard let raw = node["properties"] as? [[String: Any]], raw.count <= 64 else {
                throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool argument properties.")
            }
            var seen = Set<String>()
            self = .object(description: description, properties: try raw.map { property in
                guard let name = property["name"] as? String, Self.isIdentifier(name), seen.insert(name).inserted,
                      let optional = property["optional"] as? Bool else {
                    throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool argument property.")
                }
                return (name, optional, try NativeToolNode(property["schema"], depth: depth + 1))
            })
        case "anyOf":
            guard let raw = node["choices"] as? [Any], (2...16).contains(raw.count) else {
                throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool argument union.")
            }
            self = .anyOf(description: description, choices: try raw.map { try NativeToolNode($0, depth: depth + 1) })
        default:
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Unsupported tool argument kind.")
        }
    }

    static func isIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 80 && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
        } && value.unicodeScalars.allSatisfy { $0.isASCII }
    }

    private static func text(_ value: Any?, limit: Int) throws -> String? {
        guard let value else { return nil }
        guard let text = value as? String, text.utf8.count <= limit, !text.contains("\0") else {
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool description.")
        }
        return text
    }

    var description: String? {
        switch self {
        case .string(let d, _), .integer(let d), .number(let d), .boolean(let d), .json(let d),
             .array(let d, _, _, _), .object(let d, _), .anyOf(let d, _):
            return d
        }
    }

    /// Names only label definitions inside one tool's schema; a path keeps them unique.
    @available(iOS 26.0, macOS 26.0, *)
    func dynamicSchema(name: String) -> DynamicGenerationSchema {
        switch self {
        case .string(_, let choices?): return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
        case .string, .json: return DynamicGenerationSchema(type: String.self)
        case .integer: return DynamicGenerationSchema(type: Int.self)
        case .number: return DynamicGenerationSchema(type: Double.self)
        case .boolean: return DynamicGenerationSchema(type: Bool.self)
        case .array(_, let items, let minItems, let maxItems):
            return DynamicGenerationSchema(arrayOf: items.dynamicSchema(name: "\(name)_item"), minimumElements: minItems, maximumElements: maxItems)
        case .object(let description, let properties):
            return DynamicGenerationSchema(name: name, description: description, properties: properties.map {
                DynamicGenerationSchema.Property(name: $0.name, description: $0.schema.description,
                                                 schema: $0.schema.dynamicSchema(name: "\(name)_\($0.name)"), isOptional: $0.optional)
            })
        case .anyOf(let description, let choices):
            return DynamicGenerationSchema(name: name, description: description,
                                           anyOf: choices.enumerated().map { $1.dynamicSchema(name: "\(name)_\($0)") })
        }
    }
}

/// What the app's tool loop decided about one call.
struct NativeToolReply: Sendable {
    let output: String
    let endTurn: Bool
}

/// Thrown from a tool to stop generation once the app ends the turn after its result.
struct NativeToolTurnEnded: Error {}

/// A tool whose execution belongs to the app: the durable record, authorization
/// and effects all happen in the shared tool loop, reached through `invoke`.
@available(iOS 26.0, macOS 26.0, *)
struct AppleBridgedTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String
    let name: String
    let description: String
    let parameters: GenerationSchema
    let invoke: @Sendable (_ name: String, _ arguments: String) async throws -> NativeToolReply

    init(_ value: [String: Any], invoke: @escaping @Sendable (String, String) async throws -> NativeToolReply) throws {
        guard let name = value["name"] as? String, name.utf8.count <= 80,
              name.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil,
              let description = value["description"] as? String, description.utf8.count <= 4_000,
              case .object = try NativeToolNode(value["parameters"]) else {
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Invalid tool definition.")
        }
        let node = try NativeToolNode(value["parameters"])
        do {
            parameters = try GenerationSchema(root: node.dynamicSchema(name: "\(name)_arguments"), dependencies: [])
        } catch {
            throw MobileInferenceError(code: "INVALID_ARGUMENT", message: "Tool \(name) has an argument schema Apple on-device AI cannot use.")
        }
        self.name = name
        self.description = description
        self.invoke = invoke
    }

    func call(arguments: GeneratedContent) async throws -> String {
        let reply = try await invoke(name, arguments.jsonString)
        if reply.endTurn { throw NativeToolTurnEnded() }
        return reply.output
    }
}
