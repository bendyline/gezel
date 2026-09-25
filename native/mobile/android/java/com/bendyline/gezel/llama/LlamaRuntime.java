package com.bendyline.gezel.llama;

/** Low-level synchronous JNI binding; invoke on a background serial executor.
 * The caller owns the engine handle and immutable model files. Finish generation
 * and concurrent cancel calls before destroy; never expose handles or paths to
 * untrusted WebView content. Higher-level provider/model/lifecycle wrappers are
 * separate from this preview engine package.
 */
public final class LlamaRuntime {
    private LlamaRuntime() {}
    static { System.loadLibrary("gezel_llama_jni"); }
    public interface Delta { boolean onDelta(byte[] utf8); }
    public static native long create();
    public static native void destroy(long engine);
    public static native void unload(long engine);
    public static native void load(long engine, String path, long requestId, int contextSize);
    public static native int generate(long engine, String[] roles, String[] contents, long requestId, int maxTokens, Delta delta);
    public static native void cancel(long engine, long requestId);
}
