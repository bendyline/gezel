package com.bendyline.gezel.mobile;

import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.audio.AudioSource;
import com.google.mlkit.genai.speechrecognition.*;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.*;
import java.util.function.Function;
import kotlin.ResultKt;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.intrinsics.IntrinsicsKt;
import kotlinx.coroutines.*;

/** No microphone source or download API is reachable from transcription. */
final class MlKitSpeech implements AutoCloseable {
    private final CompletableJob job = JobKt.Job((Job) null);
    private final SpeechRecognizer recognizer;
    private volatile boolean stopped;
    private volatile ParcelFileDescriptor[] pipe;
    MlKitSpeech(String language) {
        SpeechRecognizerOptions.Builder options = new SpeechRecognizerOptions.Builder();
        options.setLocale(language == null ? Locale.getDefault() : Locale.forLanguageTag(language));
        options.setPreferredMode(SpeechRecognizerOptions.Mode.MODE_BASIC);
        recognizer = SpeechRecognition.INSTANCE.getClient(options.build());
    }
    private <T> T await(long timeout, Function<Continuation<? super T>, Object> operation) throws Exception {
        if (stopped) throw new CancellationException();
        CompletableFuture<T> result = new CompletableFuture<>();
        Continuation<T> continuation = new Continuation<T>() {
            public CoroutineContext getContext() { return Dispatchers.getIO().plus(job); }
            @SuppressWarnings("unchecked") public void resumeWith(Object value) {
                try { ResultKt.throwOnFailure(value); result.complete((T) value); }
                catch (Throwable failure) { result.completeExceptionally(failure); }
            }
        };
        Object immediate = operation.apply(continuation);
        if (immediate != IntrinsicsKt.getCOROUTINE_SUSPENDED()) continuation.resumeWith(immediate);
        long start = SystemClock.uptimeMillis();
        while (true) {
            if (stopped) throw new CancellationException();
            if (SystemClock.uptimeMillis() - start > timeout) { cancel(); throw new TimeoutException("On-device speech timed out"); }
            try { return result.get(100, TimeUnit.MILLISECONDS); }
            catch (TimeoutException pending) { }
            catch (ExecutionException failure) { throw new IllegalStateException("On-device speech failed", failure.getCause()); }
        }
    }
    int status() throws Exception { return this.<Integer>await(15000, recognizer::checkStatus); }
    String transcribe(byte[] pcm) throws Exception {
        if (status() != FeatureStatus.AVAILABLE) throw new Unavailable();
        pipe = ParcelFileDescriptor.createPipe();
        SpeechRecognizerRequest.Builder builder = new SpeechRecognizerRequest.Builder();
        builder.setAudioSource(AudioSource.fromPfd(pipe[0]));
        StringBuilder transcript = new StringBuilder();
        final Throwable[] error = {null};
        Thread feeder = new Thread(() -> {
            try (OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                long start = SystemClock.uptimeMillis();
                for (int offset = 0; offset < pcm.length && !stopped; offset += 640) {
                    output.write(pcm, offset, Math.min(640, pcm.length - offset));
                    long due = start + (offset + 640L) * 1000 / 32000;
                    while (!stopped && SystemClock.uptimeMillis() < due) Thread.sleep(Math.max(1, Math.min(20, due - SystemClock.uptimeMillis())));
                }
            } catch (Exception failure) { if (!stopped) error[0] = failure; }
        }, "gezel-speech-input");
        feeder.start();
        try {
            this.<Unit>await(150000, done -> recognizer.startRecognition(builder.build()).collect((response, next) -> {
                if (response instanceof SpeechRecognizerResponse.FinalTextResponse) {
                    if (transcript.length() > 0) transcript.append(' ');
                    transcript.append(((SpeechRecognizerResponse.FinalTextResponse) response).getText());
                    if (transcript.length() > 256000) throw new IllegalStateException("Speech transcript is too large");
                } else if (response instanceof SpeechRecognizerResponse.ErrorResponse) {
                    throw new IllegalStateException("On-device speech failed", ((SpeechRecognizerResponse.ErrorResponse) response).getE());
                }
                return Unit.INSTANCE;
            }, done));
            if (error[0] != null) throw new IllegalStateException("The speech recording could not be read", error[0]);
            return transcript.toString();
        } finally { cancel(); feeder.interrupt(); feeder.join(); }
    }
    void cancel() {
        stopped = true; job.cancel(new CancellationException("Speech stopped"));
        ParcelFileDescriptor[] current = pipe;
        if (current != null) for (ParcelFileDescriptor descriptor : current) try { descriptor.close(); } catch (Exception ignored) { }
    }
    public void close() { cancel(); recognizer.close(); }
    static final class Unavailable extends Exception { }
}
