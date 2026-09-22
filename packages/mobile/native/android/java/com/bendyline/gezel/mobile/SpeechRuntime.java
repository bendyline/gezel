package com.bendyline.gezel.mobile;

final class SpeechRuntime {
    static { System.loadLibrary("gezel_mobile"); }
    static native long create();
    static native void cancel(long engine);
    static native void destroy(long engine);
    static native byte[] transcribe(long engine, String model, byte[] pcm, String language, String prompt);
    /** Phoneme ids from the shared frontend; nothing native reads text. */
    static native byte[] synthesize(long engine, String directory, int[] tokens, int voice, float speed);
}
