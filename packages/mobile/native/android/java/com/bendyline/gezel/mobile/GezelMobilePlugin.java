package com.bendyline.gezel.mobile;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
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
    private final ExecutorService downloadControl = Executors.newSingleThreadExecutor();
    private ModelDownloads downloads;
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
        try { store = new MobileStore(getContext().getFilesDir()); downloads = new ModelDownloads(store); }
        catch (Exception error) { initializationError = error.getMessage(); }
        try { engine = LlamaRuntime.create(); }
        catch (LinkageError error) { initializationError = "Native inference is not included in this build"; }
    }

    private PreviewSnapshots previews() { return ((MainActivity) getActivity()).previewSnapshots; }
    @PluginMethod public void previewAvailability(PluginCall call) { JSObject result = new JSObject(); result.put("available", previews().available); call.resolve(result); }
    @PluginMethod public void publishHtmlPreview(PluginCall call) {
        try { call.resolve(previews().publish(call.getString("html"))); } catch (Exception error) { call.reject(error.getMessage()); }
    }
    @PluginMethod public void removeHtmlPreview(PluginCall call) { previews().remove(call.getString("id")); call.resolve(); }

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

    @PluginMethod public void readProductFile(PluginCall call) { storage(call, () -> {
        byte[] data = store.productFiles.read(call.getString("path"));
        return new JSObject().put("data", data == null ? JSONObject.NULL : android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP));
    }); }
    @PluginMethod public void writeProductFile(PluginCall call) {
        String encoded = call.getString("data");
        if (encoded == null || encoded.length() > ((ProductFiles.MAX_FILE + 2) / 3) * 4) { call.reject("A valid base64 product file up to 16 MiB is required"); return; }
        storage(call, () -> {
            byte[] data = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
            if (!android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP).equals(encoded)) throw new IllegalArgumentException("Invalid base64 file");
            store.productFiles.write(call.getString("path"), data); return new JSObject();
        });
    }
    @PluginMethod public void listProductFiles(PluginCall call) { storage(call, () -> {
        JSArray entries = new JSArray();
        for (ProductFiles.Entry entry : store.productFiles.list(call.getString("path")))
            entries.put(new JSObject().put("name", entry.name).put("isDirectory", entry.isDirectory).put("size", entry.size).put("mtime", entry.mtime));
        return new JSObject().put("entries", entries);
    }); }
    @PluginMethod public void mkdirProductDirectory(PluginCall call) { storage(call, () -> { store.productFiles.mkdir(call.getString("path")); return new JSObject(); }); }
    @PluginMethod public void removeProductPath(PluginCall call) { storage(call, () -> { store.productFiles.remove(call.getString("path")); return new JSObject(); }); }
    @PluginMethod public void renameProductPath(PluginCall call) { storage(call, () -> { store.productFiles.rename(call.getString("from"), call.getString("to")); return new JSObject(); }); }

    @PluginMethod public void listModels(PluginCall call) { storage(call, () -> store.listModels()); }

    private synchronized boolean reserveDownloadAdmission() {
        if (backgrounded || releaseRequested || downloads == null) return false;
        return reserveModelMutation();
    }
    @PluginMethod public void resolveModelSource(PluginCall call) {
        if (!reserveDownloadAdmission()) { call.reject("Open Gezel and finish the current operation before checking a model", "BUSY"); return; }
        try { synchronized(this) {
            if (backgrounded || destroyed) throw new IllegalStateException("Open Gezel to check a model source");
            downloads.resolveSource(call.getObject("source"), (source,error)->{
                releaseModelMutation();
                if(error!=null)call.reject(failureMessage(error));else call.resolve(new JSObject().put("source",source));
            });
        }} catch(Exception error) {releaseModelMutation();call.reject(failureMessage(error));}
    }
    @PluginMethod public void cancelModelSourceResolution(PluginCall call) {
        downloadAction(call, ()->{downloads.cancelSourceResolution();return new JSObject();});
    }
    @PluginMethod public void listModelDownloads(PluginCall call) { storage(call, ()->downloads.list()); }
    @PluginMethod public void startModelDownload(PluginCall call) {
        if(!reserveDownloadAdmission()){call.reject("Finish the current operation before downloading a model", "BUSY");return;}
        storage(call, ()->{synchronized(this){
            if(backgrounded||destroyed)throw new IllegalStateException("Open Gezel to start a download");
            return downloads.start(call.getObject("source"),call.getString("name"));
        }},this::releaseModelMutation);
    }
    @PluginMethod public void resumeModelDownload(PluginCall call) {
        if(!reserveDownloadAdmission()){call.reject("Finish the current operation before resuming a model", "BUSY");return;}
        storage(call, ()->{synchronized(this){
            if(backgrounded||destroyed)throw new IllegalStateException("Open Gezel to resume a download");
            return downloads.resume(call.getString("id"));
        }},this::releaseModelMutation);
    }
    private void downloadAction(PluginCall call,StoreAction action) {
        try{downloadControl.execute(()->{try{
            if(downloads==null)throw new IllegalStateException("Model storage is unavailable");
            call.resolve(action.run());
        }catch(Exception error){call.reject(failureMessage(error));}});}
        catch(RejectedExecutionException error){call.reject("The app is closing");}
    }
    @PluginMethod public void cancelModelDownload(PluginCall call) {downloadAction(call,()->{downloads.cancel(call.getString("id"));return new JSObject();});}
    @PluginMethod public void removeModelDownload(PluginCall call) {downloadAction(call,()->{downloads.remove(call.getString("id"));return new JSObject();});}

    private static JSObject descriptor(String id, String name, String availability, String reason, int context, int output) {
        JSObject capabilities = new JSObject().put("text", true).put("tools", false)
            .put("structuredOutput", false).put("images", false).put("foregroundOnly", true);
        JSObject result = new JSObject().put("id", id).put("name", name).put("locality", "on-device")
            .put("availability", availability).put("contextTokens", context).put("maxOutputTokens", output)
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
            if (store.listModels().getJSONArray("models").length() == 0) throw new IllegalStateException("No imported models");
        } catch (Exception error) { llamaReason = "Import a GGUF model first"; }
        if (inactive) { availability = "unavailable"; aiReason = llamaReason; }
        JSArray providers = new JSArray();
        providers.put(descriptor("llama-cpp", "Imported model", llamaReason == null ? "available" : "unavailable", llamaReason, 8192, 4096));
        providers.put(descriptor("android-mlkit", "Android on-device AI", availability, aiReason, context, MlKitPrompt.MAX_OUTPUT_TOKENS));
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

    private java.io.File exportFile;
    private String exportToken, exportMime;
    private long exportExpected;
    private boolean exportSaving;

    @PluginMethod public void beginExport(PluginCall call) {
        String name = call.getString("name"), mime = call.getString("mimeType");
        Integer size = call.getInt("sizeBytes");
        if (name == null || !name.matches("[a-zA-Z0-9][a-zA-Z0-9._ -]{0,150}") || !name.endsWith(".zip") || !"application/zip".equals(mime) || size == null || size < 1 || size > 72 * 1024 * 1024) {
            call.reject("Invalid ZIP export or archive exceeds 72 MiB"); return;
        }
        if (store == null) { call.reject("Storage is unavailable"); return; }
        if (!reserveModelMutation()) { call.reject("Finish the current operation before exporting", "BUSY"); return; }
        storage(call, () -> {
            try {
                if (exportFile != null) throw new IllegalStateException("An export is already open");
                java.io.File folder = new java.io.File(getContext().getCacheDir(), "gezel-export");
                if (!folder.isDirectory() && !folder.mkdirs()) throw new java.io.IOException("Cannot create export staging folder");
                java.io.File[] leftovers = folder.listFiles();
                if (leftovers != null) for (java.io.File leftover : leftovers) java.nio.file.Files.deleteIfExists(leftover.toPath());
                if (folder.getUsableSpace() < size + 64L * 1024 * 1024) throw new java.io.IOException("Not enough storage for this export");
                exportFile = new java.io.File(folder, name);
                if (!exportFile.createNewFile()) throw new java.io.IOException("Cannot stage export");
                exportToken = java.util.UUID.randomUUID().toString(); exportExpected = size; exportMime = mime;
                return new JSObject().put("token", exportToken);
            } catch (Exception error) { clearExport(); throw error; }
        });
    }
    private void requireExport(String token) {
        if (exportFile == null || token == null || !token.equals(exportToken)) throw new IllegalArgumentException("Export expired or unavailable");
    }
    private void clearExport() {
        if (exportFile != null) exportFile.delete();
        exportFile = null; exportToken = null; exportExpected = 0; exportMime = null; exportSaving = false;
        releaseModelMutation();
    }
    @PluginMethod public void appendExport(PluginCall call) { storage(call, () -> {
        requireExport(call.getString("token"));
        if (exportSaving) throw new IllegalStateException("Export is already being saved");
        String encoded = call.getString("data"); Integer offset = call.getInt("offset");
        if (encoded == null || encoded.length() > 349528 || offset == null || offset != exportFile.length()) throw new IllegalArgumentException("Invalid export chunk position or size");
        byte[] bytes = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
        if (bytes.length > 256 * 1024 || exportFile.length() + bytes.length > exportExpected || !android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP).equals(encoded)) throw new IllegalArgumentException("Invalid export chunk");
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(exportFile, true)) { output.write(bytes); output.getFD().sync(); }
        return new JSObject();
    }); }
    @PluginMethod public void cancelExport(PluginCall call) { storage(call, () -> {
        if (exportToken != null && exportToken.equals(call.getString("token"))) clearExport();
        return new JSObject();
    }); }
    @PluginMethod public void saveExport(PluginCall call) {
        storageQueue.execute(() -> {
            try {
                requireExport(call.getString("token"));
                if (exportSaving) throw new IllegalStateException("Export is already being saved");
                if (exportFile.length() != exportExpected) throw new IllegalStateException("Export is incomplete");
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.setType(exportMime); intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_TITLE, exportFile.getName());
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                exportSaving = true;
                getActivity().runOnUiThread(() -> {
                    try { startActivityForResult(call, intent, "exportPicked"); }
                    catch (Exception error) { storageQueue.execute(this::clearExport); call.reject("Document picker unavailable", error); }
                });
            } catch (Exception error) { call.reject(failureMessage(error)); }
        });
    }
    @ActivityCallback private void exportPicked(PluginCall call, ActivityResult result) {
        if (call == null) { storageQueue.execute(this::clearExport); return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            storageQueue.execute(this::clearExport); call.reject("Export cancelled", "CANCELLED"); return;
        }
        storage(call, () -> {
            requireExport(call.getString("token"));
            try (java.io.InputStream input = new java.io.FileInputStream(exportFile);
                 java.io.OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new java.io.IOException("Export destination is unavailable");
                byte[] chunk = new byte[64 * 1024]; int count;
                while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count);
                output.flush();
            }
            return new JSObject();
        }, this::clearExport);
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
        String modelId = call.getString("modelId");
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

    private void runGeneration(PluginCall call, String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize) {
        StringBuilder text = new StringBuilder();
        ScheduledFuture<?> cancelTimer = null;
        JSObject result = null;
        Throwable failure = null;
        List<PluginCall> waiting;
        try {
            cancelTimer = cancellationQueue.scheduleAtFixedRate(() -> {
                if (isCancelled(requestId)) cancelActive(requestId);
            }, 50, 50, TimeUnit.MILLISECONDS);
            result = performGeneration(requestId, modelId, roles, contents, maxTokens, contextSize, text);
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

    private JSObject performGeneration(String requestId, String modelId, String[] roles, String[] contents, int maxTokens, int contextSize, StringBuilder text) throws Exception {
            if (isCancelled(requestId)) return new JSObject().put("text", "").put("stopReason", "cancelled");
            if ("android-mlkit".equals(activeProvider)) {
                unloadLlama();
                checkResources(256L * 1024 * 1024);
                MlKitPrompt.Reply reply = mlkit.generate(roles, contents, maxTokens, contextSize, () -> isCancelled(requestId),
                    delta -> emitDelta(requestId, text, delta));
                return new JSObject().put("text", reply.text).put("stopReason", reply.stopReason);
            }
            if (store == null) throw new IllegalStateException("Model storage is unavailable");
            String[] model = store.model(modelId);
            if (!model[0].equals(loadedId) || contextSize != loadedContext) {
                unloadLlama();
                checkResources(new java.io.File(model[1]).length() + 256L * 1024 * 1024 + (long) contextSize * 64 * 1024);
                long operation = nextOperation(requestId);
                if (operation == 0) return new JSObject().put("text", "").put("stopReason", "cancelled");
                loadedId = null;
                LlamaRuntime.load(engine, model[1], operation, contextSize);
                loadedId = model[0]; loadedContext = contextSize;
            }
            long operation = nextOperation(requestId);
            if (operation == 0) return new JSObject().put("text", "").put("stopReason", "cancelled");
            checkResources(64L * 1024 * 1024);
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
        if(downloads!=null)downloads.requestPause();
        downloadControl.execute(()->{if(downloads!=null)downloads.suspend();});
        releaseForMemory();
        notifyListeners("appBackground", new JSObject());
    }

    @Override protected void handleOnResume() {
        synchronized (this) { backgrounded = false; }
    }

    @Override protected void handleOnDestroy() {
        synchronized (this) { if (destroyed) return; destroyed = true; }
        if(downloads!=null)downloads.requestPause();
        downloadControl.execute(()->{if(downloads!=null)downloads.close();}); downloadControl.shutdown();
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
