import XCTest
import Capacitor
import WebKit
@testable import App
@testable import GezelRuntime

/// Actual shared React UI, portable service, and native inference on a dedicated simulator.
final class MobileBridgeTests: XCTestCase {
    @MainActor
    func testOfflineSpeechPackRoundTrip() async throws {
        let plugin = GezelSpeechPlugin()
        func invoke(_ method: String, _ options: JSObject) async throws -> PluginCallResultData {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<PluginCallResultData, Error>) in
                let call = CAPPluginCall(callbackId: UUID().uuidString, methodName: method, options: options,
                    success: { result, _ in continuation.resume(returning: result?.data ?? [:]) },
                    error: { failure in continuation.resume(throwing: NSError(domain: "OfflineSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: failure?.message ?? "Speech failed"])) })!
                if method == "synthesize" { plugin.synthesize(call) }
                else if method == "transcribe" { plugin.transcribe(call) }
                else { plugin.status(call) }
            }
        }
        let status = try await invoke("status", [:])
        XCTAssertEqual((status["kokoro"] as? PluginCallResultData)?["state"] as? String, "ready")
        XCTAssertGreaterThanOrEqual((status["voices"] as? [PluginCallResultData])?.count ?? 0, 30)
        // Shared Kokoro frontend output for "The blue bicycle is beside the window."
        // The native plugin accepts padded phoneme ids rather than text.
        let usSentence = [0, 81, 51, 16, 44, 54, 156, 63, 16, 44, 156, 25, 61, 83, 53, 83, 54, 16, 102, 68, 16, 44, 83, 61, 156, 25, 46, 16, 81, 51, 16, 65, 156, 102, 56, 46, 31, 4, 0]
        let gbSentence = [0, 81, 83, 16, 44, 54, 156, 63, 158, 16, 44, 156, 25, 61, 102, 53, 42, 54, 16, 102, 68, 16, 44, 102, 61, 156, 25, 46, 16, 81, 83, 16, 65, 156, 102, 56, 46, 33, 4, 0]
        for voice in ["af_heart", "bm_george"] {
            let output = try await invoke("synthesize", ["requestId": UUID().uuidString, "voice": voice, "tokens": voice.hasPrefix("b") ? gbSentence : usSentence])
            let wav = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(output["wav"] as? String)))
            XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
            XCTAssertEqual((output["meta"] as? PluginCallResultData)?["voice"] as? String, voice)
            let frames = (wav.count - 44) / 2
            var pcm = Data(capacity: frames * 2 / 3 * 2)
            for index in 0..<(frames * 2 / 3) {
                let offset = 44 + (index * 3 / 2) * 2
                pcm.append(wav[offset]); pcm.append(wav[offset + 1])
            }
            let transcript = try await invoke("transcribe", ["requestId": UUID().uuidString, "engine": "whisper", "audio": pcm.base64EncodedString(), "language": "en"])
            let text = try XCTUnwrap(transcript["text"] as? String).lowercased()
            XCTAssertTrue(text.contains("bicycle"), text)
            XCTAssertTrue(text.contains("window"), text)
        }
    }

    func testUnavailableSystemModelIsRejectedBeforeInference() throws {
        // Invoke the real plugin before loading a provider, independently of
        // other smoke tests that deliberately unload the product WebView.
        let plugin = GezelMobilePlugin()
        plugin.load()
        for modelId in ["model-from-another-provider", ""] {
            var failure: String?
            var failureMessage: String?
            let message: JSObject = ["role": "user", "content": "Must not run"]
            let options: JSObject = [
                "requestId": "invalid-system-model", "providerId": "apple-foundation-models", "modelId": modelId,
                "messages": [message], "contextSize": 4096, "maxTokens": 1
            ]
            let call = CAPPluginCall(callbackId: "invalid-system-model", methodName: "generate", options: options,
                success: { _, _ in XCTFail("An unavailable system model was silently substituted") },
                error: { failure = $0?.code; failureMessage = $0?.message })
            plugin.generate(try XCTUnwrap(call))
            XCTAssertEqual(failure, "MODEL_UNAVAILABLE", failureMessage ?? "No rejection")
        }
    }

