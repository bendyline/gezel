package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
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
import org.junit.runner.RunWith;

/** Exercises the packaged React app, worker, Capacitor bridge, and private storage together. */
@RunWith(AndroidJUnit4.class)
public final class MobileUiSmokeTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Map<File, byte[]> priorState = new LinkedHashMap<>();
    private MainActivity activity;
    private WebView webView;
    private MobileStore store;
    private File fixtureSource;
    private File importedFixture;
    private String fixtureId;

    @Before public void launchWithIsolatedConversations() throws Exception {
        File files = instrumentation.getTargetContext().getFilesDir();
        store = new MobileStore(files);
        // Preserve even AtomicFile recovery sidecars when this runs on a developer's device.
        for (String name : new String[] { "state.json", "state.json.bak", "state.json.new",
                "models.json", "models.json.bak", "models.json.new" }) {
            File file = new File(new File(files, "gezel"), name);
            priorState.put(file, file.exists() ? Files.readAllBytes(file.toPath()) : null);
        }
        for (File file : priorState.keySet()) Files.deleteIfExists(file.toPath());
        fixtureSource = File.createTempFile("ui-smoke-", ".gguf", instrumentation.getTargetContext().getCacheDir());
        try (InputStream input = instrumentation.getContext().getAssets().open("fixtures/deterministic-native.gguf");
                FileOutputStream output = new FileOutputStream(fixtureSource)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
        fixtureId = store.importModel(instrumentation.getTargetContext().getContentResolver(), Uri.fromFile(fixtureSource)).getString("id");
        importedFixture = new File(new File(files, "gezel/models"), fixtureId + ".gguf");
        Intent launch = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(launch);
        instrumentation.runOnMainSync(() -> webView = activity.getBridge().getWebView());
        assertNotNull("Capacitor must host the actual application WebView", webView);
        waitForApp();
    }

    @After public void restoreConversations() throws Exception {
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
        for (Map.Entry<File, byte[]> entry : priorState.entrySet()) {
            Files.deleteIfExists(entry.getKey().toPath());
            if (entry.getValue() != null) Files.write(entry.getKey().toPath(), entry.getValue());
        }
        if (importedFixture != null) Files.deleteIfExists(importedFixture.toPath());
        if (fixtureSource != null) Files.deleteIfExists(fixtureSource.toPath());
    }

    @Test public void sharedNavigationSettingsAndConversationPersistence() throws Exception {
        JSONObject initial = run("""
            check(window.Capacitor?.getPlatform() === 'android', 'Must use the native Android host');
            check(innerWidth <= 760, 'Run the UI smoke on a phone-sized emulator or device');
            check(document.documentElement.scrollWidth <= innerWidth, 'Phone navigation overflows horizontally');
            const navigation = document.querySelector('[aria-label="Primary navigation"]');
            check(visible(navigation), 'Phone must open at shared primary navigation');
            check(!visible(document.querySelector('.mobile-main')), 'Project must not cover initial navigation');
            check(button('Documents', navigation)?.disabled, 'Unsupported Documents must not appear usable');
            const saved = await read();
            check(saved.sessions.length === 1, 'Isolated app should create one initial conversation');
            return {projectName:saved.project.name};
            """);
        snapshot("01-navigation");

        JSONObject readiness = run("""
            await enterProject();
            const send = document.querySelector('.mobile-send');
            check(visible(send) && send.getBoundingClientRect().bottom <= innerHeight + 1,
                'Composer must fit within the phone viewport');
            check(visible(document.querySelector('[data-testid="project-tab-chat"]')), 'Shared project Chat tab is missing');
            await openNavigation();
            await clickButton('Settings', document.querySelector('[aria-label="Primary navigation"]'));
            await until(() => visible(document.querySelector('.mobile-settings')), 'global Settings');
            const models = document.querySelector('.mobile-models');
            if (!models.open) models.querySelector('summary').click();
            const chooser = models.querySelector('select');
            await until(() => Array.from(chooser.options).some(option => option.value === 'android-mlkit'),
                'native Android provider in the packaged chooser');
            await until(() => !button('Check availability', models).disabled, 'enabled model controls');
            await clickButton('Check availability', models);
            await until(() => !button('Check availability', models).disabled, 'completed readiness refresh');
            const providers = (await plugin.providers()).providers;
            for (const id of ['llama-cpp', 'android-mlkit']) {
                const provider = providers.find(item => item.id === id);
                check(provider?.locality === 'on-device', 'Missing native descriptor: ' + id);
                check(provider.capabilities.tools === false, 'Text-only provider must not advertise tools');
                const option = Array.from(chooser.options).find(item => item.value === id);
                check(option, 'Native provider did not reach Settings: ' + id);
                if (provider.availability !== 'available') {
                    check(option.textContent.includes('not ready'), 'Unavailable provider must be labeled not ready');
                    check(option.disabled || chooser.value === id, 'Unavailable provider must not be newly selectable');
                    if (provider.availability === 'unavailable') {
                        check(provider.reason?.length > 0, 'Unavailable provider must explain why');
                        check(models.textContent.includes(provider.reason), 'Settings must show provider unavailability reason');
                    }
                }
            }
            return {providers:providers.map(({id,availability,reason}) => ({id,availability,reason}))};
            """);
        Log.i("GezelUiSmoke", "Native provider readiness: " + readiness);
        run("""
            const models = document.querySelector('.mobile-models');
            const imported = models.querySelector('.mobile-model-library select');
            await until(() => visible(imported) && !imported.disabled, 'enabled imported-model chooser');
            check(Array.from(imported.options).some(option => option.value === %s),
                'Imported fixture must appear in the real model library');
            imported.value = %s;
            imported.dispatchEvent(new Event('change', {bubbles:true}));
            await until(async () => (await plugin.listModels()).selectedModelId === %s
                && (await plugin.providers()).providers.find(item => item.id === 'llama-cpp').availability === 'available'
                && !imported.disabled, 'fixture selected through Settings');
            check((await read()).selectedProviderId === 'llama-cpp', 'Settings must save the chosen provider');
            if (!models.open) models.querySelector('summary').click();
            await until(() => visible(imported), 'expanded selected-model Settings');
            return true;
            """.formatted(JSONObject.quote(fixtureId), JSONObject.quote(fixtureId), JSONObject.quote(fixtureId)));
        snapshot("02-settings");

        JSONObject chat = run("""
            await openNavigation();
            await enterProject();
            const before = await read();
            const sessionId = before.activeSessionId;
            const textarea = document.querySelector('textarea');
            await until(() => !textarea.disabled, 'available native model in composer');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Say hello.');
            textarea.dispatchEvent(new Event('input', {bubbles:true}));
            await until(() => !document.querySelector('.mobile-send').disabled, 'enabled native chat Send');
            let streamed = '';
            const listener = await plugin.addListener('chatDelta', event => { streamed += event.delta; });
            try {
                document.querySelector('form.mobile-composer').requestSubmit();
                const reply = await until(async () => {
                    const state = await read();
                    const messages = state.sessions.find(item => item.id === sessionId).messages;
                    const assistant = messages[1];
                    if (assistant?.status === 'error') throw new Error(assistant.error || 'Native UI generation failed');
                    return assistant?.status === 'complete' && assistant;
                }, 'native response persisted by the worker');
                check(reply.providerId === 'llama-cpp', 'UI chat must use the explicitly selected native provider');
                check(reply.content === 'a'.repeat(256), 'Native fixture must generate the deterministic reply');
                await until(() => streamed === reply.content, 'native streaming deltas matching saved response');
                await until(() => document.querySelector('[role="log"]').textContent.includes(reply.content), 'rendered assistant response');
                await until(() => visible(document.querySelector('.mobile-send')), 'finished native turn');
                return {sessionId,text:reply.content};
            } finally { await listener.remove(); }
            """);
        assertEquals(256, chat.getString("text").length());
        snapshot("03-native-chat");

        JSONObject created = run("""
            await clickButton('Conversations');
            await until(() => visible(document.querySelector('.mobile-conversations')), 'conversation list');
            await clickButton('New', document.querySelector('.mobile-conversations'));
            await until(async () => (await read()).sessions.length === 2 && visible(document.querySelector('.mobile-chat')),
                'new conversation persisted through worker and native bridge');
            await clickButton('Conversations');
            await until(() => visible(document.querySelector('.mobile-conversations')), 'conversation list after creation');
            const options = document.querySelector('.mobile-conversation-options');
            if (!options.open) options.querySelector('summary').click();
            await clickButton('Rename', options);
            const input = Array.from(options.querySelectorAll('label')).find(label => label.textContent.includes('Conversation name')).querySelector('input');
            await setInput(input, 'Android smoke recovery notes');
            await until(() => !button('Save name', options).disabled, 'rename form');
            await clickButton('Save name', options);
            const state = await until(async () => {
                const saved = await read();
                return saved.sessions.find(item => item.id === saved.activeSessionId)?.title === 'Android smoke recovery notes' && saved;
            }, 'renamed conversation persisted');
            await until(() => button('Android smoke recovery notes'), 'renamed conversation in the list');
            const search = document.querySelector('.mobile-conversations input[type="search"]');
            await setInput(search, 'recovery');
            await until(() => document.querySelector('[aria-label="Conversations"]').querySelectorAll('button').length === 1,
                'conversation search');
            check(document.documentElement.scrollWidth <= innerWidth, 'Conversation list overflows horizontally');
            return {sessionId:state.activeSessionId};
            """);
        snapshot("04-conversations");
        JSONObject persisted = new JSONObject(store.readState());
        assertEquals(created.getString("sessionId"), persisted.getString("activeSessionId"));
        assertEquals(2, persisted.getJSONArray("sessions").length());

        reload();
        run("""
            await enterProject();
            await clickButton('Conversations');
            await until(() => button('Android smoke recovery notes'), 'saved title after WebView reload');
            const state = await read();
            check(state.activeSessionId === %s, 'Active conversation must survive reload');
            check(state.sessions.length === 2, 'Conversation creation must survive reload');
            const chat = state.sessions.find(item => item.id === %s);
            check(chat.messages[0].content === 'Say hello.' && chat.messages[1].content === 'a'.repeat(256)
                && chat.messages[1].status === 'complete', 'Native chat must survive reload');
            const options = document.querySelector('.mobile-conversation-options');
            if (!options.open) options.querySelector('summary').click();
            await clickButton('Delete conversation', options);
            await until(() => button('Keep conversation', options), 'delete confirmation');
            await clickButton('Keep conversation', options);
            await until(() => !button('Delete permanently', options), 'cancelled deletion');
            check((await read()).sessions.length === 2, 'Cancelling deletion must keep the conversation');
            await clickButton('Delete conversation', options);
            await until(() => button('Delete permanently', options), 'delete confirmation');
            await clickButton('Delete permanently', options);
            await until(async () => (await read()).sessions.length === 1 && !button('Android smoke recovery notes'),
                'confirmed deletion persisted');
            return true;
            """.formatted(JSONObject.quote(created.getString("sessionId")), JSONObject.quote(chat.getString("sessionId"))));

        reload();
        run("""
            await enterProject();
            await clickButton('Conversations');
            await until(() => visible(document.querySelector('.mobile-conversations')), 'conversation list after second reload');
            check(document.querySelector('[aria-label="Conversations"]').querySelectorAll('button').length === 1,
                'Deletion must survive reload');
            check(!button('Android smoke recovery notes'), 'Deleted conversation reappeared');
            await clickButton('Back to chat');
            await until(() => visible(document.querySelector('.mobile-chat')), 'return to project chat');
            const selected = (await read()).selectedProviderId;
            const descriptor = (await plugin.providers()).providers.find(provider => provider.id === selected);
            if (descriptor?.availability !== 'available') {
                check(document.querySelector('textarea').disabled && document.querySelector('.mobile-send').disabled,
                    'Unavailable models must disable the composer');
                check(visible(button('Choose a model')), 'Unavailable model must provide a Settings entry point');
            }
            return true;
            """);
        snapshot("05-project");
        assertEquals(initial.getString("projectName"), new JSONObject(store.readState()).getJSONObject("project").getString("name"));
    }

    private void reload() throws Exception {
        evaluate("window.__gezelReloadMarker = true");
        instrumentation.runOnMainSync(() -> webView.reload());
        waitForApp();
    }

    private void waitForApp() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 60_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(evaluate("Boolean(!window.__gezelReloadMarker && document.querySelector('[aria-label=\"Primary navigation\"]') && window.Capacitor?.Plugins?.GezelMobile)"))) return;
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
        evaluate("window.__gezelUiSmoke = null; (async () => {" + HELPERS + source
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
        const button = (text, scope = document) => Array.from(scope.querySelectorAll('button')).find(item => visible(item) && item.textContent.trim() === text);
        const read = async () => JSON.parse((await plugin.readState()).data);
        const until = async (action, description) => {
            for (let attempt = 0; attempt < 450; attempt++) {
                const result = await action();
                if (result) return result;
                const alert = document.querySelector('[role="alert"]');
                if (visible(alert)) throw new Error(description + ': ' + alert.textContent);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Timed out: ' + description);
        };
        const clickButton = async (text, scope = document) => {
            const element = await until(() => {
                const candidate = button(text, scope);
                return candidate && !candidate.disabled && candidate;
            }, 'enabled visible button: ' + text);
            element.click();
            await new Promise(resolve => requestAnimationFrame(resolve));
        };
        const setInput = async (input, value) => {
            check(visible(input) && !input.disabled, 'Expected an editable input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new Event('input', {bubbles:true}));
            await new Promise(resolve => requestAnimationFrame(resolve));
        };
        const openNavigation = async () => {
            if (!visible(document.querySelector('[aria-label="Primary navigation"]'))) await clickButton('Navigation');
            await until(() => visible(document.querySelector('[aria-label="Primary navigation"]')), 'primary navigation');
        };
        const enterProject = async () => {
            const state = await read();
            await clickButton(state.project.name, document.querySelector('[aria-label="Primary navigation"]'));
            await until(() => visible(document.querySelector('.mobile-chat')), 'project Meester conversation');
            check(!visible(document.querySelector('.mobile-settings')), 'Settings must not cover the project');
            check(document.querySelector('.mobile-project-heading h1').textContent === state.project.name,
                'Project heading must show the saved project');
        };
        """;
}
