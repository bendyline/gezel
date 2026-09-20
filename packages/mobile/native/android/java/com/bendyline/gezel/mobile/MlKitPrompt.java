package com.bendyline.gezel.mobile;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.common.StreamingCallback;
import com.google.mlkit.genai.prompt.Candidate;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.SystemInstruction;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** Java API verified against com.google.mlkit:genai-prompt:1.0.0-beta4.
 * All blocking work belongs on the plugin's inference queue. cancel() may run
 * concurrently; close() completes before the plugin admits another request. */
final class MlKitPrompt {
    static final int CONTEXT_TOKENS = 4096;
    static final int MAX_OUTPUT_TOKENS = 256;
    private static final int MAX_OUTPUT_CHARS = 64_000;
    private GenerativeModelFutures model;
    private ListenableFuture<?> pending;
    private boolean stopped;

    interface Delta { void accept(String text); }
    static final class Reply {
        final String text, stopReason;
        Reply(String text, String stopReason) { this.text = text; this.stopReason = stopReason; }
    }

    private synchronized GenerativeModelFutures model() {
        if (stopped) throw new CancellationException();
        if (model == null) model = GenerativeModelFutures.from(Generation.INSTANCE.getClient());
        return model;
    }

    synchronized void begin() { stopped = false; }
    synchronized Runnable requestCancellation() {
        stopped = true;
        ListenableFuture<?> current = pending;
        // Capture the exact future before the plugin releases its request lock.
        // A delayed cancellation must never act on the next request's future.
        return () -> { if (current != null) current.cancel(true); };
    }

    void cancel() { requestCancellation().run(); }

    void close() {
        GenerativeModelFutures current;
        synchronized (this) {
            current = model;
            model = null;
        }
        if (current != null) current.getGenerativeModel().close();
    }

    private <T> T await(ListenableFuture<T> future, long timeoutSeconds) throws Exception {
        boolean cancel;
        synchronized (this) {
            cancel = stopped;
            if (!cancel) pending = future;
        }
        if (cancel) { future.cancel(true); throw new CancellationException(); }
        try { return future.get(timeoutSeconds, TimeUnit.SECONDS); }
        catch (TimeoutException error) {
            future.cancel(true);
            throw new IllegalStateException("The on-device AI operation timed out", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof OutOfMemoryError) throw (OutOfMemoryError) cause;
            throw new IllegalStateException("On-device AI failed", cause);
        } finally {
            synchronized (this) { if (pending == future) pending = null; }
        }
    }

    /** Availability probing never downloads or warms the model. */
    static final class Availability {
        final int status, contextTokens;
        Availability(int status, int contextTokens) { this.status = status; this.contextTokens = contextTokens; }
    }

    static Availability status() throws Exception {
        MlKitPrompt probe = new MlKitPrompt();
        try {
            GenerativeModelFutures client = probe.model();
            int status = probe.await(client.checkStatus(), 15);
            int limit = status == FeatureStatus.AVAILABLE ? Math.min(CONTEXT_TOKENS, probe.await(client.getTokenLimit(), 15)) : CONTEXT_TOKENS;
            if (limit <= MAX_OUTPUT_TOKENS) return new Availability(FeatureStatus.UNAVAILABLE, CONTEXT_TOKENS);
            return new Availability(status, limit);
        }
        finally { probe.close(); }
    }

    void prepare(BooleanSupplier cancelled) throws Exception {
        GenerativeModelFutures client = model();
        int status = await(client.checkStatus(), 15);
        if (cancelled.getAsBoolean()) throw new CancellationException();
        if (status == FeatureStatus.AVAILABLE) return;
        if (status != FeatureStatus.DOWNLOADABLE && status != FeatureStatus.DOWNLOADING)
            throw new IllegalStateException("Android's on-device AI is unavailable on this device");
        // This is the only download call in the app, reached from prepareProvider.
        await(client.download(new DownloadCallback() {
            @Override public void onDownloadStarted(long bytes) {}
            @Override public void onDownloadProgress(long bytes) {}
            @Override public void onDownloadCompleted() {}
            @Override public void onDownloadFailed(GenAiException error) {}
        }), 600);
        if (await(client.checkStatus(), 15) != FeatureStatus.AVAILABLE)
            throw new IllegalStateException("Android's on-device AI has not finished downloading");
    }

