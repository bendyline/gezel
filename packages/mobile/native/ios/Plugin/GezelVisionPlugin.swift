import Capacitor
import CoreGraphics
import Foundation
import ImageIO
import UIKit
import Vision
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Reads a chat photo on the phone: Vision's scene labels and text on every
/// iPhone, and a Foundation Models description on iOS 27 devices whose
/// on-device model can see. The product runtime calls it from inside a turn
/// that already holds the engine, so one read runs at a time.
@objc(GezelVisionPlugin)
public final class GezelVisionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GezelVisionPlugin"
    public let jsName = "GezelVision"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    /// Vision classifies and reads small images well; Foundation Models resizes its own.
    private static let maxEdge = 1024
    private static let maxImageBase64 = 22_400_000
    private static let maxTextCharacters = 4000
    private static let maxLabels = 10
    private let lock = NSLock()
    private var activeId: String?
    private var activeTask: Task<Void, Never>?
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    /// Kept by notifications: plugin calls arrive off the main thread, where
    /// UIApplication.applicationState must not be read.
    private var backgrounded = false

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    struct Decoded {
        let image: CGImage
        let width: Int
        let height: Int
    }

    public override func load() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setBackgrounded(true)
            self?.cancelActive(nil)
        }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setBackgrounded(false)
        }
    }
    deinit {
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        activeTask?.cancel()
    }

    @objc public func status(_ call: CAPPluginCall) {
        call.resolve(["labels": "ready", "text": "ready", "describer": Self.describerStatus()])
    }
    /// The system downloads and prepares Foundation Models itself; an app has nothing to start.
    @objc public func prepare(_ call: CAPPluginCall) { status(call) }

    @objc public func read(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), UUID(uuidString: id) != nil else {
            call.reject("A vision request identity is required", "invalid-input"); return
        }
        guard let encoded = call.getString("image"), !encoded.isEmpty, encoded.utf8.count <= Self.maxImageBase64,
              let data = Data(base64Encoded: encoded) else {
            call.reject("Photos must be up to 16 MiB", "invalid-input"); return
        }
        let describe = call.getBool("describe") ?? true
        let prompt = call.getObject("prompt")
        let system = prompt?["system"] as? String ?? "You describe images accurately and concisely for someone who cannot see them."
        let user = prompt?["user"] as? String ?? "Describe this image in two or three sentences."
        let maxTokens = min(max(prompt?["maxTokens"] as? Int ?? 400, 64), 1024)
        lock.lock()
        if activeId != nil || backgrounded {
            lock.unlock(); call.reject("Photo reading is busy or Gezel is in the background", "busy"); return
        }
        activeId = id
        activeTask = Task.detached(priority: .userInitiated) { [weak self] in
            let outcome: Result<[String: Any], Error>
            do {
                outcome = .success(try await Self.run(data, describe: describe, system: system, user: user, maxTokens: maxTokens))
            } catch {
                outcome = .failure(error)
            }
            // Free the slot before answering: the next photo in the same
            // message is sent the moment this one resolves.
            self?.finish(id)
            switch outcome {
            case .success(let result): call.resolve(result)
            case .failure(is CancellationError): call.reject("Photo reading stopped", "cancelled")
            case .failure(let error): call.reject(error.localizedDescription, "failed")
            }
        }
        lock.unlock()
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        cancelActive(call.getString("requestId"))
        call.resolve()
    }

    private func setBackgrounded(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        backgrounded = value
    }
    private func cancelActive(_ id: String?) {
        lock.lock(); defer { lock.unlock() }
        if id == nil || id == activeId { activeTask?.cancel() }
    }
    private func finish(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        if activeId == id { activeId = nil; activeTask = nil }
    }

    static func run(_ data: Data, describe: Bool, system: String, user: String, maxTokens: Int) async throws -> [String: Any] {
        let decoded = try decode(data)
        try Task.checkCancellation()
        var result: [String: Any] = ["width": decoded.width, "height": decoded.height]
        var models: [String] = []
        let reading = try recognize(decoded.image)
        if !reading.labels.isEmpty { models.append("apple-vision-classify") }
        if !reading.text.isEmpty { models.append("apple-vision-text") }
        result["labels"] = reading.labels
        result["text"] = reading.text
        var describer = (describerStatus()["state"] as? String) ?? "unavailable"
        if describe && describer == "ready" {
            do {
                let description = try await self.describe(decoded.image, system: system, user: user, maxTokens: maxTokens)
                if !description.isEmpty {
                    result["description"] = description
                    models.append("apple-foundation-models")
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                describer = "failed"
                result["describerReason"] = error.localizedDescription
            }
        }
        try Task.checkCancellation()
        result["describer"] = describer
        result["models"] = models
        return result
    }

    /// The thumbnail path applies the EXIF orientation while it decodes, so
    /// Vision and the describer see the picture upright, and it reads HEIC.
    static func decode(_ data: Data) throws -> Decoded {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure(message: "This photo could not be read") }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        var width = properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
        var height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 0
        if let orientation = properties?[kCGImagePropertyOrientation] as? UInt32, orientation >= 5 { swap(&width, &height) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure(message: "This photo could not be read")
        }
        return Decoded(image: image, width: width > 0 ? width : image.width, height: height > 0 ? height : image.height)
    }

    /// Each recognizer runs on its own, so one that cannot run here (the
    /// simulator has no classifier) still leaves the other's reading. Only
    /// both failing is an error.
    static func recognize(_ image: CGImage) throws -> (labels: [[String: Any]], text: String) {
        let classify = VNClassifyImageRequest()
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let classified = (try? handler.perform([classify])) != nil
        do { try handler.perform([text]) } catch where classified {}
        // Vision scores all ~1,300 classes; Apple's guidance is to keep the
        // ones that hold 90% precision, which drops its hedges ("structure").
        let labels = (classify.results ?? [])
            .filter { $0.hasPrecisionRecallCurve ? $0.hasMinimumRecall(0.01, forPrecision: 0.9) : $0.confidence >= 0.5 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(maxLabels)
            .map { ["label": $0.identifier.replacingOccurrences(of: "_", with: " "), "confidence": Double($0.confidence)] as [String: Any] }
        let lines = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let joined = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (Array(labels), String(joined.prefix(maxTextCharacters)))
    }

    static func describerStatus() -> [String: Any] {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                return model.capabilities.contains(.vision)
                    ? ["state": "ready", "model": "apple-foundation-models"]
                    : ["state": "unavailable", "reason": "Apple's on-device model on this iPhone cannot read images."]
            case .unavailable(.deviceNotEligible):
                return ["state": "unavailable", "reason": "This iPhone does not support Apple Intelligence."]
            case .unavailable(.appleIntelligenceNotEnabled):
                return ["state": "unavailable", "reason": "Turn on Apple Intelligence in Settings to describe photos with it."]
            case .unavailable(.modelNotReady):
                return ["state": "downloading", "reason": "Apple's on-device model is still being prepared."]
            case .unavailable:
                return ["state": "unavailable", "reason": "Apple on-device AI is currently unavailable on this device."]
            }
        }
        #endif
        return ["state": "unavailable", "reason": "Describing photos with Apple's on-device model needs iOS 27."]
    }

    static func describe(_ image: CGImage, system: String, user: String, maxTokens: Int) async throws -> String {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, *) {
            let session = LanguageModelSession(model: SystemLanguageModel.default, instructions: system)
            let response = try await session.respond(options: GenerationOptions(temperature: 0.1, maximumResponseTokens: maxTokens)) {
                user
                Attachment(image)
            }
            return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        #endif
        throw Failure(message: "Describing photos with Apple's on-device model needs iOS 27")
    }
}
