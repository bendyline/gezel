package com.bendyline.gezel.speech;

/**
 * Binding for libGezelSpeech (native/mobile/speech). The library ships in the
 * optional gezel-speech AAR; without it {@link #available()} is false and no
 * other method may be called.
 */
public final class SpeechRuntime {
    /** Matches GEZEL_SPEECH_ABI in gezel_speech.h. */
    public static final int ABI = 3;
    private static final String UNAVAILABLE;
    static {
        String reason = null;
        try {
            System.loadLibrary("GezelSpeech");
            if (abi() != ABI) reason = "This app's speech engine does not match its plugin.";
        } catch (UnsatisfiedLinkError missing) {
            reason = "This app was built without the offline speech engine.";
        }
        UNAVAILABLE = reason;
    }
    private SpeechRuntime() {}
    /** Null when the engine can run, else why not. */
    public static String unavailableReason() { return UNAVAILABLE; }
    public static boolean available() { return UNAVAILABLE == null; }
    static native int abi();
    public static native long create();
    public static native void begin(long engine);
    public static native void cancel(long engine);
    public static native void release(long engine);
    public static native void destroy(long engine);
    /** Timed transcript as UTF-8 JSON; see gezel_speech_transcribe_json. */
    public static native byte[] transcribe(long engine, String model, byte[] pcm16, String language, String prompt, boolean words);
    /** {24 kHz samples, per-token durations (empty when the model has none)}. */
    public static native float[][] kokoro(long engine, String model, String voices, int voice, int[] tokens, float speed);
    /** A knowledge query's unit vector: mean-pooled, normalized hidden states. */
    public static native float[] embed(long engine, String model, long[] ids);
}
