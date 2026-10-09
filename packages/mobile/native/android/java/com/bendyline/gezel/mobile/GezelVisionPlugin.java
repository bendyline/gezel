package com.bendyline.gezel.mobile;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.genai.common.FeatureStatus;
import java.util.*;
import java.util.concurrent.*;

/** Reads a chat photo on the phone: ML Kit's labels and text everywhere, and a
 * Gemini Nano description where AICore offers one. One read at a time; the
 * product runtime calls it from inside a turn that already holds the engine. */
@CapacitorPlugin(name = "GezelVision")
public final class GezelVisionPlugin extends Plugin {
    private static final int MAX_IMAGE_BASE64 = 22_400_000;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService probes = Executors.newSingleThreadExecutor();
    private String activeId;
    private MlKitVision active;
    private boolean backgrounded;

    @PluginMethod public void status(PluginCall call) {
        probes.execute(() -> {
            try (MlKitVision probe = new MlKitVision(getContext())) { call.resolve(statusOf(probe)); }
            catch (Exception | LinkageError error) { call.resolve(statusOf(null)); }
        });
    }

    @PluginMethod public void prepare(PluginCall call) {
        worker.execute(() -> {
            try (MlKitVision vision = new MlKitVision(getContext())) {
                vision.prepare();
                call.resolve(statusOf(vision));
            } catch (MlKitVision.Unavailable unavailable) { call.reject(unavailable.getMessage(), "unavailable"); }
            catch (Exception | LinkageError error) { call.reject(error.getMessage() == null ? "Gemini Nano could not be downloaded" : error.getMessage(), "failed"); }
        });
    }

    @PluginMethod public void read(PluginCall call) {
        String id = call.getString("requestId");
        try { UUID.fromString(id); } catch (Exception invalid) { call.reject("A vision request identity is required", "invalid-input"); return; }
        String encoded = call.getString("image", "");
        if (encoded.isEmpty() || encoded.length() > MAX_IMAGE_BASE64) { call.reject("Photos must be up to 16 MiB", "invalid-input"); return; }
        boolean describe = Boolean.TRUE.equals(call.getBoolean("describe", true));
        MlKitVision vision = new MlKitVision(getContext());
        synchronized (this) {
            if (activeId != null || backgrounded) { vision.close(); call.reject("Photo reading is busy or Gezel is in the background", "busy"); return; }
            activeId = id; active = vision;
        }
        worker.execute(() -> {
            JSObject result = null; String failure = null, code = "failed";
            try { result = read(vision, Base64.decode(encoded, Base64.NO_WRAP), describe); }
            catch (CancellationException stopped) { failure = "Photo reading stopped"; code = "cancelled"; }
            catch (OutOfMemoryError memory) { failure = "Not enough memory to read this photo"; }
            catch (Exception | LinkageError error) { failure = error.getMessage() == null ? "This photo could not be read" : error.getMessage(); }
            finally { vision.close(); }
            // Free the slot before answering: the next photo in the same
            // message is sent the moment this one resolves.
            synchronized (this) { activeId = null; active = null; }
            if (result != null) call.resolve(result); else call.reject(failure, code);
        });
    }

    private JSObject read(MlKitVision vision, byte[] bytes, boolean describe) throws Exception {
        MlKitVision.Image image = MlKitVision.decode(bytes);
        try {
            JSArray labels = new JSArray();
            JSArray models = new JSArray();
            // Each recognizer stands alone: one that fails still leaves the
            // other's reading. Only both failing is an error.
            Exception first = null;
            try {
                for (MlKitVision.Label label : vision.labels(image))
                    labels.put(new JSObject().put("label", label.text).put("confidence", (double) label.confidence));
            } catch (CancellationException stopped) { throw stopped; }
            catch (Exception error) { first = error; }
            if (labels.length() > 0) models.put("mlkit-image-labeling");
            String text;
            try { text = vision.text(image); }
            catch (CancellationException stopped) { throw stopped; }
            catch (Exception error) {
                if (first != null) throw first;
                text = "";
            }
            if (!text.isEmpty()) models.put("mlkit-text-recognition");
            JSObject result = new JSObject().put("labels", labels).put("text", text)
                .put("width", image.width).put("height", image.height);
            String describer = "unavailable";
            if (describe) {
                try {
                    int status = vision.describerStatus();
                    if (status == FeatureStatus.AVAILABLE) {
                        String reason = resourceReason();
                        if (reason == null) {
                            String description = vision.describe(image);
                            if (!description.isEmpty()) { result.put("description", description); models.put("mlkit-genai-image-description"); }
                            describer = "ready";
                        } else { describer = "failed"; result.put("describerReason", reason); }
                    } else if (status == FeatureStatus.DOWNLOADABLE) describer = "download-required";
                    else if (status == FeatureStatus.DOWNLOADING) describer = "downloading";
                } catch (CancellationException stopped) { throw stopped; }
                catch (Exception | LinkageError error) {
                    describer = "failed";
                    result.put("describerReason", String.valueOf(error.getMessage()));
                }
            }
            return result.put("describer", describer).put("models", models);
        } finally { image.bitmap.recycle(); }
    }

    @PluginMethod public synchronized void cancel(PluginCall call) {
        if (activeId != null && activeId.equals(call.getString("requestId")) && active != null) active.cancel();
        call.resolve();
    }

    private JSObject statusOf(MlKitVision probe) {
        JSObject describer = new JSObject().put("state", "unavailable");
        if (probe != null && Build.VERSION.SDK_INT >= 31) {
            try {
                int status = probe.describerStatus();
                describer.put("state", status == FeatureStatus.AVAILABLE ? "ready" : status == FeatureStatus.DOWNLOADABLE ? "download-required" : status == FeatureStatus.DOWNLOADING ? "downloading" : "unavailable");
                describer.put("model", "gemini-nano");
            } catch (Exception | LinkageError unavailable) {
                describer.put("reason", "Android's on-device AI is unavailable. On supported phones, update AICore in the Play Store and try again.");
            }
        }
        return new JSObject().put("labels", "ready").put("text", "ready").put("describer", describer);
    }

    /** Nano runs in AICore, beside a chat model this app may still hold. */
    private String resourceReason() {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory);
        if (memory.lowMemory || memory.availMem < memory.threshold + 512L * 1024 * 1024) return "Not enough memory to describe the photo";
        if (Build.VERSION.SDK_INT >= 29 && ((PowerManager) getContext().getSystemService(Context.POWER_SERVICE)).getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE)
            return "Let this phone cool before describing photos";
        return null;
    }

    @Override protected synchronized void handleOnStop() { backgrounded = true; if (active != null) active.cancel(); }
    @Override protected synchronized void handleOnStart() { backgrounded = false; }
    @Override protected synchronized void handleOnDestroy() { backgrounded = true; if (active != null) active.cancel(); worker.shutdown(); probes.shutdown(); }
}