    func testCountedPromptHonorsRequestedAndAvailableSystemContext() throws {
        try AppleFoundationProvider.requireContextBudget(promptTokens: 500, maxTokens: 100, contextSize: 1024, modelContext: 4096)
        XCTAssertThrowsError(try AppleFoundationProvider.requireContextBudget(promptTokens: 500, maxTokens: 100, contextSize: 512, modelContext: 4096))
        XCTAssertThrowsError(try AppleFoundationProvider.requireContextBudget(promptTokens: 500, maxTokens: 100, contextSize: 1024, modelContext: 512))
        try AppleFoundationProvider.requireContextBudget(promptTokens: 256, maxTokens: 512, contextSize: 1024, modelContext: 4096)
        XCTAssertThrowsError(try AppleFoundationProvider.requireContextBudget(promptTokens: 257, maxTokens: 512, contextSize: 1024, modelContext: 4096))
        XCTAssertThrowsError(try AppleFoundationProvider.requireContextBudget(promptTokens: -1, maxTokens: 100, contextSize: 1024, modelContext: 4096))
    }

    func testSystemModelDescriptorLeavesInputContext() {
        let descriptor = AppleFoundationProvider.availability()
        XCTAssertGreaterThan(descriptor.contextTokens, AppleFoundationProvider.maximumOutputTokens)
    }

