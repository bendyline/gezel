package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.bendyline.gezel.runtime.GezelNativeRuntime;
import com.bendyline.gezel.runtime.NativeCall;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Native quality evals have no production endpoint, fake provider, or injected model response. */
@RunWith(AndroidJUnit4.class)
public final class MobileProductEvalTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Map<File, byte[]> inventoryBackup = new LinkedHashMap<>();
    private MainActivity activity;
    private WebView webView;
    private File productRoot;
    private File productBackup;
    private File importedModel;
    private File reportFile;
    private Map<String, String> originalProduct;

    @Test public void realProviderProductEvals() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        Assume.assumeTrue("Quality evals are opt-in; use the mobile eval launcher", "1".equals(arguments.getString("gezelEval")));
        String runId = arguments.getString("evalRunId", "android-" + System.currentTimeMillis());
        assertTrue("Invalid eval run id", runId.matches("[A-Za-z0-9_-]{1,100}"));
        File files = instrumentation.getTargetContext().getFilesDir();
        File root = new File(files, "gezel");
        File[] previous = root.listFiles();
        if (previous != null) for (File entry : previous)
            assertFalse("Recover the preserved product backup before another eval: " + entry,
                entry.isDirectory() && (entry.getName().startsWith("product-eval-backup-") || entry.getName().startsWith("product-smoke-backup-")));
        MobileStore store = new MobileStore(files);
        productRoot = new File(root, "product");
        originalProduct = productSnapshot(productRoot);
        productBackup = new File(root, "product-eval-backup-" + java.util.UUID.randomUUID());
        Files.move(productRoot.toPath(), productBackup.toPath());
        store = new MobileStore(files);
        for (String name : new String[] { "models.json", "models.json.bak", "models.json.new" }) {
            File file = new File(root, name);
            inventoryBackup.put(file, file.exists() ? Files.readAllBytes(file.toPath()) : null);
        }
        String provider = arguments.getString("evalProvider", "llama-cpp");
        String modelPath = arguments.getString("evalModelPath");
        if (modelPath != null && provider.equals("llama-cpp")) {
            File source = new File(modelPath);
            assertTrue("A real trained GGUF must be staged before the eval", source.isFile() && source.length() > 1024 * 1024);
            String modelId = store.importModel(instrumentation.getTargetContext().getContentResolver(), Uri.fromFile(source)).getString("id");
            importedModel = new File(root, "models/" + modelId + ".gguf");
            store.selectModel(modelId);
            if ("1".equals(arguments.getString("evalDeleteStaged"))) {
                assertEquals("Only an eval-owned app-cache source may be deleted", instrumentation.getTargetContext().getCacheDir().getCanonicalFile(), source.getCanonicalFile().getParentFile());
                assertEquals("Only the eval-owned staged filename may be deleted", "mobile-eval-" + runId + ".gguf", source.getName());
                Files.delete(source.toPath());
            }
        } else if (arguments.getString("evalModelId") != null) {
            store.selectModel(arguments.getString("evalModelId"));
        }
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(intent);
        instrumentation.runOnMainSync(() -> webView = activity.getBridge().getWebView());
        waitForApp();
        String source;
        try (java.io.InputStream input = instrumentation.getContext().getAssets().open("mobile-product-eval.js")) {
            source = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        try (java.io.InputStream input = instrumentation.getContext().getAssets().open("mobile-eval-clock.js")) {
            source = new String(input.readAllBytes(), StandardCharsets.UTF_8) + "\n" + source;
        }
        String sourceHash = sha256(source.getBytes(StandardCharsets.UTF_8));
        String productIndexHash;
        try (java.io.InputStream input = instrumentation.getTargetContext().getAssets().open("public/index.html")) {
            productIndexHash = sha256(input.readAllBytes());
        }
        JSONObject options = new JSONObject()
            .put("runId", runId).put("provider", provider)
            .put("trialTimeoutMs", Integer.parseInt(arguments.getString("evalTrialTimeoutMs", "180000")))
            .put("identity", new JSONObject().put("os", "Android").put("osVersion", Build.VERSION.RELEASE)
                .put("apiLevel", Build.VERSION.SDK_INT).put("device", Build.MODEL).put("abi", Build.SUPPORTED_ABIS[0])
                .put("nativeHarness", "Android instrumentation packaged WebView").put("harnessSourceSha256", sourceHash).put("productIndexSha256", productIndexHash)
                .put("modelSourceSha256", arguments.getString("evalModelSha256", "unavailable")));
        if (arguments.getString("evalContext") != null) options.put("contextSize", Integer.parseInt(arguments.getString("evalContext")));
        if (arguments.getString("evalMaxTokens") != null) options.put("maxTokens", Integer.parseInt(arguments.getString("evalMaxTokens")));
        if (arguments.getString("evalScenarios") != null) options.put("scenarios", new JSONArray(java.util.Arrays.asList(arguments.getString("evalScenarios").split(","))));
        try (java.io.InputStream input = instrumentation.getContext().getAssets().open("canonical-fixtures.json")) {
            options.put("canonicalFixtures", new JSONArray(new String(input.readAllBytes(), StandardCharsets.UTF_8)));
        }
        evaluate(source);
        JSONObject contracts = new JSONObject().put("passed", false);
        try {
            contracts = asyncObject("return await window.__gezelMobileEval.prepareContracts();");
            evaluate("window.__gezelEvalReloading=true");
            instrumentation.runOnMainSync(() -> webView.reload());
            waitForApp();
            evaluate(source);
            contracts = asyncObject("return await window.__gezelMobileEval.finishContracts(" + contracts + ");");
        } catch (Exception error) { contracts.put("passed", false).put("error", error.toString()); }
        String outputDir = arguments.getString("additionalTestOutputDir");
        File output = outputDir == null ? new File(files, "mobile-evals") : new File(outputDir, "mobile-evals");
        assertTrue(output.isDirectory() || output.mkdirs());
        reportFile = new File(output, runId + ".json");
        android.util.Log.i("GezelMobileEval", "MOBILE_EVAL_REPORT " + reportFile);
        JSONArray reports = new JSONArray();
        JSONObject contractOptions = new JSONObject(options.toString()).put("contracts", contracts)
            .put("contractsOnly", true).put("scenarios", new JSONArray());
        runPhase(contractOptions, source, reports, reportFile);
        resetProduct(files, source);
        JSONObject isolation = asyncObject("return await window.__gezelMobileEval.verifyFreshProduct();");
        JSONObject savedContracts = reports.getJSONObject(0).getJSONObject("contracts");
        JSONArray assertions = savedContracts.optJSONArray("assertions");
        if (assertions == null) assertions = new JSONArray();
        savedContracts.put("assertions", assertions.put(isolation));
        savedContracts.put("passed", savedContracts.optBoolean("passed") && isolation.getBoolean("passed"));
        if (!"1".equals(arguments.getString("evalContractsOnly"))) {
            JSONArray scenarios = options.optJSONArray("scenarios");
            if (scenarios == null) scenarios = new JSONArray(evaluate("[...window.__gezelMobileEval.scenarios,..." + options.getJSONArray("canonicalFixtures") + ".map(f=>f.id)]"));
            long cooldownMs = Long.parseLong(arguments.getString("evalCooldownMs", "0"));
            for (int index = 0; index < scenarios.length(); index++) {
                String scenario = scenarios.getString(index);
                coolDown(cooldownMs);
                android.util.Log.i("GezelMobileEval", "MOBILE_EVAL_STAGE isolated-trial " + scenario);
                resetProduct(files, source);
                runPhase(new JSONObject(options.toString()).put("scenarios", new JSONArray().put(scenario)), source, reports, reportFile);
            }
        }
        JSONObject report = new JSONObject(evaluate("window.__gezelMobileEval.mergeReports(" + reports + ",true)"));
        Files.write(reportFile.toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8));
        assertTrue("Artifacts and transcripts must survive each isolated trial reload", report.getJSONObject("reopen").optBoolean("passed"));
        assertTrue("Authored scripts and shared question UI contracts must pass", report.getJSONObject("contracts").optBoolean("passed"));
        JSONArray trials = report.getJSONArray("trials");
        java.util.List<String> failures = new java.util.ArrayList<>();
        for (int i = 0; i < trials.length(); i++) if (!java.util.Arrays.asList("pass", "ungraded").contains(trials.getJSONObject(i).getString("status"))) failures.add(trials.getJSONObject(i).getString("id"));
        assertTrue("Quality failures are retained, never skipped: " + failures, failures.isEmpty());
    }

    private void runPhase(JSONObject options, String source, JSONArray reports, File reportFile) throws Exception {
        evaluate("window.__gezelMobileEval.run(" + options + ").catch(error=>window.__gezelMobileEvalError=String(error.stack||error));true");
        JSONObject report = new JSONObject();
        int lastRevision = -1;
        evaluate("window.__gezelMobileEvalClock.startSuspendMonitor();window.__gezelEvalOuterBudget=new window.__gezelMobileEvalClock.AwakeBudget(8*3600000);true");
        while (evaluate("window.__gezelEvalOuterBudget.expired()").equals("false")) {
            JSONObject state = new JSONObject(evaluate("({revision:window.__gezelMobileEvalReport?.revision??-1,complete:window.__gezelMobileEvalReport?.complete??false,error:window.__gezelMobileEvalError??null})"));
            if (!state.isNull("error")) fail(state.getString("error"));
            int revision = state.getInt("revision");
            if (revision != lastRevision) {
                report = new JSONObject(evaluate("window.__gezelMobileEvalReport"));
                JSONArray progress = new JSONArray(reports.toString()).put(report);
                String merged = evaluate("window.__gezelMobileEval.mergeReports(" + progress + ",false)");
                Files.write(reportFile.toPath(), merged.getBytes(StandardCharsets.UTF_8));
                lastRevision = revision;
            }
            File receiptFile = new File(reportFile.getPath() + ".receipt.json");
            if (receiptFile.isFile()) {
                String receipt = new String(Files.readAllBytes(receiptFile.toPath()), StandardCharsets.UTF_8);
                evaluate("window.__gezelMobileEvalGradeReceipt=" + new JSONObject(receipt) + ";true");
            }
            if (state.getBoolean("complete")) break;
            SystemClock.sleep(500);
        }
        assertTrue("Eval timed out; partial report retained at " + reportFile, report.optBoolean("complete"));
        evaluate("window.__gezelEvalReloading=true");
        instrumentation.runOnMainSync(() -> webView.reload());
        waitForApp();
        evaluate(source);
        JSONObject reopened = asyncObject("return await window.__gezelMobileEval.verifyReopen(" + report + ");");
        report.put("reopen", reopened);
        reports.put(report);
        String merged = evaluate("window.__gezelMobileEval.mergeReports(" + reports + ",false)");
        Files.write(reportFile.toPath(), merged.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * A phone on USB power reached THERMAL_STATUS_SEVERE after about five minutes
     * of inference, and the runtime then refuses every request, so back-to-back
     * trials measured the chassis rather than the model (Galaxy S20 FE, 2026-09-26).
     */
    private float idleHeadroom = Float.NaN;

    /**
     * Headroom is compared with what this phone showed before the first trial,
     * not a fixed number: an S20 FE on USB power idles at about 0.74, so a fixed
     * 0.75 threshold held every trial for the whole wait. The baseline waits for
     * no thermal status at all; one read from a phone still warm from an earlier
     * run (0.9) let every later trial start hot.
     */
    private void coolDown(long maxMs) {
        if (maxMs <= 0) return;
        PowerManager power = instrumentation.getTargetContext().getSystemService(PowerManager.class);
        long started = SystemClock.elapsedRealtime();
        int status;
        float headroom;
        while (true) {
            status = power.getCurrentThermalStatus();
            headroom = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? power.getThermalHeadroom(10) : Float.NaN;
            if (Float.isNaN(idleHeadroom) && status == PowerManager.THERMAL_STATUS_NONE) idleHeadroom = headroom;
            boolean cool = status < PowerManager.THERMAL_STATUS_MODERATE
                && (Float.isNaN(headroom) || (!Float.isNaN(idleHeadroom) && headroom <= idleHeadroom + 0.05f));
            if (cool || SystemClock.elapsedRealtime() - started >= maxMs) break;
            // Headroom forecasts are rate limited; polling faster returns NaN.
            SystemClock.sleep(15000);
        }
        android.util.Log.i("GezelMobileEval", "MOBILE_EVAL_STAGE cooldown waitedMs=" + (SystemClock.elapsedRealtime() - started)
            + " thermalStatus=" + status + " headroom=" + headroom + " idleHeadroom=" + idleHeadroom);
    }

    private void resetProduct(File files, String source) throws Exception {
        closeActivity();
        removeProductTree();
        new MobileStore(files);
        activity = (MainActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        instrumentation.runOnMainSync(() -> webView = activity.getBridge().getWebView());
        waitForApp();
        evaluate(source);
    }

    private static String sha256(byte[] bytes) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte value : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) {
            hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        }
        return hex.toString();
    }

    private JSONObject asyncObject(String source) throws Exception {
        evaluate("window.__gezelEvalPhase=null;(async()=>{" + source + "})().then(value=>window.__gezelEvalPhase={value},error=>window.__gezelEvalPhase={error:String(error.stack||error)});true");
        for (int attempt = 0; attempt < 1800; attempt++) {
            String encoded = evaluate("window.__gezelEvalPhase");
            if (!encoded.equals("null")) {
                JSONObject result = new JSONObject(encoded);
                if (result.has("error")) throw new IllegalStateException(result.getString("error"));
                return result.getJSONObject("value");
            }
            SystemClock.sleep(100);
        }
        throw new IllegalStateException("Native contract phase timed out");
    }

    private String evaluate(String source) throws Exception {
        String result = evaluateWithin(source, 20);
        assertNotNull("WebView evaluation timed out", result);
        return result;
    }
    /** Returns null when no answer came back in time. */
    private String evaluateWithin(String source, int seconds) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> webView.evaluateJavascript(source, value -> { result.set(value); done.countDown(); }));
        return done.await(seconds, TimeUnit.SECONDS) ? result.get() : null;
    }
    private void waitForApp() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 120_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            // A page that navigates again while loading drops an evaluation's
            // callback; that means not ready yet. Twice on the S20 FE a reload
            // outlived one 20 s evaluation and failed the whole run.
            if ("true".equals(evaluateWithin("Boolean(!window.__gezelEvalReloading && window.__GEZEL__?.fetch && document.querySelector('[data-testid=\"app-sidebar\"]') && window.Capacitor?.Plugins?.GezelMobile)", 5))) return;
            SystemClock.sleep(100);
        }
        fail("Packaged product did not initialize");
    }
    private void closeActivity() throws Exception {
        if (activity == null) return;
        GezelMobilePlugin plugin = (GezelMobilePlugin) activity.getBridge().getPlugin("GezelMobile").getInstance();
        Field field = GezelMobilePlugin.class.getDeclaredField("storageQueue");
        field.setAccessible(true);
        ExecutorService storage = (ExecutorService) field.get(plugin);
        instrumentation.runOnMainSync(() -> activity.finish());
        instrumentation.waitForIdleSync();
        assertTrue("Storage must stop before resetting data", storage.awaitTermination(30, TimeUnit.SECONDS));
        // Inference lives in the process-wide runtime, which outlives this
        // activity and never shuts down; wait for its model release instead.
        CountDownLatch released = new CountDownLatch(1);
        String[] releaseFailure = new String[1];
        GezelNativeRuntime.shared(instrumentation.getTargetContext()).releaseModel(new NativeCall(new JSONObject(), new NativeCall.Reply() {
            @Override public void resolve(JSONObject value) { released.countDown(); }
            @Override public void reject(String message, String code) { releaseFailure[0] = message; released.countDown(); }
        }));
        assertTrue("Native inference and model unload must finish before the next trial", released.await(30, TimeUnit.SECONDS));
        assertNull("Native model release failed", releaseFailure[0]);
        activity = null;
        webView = null;
    }
    private void removeProductTree() throws Exception {
        if (productRoot != null && productRoot.isDirectory()) try (java.util.stream.Stream<java.nio.file.Path> entries = Files.walk(productRoot.toPath())) {
            // Collectors, not Stream.toList(): that is Java 16, and an Android 13
            // device without ART module updates lacks it (ONYX Boox, 2026-09-27).
            for (java.nio.file.Path path : entries.sorted(java.util.Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList())) Files.delete(path);
        }
    }
    private Map<String, String> productSnapshot(File directory) throws Exception {
        Map<String, String> snapshot = new java.util.TreeMap<>();
        try (java.util.stream.Stream<java.nio.file.Path> entries = Files.walk(directory.toPath())) {
            for (java.nio.file.Path path : entries.filter(Files::isRegularFile).collect(java.util.stream.Collectors.toList())) {
                java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                try (java.io.InputStream input = Files.newInputStream(path)) {
                    byte[] buffer = new byte[65536];
                    for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
                }
                StringBuilder hex = new StringBuilder();
                for (byte value : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
                snapshot.put(directory.toPath().relativize(path).toString(), hex.toString());
            }
        }
        return snapshot;
    }
    @After public void restoreDedicatedDevice() throws Exception {
        closeActivity();
        if (productBackup != null && productBackup.isDirectory()) {
            removeProductTree();
            Files.move(productBackup.toPath(), productRoot.toPath());
        }
        for (Map.Entry<File, byte[]> entry : inventoryBackup.entrySet()) {
            if (entry.getValue() == null) Files.deleteIfExists(entry.getKey().toPath());
            else Files.write(entry.getKey().toPath(), entry.getValue());
        }
        if (importedModel != null) Files.deleteIfExists(importedModel.toPath());
        if (originalProduct != null) {
            boolean restored = originalProduct.equals(productSnapshot(productRoot));
            for (Map.Entry<File, byte[]> entry : inventoryBackup.entrySet())
                restored &= entry.getValue() == null ? !entry.getKey().exists() :
                    java.util.Arrays.equals(entry.getValue(), Files.readAllBytes(entry.getKey().toPath()));
            if (reportFile != null && reportFile.isFile()) {
                JSONObject report = new JSONObject(new String(Files.readAllBytes(reportFile.toPath()), StandardCharsets.UTF_8));
                report.put("nativeRestoration", new JSONObject().put("passed", restored)
                    .put("productFiles", originalProduct.size()).put("modelInventoryFiles", inventoryBackup.size()));
                Files.write(reportFile.toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            assertTrue("Original product bytes and model selection must be restored", restored);
        }
    }
}
