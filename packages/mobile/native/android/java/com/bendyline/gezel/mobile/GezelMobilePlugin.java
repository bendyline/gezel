package com.bendyline.gezel.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.ComponentCallbacks2;
import android.content.res.Configuration;
import com.google.mlkit.genai.common.FeatureStatus;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import org.json.*;

@CapacitorPlugin(name = "GezelMobile")
public final class GezelMobilePlugin extends Plugin {
    private final ExecutorService storageQueue = Executors.newSingleThreadExecutor();
    private final MlKitPrompt mlkit = new MlKitPrompt();
    private final ExecutorService inferenceQueue = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService cancellationQueue = Executors.newSingleThreadScheduledExecutor();
    private MobileStore store;
    private String initializationError;
    private volatile long engine;
    private String activeId;
    private String activeProvider;
    private boolean preparing;
    private boolean preparationCancelled;
    private final List<PluginCall> preparationWaiters = new ArrayList<>();
    private boolean releaseRequested;
    private long nativeId;
    private long nextId;
    private boolean cancelled;
    private final List<PluginCall> cancelWaiters = new ArrayList<>();
    private boolean modelMutation;
    private boolean destroyed;
    private boolean backgrounded;
    private String loadedId;
    private int loadedContext;

    private final ComponentCallbacks2 memory = new ComponentCallbacks2() {
        @Override public void onConfigurationChanged(Configuration configuration) {}
        @Override public void onLowMemory() { releaseForMemory(); }
        @Override public void onTrimMemory(int level) {
            if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) releaseForMemory();
        }
    };

    @Override public void load() {
        getContext().registerComponentCallbacks(memory);
        try { store = new MobileStore(getContext().getFilesDir()); }
        catch (Exception error) { initializationError = error.getMessage(); }
        try { engine = LlamaRuntime.create(); }
        catch (LinkageError error) { initializationError = "Native inference is not included in this build"; }
    }

    private static String failureMessage(Throwable error) {
        if (error instanceof OutOfMemoryError) return "Not enough memory for this model";
        if (error instanceof CancellationException) return "The operation was cancelled";
        String message = error.getMessage();
        if (message == null || message.isEmpty()) return "The on-device operation could not be completed";
        return message.substring(0, Math.min(message.length(), 1000));
    }

    private interface StoreAction { JSObject run() throws Exception; }
    private void storage(PluginCall call, StoreAction action) { storage(call, action, () -> {}); }
    private void storage(PluginCall call, StoreAction action, Runnable completion) {
        try { storageQueue.execute(() -> {
            JSObject result = null;
            Throwable failure = null;
            try {
                if (store == null) throw new IllegalStateException(initializationError);
                result = action.run();
            } catch (Exception | OutOfMemoryError error) { failure = error; }
            finally { completion.run(); }
            if (failure == null) call.resolve(result);
            else call.reject(failureMessage(failure));
        }); } catch (RejectedExecutionException error) { completion.run(); call.reject("The app is closing"); }
    }

    @PluginMethod public void readState(PluginCall call) { storage(call, () -> {
        String data = store.readState();
        return new JSObject().put("data", data == null ? JSONObject.NULL : data);
    }); }
    @PluginMethod public void writeState(PluginCall call) {
        String data = call.getString("data");
        if (data == null) { call.reject("State data is required"); return; }
        storage(call, () -> { store.writeState(data); return new JSObject(); });
    }
    @PluginMethod public void listModels(PluginCall call) { storage(call, () -> store.listModels()); }

    private static JSObject descriptor(String id, String name, String availability, String reason, int context) {
        JSObject capabilities = new JSObject().put("text", true).put("tools", false)
            .put("structuredOutput", false).put("images", false).put("foregroundOnly", true);
        JSObject result = new JSObject().put("id", id).put("name", name).put("locality", "on-device")
            .put("availability", availability).put("contextTokens", context).put("maxOutputTokens", 256)
            .put("capabilities", capabilities);
        if (reason != null) result.put("reason", reason.substring(0, Math.min(reason.length(), 1000)));
        return result;
    }

    private JSObject providerPayload(String availability, String aiReason, int context) {
        String llamaReason = null;
        boolean inactive;
        synchronized (this) { inactive = destroyed || backgrounded; }
        if (inactive) llamaReason = "Open Gezel to use on-device AI";
        else if (engine == 0) llamaReason = "Native inference is not included in this build";
        else try {
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            store.selectedModel();
        } catch (Exception error) { llamaReason = "Import and select a GGUF model first"; }
        if (inactive) { availability = "unavailable"; aiReason = llamaReason; }
        JSArray providers = new JSArray();
        providers.put(descriptor("llama-cpp", "Imported model", llamaReason == null ? "available" : "unavailable", llamaReason, 2048));
        providers.put(descriptor("android-mlkit", "Android on-device AI", availability, aiReason, context));
        return new JSObject().put("providers", providers);
    }

    @PluginMethod public void providers(PluginCall call) {
        boolean downloading;
        synchronized (this) { downloading = preparing; }
        if (downloading) {
            // Do not queue behind the potentially long explicit download.
            call.resolve(providerPayload("downloading", null, MlKitPrompt.CONTEXT_TOKENS));
            return;
        }
        // Probes share the inference queue: closing their SDK client can never
        // overlap a live generation or model preparation.
        try { inferenceQueue.execute(() -> {
            String reason = null, availability = "unavailable";
            int context = MlKitPrompt.CONTEXT_TOKENS;
            boolean inactive;
            synchronized (this) { inactive = destroyed || backgrounded; }
            if (!inactive) try {
                MlKitPrompt.Availability status = MlKitPrompt.status();
                context = status.contextTokens;
                switch (status.status) {
                    case FeatureStatus.AVAILABLE: availability = "available"; break;
                    case FeatureStatus.DOWNLOADABLE: availability = "download-required"; break;
                    case FeatureStatus.DOWNLOADING: availability = "downloading"; break;
                    default: reason = "Android's on-device AI is not supported or enabled on this device";
                }
            } catch (Exception | LinkageError error) { reason = "Android's on-device AI is unavailable: " + failureMessage(error); }
            call.resolve(providerPayload(availability, reason, context));
        }); } catch (RejectedExecutionException error) { call.reject("The app is closing"); }
    }

    @PluginMethod public void cancelProviderPreparation(PluginCall call) {
        if (!"android-mlkit".equals(call.getString("providerId"))) { call.reject("Unknown downloadable provider"); return; }
        Runnable stop;
        synchronized (this) {
            if (!preparing) { call.resolve(); return; }
            preparationCancelled = true;
            preparationWaiters.add(call);
            stop = mlkit.requestCancellation();
        }
        stop.run();
    }

    @PluginMethod public void prepareProvider(PluginCall call) {
        if (!"android-mlkit".equals(call.getString("providerId"))) {
            call.reject("This provider cannot download a model. Import a GGUF model for llama.cpp."); return;
        }
        synchronized (this) {
            if (destroyed || backgrounded || activeId != null || modelMutation || releaseRequested) {
                call.reject("Open Gezel and finish the current operation first", "BUSY"); return;
            }
            modelMutation = true; preparing = true; preparationCancelled = false; mlkit.begin();
            inferenceQueue.execute(() -> {
                Throwable failure = null;
                List<PluginCall> waiting;
                try {
                    unloadLlama();
                    mlkit.prepare(() -> { synchronized (this) { return preparationCancelled || backgrounded || destroyed; } });
                    synchronized (this) { if (preparationCancelled || backgrounded || destroyed) throw new CancellationException(); }
                } catch (Exception | LinkageError | OutOfMemoryError error) { failure = error; }
                finally {
                    try { mlkit.close(); }
                    catch (Exception | LinkageError | OutOfMemoryError error) { if (failure == null) failure = error; }
                    finally { synchronized (this) {
                        preparing = false; modelMutation = false;
                        waiting = new ArrayList<>(preparationWaiters); preparationWaiters.clear();
                    } }
                }
                if (failure == null) call.resolve();
                else call.reject(failure instanceof CancellationException ? "Model preparation was cancelled" : "Could not prepare Android's on-device AI: " + failureMessage(failure));
                for (PluginCall waiter : waiting) waiter.resolve();
            });
        }
    }

    @PluginMethod public void removeModel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("Model ID is required"); return; }
        if (!reserveModelMutation()) { call.reject("Wait for the current operation to finish", "BUSY"); return; }
        try { inferenceQueue.execute(() -> {
            Throwable failure = null;
            try { unloadLlama(); store.removeModel(id); }
            catch (Exception | LinkageError | OutOfMemoryError error) { failure = error; }
            finally { releaseModelMutation(); }
            if (failure == null) call.resolve();
            else call.reject("Could not remove this model: " + failureMessage(failure));
        }); } catch (RejectedExecutionException error) { releaseModelMutation(); call.reject("The app is closing"); }
    }

    private synchronized boolean reserveModelMutation() {
        if (activeId != null || modelMutation || destroyed) return false;
        modelMutation = true;
        return true;
    }
    private synchronized void releaseModelMutation() { modelMutation = false; }

    @PluginMethod public void selectModel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("Model ID is required"); return; }
        if (!reserveModelMutation()) { call.reject("Wait for the current conversation or import to finish", "BUSY"); return; }
        storage(call, () -> {
            return new JSObject().put("model", store.selectModel(id));
        }, this::releaseModelMutation);
    }

    @PluginMethod public void importModel(PluginCall call) {
        if (!reserveModelMutation()) { call.reject("Wait for the current conversation or import to finish", "BUSY"); return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("application/octet-stream");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(call, intent, "modelPicked"); }
        catch (Exception error) { releaseModelMutation(); call.reject("Document picker unavailable", error); }
    }

    @ActivityCallback private void modelPicked(PluginCall call, ActivityResult result) {
        if (call == null) { releaseModelMutation(); return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            releaseModelMutation(); call.resolve(new JSObject().put("model", JSONObject.NULL)); return;
        }
        storage(call, () -> {
            return new JSObject().put("model", store.importModel(getContext().getContentResolver(), uri));
        }, this::releaseModelMutation);
    }

    private synchronized boolean isCancelled(String id) { return !id.equals(activeId) || cancelled; }
    private synchronized long nextOperation(String id) {
        if (isCancelled(id)) return 0;
        nextId = nextId == Long.MAX_VALUE ? 1 : nextId + 1;
        nativeId = nextId;
        return nativeId;
    }
    private void cancelActive(String id) {
        Runnable cancelAi = null;
        synchronized (this) {
            if (activeId != null && (id == null || id.equals(activeId))) {
                cancelled = true;
                if ("android-mlkit".equals(activeProvider)) cancelAi = mlkit.requestCancellation();
                // Hold lifetime lock for the C pointer's atomic cancel only.
                else if (engine != 0) LlamaRuntime.cancel(engine, nativeId);
            }
        }
        if (cancelAi != null) cancelAi.run();
    }
    @PluginMethod public void cancel(PluginCall call) {
        String id = call.getString("requestId");
        if (id == null) { call.reject("Request ID is required"); return; }
        synchronized (this) {
            if (!id.equals(activeId)) { call.resolve(); return; }
            cancelWaiters.add(call);
        }
        cancelActive(id);
    }

    @PluginMethod public void generate(PluginCall call) {
        String requestId = call.getString("requestId");
        String providerId = call.getString("providerId", "llama-cpp");
        JSArray messages = call.getArray("messages");
        int maxTokens = call.getInt("maxTokens", 256);
        int contextSize = call.getInt("contextSize", 2048);
        try {
            if (!"llama-cpp".equals(providerId) && !"android-mlkit".equals(providerId)) throw new IllegalArgumentException("Unknown on-device provider");
            if ("llama-cpp".equals(providerId) && engine == 0) throw new IllegalStateException(initializationError == null ? "Native engine unavailable" : initializationError);
            if (requestId == null || requestId.isEmpty() || requestId.getBytes(StandardCharsets.UTF_8).length > 128 || messages == null || messages.length() == 0 || messages.length() > 128) throw new IllegalArgumentException("A request ID and conversation are required");
            String[] roles = new String[messages.length()], contents = new String[messages.length()];
            int bytes = 0;
            for (int index = 0; index < messages.length(); index++) {
                JSONObject message = messages.getJSONObject(index);
                roles[index] = message.getString("role"); contents[index] = message.getString("content");
                if ((!roles[index].equals("user") && !roles[index].equals("assistant") && !roles[index].equals("system")) || contents[index].indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid conversation message");
                if (roles[index].equals("system") && index != 0) throw new IllegalArgumentException("System instructions must come first");
                if (contents[index].length() > 64_000) throw new IllegalArgumentException("Conversation message is too long");
                bytes += contents[index].getBytes(StandardCharsets.UTF_8).length;
            }
            if (bytes > 256 * 1024 || !roles[roles.length - 1].equals("user") || maxTokens < 1 || maxTokens > 256 || contextSize < 512 || contextSize > 8192) throw new IllegalArgumentException("Conversation or token budget is outside the supported range");
            synchronized (this) {
                if (destroyed || backgrounded) { call.reject("Reopen the app to start a conversation", "BACKGROUND"); return; }
                if (activeId != null || modelMutation || releaseRequested) { call.reject("Another conversation or memory cleanup is running", "BUSY"); return; }
                activeId = requestId; activeProvider = providerId; cancelled = false; mlkit.begin();
                inferenceQueue.execute(() -> runGeneration(call, requestId, roles, contents, maxTokens, contextSize));
            }
        } catch (Exception error) { call.reject(failureMessage(error)); }
    }

    private void runGeneration(PluginCall call, String requestId, String[] roles, String[] contents, int maxTokens, int contextSize) {
        StringBuilder text = new StringBuilder();
        ScheduledFuture<?> cancelTimer = null;
        JSObject result = null;
        Throwable failure = null;
        List<PluginCall> waiting;
        try {
            cancelTimer = cancellationQueue.scheduleAtFixedRate(() -> {
                if (isCancelled(requestId)) cancelActive(requestId);
            }, 50, 50, TimeUnit.MILLISECONDS);
            result = performGeneration(requestId, roles, contents, maxTokens, contextSize, text);
        }
        catch (Exception | LinkageError | OutOfMemoryError error) {
            if (!(error instanceof OutOfMemoryError) && isCancelled(requestId)) result = new JSObject().put("text", text.toString()).put("stopReason", "cancelled");
            else failure = error;
        }
        finally {
            if (cancelTimer != null) cancelTimer.cancel(false);
            try {
                if ("android-mlkit".equals(activeProvider)) mlkit.close();
                boolean release;
                synchronized (this) { release = releaseRequested || backgrounded || destroyed; }
                if (release) unloadLlama();
            } catch (Exception | LinkageError | OutOfMemoryError error) { if (failure == null) failure = error; }
            synchronized (this) {
                activeId = null; activeProvider = null; nativeId = 0;
                waiting = new ArrayList<>(cancelWaiters); cancelWaiters.clear();
            }
        }
        if (failure == null) call.resolve(result);
        else call.reject(failureMessage(failure));
        for (PluginCall waiter : waiting) waiter.resolve();
    }

    private JSObject performGeneration(String requestId, String[] roles, String[] contents, int maxTokens, int contextSize, StringBuilder text) throws Exception {
            if (isCancelled(requestId)) return new JSObject().put("text", "").put("stopReason", "cancelled");
            if ("android-mlkit".equals(activeProvider)) {
                unloadLlama();
                MlKitPrompt.Reply reply = mlkit.generate(roles, contents, maxTokens, () -> isCancelled(requestId),
                    delta -> emitDelta(requestId, text, delta));
                return new JSObject().put("text", reply.text).put("stopReason", reply.stopReason);
            }
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            String[] model = store.selectedModel();
            if (!model[0].equals(loadedId) || contextSize != loadedContext) {
                long operation = nextOperation(requestId);
                if (operation == 0) return new JSObject().put("text", "").put("stopReason", "cancelled");
                loadedId = null;
                LlamaRuntime.load(engine, model[1], operation, contextSize);
                loadedId = model[0]; loadedContext = contextSize;
            }
            long operation = nextOperation(requestId);
            if (operation == 0) return new JSObject().put("text", "").put("stopReason", "cancelled");
            int reason = LlamaRuntime.generate(engine, roles, contents, operation, maxTokens, utf8 -> {
                if (isCancelled(requestId)) return false;
                String delta = new String(utf8, StandardCharsets.UTF_8);
                emitDelta(requestId, text, delta);
                return !isCancelled(requestId);
            });
            return new JSObject().put("text", text.toString()).put("stopReason", isCancelled(requestId) || reason == 3 ? "cancelled" : reason == 2 ? "length" : "stop");
    }

    private synchronized void emitDelta(String requestId, StringBuilder text, String delta) {
        if (isCancelled(requestId)) return;
        if (delta.length() > 64_000 - text.length()) throw new IllegalStateException("The model response exceeded the supported size");
        text.append(delta);
        notifyListeners("chatDelta", new JSObject().put("requestId", requestId).put("delta", delta));
    }

    private void unloadLlama() {
        loadedId = null; loadedContext = 0;
        if (engine != 0) LlamaRuntime.unload(engine);
    }

    private void releaseForMemory() {
        synchronized (this) { releaseRequested = true; if (destroyed) return; }
        cancelActive(null);
        mlkit.cancel();
        try { inferenceQueue.execute(() -> {
            try { unloadLlama(); mlkit.close(); }
            finally { synchronized (this) { releaseRequested = false; } }
        }); }
        catch (RejectedExecutionException ignored) {}
    }

    @Override protected void handleOnStop() {
        synchronized (this) { backgrounded = true; }
        releaseForMemory();
        notifyListeners("appBackground", new JSObject());
    }

    @Override protected void handleOnResume() {
        synchronized (this) { backgrounded = false; }
    }

    @Override protected void handleOnDestroy() {
        synchronized (this) { if (destroyed) return; destroyed = true; }
        getContext().unregisterComponentCallbacks(memory);
        cancelActive(null);
        mlkit.cancel();
        inferenceQueue.execute(() -> {
            synchronized (this) { if (engine != 0) LlamaRuntime.destroy(engine); engine = 0; }
            mlkit.close();
            cancellationQueue.shutdown();
        });
        inferenceQueue.shutdown(); storageQueue.shutdown();
    }

    @Override public Boolean shouldOverrideLoad(Uri url) {
        return !("https".equals(url.getScheme()) && "localhost".equals(url.getHost()));
    }
}
