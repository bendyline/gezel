package com.bendyline.gezel.mobile;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.genai.common.FeatureStatus;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

@CapacitorPlugin(name = "GezelSpeech")
public final class GezelSpeechPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService probes = Executors.newSingleThreadExecutor();
    private SpeechAssets assets;
    private String activeId;
    private boolean backgrounded, stopped;
    private long engine;
    private MlKitSpeech system;
    private final List<PluginCall> waiters = new ArrayList<>();
    @Override public void load() { assets = new SpeechAssets(getContext()); }
    @PluginMethod public void status(PluginCall call) {
        probes.execute(() -> {
            JSObject systemStatus = new JSObject().put("state", "unavailable");
            if (Build.VERSION.SDK_INT >= 31) {
                try (MlKitSpeech probe = new MlKitSpeech(call.getString("language"))) {
                    int status = probe.status();
                    systemStatus.put("state", status == FeatureStatus.AVAILABLE ? "ready" : status == FeatureStatus.DOWNLOADABLE || status == FeatureStatus.DOWNLOADING ? "download-required" : "unavailable");
                    systemStatus.put("model", "system");
                } catch (Exception | LinkageError unavailable) { systemStatus.put("reason", "On-device speech is unavailable; Gezel can use Whisper offline."); }
            }
            try {
                String state = assets.bundled() ? "ready" : "unavailable";
                call.resolve(new JSObject().put("system", systemStatus)
                    .put("whisper", new JSObject().put("state", state).put("model", "whisper-tiny"))
                    .put("kokoro", new JSObject().put("state", state).put("model", "kokoro-82m-v1.0"))
                    .put("models", assets.models())
                    .put("voices", assets.bundled() ? assets.voices() : new JSONArray()));
            } catch (Exception error) { call.reject("The offline speech pack could not be read", "unavailable"); }
        });
    }
    @PluginMethod public void transcribe(PluginCall call) { run(call, false); }
    @PluginMethod public void synthesize(PluginCall call) { run(call, true); }
    private void run(PluginCall call, boolean synthesis) {
        String id = call.getString("requestId");
        try { UUID.fromString(id); } catch (Exception invalid) { call.reject("A speech request identity is required", "invalid-input"); return; }
        synchronized (this) {
            if (activeId != null || backgrounded) { call.reject("Speech is busy or Gezel is in the background", "busy"); return; }
            activeId = id; stopped = false;
        }
        worker.execute(() -> {
            JSObject result = null; String failure = null, code = "failed";
            long start = SystemClock.uptimeMillis();
            try {
                check();
                if (synthesis) {
                    String model = call.getString("model", "kokoro-82m-v1.0");
                    if (!model.equals("kokoro-82m-v1.0")) throw new IllegalArgumentException("The selected Kokoro model is unavailable");
                    String text = call.getString("text", ""), voice = call.getString("voice", "af_heart");
                    if (text.isEmpty() || text.length() > 12000) throw new IllegalArgumentException("Use up to 12,000 characters of speech");
                    int index = -1; JSONArray voices = assets.voices();
                    for (int i = 0; i < voices.length(); i++) if (voices.getJSONObject(i).getString("id").equals(voice)) index = voices.getJSONObject(i).getInt("index");
                    if (index < 0) throw new IllegalArgumentException("The selected Kokoro voice is unavailable");
                    File root = assets.ensure(); checkResources(); check();
                    long nativeEngine = allocate();
                    byte[] wav = SpeechRuntime.synthesize(nativeEngine, new File(root, "kokoro").getPath(), text, index, (float) Math.min(2, Math.max(.5, call.getDouble("speed", 1.0))));
                    check();
                    result = new JSObject().put("wav", Base64.encodeToString(wav, Base64.NO_WRAP)).put("meta", new JSObject()
                        .put("voice", voice).put("model", model).put("sampleRate", 24000).put("durationSeconds", (wav.length - 44) / 48000.0).put("durationMs", SystemClock.uptimeMillis() - start));
                } else {
                    String encoded = call.getString("audio", "");
                    if (encoded.isEmpty() || encoded.length() > 5120000) throw new IllegalArgumentException("Use up to two minutes of speech");
                    byte[] pcm = Base64.decode(encoded, Base64.NO_WRAP);
                    if (pcm.length % 2 != 0 || pcm.length == 0 || !Base64.encodeToString(pcm, Base64.NO_WRAP).equals(encoded)) throw new IllegalArgumentException("Invalid speech recording");
                    String provider = call.getString("engine", "");
                    String text;
                    if (provider.equals("system")) {
                        if (Build.VERSION.SDK_INT < 31) throw new MlKitSpeech.Unavailable();
                        synchronized (this) { check(); system = new MlKitSpeech(call.getString("language")); }
                        text = system.transcribe(pcm);
                    } else if (provider.equals("whisper")) {
                        if (!call.getString("model", "whisper-tiny").equals("whisper-tiny")) throw new IllegalArgumentException("The selected Whisper model is unavailable");
                        File root = assets.ensure(); checkResources(); check();
                        text = new String(SpeechRuntime.transcribe(allocate(), new File(root, "whisper-tiny.bin").getPath(), pcm, call.getString("language"), call.getString("prompt")), StandardCharsets.UTF_8);
                    } else throw new IllegalArgumentException("Unknown speech recognizer");
                    check(); result = new JSObject().put("text", text).put("durationMs", SystemClock.uptimeMillis() - start);
                }
            } catch (MlKitSpeech.Unavailable unavailable) { failure = "On-device speech is unavailable"; code = "unavailable"; }
            catch (CancellationException cancelled) { failure = "Speech stopped"; code = "cancelled"; }
            catch (Exception | LinkageError | OutOfMemoryError error) { failure = error instanceof OutOfMemoryError ? "Not enough memory for speech" : error.getMessage(); }
            finally {
                MlKitSpeech previous; synchronized (this) { previous = system; system = null; }
                if (previous != null) previous.close();
                synchronized (this) {
                    if (engine != 0) SpeechRuntime.destroy(engine); engine = 0;
                    if (stopped) { failure = "Speech stopped"; code = "cancelled"; }
                    activeId = null;
                    if (failure == null && result != null) call.resolve(result); else call.reject(failure == null ? "Speech failed" : failure, code);
                    for (PluginCall waiter : waiters) waiter.resolve(); waiters.clear();
                }
            }
        });
    }
    private synchronized long allocate() {
        check(); engine = SpeechRuntime.create();
        if (engine == 0) throw new IllegalStateException("Not enough memory for speech");
        return engine;
    }
    private synchronized void check() { if (stopped || backgrounded) throw new CancellationException(); }
    private void checkResources() {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory);
        if (memory.lowMemory || memory.availMem < memory.threshold + 512L * 1024 * 1024) throw new IllegalStateException("Not enough memory for speech. Release the chat model and try again.");
        if (Build.VERSION.SDK_INT >= 29 && ((PowerManager) getContext().getSystemService(Context.POWER_SERVICE)).getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE)
            throw new IllegalStateException("Let this device cool before running speech");
    }
    private synchronized void stop() {
        stopped = true;
        if (engine != 0) SpeechRuntime.cancel(engine);
        if (system != null) system.cancel();
    }
    @PluginMethod public synchronized void cancel(PluginCall call) {
        if (activeId != null && activeId.equals(call.getString("requestId"))) { waiters.add(call); stop(); }
        else call.resolve();
    }
    @Override protected synchronized void handleOnStop() { backgrounded = true; stop(); }
    @Override protected synchronized void handleOnStart() { backgrounded = false; }
    @Override protected synchronized void handleOnDestroy() { backgrounded = true; stop(); worker.shutdown(); probes.shutdown(); }
}
