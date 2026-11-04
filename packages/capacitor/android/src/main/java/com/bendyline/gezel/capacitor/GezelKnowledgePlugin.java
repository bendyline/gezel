package com.bendyline.gezel.capacitor;

import com.bendyline.gezel.speech.SpeechRuntime;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Knowledge catalog archives on the device. Each catalog is one verified
 * `.gezk` download that the WebView's reader opens in place, in byte ranges
 * served by {@link KnowledgeFiles}; nothing is extracted. JavaScript chooses
 * catalogs from its pinned snapshot; this plugin only stores what it is given.
 * Each catalog's query model downloads into the same store and runs on the
 * speech runtime's ONNX Runtime ({@link #embed}).
 */
@CapacitorPlugin(name = "GezelKnowledge")
public final class GezelKnowledgePlugin extends Plugin {
    /** A sanity bound; the store refuses any download the device has no room for. */
    private static final long MAX_ARCHIVE = 32L << 30;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final ExecutorService encoder = Executors.newSingleThreadExecutor();
    private SpeechModels store;
    private long engine;
    private String downloading;
    private boolean paused;

    @Override public void load() { store = new SpeechModels(KnowledgeFiles.root(getContext()), MAX_ARCHIVE); }

    @PluginMethod public void info(PluginCall call) {
        try {
            JSObject result = new JSObject().put("baseUrl", "https://localhost" + KnowledgeFiles.PREFIX.substring(0, KnowledgeFiles.PREFIX.length() - 1)).put("catalogs", store.list());
            synchronized (this) { if (downloading != null) result.put("downloading", downloading); }
            call.resolve(result);
        } catch (Exception error) { call.reject("Knowledge catalogs could not be read", "failed"); }
    }

    @PluginMethod public void install(PluginCall call) {
        String id;
        try { id = SpeechModels.id(call.getString("id")); }
        catch (Exception invalid) { call.reject("Invalid knowledge catalog", "invalid-input"); return; }
        JSONArray files;
        try {
            files = new JSONArray().put(new JSONObject().put("name", call.getString("version") + "/catalog.gezk")
                .put("url", call.getString("url")).put("sha256", call.getString("sha256")).put("size", call.getData().getLong("size")));
        } catch (Exception invalid) { call.reject("Invalid knowledge catalog", "invalid-input"); return; }
        synchronized (this) {
            if (downloading != null) { call.reject("Another catalog is downloading", "busy"); return; }
            downloading = id; paused = false;
        }
        downloads.execute(() -> {
            try {
                store.install(id, files, (received, total) -> notifyListeners("knowledgeDownload",
                    new JSObject().put("id", id).put("receivedBytes", received).put("totalBytes", total)));
                // One version per catalog: a verified update replaces the archive it supersedes.
                // Pruning only now keeps an interrupted download's partial file for resuming.
                java.io.File[] versions = new java.io.File(store.root(), id).listFiles(java.io.File::isDirectory);
                if (versions != null) for (java.io.File version : versions)
                    if (!version.getName().equals(call.getString("version"))) delete(version);
                call.resolve(new JSObject().put("id", id));
            } catch (CancellationException cancelled) {
                boolean wasPaused; synchronized (this) { wasPaused = paused; }
                call.reject(wasPaused ? "Download paused when the app left the foreground" : "Download cancelled", wasPaused ? "paused" : "cancelled");
            } catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "The catalog could not be saved" : error.getMessage(), "failed"); }
            finally { synchronized (this) { downloading = null; } }
        });
    }

    private static void delete(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) for (java.io.File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** A catalog profile's query model, verified file by file like a catalog. */
    @PluginMethod public void installModel(PluginCall call) {
        String id;
        try { id = SpeechModels.id(call.getString("id")); }
        catch (Exception invalid) { call.reject("Invalid query model", "invalid-input"); return; }
        JSONArray files = call.getArray("files");
        synchronized (this) {
            if (downloading != null) { call.reject("Another download is running", "busy"); return; }
            downloading = id; paused = false;
        }
        downloads.execute(() -> {
            try {
                store.install(id, files, (received, total) -> notifyListeners("knowledgeDownload",
                    new JSObject().put("id", id).put("receivedBytes", received).put("totalBytes", total)));
                call.resolve(new JSObject().put("id", id));
            } catch (CancellationException cancelled) {
                boolean wasPaused; synchronized (this) { wasPaused = paused; }
                call.reject(wasPaused ? "Download paused when the app left the foreground" : "Download cancelled", wasPaused ? "paused" : "cancelled");
            } catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "The query model could not be saved" : error.getMessage(), "failed"); }
            finally { synchronized (this) { downloading = null; } }
        });
    }

    /** A query's unit vector from the installed model; token ids come from the profile's tokenizer. */
    @PluginMethod public void embed(PluginCall call) {
        if (!SpeechRuntime.available()) { call.reject(SpeechRuntime.unavailableReason(), "unavailable"); return; }
        encoder.execute(() -> {
            try {
                File model = store.file(call.getString("model"), call.getString("file"));
                JSONArray encoded = call.getArray("ids");
                if (encoded == null || encoded.length() == 0 || encoded.length() > 8192) throw new SpeechModels.Failure("invalid-input", "Invalid text for the query model");
                long[] ids = new long[encoded.length()];
                for (int i = 0; i < ids.length; i++) ids[i] = encoded.getLong(i);
                long handle;
                synchronized (this) {
                    if (engine == 0) engine = SpeechRuntime.create();
                    if (engine == 0) throw new OutOfMemoryError();
                    SpeechRuntime.begin(engine);
                    handle = engine;
                }
                call.resolve(new JSObject().put("vector", new JSONArray(SpeechRuntime.embed(handle, model.getPath(), ids))));
            } catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (OutOfMemoryError error) { call.reject("Not enough memory for knowledge search", "resources"); }
            catch (Exception | LinkageError error) { call.reject(error.getMessage() == null ? "The query model failed" : error.getMessage(), "failed"); }
        });
    }

    @PluginMethod public void cancelInstall(PluginCall call) { store.cancel(); call.resolve(); }

    @PluginMethod public void remove(PluginCall call) {
        String id = call.getString("id");
        synchronized (this) { if (id != null && id.equals(downloading)) { call.reject("Cancel the download before removing this catalog", "busy"); return; } }
        downloads.execute(() -> {
            try { store.remove(id); call.resolve(); }
            catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (Exception error) { call.reject("The catalog could not be removed", "failed"); }
        });
    }

    @Override protected void handleOnStop() {
        synchronized (this) { if (downloading != null) paused = true; }
        store.cancel();
        // The query model holds hundreds of megabytes; load it again on the next search.
        encoder.execute(() -> { synchronized (this) { if (engine != 0) SpeechRuntime.release(engine); } });
    }
    @Override protected void handleOnDestroy() {
        store.cancel();
        encoder.execute(() -> { synchronized (this) { if (engine != 0) SpeechRuntime.destroy(engine); engine = 0; } });
        downloads.shutdown();
        encoder.shutdown();
    }
}
