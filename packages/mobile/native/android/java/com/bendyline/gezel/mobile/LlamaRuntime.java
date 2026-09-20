package com.bendyline.gezel.mobile;

/** Only the plugin calls this JNI surface; no native paths reach JavaScript. */
final class LlamaRuntime {
    static { System.loadLibrary("gezel_mobile"); }
    interface Delta { boolean onDelta(byte[] utf8); }
    static native long create();
    static native void destroy(long engine);
    static native void unload(long engine);
    static native void load(long engine, String path, long requestId, int contextSize);
    static native int generate(long engine, String[] roles, String[] contents, long requestId, int maxTokens, Delta delta);
    static native void cancel(long engine, long requestId);
}
