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
    /** One runtime serves every activity in the process, and a finishing
     * activity's onStop arrives after its replacement is already on screen.
     * Only the last started activity to stop backgrounds the runtime; a stale
     * stop cancelled the new activity's reply mid-stream (Galaxy S20 FE eval,
     * 2026-09-26). */
    private int startedActivities;
    // Written and read under `sizing`: the model listing runs on the storage
    // queue and fits windows against what the inference queue holds.
    private String loadedId;
    private String loadedPath;
    private int loadedContext;
    /** Serializes the bridge's dry-run sizing with model loads. */
    private final Object sizing = new Object();
    /** Allocated bytes per model file and window from the bridge's dry run, or
     * -1 when llama.cpp cannot load the file at that window. Imported files
     * never change in place, so an entry cannot go stale. */
    private final java.util.concurrent.ConcurrentHashMap<String, Long> allocations = new java.util.concurrent.ConcurrentHashMap<>();
    /** The bridge's own buffers beside llama.cpp's: the hybrid/windowed state
     * checkpoint (19 MiB for Qwen 3.5 2B), token vectors and the reply text. */
    private static final long BRIDGE_BUFFER_BYTES = 128L * 1024 * 1024;
    /** Windows offered above the 4K floor, largest first. Phones and small
     * desktops aim for 8K-16K; the floor is what the phone prompt was sized for. */
    private static final int[] CONTEXT_LADDER = {16384, 8192};
    private static final int FLOOR_CONTEXT = 4096;
    /** Room a larger window must leave beyond Android's low-memory threshold,
     * so the chosen window is not the one that barely fits. */
    private static final long LADDER_SPARE_BYTES = 256L * 1024 * 1024;

    /** Loading a model is itself what pushes a 6 GB phone into memory pressure:
     * lmkd kills background apps and every process hears RUNNING_CRITICAL.
     * Releasing then cancelled the load that caused it, so the user's first
     * reply died "interrupted" with no error (Galaxy S20 FE, 2026-09-26). A
     * foreground request rides out running-level pressure; an idle model or a
     * backgrounded app still gives its memory back. */
    private final ComponentCallbacks2 memory = new ComponentCallbacks2() {
        @Override public void onConfigurationChanged(Configuration configuration) {}
        @Override public void onLowMemory() { releaseIdleForMemory(); }
        @Override public void onTrimMemory(int level) {
            if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) releaseForMemory();
            else if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) releaseIdleForMemory();
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

    /**
     * A model's catalog sampling, resolved by the product runtime the same way
     * the desktop resolves it. Absent fields keep the bridge's defaults: greedy
     * decoding, top-k 40 / top-p 0.95 when sampling, no repetition penalty.
     */
    private static final class Sampling {
        final float temperature, topP, minP, repeatPenalty;
        final int topK, repeatLastN, seed;
        private Sampling(float temperature, int topK, float topP, float minP, float repeatPenalty, int repeatLastN, int seed) {
            this.temperature = temperature; this.topK = topK; this.topP = topP; this.minP = minP;
            this.repeatPenalty = repeatPenalty; this.repeatLastN = repeatLastN; this.seed = seed;
        }
        static Sampling from(JSONObject value) {
            // An unset seed varies per reply, so a retry is not the same text again.
            int seed = new java.util.Random().nextInt() & Integer.MAX_VALUE;
            if (value == null) return new Sampling(0f, 40, 0.95f, 0f, 1f, 64, seed);
            float temperature = (float) value.optDouble("temperature", 0);
            int topK = value.optInt("topK", 40);
            float topP = (float) value.optDouble("topP", 0.95);
            float minP = (float) value.optDouble("minP", 0);
            float repeatPenalty = (float) value.optDouble("repetitionPenalty", 1);
            int repeatLastN = value.optInt("repetitionContext", 64);
            if (value.has("seed")) seed = value.optInt("seed", seed) & Integer.MAX_VALUE;
            if (!(temperature >= 0 && temperature <= 2) || topK < 0 || topK > 1000 || !(topP > 0 && topP <= 1)
                || !(minP >= 0 && minP < 1) || !(repeatPenalty >= 1 && repeatPenalty <= 2) || repeatLastN < 0 || repeatLastN > 4096)
                throw new IllegalArgumentException("Sampling settings are outside the supported range");
            return new Sampling(temperature, topK, topP, minP, repeatPenalty, repeatLastN, seed);
        }
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
    private ActivityManager.MemoryInfo memoryInfo() {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(info);
        return info;
    }

    private void checkResources(long additionalBytes) {
        ActivityManager.MemoryInfo info = memoryInfo();
        if (info.lowMemory || info.availMem < additionalBytes + info.threshold)
            throw new IllegalStateException("Not enough available memory. Choose a smaller model or conversation capacity.");
        if (Build.VERSION.SDK_INT >= 29) {
            PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (power.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE)
                throw new IllegalStateException("This device is too warm to run a model. Let it cool before trying again.");
        }
    }

    /** How long a request waits for a hot phone to cool before it is refused. */
    private static final long COOLING_WAIT_MS = 10 * 60 * 1000;

    /** A hot phone refuses new work rather than heating further, but the next
     * request of a tool loop already underway waits the heat out instead of
     * failing the turn: the same work, delayed, is what the person asked for.
     * Bounded, so a phone that never cools still gets the clear refusal from
     * {@link #checkResources}. False when the request was cancelled meanwhile. */
    private boolean awaitCooling(String requestId) throws InterruptedException {
        if (Build.VERSION.SDK_INT < 29) return true;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(COOLING_WAIT_MS);
        boolean announced = false;
        while (power.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE) {
            if (isCancelled(requestId)) return false;
            if (System.nanoTime() >= deadline) return true;
            if (!announced) { emitPhase(requestId, "cooling"); announced = true; }
            Thread.sleep(2000);
        }
        return !isCancelled(requestId);
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

    public void listModels(NativeCall call) { storage(call, () -> withFittedContext(store.listModels())); }

    /** The window the phone can hold for the model it would run next, which the
     * product runtime uses unless the person chose one. Only the selected model
     * is sized, so a long library costs no dry runs. */
    private NativeObject withFittedContext(NativeObject library) throws Exception {
        String selected = library.optString("selectedModelId", null);
        if (selected == null) return library;
        org.json.JSONArray models = library.getJSONArray("models");
        for (int index = 0; index < models.length(); index++) {
            org.json.JSONObject model = models.getJSONObject(index);
            if (!selected.equals(model.getString("id"))) continue;
            Integer context = fitContext(selected, store.model(selected)[1]);
            if (context != null) model.put("contextTokens", context.intValue());
        }
        return library;
    }

    /**
     * Allocated bytes a load at this window takes from Android's available
     * memory, or -1 when llama.cpp cannot load the file at it. The bridge sizes
     * the weights as this CPU backend places them, repacked copies included;
     * the part served from the memory-mapped file is reclaimable cache in
     * availMem, so it is not charged.
     */
    private long allocation(String path, int contextSize) {
        String key = path + '\n' + new java.io.File(path).length() + '\n' + contextSize;
        Long known = allocations.get(key);
        if (known != null) return known;
        long bytes;
        try {
            long[] estimate;
            synchronized (sizing) { estimate = LlamaRuntime.estimate(engine, path, contextSize); }
            bytes = estimate[0] - estimate[1] + estimate[2] + estimate[3] + BRIDGE_BUFFER_BYTES;
        } catch (IllegalStateException error) { bytes = -1; }
        allocations.put(key, bytes);
        return bytes;
    }

    /** Admission charge. A file the dry run cannot size keeps the old flat floor
     * (weights, 256 MiB, 64 KiB per token); its load then reports the real error. */
    private long requiredBytes(String path, int contextSize) {
        long bytes = engine == 0 ? -1 : allocation(path, contextSize);
        return bytes >= 0 ? bytes : new java.io.File(path).length() + 256L * 1024 * 1024 + (long) contextSize * 64 * 1024;
    }

    /**
     * 16K or 8K when this phone can hold that window with room to spare, else
     * the 4K floor, which admission still checks. A loaded model keeps its
     * window, so a listing never makes the next turn reload it; memory another
     * loaded model holds counts as free, since loading this one releases it.
     */
    private Integer fitContext(String id, String path) {
        if (engine == 0) return null;
        String heldId, heldPath;
        int heldContext;
        synchronized (sizing) { heldId = loadedId; heldPath = loadedPath; heldContext = loadedContext; }
        if (id.equals(heldId)) return heldContext;
        ActivityManager.MemoryInfo info = memoryInfo();
        long available = info.availMem - info.threshold;
        if (heldId != null) available += Math.max(0, allocation(heldPath, heldContext));
        int chosen = FLOOR_CONTEXT;
        for (int context : CONTEXT_LADDER) {
            long bytes = allocation(path, context);
            if (bytes >= 0 && bytes + LADDER_SPARE_BYTES <= available) { chosen = context; break; }
        }
        // Field evidence for the fit, once per change: the listing is read at
        // every turn start, several times a second while a turn is set up.
        String decision = id + ':' + chosen;
        if (!decision.equals(lastFit)) {
            lastFit = decision;
            android.util.Log.i("GezelRuntime", "Context window " + chosen + " for " + id + ": needs " +
                mib(allocation(path, 16384)) + " MiB at 16K, " + mib(allocation(path, 8192)) + " at 8K, " +
                mib(allocation(path, FLOOR_CONTEXT)) + " at 4K; " + mib(available) + " MiB available");
        }
        return chosen;
    }

    private volatile String lastFit;

    private static long mib(long bytes) { return bytes < 0 ? -1 : bytes / (1024 * 1024); }

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
        NativeObject llama = descriptor("llama-cpp", "Imported model", llamaReason == null ? "available" : "unavailable", llamaReason, 16384, 4096);
        // Structured chat: llama.cpp's own chat layer, as desktop's llama-server runs it.
        try { llama.getJSONObject("capabilities").put("structuredChat", true); } catch (org.json.JSONException ignored) {}
        providers.put(llama);
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
                    // ML Kit reports a Play Store stub of AICore (a new Galaxy S26,
                    // 2026-09-26) exactly like an unsupported phone.
                    default: reason = "Android's on-device AI is unavailable. On supported phones, update AICore in the Play Store and try again.";
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
        final Sampling sampling;
        try { sampling = Sampling.from(call.getObject("sampling")); }
        catch (IllegalArgumentException error) { call.reject(error.getMessage(), "INVALID_REQUEST"); return; }
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
            if (bytes > 256 * 1024 || !roles[roles.length - 1].equals("user") || maxTokens < 1 || maxTokens > ("llama-cpp".equals(providerId) ? 4096 : MlKitPrompt.MAX_OUTPUT_TOKENS) || contextSize < 512 || contextSize > ("llama-cpp".equals(providerId) ? 16384 : MlKitPrompt.CONTEXT_TOKENS) || maxTokens + 128 >= contextSize) throw new IllegalArgumentException("Conversation or token budget is outside the supported range");
            synchronized (this) {
                if (destroyed || backgrounded) { call.reject("Reopen the app to start a conversation", "BACKGROUND"); return; }
                if (activeId != null || modelMutation || releaseRequested) { call.reject("Another conversation or memory cleanup is running", "BUSY"); return; }
                activeId = requestId; activeProvider = providerId; cancelled = false; mlkit.begin();
                inferenceQueue.execute(() -> runGeneration(call, requestId, modelId, roles, contents, maxTokens, contextSize, sampling));
            }
        } catch (Exception error) { call.reject(failureMessage(error)); }
    }

    private void runGeneration(NativeCall call, String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize, Sampling sampling) {
        StringBuilder text = new StringBuilder();
        ScheduledFuture<?> cancelTimer = null;
        NativeObject result = null;
        Throwable failure = null;
        List<NativeCall> waiting;
        try {
            final long[] lastProgress = {-1, -1};
            final int[] ticks = {0};
            cancelTimer = cancellationQueue.scheduleAtFixedRate(() -> {
                if (isCancelled(requestId)) { cancelActive(requestId); return; }
                // Every fifth tick (~250 ms) is plenty for a status pill.
                if (++ticks[0] % 5 == 0) reportProgress(requestId, lastProgress);
            }, 50, 50, TimeUnit.MILLISECONDS);
            result = performGeneration(requestId, modelId, roles, contents, maxTokens, contextSize, sampling, text);
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

    private NativeObject performGeneration(String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize, Sampling sampling, StringBuilder text) throws Exception {
            if (isCancelled(requestId)) return new NativeObject().put("text", "").put("stopReason", "cancelled");
            if ("android-mlkit".equals(activeProvider)) {
                unloadLlama();
                if (!awaitCooling(requestId)) return new NativeObject().put("text", "").put("stopReason", "cancelled");
                checkResources(256L * 1024 * 1024);
                emitPhase(requestId, "prefill");
                MlKitPrompt.Reply reply = mlkit.generate(roles, contents, maxTokens, contextSize, () -> isCancelled(requestId),
                    delta -> emitDelta(requestId, text, delta));
                return new NativeObject().put("text", reply.text).put("stopReason", reply.stopReason);
            }
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            String[] model = store.model(modelId);
            if (!model[0].equals(loadedId) || contextSize != loadedContext) {
                unloadLlama();
                if (!awaitCooling(requestId)) return new NativeObject().put("text", "").put("stopReason", "cancelled");
                checkResources(requiredBytes(model[1], contextSize));
                long operation = nextOperation(requestId);
                if (operation == 0) return new NativeObject().put("text", "").put("stopReason", "cancelled");
                emitPhase(requestId, "loading_model");
                synchronized (sizing) {
                    LlamaRuntime.load(engine, model[1], operation, contextSize);
                    loadedId = model[0]; loadedPath = model[1]; loadedContext = contextSize;
                }
            }
            if (!awaitCooling(requestId)) return new NativeObject().put("text", "").put("stopReason", "cancelled");
            long operation = nextOperation(requestId);
            if (operation == 0) return new NativeObject().put("text", "").put("stopReason", "cancelled");
            checkResources(64L * 1024 * 1024);
            emitPhase(requestId, "prefill");
            int reason = LlamaRuntime.generate(engine, roles, contents, operation, maxTokens,
                sampling.temperature, sampling.topK, sampling.topP, sampling.minP, sampling.repeatPenalty,
                sampling.repeatLastN, sampling.seed, utf8 -> {
                if (isCancelled(requestId)) return false;
                String delta = new String(utf8, StandardCharsets.UTF_8);
                emitDelta(requestId, text, delta);
                return !isCancelled(requestId);
            });
            return new NativeObject().put("text", text.toString()).put("stopReason", isCancelled(requestId) || reason == 3 ? "cancelled" : reason == 2 ? "length" : "stop");
    }

    /**
     * An OpenAI-shaped chat request for an imported llama.cpp model, served by
     * llama.cpp's own chat layer exactly as desktop's llama-server serves it:
     * the model's template renders the tools and its parser returns structured
     * tool calls. Every object llama-server would stream reaches JavaScript as a
     * `chatChunk` event (batched, in order), including its error body.
     */
    public void chat(NativeCall call) {
        String requestId = call.getString("requestId");
        String modelId = call.getString("modelId");
        JSONObject request = call.getObject("request");
        JSONObject chatConfig = call.getObject("chatConfig");
        if (call.contains("contextSize") && call.getInt("contextSize") == null) { call.reject("Token budgets must be integers", "INVALID_REQUEST"); return; }
        int contextSize = call.getInt("contextSize", 4096);
        try {
            if (engine == 0) throw new IllegalStateException(initializationError == null ? "Native engine unavailable" : initializationError);
            if (modelId == null || modelId.isEmpty()) throw new IllegalArgumentException("Choose a model for this conversation");
            if (requestId == null || requestId.isEmpty() || requestId.getBytes(StandardCharsets.UTF_8).length > 128 || request == null)
                throw new IllegalArgumentException("A request ID and chat request are required");
            if (contextSize < 512 || contextSize > 16384) throw new IllegalArgumentException("Context size is outside the supported range");
            String body = request.toString();
            if (body.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) throw new IllegalArgumentException("Chat request is too large");
            String config = chatConfig == null ? "{}" : chatConfig.toString();
            synchronized (this) {
                if (destroyed || backgrounded) { call.reject("Reopen the app to start a conversation", "BACKGROUND"); return; }
                if (activeId != null || modelMutation || releaseRequested) { call.reject("Another conversation or memory cleanup is running", "BUSY"); return; }
                activeId = requestId; activeProvider = "llama-cpp"; cancelled = false;
                inferenceQueue.execute(() -> runChat(call, requestId, modelId, contextSize, body, config));
            }
        } catch (Exception error) { call.reject(failureMessage(error)); }
    }

    private String appliedChatConfig;

    private void runChat(NativeCall call, String requestId, String modelId, int contextSize, String body, String config) {
        ScheduledFuture<?> cancelTimer = null;
        NativeObject result = null;
        Throwable failure = null;
        List<NativeCall> waiting;
        ChatBatch batch = new ChatBatch(requestId);
        try {
            final long[] lastProgress = {-1, -1};
            final int[] ticks = {0};
            cancelTimer = cancellationQueue.scheduleAtFixedRate(() -> {
                if (isCancelled(requestId)) { cancelActive(requestId); return; }
                if (++ticks[0] % 5 == 0) reportProgress(requestId, lastProgress);
            }, 50, 50, TimeUnit.MILLISECONDS);
            result = performChat(requestId, modelId, contextSize, body, config, batch);
        }
        catch (Exception | LinkageError | OutOfMemoryError error) {
            if (!(error instanceof OutOfMemoryError) && isCancelled(requestId)) result = new NativeObject().put("status", "cancelled");
            else failure = error;
        }
        finally {
            if (cancelTimer != null) cancelTimer.cancel(false);
            batch.flush();
            try {
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

    private NativeObject performChat(String requestId, String modelId, int contextSize, String body, String config, ChatBatch batch) throws Exception {
        if (isCancelled(requestId)) return new NativeObject().put("status", "cancelled");
        if (store == null) throw new IllegalStateException("Model storage is unavailable");
        String[] model = store.model(modelId);
        if (!model[0].equals(loadedId) || contextSize != loadedContext) {
            unloadLlama();
            appliedChatConfig = null;
            if (!awaitCooling(requestId)) return new NativeObject().put("status", "cancelled");
            checkResources(requiredBytes(model[1], contextSize));
            long operation = nextOperation(requestId);
            if (operation == 0) return new NativeObject().put("status", "cancelled");
            emitPhase(requestId, "loading_model");
            synchronized (sizing) {
                LlamaRuntime.load(engine, model[1], operation, contextSize);
                loadedId = model[0]; loadedPath = model[1]; loadedContext = contextSize;
            }
        }
        if (!config.equals(appliedChatConfig)) {
            LlamaRuntime.configureChat(engine, config);
            appliedChatConfig = config;
        }
        if (!awaitCooling(requestId)) return new NativeObject().put("status", "cancelled");
        long operation = nextOperation(requestId);
        if (operation == 0) return new NativeObject().put("status", "cancelled");
        checkResources(64L * 1024 * 1024);
        emitPhase(requestId, "prefill");
        final boolean[] generating = {false};
        int status = LlamaRuntime.chat(engine, body, operation, 600_000, utf8 -> {
            if (isCancelled(requestId)) return false;
            if (!generating[0]) { generating[0] = true; emitPhase(requestId, "generating"); }
            batch.add(new String(utf8, StandardCharsets.UTF_8));
            return !isCancelled(requestId);
        });
        String outcome = status == LlamaRuntime.STATUS_OK ? "ok" : isCancelled(requestId) || status == LlamaRuntime.STATUS_CANCELLED
            ? "cancelled" : status == LlamaRuntime.STATUS_TIMEOUT ? "timeout" : "error";
        return new NativeObject().put("status", outcome);
    }

    /**
     * Chunks travel to JavaScript in small batches: one bridge event per token
     * costs more than the token, and the order must hold. Flushed about every
     * 24 ms while tokens stream, and once more when the request ends.
     */
    private final class ChatBatch {
        private final String requestId;
        private final JSONArray pending = new JSONArray();
        private long flushedAt = System.nanoTime();
        ChatBatch(String requestId) { this.requestId = requestId; }
        synchronized void add(String chunk) {
            pending.put(chunk);
            if (System.nanoTime() - flushedAt >= 24_000_000L) flush();
        }
        synchronized void flush() {
            flushedAt = System.nanoTime();
            if (pending.length() == 0) return;
            JSONArray chunks = new JSONArray();
            for (int index = 0; index < pending.length(); index++) chunks.put(pending.opt(index));
            while (pending.length() > 0) pending.remove(0);
            notifyListeners("chatChunk", new NativeObject().put("requestId", requestId).put("chunks", chunks));
        }
    }

    private synchronized void emitDelta(String requestId, StringBuilder text, String delta) {
        if (isCancelled(requestId)) return;
        if (delta.length() > 64_000 - text.length()) throw new IllegalStateException("The model response exceeded the supported size");
        // The first chunk is when decoding began; say so before it arrives.
        if (text.length() == 0) emitPhase(requestId, "generating");
        text.append(delta);
        notifyListeners("chatDelta", new NativeObject().put("requestId", requestId).put("delta", delta));
    }

    /**
     * Model-loading and prompt-processing progress for the status pill, polled
     * from the cancellation timer. Reports only changes, and nothing at all
     * from a native library too old to have the counters.
     */
    private void reportProgress(String requestId, long[] last) {
        long handle = engine;
        if ("android-mlkit".equals(activeProvider) || handle == 0) return;
        long[] progress;
        try { progress = LlamaRuntime.progress(handle); }
        catch (LinkageError error) { return; }
        if (progress == null || progress.length < 6) return;
        long phase = progress[0];
        long value = phase == 1 ? progress[1] : phase == 2 ? progress[3] : -1;
        if (value < 0 || (phase == last[0] && value == last[1])) return;
        last[0] = phase;
        last[1] = value;
        NativeObject event = new NativeObject().put("requestId", requestId);
        if (phase == 1) {
            event.put("phase", "loading_model").put("progress", Math.min(1.0, progress[1] / 1000.0));
        } else {
            long prompt = progress[2];
            event.put("phase", "prefill").put("promptTokens", prompt)
                .put("processedTokens", progress[3]).put("reusedTokens", progress[4]);
            if (prompt > 0) event.put("progress", Math.min(1.0, progress[3] / (double) prompt));
        }
        if (!isCancelled(requestId)) notifyListeners("enginePhase", event);
    }

    /** Engine phase for the status pill, on the inference thread so it stays ordered with chatDelta. */
    private void emitPhase(String requestId, String phase) {
        if (isCancelled(requestId)) return;
        notifyListeners("enginePhase", new NativeObject().put("requestId", requestId).put("phase", phase));
    }

    private void unloadLlama() {
        synchronized (sizing) { loadedId = null; loadedPath = null; loadedContext = 0; }
        if (engine != 0) LlamaRuntime.unload(engine);
    }

    private void releaseForMemory() { requestRelease(null); }

    private void releaseIdleForMemory() {
        synchronized (this) { if (activeId != null || modelMutation) return; }
        requestRelease(null);
    }

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
        synchronized (this) {
            if (startedActivities > 0) startedActivities--;
            if (startedActivities > 0 || backgrounded || destroyed) return;
            backgrounded = true;
        }
        if(downloads!=null)downloads.requestPause();
        downloadControl.execute(()->{if(downloads!=null)downloads.suspend();});
        releaseForMemory();
        notifyListeners("appBackground", new NativeObject());
    }

    public void onForeground() {
        synchronized (this) { startedActivities++; backgrounded = false; }
    }

    public void importModel(NativeCall call, Uri uri) {
        if (!reserveModelMutation()) { call.reject("Finish the current operation before importing", "BUSY"); return; }
        storage(call, () -> new NativeObject().put("model", store.importModel(context.getContentResolver(), uri)), this::releaseModelMutation);
    }
    public void releaseModel(NativeCall call) { requestRelease(call); }
}
