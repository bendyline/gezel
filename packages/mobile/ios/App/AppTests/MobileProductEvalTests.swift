import XCTest
import CryptoKit
import WebKit
@testable import App

/// Runs only when explicitly selected. The suite is a test-bundle resource, not an app hook.
final class MobileProductEvalTests: XCTestCase {
    @MainActor
    func testRealProviderProductEvals() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["GEZEL_MOBILE_EVAL"] == "1" else {
            throw XCTSkip("Quality evals are opt-in; use the mobile eval launcher")
        }
        var candidate: WKWebView?
        var host: MainViewController?
        for _ in 0..<100 {
            host = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).compactMap { $0.rootViewController as? MainViewController }.first
            candidate = host?.webView
            if candidate != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let view = try XCTUnwrap(candidate)
        func stage(_ value: String) { print("MOBILE_EVAL_STAGE \(value)") }
        func runAsync(_ source: String, seconds: TimeInterval = 60) async throws -> Any? {
            _ = try await view.evaluateJavaScript("window.__gezelEvalPhase=null;(async()=>{\(source)})().then(value=>window.__gezelEvalPhase={value},error=>window.__gezelEvalPhase={error:String(error.stack||error)});true")
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline {
                if let result = try await view.evaluateJavaScript("window.__gezelEvalPhase||null") as? [String: Any] {
                    if let error = result["error"] as? String {
                        throw NSError(domain: "MobileEval", code: 4, userInfo: [NSLocalizedDescriptionKey: error])
                    }
                    return result["value"]
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw NSError(domain: "MobileEval", code: 5, userInfo: [NSLocalizedDescriptionKey: "Native JavaScript phase exceeded \(seconds) seconds"])
        }
        func waitForApp() async throws {
            let deadline = Date().addingTimeInterval(60)
            for _ in 0..<600 {
                if (try? await view.evaluateJavaScript("Boolean(!window.__gezelEvalReloading && window.__GEZEL__?.fetch && document.querySelector('[data-testid=\"app-sidebar\"]') && window.Capacitor?.Plugins?.GezelMobile)")) as? Bool == true { return }
                if Date() >= deadline { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw NSError(domain: "MobileEval", code: 1, userInfo: [NSLocalizedDescriptionKey: "Packaged product did not initialize"])
        }
        stage("waiting-initial-app")
        try await waitForApp()
        stage("initial-app-ready")
        let appURL = try XCTUnwrap(view.url)
        let plugin = try XCTUnwrap(host?.bridge?.plugin(withName: "GezelMobile"))
        // Like Android's test-only reflection barrier, this waits for every
        // native write queued before the old WebView was unloaded. No app hook.
        let storageQueue = try XCTUnwrap(Mirror(reflecting: plugin).children
            .first(where: { $0.label == "storageQueue" })?.value as? DispatchQueue)
        func storageFence() async {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                storageQueue.async { continuation.resume() }
            }
        }
        let fm = FileManager.default
        let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = support.appendingPathComponent("Gezel", isDirectory: true)
        let unresolved = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("product-eval-backup-") || $0.lastPathComponent.hasPrefix("product-smoke-backup-") }
        guard unresolved == nil else {
            throw NSError(domain: "MobileEval", code: 8, userInfo: [NSLocalizedDescriptionKey: "Recover the preserved product backup before another eval: \(unresolved!.path)"])
        }
        let product = root.appendingPathComponent("product", isDirectory: true)
        let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let output = documents.appendingPathComponent("mobile-evals", isDirectory: true)
        try fm.createDirectory(at: output, withIntermediateDirectories: true)
        let runId = env["GEZEL_EVAL_RUN_ID"] ?? "ios-\(Int(Date().timeIntervalSince1970))"
        guard runId.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else {
            throw NSError(domain: "MobileEval", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid run id"])
        }
        let reportURL = output.appendingPathComponent("\(runId).json")
        print("MOBILE_EVAL_REPORT \(reportURL.path)")
        func recordRestoration(_ receipt: [String: Any]) throws {
            let bytes = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            let receiptURL = output.appendingPathComponent("\(runId).restoration.json")
            try bytes.write(to: receiptURL, options: .atomic)
            if fm.fileExists(atPath: reportURL.path) {
                var report = try JSONSerialization.jsonObject(with: Data(contentsOf: reportURL)) as? [String: Any] ?? [:]
                report["nativeRestoration"] = receipt
                try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL, options: .atomic)
            }
            let attachment = XCTAttachment(data: bytes, uniformTypeIdentifier: "public.json")
            attachment.name = "\(runId)-native-restoration.json"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            print("MOBILE_EVAL_RESTORATION \(receiptURL.path)")
        }
        let appNavigationDelegate = view.navigationDelegate
        func unloadProduct() async throws {
            if (try? await view.evaluateJavaScript("!window.__GEZEL__ && document.readyState === 'complete'")) as? Bool == true {
                await storageFence()
                return
            }
            _ = try await runAsync("const p=window.Capacitor.Plugins.GezelMobile; await p.releaseModel(); await p.listProductFiles({path:''}); return true;")
            // The production delegate rejects about:blank. Only XCTest temporarily
            // clears it to unload all product JavaScript before resetting test files.
            view.navigationDelegate = nil
            _ = try await view.evaluateJavaScript("window.__gezelEvalReloading=true")
            view.loadHTMLString("", baseURL: nil)
            for _ in 0..<100 {
                if (try? await view.evaluateJavaScript("!window.__GEZEL__ && document.readyState === 'complete'")) as? Bool == true {
                    await storageFence()
                    return
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            view.navigationDelegate = appNavigationDelegate
            throw NSError(domain: "MobileEval", code: 6, userInfo: [NSLocalizedDescriptionKey: "Old product page did not unload"])
        }
        stage("isolating-product")
        try await unloadProduct()
        let preservation = try EvalDataPreservation.begin(root: root)
        addTeardownBlock { @MainActor in
            do {
                // A failed native drain is not permission to replace live files.
                try await unloadProduct()
                view.stopLoading()
                view.configuration.userContentController.removeAllScriptMessageHandlers()
                let verified = try preservation.restoreAndVerify()
                let receipt = try JSONSerialization.jsonObject(with: JSONEncoder().encode(verified)) as? [String: Any] ?? [:]
                try recordRestoration(receipt)
                XCTAssertTrue(verified.passed, "Original product bytes and model inventory must be restored")
            } catch {
                try? recordRestoration(["passed": false, "error": String(describing: error), "backupPath": preservation.backup.path])
                throw error
            }
        }
        view.navigationDelegate = appNavigationDelegate
        view.load(URLRequest(url: appURL))
        try await waitForApp()
        stage("isolated-app-ready")
        let sourceURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "mobile-product-eval", withExtension: "js"))
        let clockURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "mobile-eval-clock", withExtension: "js"))
        let source = try String(contentsOf: clockURL, encoding: .utf8) + "\n" + String(contentsOf: sourceURL, encoding: .utf8)
        let sourceHash = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        print("MOBILE_EVAL_HARNESS \(sourceHash) \(sourceURL.path)")
        let productIndexURL = try XCTUnwrap(Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public"))
        let productIndexHash = SHA256.hash(data: try Data(contentsOf: productIndexURL)).map { String(format: "%02x", $0) }.joined()

        var options: [String: Any] = [
            "runId": runId,
            "provider": env["GEZEL_EVAL_PROVIDER"] ?? "apple-foundation-models",
            "trialTimeoutMs": Int(env["GEZEL_EVAL_TRIAL_TIMEOUT_MS"] ?? "180000") ?? 180000,
            "identity": ["os": UIDevice.current.systemName, "osVersion": UIDevice.current.systemVersion,
                         "device": UIDevice.current.model, "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
                         "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
                         "nativeHarness": "XCTest packaged WKWebView", "harnessSourceSha256": sourceHash, "productIndexSha256": productIndexHash],
        ]
        if let raw = env["GEZEL_EVAL_CONTEXT"], let value = Int(raw) { options["contextSize"] = value }
        if let raw = env["GEZEL_EVAL_MAX_TOKENS"], let value = Int(raw) { options["maxTokens"] = value }
        let fixturesURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "canonical-fixtures", withExtension: "json"))
        options["canonicalFixtures"] = try JSONSerialization.jsonObject(with: Data(contentsOf: fixturesURL))
        if let selected = env["GEZEL_EVAL_SCENARIOS"], !selected.isEmpty { options["scenarios"] = selected.split(separator: ",").map(String.init) }
        _ = try await view.evaluateJavaScript(source)
        stage("harness-injected")
        var contracts: [String: Any] = ["passed": false]
        do {
            stage("preparing-contracts")
            contracts = try await runAsync("return await window.__gezelMobileEval.prepareContracts();", seconds: 180) as? [String: Any] ?? contracts
            stage("contracts-prepared-reloading")
            _ = try await view.evaluateJavaScript("window.__gezelEvalReloading=true")
            view.reload()
            try await waitForApp()
            _ = try await view.evaluateJavaScript(source)
            stage("checking-contract-ui")
            let encoded = String(decoding: try JSONSerialization.data(withJSONObject: contracts), as: UTF8.self)
            contracts = try await runAsync("return await window.__gezelMobileEval.finishContracts(\(encoded));") as? [String: Any] ?? contracts
        } catch { contracts["error"] = String(describing: error); contracts["passed"] = false }
        stage("contracts-complete")
        var reports: [[String: Any]] = []
        func persist(_ phases: [[String: Any]], complete: Bool = false) async throws -> [String: Any] {
            let merged = try await view.callAsyncJavaScript("return window.__gezelMobileEval.mergeReports(reports,complete);", arguments: ["reports": phases, "complete": complete], in: nil, contentWorld: .page) as? [String: Any] ?? [:]
            try JSONSerialization.data(withJSONObject: merged, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL, options: .atomic)
            return merged
        }
        func runPhase(_ phaseOptions: [String: Any]) async throws {
            _ = try await view.callAsyncJavaScript("window.__gezelMobileEval.run(options).catch(error=>{window.__gezelMobileEvalError=String(error.stack||error)}); return true;", arguments: ["options": phaseOptions], in: nil, contentWorld: .page)
            var lastRevision = -1
            var report: [String: Any] = [:]
            _ = try await view.evaluateJavaScript("window.__gezelMobileEvalClock.startSuspendMonitor();window.__gezelEvalOuterBudget=new window.__gezelMobileEvalClock.AwakeBudget(8*3600000);true")
            while (try await view.evaluateJavaScript("window.__gezelEvalOuterBudget.expired()")) as? Bool == false {
                let state = try await view.evaluateJavaScript("({revision:window.__gezelMobileEvalReport?.revision??-1,complete:window.__gezelMobileEvalReport?.complete??false,error:window.__gezelMobileEvalError??null})") as? [String: Any] ?? [:]
                if let error = state["error"] as? String { throw NSError(domain: "MobileEval", code: 3, userInfo: [NSLocalizedDescriptionKey: error]) }
                let revision = state["revision"] as? Int ?? -1
                if revision != lastRevision {
                    report = try await view.evaluateJavaScript("JSON.parse(JSON.stringify(window.__gezelMobileEvalReport))") as? [String: Any] ?? [:]
                    _ = try await persist(reports + [report])
                    lastRevision = revision
                }
                let receiptURL = URL(fileURLWithPath: reportURL.path + ".receipt.json")
                if let receiptData = try? Data(contentsOf: receiptURL) {
                    let receipt = try JSONSerialization.jsonObject(with: receiptData)
                    _ = try await view.callAsyncJavaScript("window.__gezelMobileEvalGradeReceipt=receipt;return true;", arguments: ["receipt": receipt], in: nil, contentWorld: .page)
                }
                if state["complete"] as? Bool == true { break }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            guard report["complete"] as? Bool == true else {
                throw NSError(domain: "MobileEval", code: 7, userInfo: [NSLocalizedDescriptionKey: "Eval deadline exceeded; partial report retained at \(reportURL.path)"])
            }
            _ = try await view.evaluateJavaScript("window.__gezelEvalReloading=true")
            view.reload()
            try await waitForApp()
            _ = try await view.evaluateJavaScript(source)
            let encoded = String(decoding: try JSONSerialization.data(withJSONObject: report), as: UTF8.self)
            report["reopen"] = try await runAsync("return await window.__gezelMobileEval.verifyReopen(\(encoded));")
            reports.append(report)
            _ = try await persist(reports)
        }
        func resetProduct() async throws {
            try await unloadProduct()
            try fm.removeItem(at: product)
            try fm.createDirectory(at: product, withIntermediateDirectories: true)
            view.navigationDelegate = appNavigationDelegate
            view.load(URLRequest(url: appURL))
            try await waitForApp()
            _ = try await view.evaluateJavaScript(source)
        }
        var contractOptions = options
        contractOptions["contracts"] = contracts
        contractOptions["contractsOnly"] = true
        contractOptions["scenarios"] = [String]()
        try await runPhase(contractOptions)
        try await resetProduct()
        let isolation = try await runAsync("return await window.__gezelMobileEval.verifyFreshProduct();") as? [String: Any] ?? ["passed": false]
        var savedContracts = reports[0]["contracts"] as? [String: Any] ?? [:]
        var assertions = savedContracts["assertions"] as? [[String: Any]] ?? []
        assertions.append(isolation)
        savedContracts["assertions"] = assertions
        savedContracts["passed"] = savedContracts["passed"] as? Bool == true && isolation["passed"] as? Bool == true
        reports[0]["contracts"] = savedContracts
        if env["GEZEL_EVAL_CONTRACTS_ONLY"] != "1" {
            let fixtures = options["canonicalFixtures"] as? [[String: Any]] ?? []
            let defaults = (try await view.evaluateJavaScript("window.__gezelMobileEval.scenarios") as? [String] ?? []) + fixtures.compactMap { $0["id"] as? String }
            for scenario in options["scenarios"] as? [String] ?? defaults {
                stage("isolated-trial \(scenario)")
                try await resetProduct()
                var phaseOptions = options
                phaseOptions["scenarios"] = [scenario]
                try await runPhase(phaseOptions)
            }
        }
        let report = try await persist(reports, complete: true)
        let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try bytes.write(to: reportURL, options: .atomic)
        let attachment = XCTAttachment(data: bytes, uniformTypeIdentifier: "public.json")
        attachment.name = "\(runId)-mobile-product-eval.json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("MOBILE_EVAL_REPORT \(reportURL.path)")
        XCTAssertEqual((report["reopen"] as? [String: Any])?["passed"] as? Bool, true, "Saved artifacts and sessions must survive every isolated trial reload")
        XCTAssertEqual((report["contracts"] as? [String: Any])?["passed"] as? Bool, true, "Authored scripts and shared question UI contracts must pass")
        let failures = (report["trials"] as? [[String: Any]] ?? []).filter { !["pass", "ungraded"].contains($0["status"] as? String ?? "") }
        XCTAssertTrue(failures.isEmpty, "Quality failures are retained, never skipped: \(failures.map { $0["id"] as? String ?? "unknown" }.joined(separator: ", "))")
    }
}
