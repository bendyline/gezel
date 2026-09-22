import Capacitor
import Foundation
import Speech
import UIKit
import AVFoundation
import GezelSpeech

@objc(GezelSpeechPlugin)
public final class GezelSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GezelSpeechPlugin"
    public let jsName = "GezelSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synthesize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var active: CAPPluginCall?
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    private var backgroundObserver: NSObjectProtocol?
    private let worker = DispatchQueue(label: "com.bendyline.gezel.speech", qos: .userInitiated)
    private var nativeEngine: OpaquePointer?
    private var nativeCancelled = false
    private var cancelWaiters: [CAPPluginCall] = []
    private var speechRoot: URL { Bundle.main.bundleURL.appendingPathComponent("speech") }
    private var voices: [[String: Any]] {
        guard let data = try? Data(contentsOf: speechRoot.appendingPathComponent("voices.json")),
              let values = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return values
    }
    private func ready(_ name: String) -> Bool { FileManager.default.fileExists(atPath: speechRoot.appendingPathComponent(name).path) }
    private var models: [String: Any] {
        guard let data = try? Data(contentsOf: speechRoot.appendingPathComponent("pack.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["stt": [], "tts": []] }
        return value
    }

    public override func load() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.finish(error: "Speech stopped when Gezel entered the background", code: "cancelled")
        }
    }
    deinit {
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        task?.cancel()
    }
    private func locale(_ call: CAPPluginCall) -> Locale {
        call.getString("language").map { Locale(identifier: $0) } ?? Locale.current
    }
    private func systemStatus(_ locale: Locale) -> [String: Any] {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
            return ["state": "unavailable", "reason": "On-device recognition is unavailable for this language."]
        }
        let permission = SFSpeechRecognizer.authorizationStatus()
        if permission != .authorized {
            return ["state": "permission-required", "language": locale.identifier, "model": "system", "reason": "Allow speech recognition to transcribe on this device."]
        }
        return ["state": recognizer.isAvailable ? "ready" : "unavailable", "language": locale.identifier, "model": "system"]
    }
    @objc public func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "system": self.systemStatus(self.locale(call)),
                "whisper": ["state": self.ready("whisper-tiny.bin") ? "ready" : "unavailable", "model": "whisper-tiny"],
                "kokoro": ["state": self.ready("kokoro/model.int8.onnx") ? "ready" : "unavailable", "model": "kokoro-82m-v1.0"],
                "voices": self.voices, "models": self.models
            ])
        }
    }
    @objc public func transcribe(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.active == nil, UIApplication.shared.applicationState != .background else {
                call.reject("Speech is busy or Gezel is in the background", "busy"); return
            }
            guard call.getString("requestId").flatMap(UUID.init(uuidString:)) != nil else {
                call.reject("A valid speech request identity is required", "invalid-input"); return
            }
            if call.getString("engine") == "whisper" {
                self.runNative(call, synthesis: false); return
            }
            guard call.getString("engine") == "system" else {
                call.reject("Unknown speech recognizer", "invalid-input"); return
            }
            guard let recognizer = SFSpeechRecognizer(locale: self.locale(call)), recognizer.supportsOnDeviceRecognition else {
                call.reject("On-device recognition is unavailable for this language", "unavailable"); return
            }
            self.active = call
            self.recognizer = recognizer
            let begin = { [weak self] in
                guard let self, self.active === call else { return }
                guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
                    self.finish(error: "Allow speech recognition in Settings to use on-device transcription", code: "permission-required"); return
                }
                self.recognize(call, recognizer)
            }
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async(execute: begin) }
            } else { begin() }
        }
    }
    private func recognize(_ call: CAPPluginCall, _ recognizer: SFSpeechRecognizer) {
        guard let encoded = call.getString("audio"), encoded.count <= 5_120_000,
                  let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 3_840_000, data.count % 2 == 0,
                  data.base64EncodedString() == encoded else {
                finish(error: "Use up to two minutes of mono 16 kHz speech", code: "invalid-input"); return
            }
            guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
                  let samples = buffer.int16ChannelData else { finish(error: "Audio allocation failed"); return }
            buffer.frameLength = AVAudioFrameCount(data.count / 2)
            data.copyBytes(to: UnsafeMutableRawBufferPointer(start: samples[0], count: data.count))
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = false
            let start = ProcessInfo.processInfo.systemUptime
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self, self.active === call else { return }
                    if let result, result.isFinal {
                        let segments = result.bestTranscription.segments.map {
                            ["start": $0.timestamp, "end": $0.timestamp + $0.duration, "text": $0.substring] as [String: Any]
                        }
                        let value: [String: Any] = [
                            "text": result.bestTranscription.formattedString,
                            "language": self.locale(call).identifier.replacingOccurrences(of: "_", with: "-"),
                            "segments": segments,
                            "durationMs": Int((ProcessInfo.processInfo.systemUptime - start) * 1000)
                        ]
                        self.finish(result: value)
                    } else if let error {
                        self.finish(error: error.localizedDescription, code: recognizer.isAvailable ? "failed" : "unavailable")
                    }
                }
            }
            request.append(buffer)
            request.endAudio()
    }
    @objc public func synthesize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.runNative(call, synthesis: true) }
    }
    @objc public func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("requestId"), id == self.active?.getString("requestId") {
                if self.nativeEngine != nil { self.cancelWaiters.append(call); self.finish(error: "Speech stopped", code: "cancelled"); return }
                self.finish(error: "Speech stopped", code: "cancelled")
            }
            call.resolve()
        }
    }
    private func finish(result: [String: Any]? = nil, error: String? = nil, code: String = "failed") {
        if let nativeEngine { nativeCancelled = true; gezel_speech_cancel(nativeEngine); return }
        guard let call = active else { return }
        active = nil
        task?.cancel(); task = nil; recognizer = nil
        if let result { call.resolve(result) }
        else { call.reject(error ?? "Speech failed", code) }
    }

    private func runNative(_ call: CAPPluginCall, synthesis: Bool) {
        guard active == nil, UIApplication.shared.applicationState != .background else { call.reject("Speech is busy or Gezel is in the background", "busy"); return }
        guard call.getString("requestId").flatMap(UUID.init(uuidString:)) != nil else { call.reject("A speech request identity is required", "invalid-input"); return }
        if ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical {
            call.reject("Let this device cool before running speech", "resource-limit"); return
        }
        let model = synthesis ? "kokoro-82m-v1.0" : "whisper-tiny"
        if let requested = call.getString("model"), requested != model { call.reject("The selected speech model is not installed", "unavailable"); return }
        guard ready(synthesis ? "kokoro/model.int8.onnx" : "whisper-tiny.bin") else { call.reject("The offline speech pack is missing from this build", "unavailable"); return }
        let voice = call.getString("voice") ?? "af_heart"
        let index = voices.first { $0["id"] as? String == voice }?["index"] as? Int
        if synthesis && index == nil { call.reject("The selected Kokoro voice is unavailable", "invalid-input"); return }
        // Phoneme ids, produced by the shared @bendyline/gezel/kokoro frontend
        // in the WebView. Nothing native turns text into sound any more, which
        // is how eSpeak NG left the app.
        var tokens: [Int32] = []
        if synthesis {
            let supplied = (call.getArray("tokens") as? [Int]) ?? []
            guard supplied.count >= 3, supplied.count <= 511, supplied.allSatisfy({ $0 >= 0 && $0 <= 177 })
            else { call.reject("Speech phonemes are missing or too long", "invalid-input"); return }
            tokens = supplied.map(Int32.init)
        }
        guard let engine = gezel_speech_create() else { call.reject("Not enough memory for speech", "resource-limit"); return }
        active = call; nativeEngine = engine; nativeCancelled = false
        let root = speechRoot
        worker.async {
            let start = ProcessInfo.processInfo.systemUptime
            var result: [String: Any]?
            var failure: String?
            if synthesis {
                var wav: UnsafeMutablePointer<UInt8>?
                var count = 0
                let speed = Float(min(2, max(0.5, call.getDouble("speed") ?? 1)))
                let code = tokens.withUnsafeBufferPointer { ids in
                    gezel_speech_synthesize(engine, root.appendingPathComponent("kokoro").path,
                                            ids.baseAddress, ids.count, Int32(index!), speed, &wav, &count)
                }
                if code == 0, let wav {
                    let data = Data(bytes: wav, count: count)
                    result = ["wav": data.base64EncodedString(), "meta": ["voice": voice, "model": model, "sampleRate": 24000, "durationSeconds": Double(count - 44) / 48000, "durationMs": Int((ProcessInfo.processInfo.systemUptime - start) * 1000)]]
                } else { failure = String(cString: gezel_speech_error(engine)) }
                gezel_speech_free(wav)
            } else if let encoded = call.getString("audio"), encoded.count <= 5_120_000, let pcm = Data(base64Encoded: encoded), pcm.base64EncodedString() == encoded {
                var text: UnsafeMutablePointer<CChar>?
                let code = pcm.withUnsafeBytes { bytes in
                    gezel_speech_transcribe(engine, root.appendingPathComponent("whisper-tiny.bin").path, bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), bytes.count, call.getString("language"), call.getString("prompt"), &text)
                }
                if code == 0, let text { result = ["text": String(cString: text), "durationMs": Int((ProcessInfo.processInfo.systemUptime - start) * 1000)] }
                else { failure = String(cString: gezel_speech_error(engine)) }
                gezel_speech_free(text)
            } else { failure = "Invalid speech recording" }
            DispatchQueue.main.async {
                gezel_speech_destroy(engine); self.nativeEngine = nil
                let stopped = self.nativeCancelled
                self.finish(result: stopped ? nil : result, error: stopped ? "Speech stopped" : failure, code: stopped ? "cancelled" : "failed")
                let waiters = self.cancelWaiters; self.cancelWaiters = []
                for waiter in waiters { waiter.resolve() }
            }
        }
    }
}