    Reply generate(String[] roles, String[] contents, int maxTokens,
                   BooleanSupplier cancelled, Delta delta) throws Exception {
        GenerativeModelFutures client = model();
        if (await(client.checkStatus(), 15) != FeatureStatus.AVAILABLE)
            throw new IllegalStateException("Prepare Android's on-device AI before starting a conversation");
        boolean systemSupported = await(client.isSystemPromptAvailable(), 15);
        JSONArray transcript = new JSONArray();
        String system = null;
        for (int index = 0; index < roles.length; index++) {
            if (roles[index].equals("system") && index == 0) system = contents[index];
            else transcript.put(new JSONObject().put("role", roles[index]).put("content", contents[index]));
        }
        // Prompt API Content has no role field. Reconstruct all previous turns
        // explicitly rather than retaining invisible SDK conversation state.
        String prompt = "Continue the following conversation. Reply only as the assistant to its final user message.\n"
            + ((!systemSupported && system != null) ? "Instructions:\n" + system + "\n" : "")
            + "Conversation (JSON):\n" + transcript;
        GenerateContentRequest.Builder builder = new GenerateContentRequest.Builder(new TextPart(prompt));
        if (systemSupported && system != null) builder.setSystemInstruction(new SystemInstruction(system));
        builder.setMaxOutputTokens(maxTokens);
        builder.setCandidateCount(1);
        builder.setTemperature(0.2f);
        builder.setEnableThinking(false);
        GenerateContentRequest request = builder.build();
        int count = await(client.countTokens(request), 15).getTotalTokens();
        int limit = Math.min(CONTEXT_TOKENS, await(client.getTokenLimit(), 15));
        // Conservatively reserve output even on SDK builds counting it already.
        if (count < 0 || count >= 4000 || count + maxTokens > limit)
            throw new IllegalArgumentException("This conversation is too long for Android's on-device AI. Start a new conversation.");
        if (cancelled.getAsBoolean()) throw new CancellationException();
        AtomicReference<RuntimeException> streamError = new AtomicReference<>();
        StringBuilder streamed = new StringBuilder();
        GenerateContentResponse response;
        try { response = await(client.generateContent(request, new StreamingCallback() {
            @Override public void onNewText(String text) {
                synchronized (streamed) {
                    if (cancelled.getAsBoolean() || streamError.get() != null) return;
                    if (text == null || text.length() > MAX_OUTPUT_CHARS - streamed.length()) {
                        streamError.set(new IllegalStateException("The model response exceeded the supported size"));
                    } else {
                        streamed.append(text);
                        delta.accept(text);
                        return;
                    }
                }
                cancel();
            }
            @Override public void onNewThought(String ignored) {}
        }), 120); }
        catch (Exception error) { if (streamError.get() != null) throw streamError.get(); throw error; }
        if (streamError.get() != null) throw streamError.get();
        if (cancelled.getAsBoolean()) throw new CancellationException();
        if (response.getCandidates().isEmpty()) throw new IllegalStateException("Android's on-device AI returned no response");
        Candidate candidate = response.getCandidates().get(0);
        String text = candidate.getText();
        if (text == null || text.length() > MAX_OUTPUT_CHARS) throw new IllegalStateException("Invalid model response");
        Integer reason = candidate.getFinishReason();
        if (reason != null && reason == Candidate.FinishReason.OTHER)
            throw new IllegalStateException("Android's on-device AI could not complete this response");
        return new Reply(text, reason != null && reason == Candidate.FinishReason.MAX_TOKENS ? "length" : "stop");
    }
}
