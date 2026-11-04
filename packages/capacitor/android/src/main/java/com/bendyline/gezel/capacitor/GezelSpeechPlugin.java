package com.bendyline.gezel.capacitor;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import com.bendyline.gezel.speech.SpeechRuntime;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONArray;

/**
 * Offline speech: Whisper dictation and Kokoro narration on the optional
 * gezel-speech runtime, with models the host downloads on request. One
 * request runs at a time; models stay loaded between requests and are
 * released after a quiet spell or when the app leaves the foreground.
 */
@CapacitorPlugin(name = "GezelSpeech")
public final class GezelSpeechPlugin extends Plugin {
    private static final long IDLE_RELEASE_MS = 120_000;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private SpeechModels models;
    private long engine;
    private String activeId, downloading;
    private boolean stopped, backgrounded, downloadPaused;
    private ScheduledFuture<?> idle;
    private final List<PluginCall> waiters = new ArrayList<>();

    @Override public void load() { models = new SpeechModels(getContext()); }

    @PluginMethod public void status(PluginCall call) {
        try {
            JSObject result = new JSObject().put("available", SpeechRuntime.available()).put("models", models.list());
            if (!SpeechRuntime.available()) result.put("reason", SpeechRuntime.unavailableReason());
            synchronized (this) { if (downloading != null) result.put("downloading", downloading); }
            call.resolve(result);
        } catch (Exception error) { call.reject("Speech models could not be read", "failed"); }
    }

