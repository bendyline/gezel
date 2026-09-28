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
    /** What a load at this context would take, without loading: weight bytes, the
     * part of them mapped from the file, context (KV) bytes, scratch bytes. */
    public static native long[] estimate(long engine, String path, int contextSize);
    /** Sampling follows the bridge's gezel_llama_generation_options; temperature 0 is greedy. */
    public static native int generate(long engine, String[] roles, String[] contents, long requestId, int maxTokens,
        float temperature, int topK, float topP, float minP, float repeatPenalty, int repeatLastN, int seed, Delta delta);
    /** Greedy decoding with no repetition penalty: the bridge's defaults. */
    public static int generate(long engine, String[] roles, String[] contents, long requestId, int maxTokens, Delta delta) {
        return generate(engine, roles, contents, requestId, maxTokens, 0f, 40, 0.95f, 0f, 1f, 64, 1, delta);
    }
    public static native void cancel(long engine, long requestId);
}
