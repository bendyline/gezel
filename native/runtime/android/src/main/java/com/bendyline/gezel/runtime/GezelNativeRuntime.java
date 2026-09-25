package com.bendyline.gezel.runtime;

import com.bendyline.gezel.llama.LlamaRuntime;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.content.ComponentCallbacks2;
import android.content.res.Configuration;
import com.google.mlkit.genai.common.FeatureStatus;
import android.net.Uri;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import org.json.*;

/** Process-owned model/provider runtime; no Capacitor or product filesystem authority. */
public final class GezelNativeRuntime {
    private static GezelNativeRuntime shared;
    private static java.io.File sharedRoot;
    public static synchronized GezelNativeRuntime shared(Context context) {
        return shared != null ? shared : shared(context, new java.io.File(context.getFilesDir(), "gezel"));
    }
    /** Configure once before attaching a plugin. All clients share this model root and gate. */
    public static synchronized GezelNativeRuntime shared(Context context, java.io.File root) {
        final java.io.File canonical;
        try { canonical = root.getCanonicalFile(); }
        catch (java.io.IOException error) { throw new IllegalArgumentException("Invalid model root", error); }
        if (shared != null) {
            if (!canonical.equals(sharedRoot)) throw new IllegalStateException("The process runtime already owns another model root");
            return shared;
        }
        sharedRoot = canonical;
        shared = new GezelNativeRuntime(context.getApplicationContext(), canonical);
        return shared;
    }
    private final Context context;
    private final java.util.concurrent.CopyOnWriteArrayList<java.util.function.BiConsumer<String, NativeObject>> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    public AutoCloseable listen(java.util.function.BiConsumer<String, NativeObject> listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }
    private void notifyListeners(String name, NativeObject data) { for (var listener : listeners) listener.accept(name, data); }
    private Context getContext() { return context; }
    private final ExecutorService storageQueue = Executors.newSingleThreadExecutor();
    private final MlKitPrompt mlkit = new MlKitPrompt();
    private final ExecutorService inferenceQueue = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService cancellationQueue = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService downloadControl = Executors.newSingleThreadExecutor();
    private ModelDownloads downloads;
    private MobileModelStore store;
    private String initializationError;
    private volatile long engine;
    private String activeId;
    private String activeProvider;
    private boolean preparing;
    private boolean preparationCancelled;
    private final List<NativeCall> preparationWaiters = new ArrayList<>();
    private boolean releaseRequested;
    private final List<NativeCall> releaseWaiters = new ArrayList<>();
    private long nativeId;
    private long nextId;
    private boolean cancelled;
    private final List<NativeCall> cancelWaiters = new ArrayList<>();
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

