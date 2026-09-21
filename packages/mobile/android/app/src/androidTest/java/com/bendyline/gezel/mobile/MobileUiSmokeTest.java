package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TestName;
import org.junit.runner.RunWith;

/** Exercises the shared React app, portable service, Capacitor bridge, and product files together. */
@RunWith(AndroidJUnit4.class)
public final class MobileUiSmokeTest {
    @Rule public final TestName testName = new TestName();
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Map<File, byte[]> priorState = new LinkedHashMap<>();
    private MainActivity activity;
    private WebView webView;
    private MobileStore store;
    private File fixtureSource;
    private File importedFixture;
    private String fixtureId;
    private File productRoot;
    private File productBackup;

    @Before public void launchWithIsolatedProductFiles() throws Exception {
        File files = instrumentation.getTargetContext().getFilesDir();
        File[] previous = new File(files, "gezel").listFiles();
        if (previous != null) for (File entry : previous)
            assertFalse("Recover the preserved product backup before another smoke test: " + entry,
                entry.isDirectory() && (entry.getName().startsWith("product-eval-backup-") || entry.getName().startsWith("product-smoke-backup-")));
        store = new MobileStore(files);
        productRoot = new File(new File(files, "gezel"), "product");
        productBackup = new File(new File(files, "gezel"), "product-smoke-backup-" + java.util.UUID.randomUUID());
        Files.move(productRoot.toPath(), productBackup.toPath());
        store = new MobileStore(files);
        // Speech uses no chat model. Keep the model registry completely untouched
        // for this test, including if the emulator is interrupted.
        if (!testName.getMethodName().equals("offlineSpeechUsesSharedProductArtifactsAndVoiceIdentity")) {
            for (String name : new String[] { "models.json", "models.json.bak", "models.json.new" }) {
                File file = new File(new File(files, "gezel"), name);
                priorState.put(file, file.exists() ? Files.readAllBytes(file.toPath()) : null);
            }
            for (File file : priorState.keySet()) Files.deleteIfExists(file.toPath());
            if (!testName.getMethodName().equals("missingChatModelOpensSettingsAndPreservesDraft")) {
                fixtureSource = File.createTempFile("ui-smoke-", ".gguf", instrumentation.getTargetContext().getCacheDir());
                try (InputStream input = instrumentation.getContext().getAssets().open("fixtures/deterministic-native.gguf");
                        FileOutputStream output = new FileOutputStream(fixtureSource)) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
                fixtureId = store.importModel(instrumentation.getTargetContext().getContentResolver(), Uri.fromFile(fixtureSource)).getString("id");
                store.selectModel(fixtureId);
                importedFixture = new File(new File(files, "gezel/models"), fixtureId + ".gguf");
            }
        }
        // Connect before WebView creation so its virtual accessibility tree is enabled.
        android.accessibilityservice.AccessibilityServiceInfo accessibility = instrumentation.getUiAutomation().getServiceInfo();
        accessibility.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        instrumentation.getUiAutomation().setServiceInfo(accessibility);
        Intent launch = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(launch);
        instrumentation.runOnMainSync(() -> webView = activity.getBridge().getWebView());
        assertNotNull("Capacitor must host the actual application WebView", webView);
        waitForApp();
    }

