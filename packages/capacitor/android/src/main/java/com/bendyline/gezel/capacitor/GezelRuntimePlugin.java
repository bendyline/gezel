package com.bendyline.gezel.capacitor;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.bendyline.gezel.runtime.GezelNativeRuntime;
import com.bendyline.gezel.runtime.NativeCall;
import org.json.JSONObject;

@CapacitorPlugin(name = "GezelRuntime")
public final class GezelRuntimePlugin extends Plugin {
    private GezelNativeRuntime runtime;
    private AutoCloseable listener;
    private boolean pickingModel;
    @Override public void load() {
        runtime = GezelNativeRuntime.shared(getContext());
        listener = runtime.listen((name, data) -> notifyListeners(name, toJS(data)));
    }
    public static JSObject toJS(JSONObject value) {
        JSObject copy = new JSObject();
        for (var keys = value.keys(); keys.hasNext();) { String key = keys.next(); copy.put(key, value.opt(key)); }
        return copy;
    }
    public static NativeCall adapt(PluginCall call) {
        return new NativeCall(call.getData(), new NativeCall.Reply() {
            public void resolve(JSONObject value) { call.resolve(toJS(value)); }
            public void reject(String message, String code) { call.reject(message, code); }
        });
    }
    @PluginMethod public void providers(PluginCall call) { runtime.providers(adapt(call)); }
    @PluginMethod public void prepareProvider(PluginCall call) { runtime.prepareProvider(adapt(call)); }
    @PluginMethod public void cancelProviderPreparation(PluginCall call) { runtime.cancelProviderPreparation(adapt(call)); }
    @PluginMethod public void generate(PluginCall call) { runtime.generate(adapt(call)); }
    @PluginMethod public void cancel(PluginCall call) { runtime.cancel(adapt(call)); }
    @PluginMethod public void releaseModel(PluginCall call) { runtime.releaseModel(adapt(call)); }
    @PluginMethod public void listModels(PluginCall call) { runtime.listModels(adapt(call)); }
    @PluginMethod public void selectModel(PluginCall call) { runtime.selectModel(adapt(call)); }
    @PluginMethod public void removeModel(PluginCall call) { runtime.removeModel(adapt(call)); }
    @PluginMethod public void resolveModelSource(PluginCall call) { runtime.resolveModelSource(adapt(call)); }
    @PluginMethod public void cancelModelSourceResolution(PluginCall call) { runtime.cancelModelSourceResolution(adapt(call)); }
    @PluginMethod public void listModelDownloads(PluginCall call) { runtime.listModelDownloads(adapt(call)); }
    @PluginMethod public void startModelDownload(PluginCall call) { runtime.startModelDownload(adapt(call)); }
    @PluginMethod public void resumeModelDownload(PluginCall call) { runtime.resumeModelDownload(adapt(call)); }
    @PluginMethod public void cancelModelDownload(PluginCall call) { runtime.cancelModelDownload(adapt(call)); }
    @PluginMethod public void removeModelDownload(PluginCall call) { runtime.removeModelDownload(adapt(call)); }
    @PluginMethod public void importModel(PluginCall call) {
        if (!runtime.reserveModelMutation()) { call.reject("Finish the current operation before importing", "BUSY"); return; }
        pickingModel = true;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("application/octet-stream");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(call, intent, "modelPicked"); }
        catch (Exception error) { pickingModel = false; runtime.releaseModelMutation(); call.reject("Document picker unavailable", error); }
    }
    @ActivityCallback private void modelPicked(PluginCall call, ActivityResult result) {
        if (!pickingModel) { if (call != null) call.reject("Document picker closed", "CANCELLED"); return; }
        pickingModel = false;
        runtime.releaseModelMutation();
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) { call.resolve(new JSObject().put("model", JSONObject.NULL)); return; }
        runtime.importModel(adapt(call), uri);
    }
    @Override protected void handleOnStop() { runtime.onBackground(); }
    @Override protected void handleOnResume() { runtime.onForeground(); }
    @Override protected void handleOnDestroy() {
        if (pickingModel) { pickingModel = false; runtime.releaseModelMutation(); }
        try { if (listener != null) listener.close(); } catch (Exception ignored) {}
    }
}