    private GezelNativeRuntime(Context context, java.io.File storageRoot) {
        this.context = context.getApplicationContext();
        getContext().registerComponentCallbacks(memory);
        try { store = new MobileModelStore(storageRoot); downloads = new ModelDownloads(store); }
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

    /** Admission is a conservative floor, not an estimate of every GGUF's KV
     * cache. Native allocation and Android memory-pressure callbacks remain
     * authoritative, and no smaller model is substituted on failure. */
    private void checkResources(long additionalBytes) {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(info);
        if (info.lowMemory || info.availMem < additionalBytes + info.threshold)
            throw new IllegalStateException("Not enough available memory. Choose a smaller model or conversation capacity.");
        if (Build.VERSION.SDK_INT >= 29) {
            PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (power.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE)
                throw new IllegalStateException("This device is too warm to run a model. Let it cool before trying again.");
        }
    }

    private interface StoreAction { NativeObject run() throws Exception; }
    private void storage(NativeCall call, StoreAction action) { storage(call, action, () -> {}); }
    private void storage(NativeCall call, StoreAction action, Runnable completion) {
        try { storageQueue.execute(() -> {
            NativeObject result = null;
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

    public void listModels(NativeCall call) { storage(call, () -> store.listModels()); }

    private synchronized boolean reserveDownloadAdmission() {
        if (backgrounded || releaseRequested || downloads == null) return false;
        return reserveModelMutation();
    }
    public void resolveModelSource(NativeCall call) {
        if (!reserveDownloadAdmission()) { call.reject("Open the app and finish the current operation before checking a model", "BUSY"); return; }
        try { synchronized(this) {
            if (backgrounded || destroyed) throw new IllegalStateException("Open the app to check a model source");
            downloads.resolveSource(call.getObject("source"), (source,error)->{
                releaseModelMutation();
                if(error!=null)call.reject(failureMessage(error));else call.resolve(new NativeObject().put("source",source));
            });
        }} catch(Exception error) {releaseModelMutation();call.reject(failureMessage(error));}
    }
    public void cancelModelSourceResolution(NativeCall call) {
        downloadAction(call, ()->{downloads.cancelSourceResolution();return new NativeObject();});
    }
    public void listModelDownloads(NativeCall call) { storage(call, ()->downloads.list()); }
    public void startModelDownload(NativeCall call) {
        if(!reserveDownloadAdmission()){call.reject("Finish the current operation before downloading a model", "BUSY");return;}
        storage(call, ()->{synchronized(this){
            if(backgrounded||destroyed)throw new IllegalStateException("Open the app to start a download");
            return downloads.start(call.getObject("source"),call.getString("name"));
        }},this::releaseModelMutation);
    }
    public void resumeModelDownload(NativeCall call) {
        if(!reserveDownloadAdmission()){call.reject("Finish the current operation before resuming a model", "BUSY");return;}
        storage(call, ()->{synchronized(this){
            if(backgrounded||destroyed)throw new IllegalStateException("Open the app to resume a download");
            return downloads.resume(call.getString("id"));
        }},this::releaseModelMutation);
    }
    private void downloadAction(NativeCall call,StoreAction action) {
        try{downloadControl.execute(()->{try{
            if(downloads==null)throw new IllegalStateException("Model storage is unavailable");
            call.resolve(action.run());
        }catch(Exception error){call.reject(failureMessage(error));}});}
        catch(RejectedExecutionException error){call.reject("The app is closing");}
    }
    public void cancelModelDownload(NativeCall call) {downloadAction(call,()->{downloads.cancel(call.getString("id"));return new NativeObject();});}
    public void removeModelDownload(NativeCall call) {downloadAction(call,()->{downloads.remove(call.getString("id"));return new NativeObject();});}

    private static NativeObject descriptor(String id, String name, String availability, String reason, int context, int output) {
        NativeObject capabilities = new NativeObject().put("text", true).put("tools", false)
            .put("structuredOutput", false).put("images", false).put("foregroundOnly", true);
        NativeObject result = new NativeObject().put("id", id).put("name", name).put("locality", "on-device")
            .put("availability", availability).put("contextTokens", context).put("maxOutputTokens", output)
            .put("capabilities", capabilities);
        if (reason != null) result.put("reason", reason.substring(0, Math.min(reason.length(), 1000)));
        return result;
    }

    private NativeObject providerPayload(String availability, String aiReason, int context) {
        String llamaReason = null;
        boolean inactive;
        synchronized (this) { inactive = destroyed || backgrounded; }
        if (inactive) llamaReason = "Open the app to use on-device AI";
        else if (engine == 0) llamaReason = "Native inference is not included in this build";
        else try {
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            if (store.listModels().getJSONArray("models").length() == 0) throw new IllegalStateException("No imported models");
        } catch (Exception error) { llamaReason = "Import a GGUF model first"; }
        if (inactive) { availability = "unavailable"; aiReason = llamaReason; }
        JSONArray providers = new JSONArray();
        providers.put(descriptor("llama-cpp", "Imported model", llamaReason == null ? "available" : "unavailable", llamaReason, 8192, 4096));
        providers.put(descriptor("android-mlkit", "Android on-device AI", availability, aiReason, context, MlKitPrompt.MAX_OUTPUT_TOKENS));
        return new NativeObject().put("providers", providers);
    }

    public void providers(NativeCall call) {
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

    public void cancelProviderPreparation(NativeCall call) {
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

    public void prepareProvider(NativeCall call) {
        if (!"android-mlkit".equals(call.getString("providerId"))) {
            call.reject("This provider cannot download a model. Import a GGUF model for llama.cpp."); return;
        }
        synchronized (this) {
            if (destroyed || backgrounded || activeId != null || modelMutation || releaseRequested) {
                call.reject("Open the app and finish the current operation first", "BUSY"); return;
            }
            modelMutation = true; preparing = true; preparationCancelled = false; mlkit.begin();
            inferenceQueue.execute(() -> {
                Throwable failure = null;
                List<NativeCall> waiting;
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
                for (NativeCall waiter : waiting) waiter.resolve();
            });
        }
    }

    public void removeModel(NativeCall call) {
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

    public synchronized boolean reserveModelMutation() {
        if (activeId != null || modelMutation || destroyed || backgrounded || releaseRequested) return false;
        modelMutation = true;
        return true;
    }
    public synchronized void releaseModelMutation() { modelMutation = false; }

    public void selectModel(NativeCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("Model ID is required"); return; }
        if (!reserveModelMutation()) { call.reject("Wait for the current conversation or import to finish", "BUSY"); return; }
        storage(call, () -> {
            return new NativeObject().put("model", store.selectModel(id));
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
    public void cancel(NativeCall call) {
        String id = call.getString("requestId");
        if (id == null) { call.reject("Request ID is required"); return; }
        synchronized (this) {
            if (!id.equals(activeId)) { call.resolve(); return; }
            cancelWaiters.add(call);
        }
        cancelActive(id);
    }

    public void generate(NativeCall call) {
        String requestId = call.getString("requestId");
        String providerId = call.getString("providerId", "llama-cpp");
        JSONArray messages = call.getArray("messages");
        String modelId = call.getString("modelId");
        for (String key : new String[]{"maxTokens", "contextSize"}) {
            if (call.contains(key) && call.getInt(key) == null) { call.reject("Token budgets must be integers", "INVALID_REQUEST"); return; }
        }
        int maxTokens = call.getInt("maxTokens", 1024);
        int contextSize = call.getInt("contextSize", 4096);
        try {
            if (!"llama-cpp".equals(providerId) && !"android-mlkit".equals(providerId)) throw new IllegalArgumentException("Unknown on-device provider");
            if ("android-mlkit".equals(providerId) && modelId != null && !providerId.equals(modelId)) {
                call.reject("The requested model is not available from Android on-device AI", "MODEL_UNAVAILABLE"); return;
            }
            if ("llama-cpp".equals(providerId) && (modelId == null || modelId.isEmpty())) throw new IllegalArgumentException("Choose a model for this conversation");
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
            if (bytes > 256 * 1024 || !roles[roles.length - 1].equals("user") || maxTokens < 1 || maxTokens > ("llama-cpp".equals(providerId) ? 4096 : MlKitPrompt.MAX_OUTPUT_TOKENS) || contextSize < 512 || contextSize > ("llama-cpp".equals(providerId) ? 8192 : MlKitPrompt.CONTEXT_TOKENS) || maxTokens + 128 >= contextSize) throw new IllegalArgumentException("Conversation or token budget is outside the supported range");
            synchronized (this) {
                if (destroyed || backgrounded) { call.reject("Reopen the app to start a conversation", "BACKGROUND"); return; }
                if (activeId != null || modelMutation || releaseRequested) { call.reject("Another conversation or memory cleanup is running", "BUSY"); return; }
                activeId = requestId; activeProvider = providerId; cancelled = false; mlkit.begin();
                inferenceQueue.execute(() -> runGeneration(call, requestId, modelId, roles, contents, maxTokens, contextSize));
            }
        } catch (Exception error) { call.reject(failureMessage(error)); }
    }

    private void runGeneration(NativeCall call, String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize) {
        StringBuilder text = new StringBuilder();
        ScheduledFuture<?> cancelTimer = null;
        NativeObject result = null;
        Throwable failure = null;
        List<NativeCall> waiting;
        try {
            cancelTimer = cancellationQueue.scheduleAtFixedRate(() -> {
                if (isCancelled(requestId)) cancelActive(requestId);
            }, 50, 50, TimeUnit.MILLISECONDS);
            result = performGeneration(requestId, modelId, roles, contents, maxTokens, contextSize, text);
        }
        catch (Exception | LinkageError | OutOfMemoryError error) {
            if (!(error instanceof OutOfMemoryError) && isCancelled(requestId)) result = new NativeObject().put("text", text.toString()).put("stopReason", "cancelled");
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
        for (NativeCall waiter : waiting) waiter.resolve();
    }

    private NativeObject performGeneration(String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize, StringBuilder text) throws Exception {
            if (isCancelled(requestId)) return new NativeObject().put("text", "").put("stopReason", "cancelled");
            if ("android-mlkit".equals(activeProvider)) {
                unloadLlama();
                checkResources(256L * 1024 * 1024);
                MlKitPrompt.Reply reply = mlkit.generate(roles, contents, maxTokens, contextSize, () -> isCancelled(requestId),
                    delta -> emitDelta(requestId, text, delta));
                return new NativeObject().put("text", reply.text).put("stopReason", reply.stopReason);
            }
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            String[] model = store.model(modelId);
            if (!model[0].equals(loadedId) || contextSize != loadedContext) {
                unloadLlama();
                checkResources(new java.io.File(model[1]).length() + 256L * 1024 * 1024 + (long) contextSize * 64 * 1024);
                long operation = nextOperation(requestId);
                if (operation == 0) return new NativeObject().put("text", "").put("stopReason", "cancelled");
                loadedId = null;
                LlamaRuntime.load(engine, model[1], operation, contextSize);
                loadedId = model[0]; loadedContext = contextSize;
            }
            long operation = nextOperation(requestId);
            if (operation == 0) return new NativeObject().put("text", "").put("stopReason", "cancelled");
            checkResources(64L * 1024 * 1024);
            int reason = LlamaRuntime.generate(engine, roles, contents, operation, maxTokens, utf8 -> {
                if (isCancelled(requestId)) return false;
                String delta = new String(utf8, StandardCharsets.UTF_8);
                emitDelta(requestId, text, delta);
                return !isCancelled(requestId);
            });
            return new NativeObject().put("text", text.toString()).put("stopReason", isCancelled(requestId) || reason == 3 ? "cancelled" : reason == 2 ? "length" : "stop");
    }

    private synchronized void emitDelta(String requestId, StringBuilder text, String delta) {
        if (isCancelled(requestId)) return;
        if (delta.length() > 64_000 - text.length()) throw new IllegalStateException("The model response exceeded the supported size");
        text.append(delta);
        notifyListeners("chatDelta", new NativeObject().put("requestId", requestId).put("delta", delta));
    }

    private void unloadLlama() {
        loadedId = null; loadedContext = 0;
        if (engine != 0) LlamaRuntime.unload(engine);
    }

    private void releaseForMemory() { requestRelease(null); }

    private void requestRelease(NativeCall call) {
        synchronized (this) {
            if (destroyed) { if (call != null) call.resolve(); return; }
            if (call != null) releaseWaiters.add(call);
            if (releaseRequested) return;
            releaseRequested = true;
        }
        cancelActive(null);
        mlkit.cancel();
        inferenceQueue.execute(() -> {
            Throwable failure = null;
            try { unloadLlama(); mlkit.close(); }
            catch (Exception | LinkageError | OutOfMemoryError error) { failure = error; }
            List<NativeCall> waiting;
            synchronized (this) {
                releaseRequested = false;
                waiting = new ArrayList<>(releaseWaiters); releaseWaiters.clear();
            }
            for (NativeCall waiter : waiting) {
                if (failure == null) waiter.resolve(); else waiter.reject(failureMessage(failure));
            }
        });
    }

    public void onBackground() {
        synchronized (this) { if (backgrounded || destroyed) return; backgrounded = true; }
        if(downloads!=null)downloads.requestPause();
        downloadControl.execute(()->{if(downloads!=null)downloads.suspend();});
        releaseForMemory();
        notifyListeners("appBackground", new NativeObject());
    }

    public void onForeground() {
        synchronized (this) { backgrounded = false; }
    }

    public void importModel(NativeCall call, Uri uri) {
        if (!reserveModelMutation()) { call.reject("Finish the current operation before importing", "BUSY"); return; }
        storage(call, () -> new NativeObject().put("model", store.importModel(context.getContentResolver(), uri)), this::releaseModelMutation);
    }
    public void releaseModel(NativeCall call) { requestRelease(call); }
}
