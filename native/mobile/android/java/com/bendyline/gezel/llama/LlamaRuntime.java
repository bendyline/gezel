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
    /**
     * Live counters for the current load or generate, safe from any thread:
     * {phase (0 idle, 1 loading, 2 prompt, 3 generating), load per-mille,
     * prompt tokens, processed tokens, reused tokens, generated tokens}.
     */
    public static native long[] progress(long engine);

    /** One streamed object from a chat request, as UTF-8 JSON; return false to stop. */
    public interface Event { boolean onEvent(byte[] utf8); }
    /** Status codes a chat call returns (gezel_llama_status). */
    public static final int STATUS_OK = 0;
    public static final int STATUS_CANCELLED = 7;
    public static final int STATUS_TIMEOUT = 8;
    /**
     * Settings llama-server takes from its launch flags, as JSON: chat_template,
     * reasoning_format, reasoning_budget, enable_thinking, chat_template_kwargs.
     */
    public static native void configureChat(long engine, String configJson);
    /**
     * An OpenAI-shaped chat request, served by llama.cpp's own chat layer the way
     * desktop's llama-server serves it. Every chunk llama-server would stream, or
     * its error body, arrives through `event`. Returns the status code; throws only
     * when the engine refuses the call outright (busy, nothing loaded).
     */
    public static native int chat(long engine, String requestJson, long requestId, int timeoutMs, Event event);
}