    @PluginMethod public void install(PluginCall call) {
        String id;
        try { id = SpeechModels.id(call.getString("id")); }
        catch (Exception invalid) { call.reject("Invalid speech model", "invalid-input"); return; }
        JSONArray files = call.getArray("files");
        synchronized (this) {
            if (downloading != null) { call.reject("Another speech model is downloading", "busy"); return; }
            if (backgrounded) { call.reject("Speech downloads run in the foreground", "paused"); return; }
            downloading = id; downloadPaused = false;
        }
        downloads.execute(() -> {
            try {
                models.install(id, files, (received, total) -> notifyListeners("speechDownload",
                    new JSObject().put("id", id).put("receivedBytes", received).put("totalBytes", total)));
                call.resolve(new JSObject().put("id", id));
            } catch (CancellationException cancelled) {
                boolean paused; synchronized (this) { paused = downloadPaused; }
                call.reject(paused ? "Download paused when the app left the foreground" : "Download cancelled", paused ? "paused" : "cancelled");
            } catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "The speech model could not be saved" : error.getMessage(), "failed"); }
            finally { synchronized (this) { downloading = null; } }
        });
    }

    @PluginMethod public void cancelInstall(PluginCall call) { models.cancel(); call.resolve(); }

    @PluginMethod public void remove(PluginCall call) {
        String id = call.getString("id");
        synchronized (this) {
            if (id != null && id.equals(downloading)) { call.reject("Cancel the download before removing this model", "busy"); return; }
            if (activeId != null) { call.reject("Speech is busy", "busy"); return; }
        }
        worker.execute(() -> {
            try {
                synchronized (this) { if (engine != 0) SpeechRuntime.release(engine); }
                models.remove(id);
                call.resolve();
            } catch (SpeechModels.Failure failure) { call.reject(failure.getMessage(), failure.code); }
            catch (Exception error) { call.reject("The speech model could not be removed", "failed"); }
        });
    }

    @PluginMethod public void transcribe(PluginCall call) { run(call, false); }
    @PluginMethod public void synthesize(PluginCall call) { run(call, true); }

    private void run(PluginCall call, boolean synthesis) {
        String id = call.getString("requestId");
        try { UUID.fromString(id); } catch (Exception invalid) { call.reject("A speech request identity is required", "invalid-input"); return; }
        if (!SpeechRuntime.available()) { call.reject(SpeechRuntime.unavailableReason(), "unavailable"); return; }
        synchronized (this) {
            if (activeId != null) { call.reject("Speech is busy", "busy"); return; }
            if (backgrounded) { call.reject("Speech runs while the app is in the foreground", "cancelled"); return; }
            activeId = id; stopped = false;
            if (idle != null) idle.cancel(false);
        }
        worker.execute(() -> {
            JSObject result = null; String failure = null, code = "failed";
            long started = SystemClock.uptimeMillis();
            try {
                File model = models.file(call.getString("model"), call.getString("file"));
                checkResources();
                long handle = begin();
                if (synthesis) {
                    File voices = models.file(call.getString("model"), call.getString("voices"));
                    JSONArray encoded = call.getArray("tokens");
                    if (encoded == null || encoded.length() < 3 || encoded.length() > 511)
                        throw new SpeechModels.Failure("invalid-input", "Speech phonemes are missing or too long");
                    int[] tokens = new int[encoded.length()];
                    for (int i = 0; i < tokens.length; i++) {
                        tokens[i] = encoded.getInt(i);
                        if (tokens[i] < 0 || tokens[i] > 177) throw new SpeechModels.Failure("invalid-input", "Invalid speech phoneme");
                    }
                    float speed = (float) Math.min(2, Math.max(.5, call.getDouble("speed", 1.0)));
                    float[][] output = SpeechRuntime.kokoro(handle, model.getPath(), voices.getPath(), call.getInt("voice", 0), tokens, speed);
                    result = new JSObject().put("pcm", Base64.encodeToString(pcm16(output[0]), Base64.NO_WRAP))
                        .put("sampleRate", 24000).put("durations", new JSONArray(output[1]));
                } else {
                    String encoded = call.getString("audio", "");
                    if (encoded.isEmpty() || encoded.length() > 5_120_000) throw new SpeechModels.Failure("invalid-input", "Use up to two minutes of speech");
                    byte[] pcm = Base64.decode(encoded, Base64.NO_WRAP);
                    if (pcm.length == 0 || pcm.length % 2 != 0) throw new SpeechModels.Failure("invalid-input", "Invalid speech recording");
                    byte[] json = SpeechRuntime.transcribe(handle, model.getPath(), pcm, call.getString("language"),
                        call.getString("prompt"), Boolean.TRUE.equals(call.getBoolean("words", false)));
                    result = new JSObject(new String(json, StandardCharsets.UTF_8));
                }
                result.put("durationMs", SystemClock.uptimeMillis() - started);
            } catch (CancellationException cancelled) { failure = "Speech stopped"; code = "cancelled"; }
            catch (SpeechModels.Failure error) { failure = error.getMessage(); code = error.code; }
            catch (OutOfMemoryError error) { failure = "Not enough memory for speech"; code = "resources"; }
            catch (Exception | LinkageError error) { failure = error.getMessage(); }
            finally {
                synchronized (this) {
                    if (stopped) { failure = "Speech stopped"; code = "cancelled"; }
                    activeId = null;
                    if (failure == null && result != null) call.resolve(result); else call.reject(failure == null ? "Speech failed" : failure, code);
                    for (PluginCall waiter : waiters) waiter.resolve();
                    waiters.clear();
                    scheduleRelease(backgrounded ? 0 : IDLE_RELEASE_MS);
                }
            }
        });
    }

    /** The long-lived engine, cleared of any earlier cancel; serialized with stop(). */
    private synchronized long begin() {
        if (stopped || backgrounded) throw new CancellationException();
        if (engine == 0) engine = SpeechRuntime.create();
        if (engine == 0) throw new OutOfMemoryError();
        SpeechRuntime.begin(engine);
        return engine;
    }

    private static byte[] pcm16(float[] samples) {
        byte[] out = new byte[samples.length * 2];
        for (int i = 0; i < samples.length; i++) {
            float sample = Float.isFinite(samples[i]) ? Math.max(-1f, Math.min(1f, samples[i])) : 0f;
            int value = Math.round(sample * (sample < 0 ? 32768f : 32767f));
            out[2 * i] = (byte) value;
            out[2 * i + 1] = (byte) (value >> 8);
        }
        return out;
    }

    private void checkResources() throws SpeechModels.Failure {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(memory);
        if (memory.lowMemory || memory.availMem < memory.threshold + 512L * 1024 * 1024)
            throw new SpeechModels.Failure("resources", "Not enough memory for speech. Close other apps and try again.");
        if (Build.VERSION.SDK_INT >= 29 && ((PowerManager) getContext().getSystemService(Context.POWER_SERVICE)).getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE)
            throw new SpeechModels.Failure("resources", "Let this device cool before running speech");
    }

    private synchronized void scheduleRelease(long delay) {
        if (idle != null) idle.cancel(false);
        idle = timer.schedule(() -> worker.execute(() -> {
            synchronized (this) { if (activeId == null && engine != 0) SpeechRuntime.release(engine); }
        }), delay, TimeUnit.MILLISECONDS);
    }

    private synchronized void stop() {
        stopped = true;
        if (engine != 0) SpeechRuntime.cancel(engine);
    }

    @PluginMethod public synchronized void cancel(PluginCall call) {
        if (activeId != null && activeId.equals(call.getString("requestId"))) { waiters.add(call); stop(); }
        else call.resolve();
    }

    @PluginMethod public void release(PluginCall call) { scheduleRelease(0); call.resolve(); }

    @Override protected void handleOnStop() {
        synchronized (this) {
            backgrounded = true;
            if (activeId != null) stop();
            if (downloading != null) downloadPaused = true;
            scheduleRelease(0);
        }
        models.cancel();
    }
    @Override protected synchronized void handleOnStart() { backgrounded = false; }
    @Override protected void handleOnDestroy() {
        synchronized (this) { backgrounded = true; if (activeId != null) stop(); }
        models.cancel();
        worker.execute(() -> { synchronized (this) { if (engine != 0) SpeechRuntime.destroy(engine); engine = 0; } });
        worker.shutdown(); downloads.shutdown(); timer.shutdown();
    }
}