    @After public void restoreProductFiles() throws Exception {
        if (activity != null) {
            GezelMobilePlugin plugin = (GezelMobilePlugin) activity.getBridge().getPlugin("GezelMobile").getInstance();
            Field queueField = GezelMobilePlugin.class.getDeclaredField("storageQueue");
            queueField.setAccessible(true);
            ExecutorService storageQueue = (ExecutorService) queueField.get(plugin);
            instrumentation.runOnMainSync(() -> activity.finish());
            instrumentation.waitForIdleSync();
            // A failed UI turn can leave a save queued; it must not overwrite the restored state.
            assertTrue("Activity storage must finish before restoring test state", storageQueue.awaitTermination(30, TimeUnit.SECONDS));
        }
        if (productBackup != null && productBackup.isDirectory()) {
            if (productRoot.isDirectory()) {
                try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(productRoot.toPath())) {
                    for (java.nio.file.Path path : (Iterable<java.nio.file.Path>) paths.sorted(java.util.Comparator.reverseOrder())::iterator) Files.delete(path);
                }
            }
            Files.move(productBackup.toPath(), productRoot.toPath());
        }
        for (Map.Entry<File, byte[]> entry : priorState.entrySet()) {
            Files.deleteIfExists(entry.getKey().toPath());
            if (entry.getValue() != null) Files.write(entry.getKey().toPath(), entry.getValue());
        }
        if (importedFixture != null) Files.deleteIfExists(importedFixture.toPath());
        if (fixtureSource != null) Files.deleteIfExists(fixtureSource.toPath());
    }

    @Test public void missingChatModelOpensSettingsAndPreservesDraft() throws Exception {
        run("""
            const inventory=await plugin.listModels();
            check(inventory.models.length===0,'This test must start without a chat model');
            const config=await api('/api/config');
            const project=await api('/api/projects','POST',{name:'Model setup workshop',indexingEnabled:false});
            await api('/api/projects/'+project.id+'/gezels','POST',{gezelId:config.meesterGezelId});
            await api('/api/projects/'+project.id,'PUT',{voormanGezelId:config.meesterGezelId});
            return true;
            """);
        reload();
        run("""
            await openNavigation();
            await clickButton('Model setup workshop',document.querySelector('[data-testid="app-sidebar"]'));
            const editor=await until(()=>document.querySelector('[data-testid="chat-composer"] [contenteditable="true"]'),'shared composer');
            editor.focus();document.execCommand('insertText',false,'Hello from an empty model library.');editor.blur();
            const project=(await api('/api/projects')).projects.find(item=>item.name==='Model setup workshop');
            await until(async()=>(await api('/api/projects/'+project.id+'/prompt-drafts')).drafts.some(item=>item.title.includes('Hello from an empty model library.')),'editor change saved before Send');
            await clickButton('Send');
            await until(()=>document.querySelector('.chat-composer-error')?.textContent.includes('No chat model is installed'),'actionable missing model explanation');
            check(!document.querySelector('.chat-composer-error').textContent.includes('409'),'Raw HTTP status must not replace the explanation');
            check(editor.textContent.includes('Hello from an empty model library.'),'Rejected send must keep the draft');
            check((await api('/api/sessions')).sessions.length===0,'Missing model must not leave an empty conversation');
            check(document.documentElement.scrollWidth<=innerWidth+1,'Error and action must fit a phone');
            return true;
            """);
        JSONObject modelAction=run("""
            const action=await until(()=>{
                const button=document.querySelector('.chat-composer-error button');
                if (!button) return false;
                const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
                return box.top>=0 && box.bottom<=innerHeight && button.contains(document.elementFromPoint(x,y)) && {x,y,viewportWidth:innerWidth};
            },'model setup action visible and tappable');
            return action;
            """);
        snapshot("05-missing-chat-model");
        int[] location=new int[2];int[] viewWidth=new int[1];
        instrumentation.runOnMainSync(()->{webView.getLocationOnScreen(location);viewWidth[0]=webView.getWidth();});
        float scale=(float)(viewWidth[0]/modelAction.getDouble("viewportWidth"));
        float x=location[0]+(float)modelAction.getDouble("x")*scale,y=location[1]+(float)modelAction.getDouble("y")*scale;
        long now=SystemClock.uptimeMillis();
        android.view.MotionEvent down=android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,x,y,0);
        android.view.MotionEvent up=android.view.MotionEvent.obtain(now,now+80,android.view.MotionEvent.ACTION_UP,x,y,0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try {
            assertTrue(instrumentation.getUiAutomation().injectInputEvent(down,true));
            assertTrue(instrumentation.getUiAutomation().injectInputEvent(up,true));
        } finally {down.recycle();up.recycle();}
        run("""
            await until(()=>visible(document.querySelector('[aria-label="On-device models"]')),'model settings from chat');
            check(visible(button('Import a model')),'Model setup must offer local GGUF import');
            await openNavigation();
            await clickButton('Model setup workshop',document.querySelector('[data-testid="app-sidebar"]'));
            await until(()=>document.querySelector('[data-testid="chat-composer"] [contenteditable="true"]')?.textContent.includes('Hello from an empty model library.'),'draft after returning from model settings');
            return true;
            """);
    }

    @Test public void unavailableSystemModelIsRejectedBeforeInference() throws Exception {
        run("""
            for (const modelId of ['model-from-another-provider', '']) {
                let failure;
                try {
                    await window.Capacitor.Plugins.GezelMobile.generate({
                        requestId:'invalid-system-model',providerId:'android-mlkit',modelId,
                        messages:[{role:'user',content:'Must not run'}],contextSize:4096,maxTokens:1
                    });
                } catch (error) { failure=error; }
                check(failure?.code === 'MODEL_UNAVAILABLE', 'An unavailable system model must be rejected before inference');
            }
            return true;
            """);
    }

    @Test public void hardwareBackDismissesOverlaysAndPreservesDraft() throws Exception {
        run("""
            const project = await api('/api/projects', 'POST', {name:'Back workshop',indexingEnabled:false});
            const crew = await api('/api/gezels', 'POST', {name:'Back tester',role:'Helper',about:'Reply briefly.'});
            await api('/api/projects/' + project.id + '/gezels', 'POST', {gezelId:crew.id});
            await api('/api/projects/' + project.id, 'PUT', {voormanGezelId:crew.id});
            await api('/api/config', 'PUT', {provider:'llama-cpp',meesterGezelId:crew.id});
            return true;
            """);
        reload();
        run("""
            await clickButton('Back workshop', document.querySelector('[data-testid="app-sidebar"]'));
            const editor=await until(()=>document.querySelector('[data-testid="chat-composer"] [contenteditable="true"]'),'shared composer');
            editor.focus();document.execCommand('insertText',false,'An unfinished mobile draft.');editor.blur();
            await until(()=>editor.textContent.includes('An unfinished mobile draft.'),'retained draft');
            await clickButton('Choose recipients');
            await until(()=>visible(document.querySelector('.chat-recipient-popover')),'recipient picker');
            return true;
            """);
        hardwareBack();
        run("""
            await until(()=>!visible(document.querySelector('.chat-recipient-popover')),'Back dismisses picker');
            check(!visible(document.querySelector('[data-testid="app-sidebar"]')),'First Back must keep project chat open');
            window.dispatchEvent(new CustomEvent('gezel:show-backup-restore'));
            await until(()=>visible(document.querySelector('[role="alertdialog"]')),'shared backup dialog');
            return true;
            """);
        hardwareBack();
        run("""
            await until(()=>!visible(document.querySelector('[role="alertdialog"]')),'Back dismisses dialog');
            check(!visible(document.querySelector('[data-testid="app-sidebar"]')),'Modal Back must keep project chat open');
            return true;
            """);
        hardwareBack();
        run("""
            await until(()=>visible(document.querySelector('[data-testid="app-sidebar"]')),'Back returns to navigation');
            await clickButton('Back workshop',document.querySelector('[data-testid="app-sidebar"]'));
            const editor=await until(()=>document.querySelector('[data-testid="chat-composer"] [contenteditable="true"]'),'same composer');
            check(editor.textContent.includes('An unfinished mobile draft.'),'Hardware Back discarded the draft');
            return true;
            """);
    }

    @Test public void sharedHtmlViewerLoadsRelativeAssetsAndRunsAnOfflineButton() throws Exception {
        run("""
            const project=await api('/api/projects','POST',{name:'Preview workshop',indexingEnabled:false});
            const files={
                'offline-game.html':`<link rel="stylesheet" href="assets/style.css"><button id="play" onclick="parent.postMessage({nativeViewerClicked:true}, '*')">Play offline</button><img id="icon" src="assets/icon.svg"><script src="assets/game.js"></script>`,
                'assets/style.css':'#play{color:rgb(12,34,56);padding:16px;font-size:20px}',
                'assets/icon.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
                'assets/game.js':"addEventListener('load',()=>parent.postMessage({nativeViewerReady:true,color:getComputedStyle(document.getElementById('play')).color,width:document.getElementById('icon').naturalWidth,button:document.getElementById('play').getBoundingClientRect().toJSON()},'*'));"
            };
            for(const [path,content] of Object.entries(files))await api('/api/projects/'+project.id+'/artifacts/write','PUT',{path,content});
            return true;
            """);
        reload();
        run("""
            check(window.__GEZEL__.capabilities.htmlPreview,'Verified native HTML capability must be enabled');
            window.__nativeViewerReady=null;window.__nativeViewerClicked=false;
            window.addEventListener('message',event=>{
                const frame=document.querySelector('iframe[src*="/__gezel_preview/"]');
                if(event.source!==frame?.contentWindow)return;
                if(event.data?.nativeViewerReady)window.__nativeViewerReady=event.data;
                if(event.data?.nativeViewerClicked)window.__nativeViewerClicked=true;
            });
            await clickButton('Preview workshop',document.querySelector('[data-testid="app-sidebar"]'));
            const filesTab=await until(()=>document.querySelector('[data-testid="project-tab-artifacts"]'),'shared files tab');
            filesTab.focus();filesTab.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            await clickButton('offline-game.html');
            const receipt=await until(()=>window.__nativeViewerReady,'HTML page loaded in shared file viewer');
            check(receipt.color==='rgb(12, 34, 56)'&&receipt.width===8,'Relative CSS and image were not copied into the native preview');
            const frame=document.querySelector('iframe[src*="/__gezel_preview/"]');
            check(frame.getAttribute('sandbox')==='allow-scripts','Shared viewer must retain opaque script-only sandbox');
            return true;
            """);
        snapshot("04-shared-html-ready");
        android.view.accessibility.AccessibilityNodeInfo accessibilityRoot=instrumentation.getUiAutomation().getRootInActiveWindow();
        java.util.ArrayDeque<android.view.accessibility.AccessibilityNodeInfo> pendingNodes=new java.util.ArrayDeque<>();
        if(accessibilityRoot!=null)pendingNodes.add(accessibilityRoot);
        int inspected=0;boolean accessibleButton=false;
        while(!pendingNodes.isEmpty()&&inspected++<512) {
            android.view.accessibility.AccessibilityNodeInfo node=pendingNodes.removeFirst();
            String text=String.valueOf(node.getText());
            if(text.equals("Play offline")&&node.isVisibleToUser()&&node.isClickable())accessibleButton=true;
            for(int child=0;child<node.getChildCount();child++) {
                android.view.accessibility.AccessibilityNodeInfo next=node.getChild(child);if(next!=null)pendingNodes.add(next);
            }
        }
        assertTrue("The HTML button must be visible and clickable in the native accessibility tree",accessibleButton);
        JSONObject point=run("""
            const frame=document.querySelector('iframe[src*="/__gezel_preview/"]').getBoundingClientRect();
            const bounds=window.__nativeViewerReady.button;
            const x=frame.left+bounds.x+bounds.width/2,y=frame.top+bounds.y+bounds.height/2;
            check(x>0&&x<innerWidth&&y>0&&y<innerHeight,'Authored button must be on screen');
            return {x,y,viewportWidth:innerWidth};
            """);
        int[] location=new int[2];int[] viewWidth=new int[1];
        instrumentation.runOnMainSync(()->{webView.getLocationOnScreen(location);viewWidth[0]=webView.getWidth();});
        float scale=(float)(viewWidth[0]/point.getDouble("viewportWidth"));
        float x=location[0]+(float)point.getDouble("x")*scale,y=location[1]+(float)point.getDouble("y")*scale;
        long now=SystemClock.uptimeMillis();
        android.view.MotionEvent down=android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,x,y,0);
        android.view.MotionEvent up=android.view.MotionEvent.obtain(now,now+80,android.view.MotionEvent.ACTION_UP,x,y,0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try {
            assertTrue("Native touch down must reach the displayed HTML page",instrumentation.getUiAutomation().injectInputEvent(down,true));
            assertTrue("Native touch up must reach the displayed HTML page",instrumentation.getUiAutomation().injectInputEvent(up,true));
        } finally {down.recycle();up.recycle();}
        run("await until(()=>window.__nativeViewerClicked,'Authored button click in native HTML preview'); return true;");
        snapshot("04-shared-html-preview");
    }

    private void hardwareBack() throws Exception {
        instrumentation.runOnMainSync(() -> {
            android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
            keyboard.hideSoftInputFromWindow(webView.getWindowToken(), 0);
        });
        SystemClock.sleep(250);
        assertTrue("System Back must be delivered", instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));
    }

    @Test public void sharedProductNavigationNativeChatAndFilePersistence() throws Exception {
        JSONObject seeded = run("""
            check(window.Capacitor?.getPlatform() === 'android', 'Must use the native Android host');
            check(innerWidth <= 760, 'Run the UI smoke on a phone-sized emulator or device');
            check(visible(document.querySelector('[data-testid="app-sidebar"]')), 'Phone must open at the shared desktop navigation');
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
            const project = await api('/api/projects', 'POST', {name:'Native workshop',about:'A native mobile product test.',missionObjectives:'Keep projects, crew and files on this device.',indexingEnabled:false});
            const crew = await api('/api/gezels', 'POST', {name:'Native tester',role:'Helper',about:'Reply briefly.'});
            await api('/api/projects/' + project.id + '/gezels', 'POST', {gezelId:crew.id});
            await api('/api/projects/' + project.id, 'PUT', {voormanGezelId:crew.id});
            const modelId = (await plugin.listModels()).selectedModelId;
            await api('/api/config', 'PUT', {provider:'llama-cpp',meesterGezelId:crew.id,modelContextOverrides:{['llama-cpp:'+modelId]:8192},modelTuning:{[modelId]:{sampling:{maxTokens:256}}}});
            await api('/api/documents/write', 'PUT', {path:'Android notes.md',content:'# Android notes\\n\\nSaved through the shared product API.'});
            await api('/api/projects/' + project.id + '/artifacts/write', 'PUT', {path:'Native report.md',content:'# Native report\\n\\nThe same artifact drawer works on Android.'});
            return {projectId:project.id,gezelId:crew.id};
            """);
        // Exercise the actual Android document picker, then cancel without
        // creating a file outside the dedicated app's private test data.
        run("""
            const token = (await plugin.beginExport({name:'gezel-native-picker-test.zip',mimeType:'application/zip',sizeBytes:3})).token;
            await plugin.appendExport({token,offset:0,data:'AQID'});
            window.__nativeExportOutcome = null;
            plugin.saveExport({token}).then(() => {window.__nativeExportOutcome = {saved:true};}, error => {window.__nativeExportOutcome = {code:error.code};});
            return true;
            """);
        boolean pickerVisible = false;
        for (int attempt = 0; attempt < 100; attempt++) {
            android.view.accessibility.AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null && String.valueOf(root.getPackageName()).contains("documentsui")) {
                pickerVisible = true; break;
            }
            SystemClock.sleep(100);
        }
        assertTrue("Export must open Android's Save document picker", pickerVisible);
        assertTrue("The system picker must allow cancellation", instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));
        run("""
            const outcome = await until(() => window.__nativeExportOutcome, 'native document picker cancellation');
            check(outcome.code === 'CANCELLED', 'Cancelling Save must report cancellation');
            const token = (await plugin.beginExport({name:'gezel-native-picker-test.zip',mimeType:'application/zip',sizeBytes:1})).token;
            await plugin.cancelExport({token});
            return true;
            """);
        reload();
        run("""
            check(document.documentElement.scrollWidth <= innerWidth + 1, 'Primary navigation overflows');
            const sidebar = document.querySelector('[data-testid="app-sidebar"]');
            check(visible(button('Documents', sidebar)), 'Shared Documents navigation must be available');
            await clickButton('Settings', sidebar);
            const models = await until(() => document.querySelector('[aria-label="On-device models"]'), 'native provider controls inside shared Settings');
            await until(() => models.querySelector('select')?.options.length > 0, 'native provider inventory');
            const navigation = document.querySelector('.app-compact-navigation');
            if (visible(navigation)) {
                const rect = navigation.getBoundingClientRect();
                check(rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.height >= 40, 'Navigation must remain fully visible in Settings');
            }
            const providers = (await plugin.providers()).providers;
            const llama = providers.find(item => item.id === 'llama-cpp');
            check(llama?.availability === 'available', 'Imported fixture must be available');
            check(providers.every(item => item.locality === 'on-device' && !item.capabilities.tools), 'Providers must report their real capability limits');
            check((await api('/api/config')).provider === 'llama-cpp', 'Product config must select the native provider');
            return true;
            """);
        snapshot("01-shared-settings");
        run("""
            const modelId = (await plugin.listModels()).selectedModelId;
            const longer = await plugin.generate({requestId:'longer-smoke',providerId:'llama-cpp',modelId,contextSize:2048,maxTokens:512,messages:[{role:'user',content:'Hello'}]});
            check(longer.text === 'a'.repeat(512) && longer.stopReason === 'length', 'Explicit reply budgets above 256 must work');
            let rejected = false;
            try { await plugin.generate({requestId:'missing-model',providerId:'llama-cpp',modelId:'missing',contextSize:2048,maxTokens:8,messages:[{role:'user',content:'Hello'}]}); }
            catch { rejected = true; }
            check(rejected, 'Missing pinned model must fail instead of using selected model');
            return true;
            """);
        JSONObject chat = run("""
            await openNavigation();
            await clickButton('Native workshop', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => visible(document.querySelector('[data-testid="project-tab-chat"]')), 'ordinary project Chat tab');
            check(document.querySelector('.project-compact-heading h2')?.textContent === 'Native workshop', 'Current project name is missing');
            const composer = await until(() => document.querySelector('[data-testid="chat-composer"]'), 'shared chat composer');
            const editor = await until(() => composer.querySelector('[contenteditable="true"]'), 'shared rich text input');
            editor.focus();
            document.execCommand('insertText', false, 'Say hello.');
            await until(() => editor.textContent.includes('Say hello.'), 'composer draft');
            let streamed = '';
            const listener = await plugin.addListener('chatDelta', event => { streamed += event.delta; });
            try {
                await until(() => { const send = composer.querySelector('[aria-label="Send"]'); return send && !send.disabled && send; }, 'enabled Send');
                composer.querySelector('[aria-label="Send"]').click();
                const completed = await until(async () => {
                    const sessions = (await api('/api/sessions?project=' + %s)).sessions;
                    for (const summary of sessions) {
                        const session = await api('/api/sessions/' + summary.id);
                        if (session.lastTurnError) throw new Error(session.lastTurnError);
                        const answer = session.messages.find(item => item.role === 'assistant' && item.status === 'complete');
                        if (answer) return {session,answer};
                    }
                }, 'native response persisted as an ordinary session');
                check(completed.answer.providerId === 'llama-cpp', 'Native provider identity must be persisted');
                check(completed.answer.content === 'a'.repeat(256), 'Native fixture returned the wrong text');
                await until(() => streamed === completed.answer.content, 'streamed native deltas');
                await until(() => document.body.textContent.includes(completed.answer.content), 'rendered shared chat response');
                check(document.documentElement.scrollWidth <= innerWidth + 1, 'Project chat overflows');
                return {sessionId:completed.session.id};
            } finally { await listener.remove(); }
            """.formatted(JSONObject.quote(seeded.getString("projectId"))));
        snapshot("02-shared-native-chat");
        run("""
            const artifactsTab = document.querySelector('[data-testid="project-tab-artifacts"]');
            artifactsTab.focus();
            artifactsTab.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
            await clickButton('Native report.md');
            await until(() => visible(button('Back to files')), 'phone shared file viewer');
            await until(() => Array.from(document.querySelectorAll('.file-viewer-panel')).find(visible)?.textContent.includes('The same artifact drawer works on Android.'), 'saved artifact in shared editor');
            await clickButton('Back to files');
            await until(() => visible(button('Native report.md')), 'artifact list after Back');
            await openNavigation();
            await clickButton('Documents', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => visible(button('Back to files')) || visible(button('Android notes')), 'shared document library');
            if (visible(button('Back to files'))) await clickButton('Back to files');
            await clickButton('Android notes');
            await until(() => Array.from(document.querySelectorAll('.file-viewer-panel')).find(visible)?.textContent.includes('Saved through the shared product API.'), 'shared document content');
            check(document.documentElement.scrollWidth <= innerWidth + 1, 'Document viewer overflows');
            return true;
            """);
        snapshot("03-shared-documents");
        reload();
        run("""
            const project = await api('/api/projects/' + %s);
            check(project.gezelIds.includes(%s) && project.voormanGezelId === %s, 'Crew assignment must survive reload');
            const session = await api('/api/sessions/' + %s);
            check(session.messages.some(item => item.content === 'Say hello.') && session.messages.some(item => item.content === 'a'.repeat(256)), 'Ordinary session messages must survive reload');
            const savedDocument = await api('/api/documents/read?path=' + encodeURIComponent('Android notes.md'));
            check(savedDocument.content.includes('Saved through the shared product API.'), 'Shared document must survive reload');
            const artifact = await api('/api/projects/' + project.id + '/artifacts/read?path=' + encodeURIComponent('Native report.md'));
            check(artifact.content.includes('The same artifact drawer works on Android.'), 'Artifact must survive reload');
            await clickButton('Native workshop', document.querySelector('[data-testid="app-sidebar"]'));
            await until(() => document.body.textContent.includes('a'.repeat(256)), 'restored chat in shared project UI');
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
            """.formatted(JSONObject.quote(seeded.getString("projectId")), JSONObject.quote(seeded.getString("gezelId")),
                JSONObject.quote(seeded.getString("gezelId")), JSONObject.quote(chat.getString("sessionId"))));
        assertNotNull(store.productFiles.read("config.json"));
        assertNotNull(store.productFiles.read("projects/" + seeded.getString("projectId") + "/project.json"));
        assertNotNull(store.productFiles.read("gezels/" + seeded.getString("gezelId") + "/sessions/" + chat.getString("sessionId") + ".json"));
        snapshot("04-shared-reopened");
    }

    private void reload() throws Exception {
        evaluate("window.__gezelReloadMarker = true");
        instrumentation.runOnMainSync(() -> webView.reload());
        waitForApp();
    }

    @Test public void offlineSpeechUsesSharedProductArtifactsAndVoiceIdentity() throws Exception {
        run("""
            check(window.__GEZEL__.capabilities.audio, 'Native host must advertise real speech');
            const status = await api('/api/audio/offline-status');
            check(status.whisper.state === 'ready' && status.kokoro.state === 'ready', 'Offline models must ship in the app');
            const voices = await api('/api/audio/voices');
            check(voices.voices.some(voice => voice.id === 'bm_george'), 'Shared voice identity is missing');
            const models = await api('/api/audio/stt/models');
            check(models.models[0].approxSizeBytes > 0, 'Report the actual bundled model size');
            const spoken = await api('/api/audio/synthesize', 'POST', {text:'The blue bicycle is beside the window.',voice:'bm_george',inline:true});
            check(spoken.meta.voice === 'bm_george' && spoken.b64Wav, 'Kokoro must preserve the chosen voice');
            const transcript = await api('/api/audio/transcribe', 'POST', {audio:{artifactPath:spoken.artifactPath}, model:'whisper-tiny',language:'en'});
            check(/bicycle/i.test(transcript.text) && /window/i.test(transcript.text), 'Whisper did not understand the saved Kokoro artifact: ' + transcript.text);
            await openNavigation();
            await clickButton('Settings');
            await clickButton('Audio');
            await until(()=>document.body.innerText.includes('Preview a voice'),'shared audio settings');
            check(!document.body.innerText.includes('Pull a model'), 'Bundled speech must not offer unavailable downloads');
            return true;
            """);
    }

    private void waitForApp() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 60_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(evaluate("Boolean(!window.__gezelReloadMarker && document.querySelector('[data-testid=\"app-sidebar\"]') && window.Capacitor?.Plugins?.GezelMobile)"))) return;
            SystemClock.sleep(100);
        }
        fail("Packaged mobile app did not initialize: " + evaluate("document.body.innerText"));
    }

    private String evaluate(String source) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> webView.evaluateJavascript(source, value -> {
            result.set(value);
            done.countDown();
        }));
        assertTrue("WebView JavaScript callback timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private JSONObject run(String source) throws Exception {
        // Clear separately: a syntax error in the next script must not reuse the prior receipt.
        evaluate("window.__gezelUiSmoke = null");
        evaluate("(async () => {" + HELPERS + source
            + "})().then(value => window.__gezelUiSmoke = {value}, error => window.__gezelUiSmoke = {error:String(error.stack || error)}); void 0;");
        long deadline = SystemClock.elapsedRealtime() + 90_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            String encoded = evaluate("window.__gezelUiSmoke");
            if (encoded != null && !"null".equals(encoded)) {
                JSONObject result = new JSONObject(encoded);
                if (result.has("error")) fail(result.getString("error"));
                Object value = result.opt("value");
                return value instanceof JSONObject ? (JSONObject) value : new JSONObject().put("value", value);
            }
            SystemClock.sleep(100);
        }
        fail("UI smoke timed out: " + evaluate("document.body.innerText"));
        return null;
    }

    private void snapshot(String name) throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> webView.postVisualStateCallback(SystemClock.uptimeMillis(), new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) {
                webView.invalidate();
                webView.postOnAnimation(() -> webView.postOnAnimation(drawn::countDown));
            }
        }));
        assertTrue("WebView must present its updated contents before capture", drawn.await(15, TimeUnit.SECONDS));
        instrumentation.waitForIdleSync();
        SystemClock.sleep(200);
        String testOutput = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        File directory = testOutput == null || testOutput.isEmpty()
            ? new File(instrumentation.getTargetContext().getCacheDir(), "ui-smoke-screenshots")
            : new File(testOutput, "ui-smoke-screenshots");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull("Android screenshot must be available", bitmap);
        try (FileOutputStream output = new FileOutputStream(new File(directory, name + ".png"))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }

    private static final String HELPERS = """
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
            for (let attempt = 0; attempt < 450; attempt++) {
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
                const navigation = await until(() => document.querySelector('.app-compact-navigation button'), 'Navigation control');
                navigation.click();
            }
            await until(() => visible(document.querySelector('[data-testid="app-sidebar"]')), 'shared primary navigation');
        };
        """;
}
