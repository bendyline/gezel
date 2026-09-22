package com.bendyline.gezel.mobile;


import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.json.*;

import com.bendyline.gezel.runtime.GezelNativeRuntime;
import com.bendyline.gezel.capacitor.GezelRuntimePlugin;

@CapacitorPlugin(name = "GezelMobile")
public final class GezelMobilePlugin extends Plugin {
    private final ExecutorService storageQueue = Executors.newSingleThreadExecutor();
    private MobileStore store;
    private String initializationError;
    private GezelNativeRuntime runtime;
    private AutoCloseable listener;
    @Override public void load() {
        runtime = GezelNativeRuntime.shared(getContext());
        listener = runtime.listen((name, data) -> notifyListeners(name, GezelRuntimePlugin.toJS(data)));
        try { store = new MobileStore(getContext().getFilesDir(), false); }
        catch (Exception error) { initializationError = error.getMessage(); }
    }
    private boolean reserveModelMutation() { return runtime.reserveModelMutation(); }
    private void releaseModelMutation() { runtime.releaseModelMutation(); }
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
        releaseModelMutation();
        runtime.importModel(GezelRuntimePlugin.adapt(call), uri);
    }

    @PluginMethod public void listModels(PluginCall call) { runtime.listModels(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void resolveModelSource(PluginCall call) { runtime.resolveModelSource(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void cancelModelSourceResolution(PluginCall call) { runtime.cancelModelSourceResolution(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void listModelDownloads(PluginCall call) { runtime.listModelDownloads(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void startModelDownload(PluginCall call) { runtime.startModelDownload(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void resumeModelDownload(PluginCall call) { runtime.resumeModelDownload(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void cancelModelDownload(PluginCall call) { runtime.cancelModelDownload(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void removeModelDownload(PluginCall call) { runtime.removeModelDownload(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void providers(PluginCall call) { runtime.providers(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void prepareProvider(PluginCall call) { runtime.prepareProvider(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void cancelProviderPreparation(PluginCall call) { runtime.cancelProviderPreparation(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void selectModel(PluginCall call) { runtime.selectModel(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void removeModel(PluginCall call) { runtime.removeModel(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void generate(PluginCall call) { runtime.generate(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void cancel(PluginCall call) { runtime.cancel(GezelRuntimePlugin.adapt(call)); }
    @PluginMethod public void releaseModel(PluginCall call) { runtime.releaseModel(GezelRuntimePlugin.adapt(call)); }
    @Override protected void handleOnStop() { runtime.onBackground(); }
    @Override protected void handleOnResume() { runtime.onForeground(); }
    @Override protected void handleOnDestroy() {
        try { if (listener != null) listener.close(); } catch (Exception ignored) {}
        storageQueue.shutdown();
    }
    @Override public Boolean shouldOverrideLoad(Uri url) {
        return !("https".equals(url.getScheme()) && "localhost".equals(url.getHost()));
    }
}