    @MainActor
    func testPreviewFramesCannotReachNativeBridge() async throws {
        let view = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).compactMap { $0.rootViewController as? MainViewController }.first?.webView)
        for _ in 0..<600 {
            if (try? await view.evaluateJavaScript("Boolean(window.__GEZEL__ && window.Capacitor?.Plugins?.GezelMobile)")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "mobile-preview-security", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8)
        let original = view.navigationDelegate
        let audit = PreviewNavigationAudit(original: try XCTUnwrap(original))
        view.navigationDelegate = audit
        defer { view.navigationDelegate = original }
        let result = try await view.callAsyncJavaScript(source + ";return JSON.stringify(await runMobilePreviewSecurity({verifyNativeFrameDenial:true}));", arguments: [:], in: nil, contentWorld: .page)
        let text = try XCTUnwrap(result as? String)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["ok"] as? Bool, true, text)
        let receipts = parsed["receipts"] as? [String: Any]
        if receipts?["nested"] == nil {
            XCTAssertTrue(audit.deniedSubframes.contains("about:srcdoc"), "Nested document must be rejected by the production navigation delegate: \(audit.deniedSubframes)")
        }
    }

    @MainActor
    func testSharedProductAndNativeStreamingChat() async throws {
        var candidate: WKWebView?
        for _ in 0..<100 {
            candidate = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).compactMap { $0.rootViewController as? MainViewController }.first?.webView
            if candidate != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let view = try XCTUnwrap(candidate)
        func waitForApp() async throws {
            for _ in 0..<600 {
                if (try? await view.evaluateJavaScript("Boolean(!window.__gezelReloadMarker && document.querySelector('[data-testid=\"app-sidebar\"]') && window.Capacitor?.Plugins?.GezelMobile)")) as? Bool == true { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            XCTFail("Shared product App did not initialize")
            throw NSError(domain: "MobileSmoke", code: 1)
        }
        func reload() async throws {
            _ = try await view.evaluateJavaScript("window.__gezelReloadMarker = true")
            view.reload()
            try await waitForApp()
        }
        func run(_ source: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
            try await view.callAsyncJavaScript(Self.helpers + source, arguments: arguments, in: nil, contentWorld: .page)
        }
        func attachSnapshot(_ name: String) async throws {
            let attachment = XCTAttachment(image: try await view.takeSnapshot(configuration: nil))
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        func assertSafeChatLayout() async throws {
            _ = try await run(#"""
                const viewport=window.visualViewport;
                await until(()=>{const header=document.querySelector('.app-header');return !visible(header)||header.getBoundingClientRect().top>=safeTop-1;},'header clears the iOS status bar and cutout');
                const app=document.querySelector('.app').getBoundingClientRect();
                const bottom=document.documentElement.dataset.keyboard==='open'?0:safeBottom;
                check(app.bottom<=viewport.offsetTop+viewport.height-bottom+1,'App clears the home indicator and keyboard');
                const composer=await until(()=>Array.from(document.querySelectorAll('.chat-composer')).find(visible),'visible composer');
                const frame=(composer.closest('.project-chat-compose-main')||composer).getBoundingClientRect();
                check(Math.abs(frame.left-app.left)<2&&Math.abs(frame.right-app.right)<2,'Composer reaches both safe edges');
                await until(()=>composer.querySelector('[contenteditable="true"]').getBoundingClientRect().bottom<=document.querySelector('.app').getBoundingClientRect().bottom+1,'entire draft clears the home indicator and keyboard');
                check(document.documentElement.scrollWidth<=innerWidth+1,'No horizontal page overflow');
                return true;
                """#, ["safeTop": view.safeAreaInsets.top, "safeBottom": view.safeAreaInsets.bottom])
        }
        try await waitForApp()
        let fm = FileManager.default
        let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = support.appendingPathComponent("Gezel", isDirectory: true)
        let unresolved = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("product-eval-backup-") || $0.lastPathComponent.hasPrefix("product-smoke-backup-") }
        guard unresolved == nil else {
            throw NSError(domain: "MobileSmoke", code: 8, userInfo: [NSLocalizedDescriptionKey: "Recover the preserved product backup before another smoke test: \(unresolved!.path)"])
        }
        let product = root.appendingPathComponent("product", isDirectory: true)
        let backup = root.appendingPathComponent("product-smoke-backup-\(UUID().uuidString)", isDirectory: true)
        try fm.copyItem(at: product, to: backup)
        let inventory = root.appendingPathComponent("models.json")
        let priorInventory = try? Data(contentsOf: inventory)
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ios-fixture", withExtension: "gguf"))
        let store = try MobileStore(root: root)
        let model = try store.importModel(from: fixture)
        _ = try store.selectModel(id: model.id)
        addTeardownBlock { @MainActor in
            // Stop bridge access before restoring the dedicated simulator's prior product tree.
            _ = try? await view.callAsyncJavaScript("const p = window.Capacitor.Plugins.GezelMobile; await p.releaseModel(); await p.listProductFiles({path:''}); return true;", arguments: [:], in: nil, contentWorld: .page)
            view.stopLoading()
            view.configuration.userContentController.removeAllScriptMessageHandlers()
            try fm.removeItem(at: product)
            try fm.moveItem(at: backup, to: product)
            if let priorInventory { try priorInventory.write(to: inventory, options: .atomic) }
            else { try? fm.removeItem(at: inventory) }
            try? fm.removeItem(at: root.appendingPathComponent("models/\(model.id).gguf"))
        }
        let seeded = try await run(#"""
            check(window.Capacitor.getPlatform() === 'ios', 'Native iOS host is required');
            check(document.querySelector('[data-testid="app-sidebar"]'), 'Shared navigation must remain mounted during setup');
            check(!document.querySelector('.mobile-app'), 'The separate conversation prototype must not be mounted');
            const scriptRun = await api('/api/projects/default/scripts/run', 'POST', {name:'storeRecords',scope:'standard',input:{action:'create',id:'native-quickjs',fields:{title:'offline'},root:'native-script',mode:'single-file'}});
            check(scriptRun.status === 'ok', 'Bundled QuickJS must execute inside the native WebView');
            check((await api('/api/projects/default/script-runs/' + scriptRun.runId)).status === 'ok', 'Native script audit must persist');
            const scriptOutput = await api('/api/projects/default/workspace/read?path=native-script.json');
            check(scriptOutput.content.includes('native-quickjs') && scriptOutput.content.includes('offline'), 'QuickJS must write through the native product file store');
            const exportToken = (await plugin.beginExport({name:'test-backup.zip',mimeType:'application/zip',sizeBytes:3})).token;
            let staleExportRejected = false;
            try { await plugin.saveExport({token:'stale'}); } catch { staleExportRejected = true; }
            check(staleExportRejected, 'Stale export must not cancel the current staged file');
            await plugin.appendExport({token:exportToken,offset:0,data:'AQID'});
            let exportRejected = false;
            try { await plugin.appendExport({token:exportToken,offset:0,data:'AQID'}); } catch { exportRejected = true; }
            check(exportRejected, 'Export chunks must reject duplicate offsets');
            await plugin.cancelExport({token:exportToken});
            const project = await api('/api/projects', 'POST', {name:'Native workshop',about:'A native mobile product test.',missionObjectives:'Keep crew and files on this device.',indexingEnabled:false});
            const crew = await api('/api/gezels', 'POST', {name:'Native tester',role:'Helper',about:'Reply briefly.'});
            await api('/api/projects/' + project.id + '/gezels', 'POST', {gezelId:crew.id});
            await api('/api/projects/' + project.id, 'PUT', {voormanGezelId:crew.id});
            const modelId = (await plugin.listModels()).selectedModelId;
            await api('/api/config', 'PUT', {provider:'llama-cpp',meesterGezelId:crew.id,modelContextOverrides:{['llama-cpp:'+modelId]:8192},modelTuning:{[modelId]:{sampling:{maxTokens:256}}}});
            await api('/api/documents/write', 'PUT', {path:'iOS notes.md',content:'# iOS notes\n\nSaved through the shared product API.'});
            await api('/api/projects/' + project.id + '/artifacts/write', 'PUT', {path:'Native report.md',content:'# Native report\n\nThe same artifact drawer works on iOS.'});
            return {projectId:project.id,gezelId:crew.id};
            """#) as? [String: Any]
        let projectId = try XCTUnwrap(seeded?["projectId"] as? String)
        let gezelId = try XCTUnwrap(seeded?["gezelId"] as? String)
        try await reload()
        _ = try await run(#"""
            const probe = await api('/api/models/test?provider=llama-cpp');
            check(probe.ok && probe.modelCount > 0, 'Selected native model is unavailable to the shared product: ' + JSON.stringify(probe));
            window.dispatchEvent(new CustomEvent('gezel:navigate',{detail:{view:'home'}}));
            await until(()=>visible(document.querySelector('[data-testid="home-workshop"] .chat-composer')),'Meester composer');
            return true;
            """#)
        try await assertSafeChatLayout()
        try await attachSnapshot("Safe full-width Meester composer")
        _ = try await run("await openNavigation();return true;")
        _ = try await run(#"""
            check(document.documentElement.scrollWidth <= innerWidth + 1, 'Primary navigation overflows');
            await clickButton('Settings', document.querySelector('[data-testid="app-sidebar"]'));
            const models = await until(() => document.querySelector('[aria-label="On-device models"]'), 'native providers inside shared Settings');
            await until(() => models.querySelector('select')?.options.length > 0, 'native provider inventory');
            const navigation = await until(() => {
                const control = document.querySelector('.app-header-navigation[aria-label="Navigation"]');
                return visible(control) && control;
            }, 'Navigation control in Settings');
            const rect = navigation.getBoundingClientRect();
            check(rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.height >= 40, 'Navigation must remain fully visible in Settings');
            const providers = (await plugin.providers()).providers;
            check(providers.find(item => item.id === 'llama-cpp')?.availability === 'available', 'Imported fixture must be available');
            check(providers.some(item => item.id === 'apple-foundation-models'), 'Apple descriptor must reach native settings');
            check((await api('/api/config')).provider === 'llama-cpp', 'Native provider selection must persist');
            return true;
            """#)
        try await attachSnapshot("Shared Settings and native providers")
        _ = try await run(#"""
            await openNavigation();
            await clickButton('Native workshop', document.querySelector('[data-testid="app-sidebar"]'));
            await until(()=>visible(document.querySelector('.project-chat .chat-composer')),'Project composer');
            return true;
            """#)
        try await assertSafeChatLayout()
        let viewportHeightValue = try await view.evaluateJavaScript("visualViewport.height")
        let fullViewportHeight = try XCTUnwrap(viewportHeightValue as? Double)
        _ = try await run(#"""
            document.querySelector('.project-chat .chat-composer [contenteditable="true"]').focus();
            await until(()=>visualViewport.height<fullHeight-120,'real iOS keyboard');
            return true;
            """#, ["fullHeight": fullViewportHeight])
        try await assertSafeChatLayout()
        try await attachSnapshot("Safe project composer above keyboard")
        view.endEditing(true)
        _ = try await run("await until(()=>visualViewport.height>=fullHeight-1,'keyboard dismissed');return true;", ["fullHeight": fullViewportHeight])
        let chat = try await run(#"""
            await openNavigation();
            await clickButton('Native workshop', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => visible(document.querySelector('[data-testid="project-tab-chat"]')), 'ordinary project Chat tab');
            const composer = await until(() => document.querySelector('[data-testid="chat-composer"]'), 'shared chat composer');
            const editor = await until(() => composer.querySelector('[contenteditable="true"]'), 'shared rich text input');
            editor.focus(); document.execCommand('insertText', false, 'Say hello.');
            let streamed = '';
            const listener = await plugin.addListener('chatDelta', event => { streamed += event.delta; });
            try {
                const send = await until(() => { const s = composer.querySelector('[aria-label="Send"]'); return s && !s.disabled && s; }, 'enabled Send');
                send.click();
                const completed = await until(async () => {
                    for (const summary of (await api('/api/sessions?project=' + projectId)).sessions) {
                        const session = await api('/api/sessions/' + summary.id);
                        if (session.lastTurnError) throw new Error(session.lastTurnError);
                        const answer = session.messages.find(item => item.role === 'assistant' && item.status === 'complete');
                        if (answer) return {session,answer};
                    }
                }, 'native response persisted as an ordinary session');
                check(completed.answer.providerId === 'llama-cpp', 'Native provider identity must persist');
                check(completed.answer.content === 'a'.repeat(256), 'Native fixture returned the wrong text');
                await until(() => streamed === completed.answer.content, 'native streamed deltas');
                await until(() => document.body.textContent.includes(completed.answer.content), 'rendered shared chat');
                check(document.documentElement.scrollWidth <= innerWidth + 1, 'Project chat overflows');
                return {sessionId:completed.session.id};
            } finally { await listener.remove(); }
            """#, ["projectId": projectId]) as? [String: Any]
        let sessionId = try XCTUnwrap(chat?["sessionId"] as? String)
        try await attachSnapshot("Shared project native conversation")
        _ = try await run(#"""
            const artifactsTab = document.querySelector('[data-testid="project-tab-artifacts"]');
            artifactsTab.focus();
            artifactsTab.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
            await clickButton('Native report.md');
            await until(() => Array.from(document.querySelectorAll('.file-viewer-panel')).find(visible)?.textContent.includes('The same artifact drawer works on iOS.'), 'artifact in shared editor');
            await openNavigation();
            await clickButton('Documents', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => visible(button('Back to files')) || visible(button('iOS notes')), 'shared document library');
            if (visible(button('Back to files'))) await clickButton('Back to files');
            await clickButton('iOS notes');
            await until(() => Array.from(document.querySelectorAll('.file-viewer-panel')).find(visible)?.textContent.includes('Saved through the shared product API.'), 'shared document viewer');
            check(document.documentElement.scrollWidth <= innerWidth + 1, 'Document viewer overflows');
            return true;
            """#)
        try await attachSnapshot("Shared document library")
        try await reload()
        _ = try await run(#"""
            const project = await api('/api/projects/' + projectId);
            check(project.gezelIds.includes(gezelId) && project.voormanGezelId === gezelId, 'Project crew must survive reload');
            const session = await api('/api/sessions/' + sessionId);
            check(session.messages.some(m => m.content === 'Say hello.') && session.messages.some(m => m.content === 'a'.repeat(256)), 'Chat must survive reload');
            check((await api('/api/documents/read?path=' + encodeURIComponent('iOS notes.md'))).content.includes('Saved through the shared product API.'), 'Document must survive reload');
            await clickButton('Native workshop', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => document.body.textContent.includes('a'.repeat(256)), 'restored project conversation');
            await until(() => {
                const timeline = Array.from(document.querySelectorAll('[data-testid="chat-timeline"]')).find(visible);
                const reply = Array.from(timeline?.querySelectorAll('.msg-assistant .msg-body-rendered') ?? []).find(e => e.textContent.includes('a'.repeat(256)));
                if (!reply) return false;
                const box = reply.getBoundingClientRect(), viewport = timeline.getBoundingClientRect();
                const sticky = timeline.parentElement.querySelector('.chat-sticky-header');
                const visibleTop = Math.max(viewport.top, visible(sticky) ? sticky.getBoundingClientRect().bottom : viewport.top);
                const shown = Math.min(box.bottom, viewport.bottom) - Math.max(box.top, visibleTop);
                return shown >= Math.min(box.height, 80) - 1;
            }, 'readable reply below sticky context after reload');
            return true;
            """#, ["projectId": projectId, "gezelId": gezelId, "sessionId": sessionId])
        XCTAssertNotNil(try store.productFiles.read("config.json"))
        XCTAssertNotNil(try store.productFiles.read("projects/\(projectId)/project.json"))
        XCTAssertNotNil(try store.productFiles.read("gezels/\(gezelId)/sessions/\(sessionId).json"))
        try await attachSnapshot("Shared project reopened")
        let result = try await view.callAsyncJavaScript("""
            const plugin = window.Capacitor.Plugins.GezelMobile;
            const inventory = await plugin.providers();
            const local = inventory.providers.find(item => item.id === 'llama-cpp');
            const apple = inventory.providers.find(item => item.id === 'apple-foundation-models');
            if (local?.availability !== 'available') throw new Error('Selected fixture should be available');
            if (!apple || apple.locality !== 'on-device' || apple.capabilities.tools !== true) throw new Error('Invalid Apple descriptor');
            if (apple.availability === 'available') {
                let appleStreamed = '';
                const appleListener = await plugin.addListener('chatDelta', event => {
                    if (event.requestId === 'apple-smoke') appleStreamed += event.delta;
                });
                const appleResult = await plugin.generate({providerId:'apple-foundation-models',requestId:'apple-smoke',messages:[{role:'user',content:'Say hello.'}],maxTokens:32});
                await appleListener.remove();
                if (!appleResult.text) throw new Error('Available Apple model produced no response');
                if (appleStreamed !== appleResult.text) throw new Error('Apple stream differed from final response');
                const applePending = plugin.generate({providerId:'apple-foundation-models',requestId:'apple-cancel',messages:[{role:'user',content:'Tell a long story about a garden.'}],maxTokens:1024});
                try { await plugin.generate({requestId:'cross-provider-busy',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello'}],maxTokens:8}); throw new Error('Providers ran concurrently'); }
                catch (error) { if (error.code !== 'BUSY') throw error; }
                await plugin.cancel({requestId:'apple-cancel'});
                if ((await applePending).stopReason !== 'cancelled') throw new Error('Apple cancellation did not release its session');
            } else {
                if (!apple.reason) throw new Error('Unavailable Apple model must explain why');
                try { await plugin.generate({providerId:'apple-foundation-models',requestId:'apple-unavailable',messages:[{role:'user',content:'Hello'}]}); throw new Error('Unavailable Apple provider silently fell back'); }
                catch (error) { if (error.code !== 'UNAVAILABLE') throw error; }
            }
            try { await plugin.prepareProvider({providerId:'apple-foundation-models'}); throw new Error('Apple preparation should be OS managed'); }
            catch (error) { if (error.code !== 'OS_MANAGED') throw error; }
            let streamed = '';
            const listener = await plugin.addListener('chatDelta', event => {
                if (event.requestId === 'bridge-smoke') streamed += event.delta;
            });
            const result = await plugin.generate({requestId:'bridge-smoke',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello'}],maxTokens:8});
            await listener.remove();
            const pending = plugin.generate({requestId:'cancel-smoke',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello'}],maxTokens:256});
            await plugin.cancel({requestId:'cancel-smoke'});
            const cancelled = await pending;
            if (cancelled.stopReason !== 'cancelled') throw new Error('Cancellation did not settle generation');
            const reused = await plugin.generate({requestId:'reuse-smoke',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello again'}],maxTokens:8});
            if (reused.text !== 'aaaaaaaa') throw new Error('Engine was not reusable after cancellation');
            const longer = await plugin.generate({requestId:'longer-smoke',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello'}],maxTokens:512});
            if (longer.text !== 'a'.repeat(512) || longer.stopReason !== 'length') throw new Error('Explicit reply budgets above 256 must work');
            await plugin.releaseModel();
            const beforeRemoval = await plugin.listModels();
            await plugin.removeModel({id:fixtureId});
            const afterRemoval = await plugin.listModels();
            if (afterRemoval.selectedModelId) throw new Error('Removing selected model silently selected another');
            const expectedIds = beforeRemoval.models.filter(item => item.id !== fixtureId).map(item => item.id).sort();
            if (JSON.stringify(afterRemoval.models.map(item => item.id).sort()) !== JSON.stringify(expectedIds)) throw new Error('Removal changed an unrelated model or retained the removed model');
            let removedRejected = false;
            try { await plugin.generate({requestId:'removed-model',modelId:fixtureId,contextSize:2048,messages:[{role:'user',content:'Hello'}],maxTokens:8}); }
            catch { removedRejected = true; }
            if (!removedRejected) throw new Error('A removed pinned model silently used another imported model');
            const expectedAvailability = afterRemoval.models.length ? 'available' : 'unavailable';
            if ((await plugin.providers()).providers.find(item=>item.id==='llama-cpp').availability !== expectedAvailability) throw new Error('Provider availability disagrees with the remaining model inventory');
            return {text:result.text,stopReason:result.stopReason,streamed,appleAvailability:apple.availability,appleReason:apple.reason ?? ''};
            """, arguments: ["fixtureId": model.id], in: nil, contentWorld: .page) as? [String: Any]
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("models/\(model.id).gguf").path), "Model removal must delete the imported file")
        XCTAssertEqual(result?["text"] as? String, "aaaaaaaa")
        XCTAssertEqual(result?["streamed"] as? String, "aaaaaaaa")
        XCTAssertEqual(result?["stopReason"] as? String, "length")
        print("Apple native provider smoke:", result?["appleAvailability"] ?? "missing", result?["appleReason"] ?? "")

        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        let background = try await view.callAsyncJavaScript("return (await window.Capacitor.Plugins.GezelMobile.providers()).providers.every(item => item.availability === 'unavailable' && typeof item.reason === 'string' && item.reason.length > 0);", arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(background, true)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    private static let helpers = #"""
        const plugin = window.Capacitor.Plugins.GezelMobile;
        const visible = element => Boolean(element?.getClientRects().length);
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const button = (text, scope = document) => Array.from(scope.querySelectorAll('button')).find(item => visible(item) && (item.textContent.trim() === text || item.getAttribute('aria-label') === text));
        const api = async (path, method='GET', body) => {
            const host = window.__GEZEL__;
            const response = await host.fetch(new Request(host.baseUrl + path, {method,headers:{Authorization:'Bearer ' + host.token,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})}));
            const value = await response.json();
            if (!response.ok) throw new Error(path + ': ' + (value.error || response.status));
            return value;
        };
        const until = async (action, description) => {
            for (let attempt = 0; attempt < 600; attempt++) {
                const value = await action();
                if (value) return value;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Timed out: ' + description + ': ' + document.body.innerText.slice(-4000));
        };
        const clickButton = async (text, scope = document) => {
            const element = await until(() => { const candidate = button(text, scope); return candidate && !candidate.disabled && candidate; }, 'enabled visible button: ' + text);
            element.click();
            await new Promise(resolve => requestAnimationFrame(resolve));
        };
        const openNavigation = async () => {
            if (!visible(document.querySelector('[data-testid="app-sidebar"]'))) {
                const navigation = await until(() => {
                    const control = document.querySelector('.app-header-navigation[aria-label="Navigation"]');
                    return visible(control) && control;
                }, 'Navigation control');
                navigation.click();
            }
            await until(() => visible(document.querySelector('[data-testid="app-sidebar"]')), 'shared primary navigation');
        };
        """#
}

/// Observes the production delegate's decisions without changing any policy.
@MainActor
private final class PreviewNavigationAudit: NSObject, WKNavigationDelegate {
    let original: WKNavigationDelegate
    var deniedSubframes: [String] = []
    init(original: WKNavigationDelegate) { self.original = original }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        original.webView?(webView, decidePolicyFor: action, decisionHandler: { policy in
            if policy == .cancel && action.targetFrame?.isMainFrame == false { self.deniedSubframes.append(action.request.url?.absoluteString ?? "") }
            decisionHandler(policy)
        })
    }
}
