#ifndef GEZEL_LLAMA_H
#define GEZEL_LLAMA_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GEZEL_LLAMA_ABI_VERSION 1u

typedef struct gezel_llama_engine gezel_llama_engine;

typedef enum gezel_llama_status {
    GEZEL_LLAMA_OK = 0,
    GEZEL_LLAMA_INVALID_ARGUMENT = 1,
    GEZEL_LLAMA_BUSY = 2,
    GEZEL_LLAMA_NOT_LOADED = 3,
    GEZEL_LLAMA_LOAD_FAILED = 4,
    GEZEL_LLAMA_UNSUPPORTED = 5,
    GEZEL_LLAMA_CONTEXT_LIMIT = 6,
    GEZEL_LLAMA_CANCELLED = 7,
    GEZEL_LLAMA_TIMEOUT = 8,
    GEZEL_LLAMA_INFERENCE_FAILED = 9,
    GEZEL_LLAMA_RESOURCE_LIMIT = 10
} gezel_llama_status;

typedef enum gezel_llama_finish_reason {
    GEZEL_LLAMA_FINISH_NONE = 0,
    GEZEL_LLAMA_FINISH_STOP = 1,
    GEZEL_LLAMA_FINISH_LENGTH = 2,
    GEZEL_LLAMA_FINISH_CANCELLED = 3,
    GEZEL_LLAMA_FINISH_TIMEOUT = 4,
    GEZEL_LLAMA_FINISH_ERROR = 5
} gezel_llama_finish_reason;

typedef struct gezel_llama_error {
    int32_t code;
    char message[256];
} gezel_llama_error;

typedef struct gezel_llama_load_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t request_id;
    uint32_t context_tokens;
    uint32_t batch_tokens;
    uint32_t threads;
    int32_t gpu_layers;
    uint64_t max_model_bytes;
    uint32_t timeout_ms;
} gezel_llama_load_options;

typedef struct gezel_llama_message {
    /** NUL-terminated UTF-8. Allowed roles: system, user, assistant. */
    const char * role;
    const char * content;
} gezel_llama_message;

typedef struct gezel_llama_generation_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t request_id;
    /** Ceiling on the reply, 1-4096. The reply gets whatever context the prompt
     * leaves, up to this; GEZEL_LLAMA_CONTEXT_LIMIT only when the prompt leaves
     * less than min(max_tokens, 256). */
    uint32_t max_tokens;
    /** Covers prompt processing and decoding; at most 600000. */
    uint32_t timeout_ms;
    uint32_t max_output_bytes;
    /** Zero uses greedy decoding. Positive values use top-k/top-p/min-p/temperature. */
    float temperature;
    uint32_t seed;
    /** Keep only the k likeliest tokens when sampling; 0 disables. */
    uint32_t top_k;
    /** Nucleus mass kept when sampling; 1 disables. */
    float top_p;
    /** Drop tokens below this fraction of the likeliest; 0 disables. */
    float min_p;
    /** Penalty on tokens repeated within `repeat_last_n`; 1 disables. Greedy too. */
    float repeat_penalty;
    uint32_t repeat_last_n;
} gezel_llama_generation_options;

typedef struct gezel_llama_result {
    int32_t status;
    int32_t finish_reason;
    uint32_t prompt_tokens;
    uint32_t generated_tokens;
    uint32_t output_bytes;
} gezel_llama_result;

/** Called synchronously on the generation thread; bytes expire when it returns.
 * Every chunk is valid UTF-8; concatenate chunks without adding separators.
 * Return zero to continue, nonzero to cancel. Must not throw across this ABI.
 * Reentrant load/generate/unload calls return BUSY. cancel is always allowed.
 */
typedef int32_t (*gezel_llama_chunk_callback)(const char * bytes, size_t length, void * user_data);

uint32_t gezel_llama_abi_version(void);
gezel_llama_load_options gezel_llama_default_load_options(void);
gezel_llama_generation_options gezel_llama_default_generation_options(void);
gezel_llama_engine * gezel_llama_create(void);

/** Requires exclusive lifetime ownership: wait for load/generate and any callers
 * of cancel to finish first. No function may use the pointer after destroy.
 */
void gezel_llama_destroy(gezel_llama_engine * engine);

/** Blocking; call off the UI thread. Options are copied before inference starts.
 * request_id must be in 1..INT64_MAX and unique for this engine's operation lifetime.
 * Once admitted, a failed load leaves no model loaded. Validation/BUSY errors
 * preserve the existing model. Input path must be a local regular file.
 * The wrapper never downloads files, opens sockets, or executes scripts.
 */
int32_t gezel_llama_load(gezel_llama_engine * engine, const char * model_path,
    const gezel_llama_load_options * options, gezel_llama_error * error);
int32_t gezel_llama_unload(gezel_llama_engine * engine, gezel_llama_error * error);

/** Bytes a load with the same options would allocate, as llama.cpp accounts
 * them for this device's backends (repacked weight copies included). */
typedef struct gezel_llama_memory_estimate {
    uint32_t struct_size;
    uint32_t abi_version;
    /** Weight buffers. */
    uint64_t model_bytes;
    /** The part of model_bytes a load serves straight from the memory-mapped
     * file: clean pages the OS can reclaim and read again (mostly embedding
     * tables, read a few rows at a time). The rest is allocated. */
    uint64_t mapped_model_bytes;
    /** KV cache and recurrent state at the requested context. */
    uint64_t context_bytes;
    /** Scratch buffers for one batch. */
    uint64_t compute_bytes;
} gezel_llama_memory_estimate;

/** Blocking; reads GGUF metadata only and allocates no tensor data. It shares no
 * state with a loaded model, so it may run beside one; hosts serialize it with
 * loads anyway. Validates options and the file exactly as gezel_llama_load does. */
int32_t gezel_llama_estimate_memory(gezel_llama_engine * engine, const char * model_path,
    const gezel_llama_load_options * options, gezel_llama_memory_estimate * estimate,
    gezel_llama_error * error);

/** Blocking bounded text chat. Caller-owned strings/options stay valid until it
 * returns. Every call starts a fresh KV context from the supplied full transcript.
 * The last message must be user. The model must have a supported built-in chat
 * template; missing/custom-only templates fail explicitly. No tool-call support.
 * result receives partial token/byte counts even on cancellation or failure.
 */
int32_t gezel_llama_generate(gezel_llama_engine * engine,
    const gezel_llama_message * messages, size_t message_count,
    const gezel_llama_generation_options * options,
    gezel_llama_chunk_callback on_chunk, void * user_data,
    gezel_llama_result * result, gezel_llama_error * error);

/** What the engine's current operation is doing, for a host's status display. */
typedef enum gezel_llama_phase {
    GEZEL_LLAMA_PHASE_IDLE = 0,
    GEZEL_LLAMA_PHASE_LOADING = 1,
    GEZEL_LLAMA_PHASE_PROMPT = 2,
    GEZEL_LLAMA_PHASE_GENERATING = 3
} gezel_llama_phase;

typedef struct gezel_llama_progress {
    uint32_t struct_size;
    uint32_t abi_version;
    /** A gezel_llama_phase value. */
    uint32_t phase;
    /** Model loading fraction in [0, 1]; meaningful while loading. */
    float load_fraction;
    /** Tokens in the formatted prompt, and how many of them are in memory so
     * far — reused from the previous request or processed by this one. */
    uint32_t prompt_tokens;
    uint32_t processed_tokens;
    uint32_t reused_tokens;
    uint32_t generated_tokens;
} gezel_llama_progress;

/** Thread-safe snapshot of the current operation's counters; hosts poll it from
 * their cancellation timer while load or generate runs. Never blocks. Requires
 * struct_size and abi_version; returns INVALID_ARGUMENT otherwise. Added after
 * ABI 1 shipped; hosts that must run against older libraries check the symbol. */
int32_t gezel_llama_get_progress(gezel_llama_engine * engine, gezel_llama_progress * progress);

/** Thread-safe cooperative cancellation of the matching CURRENT request only.
 * A late cancellation with an older request_id cannot cancel a later request.
 * Native loading/Metal kernels can delay observation until their next safe point.
 * Cancelling before an operation starts has no effect; schedule on the host queue.
 */
void gezel_llama_cancel(gezel_llama_engine * engine, uint64_t request_id);

#ifdef __cplusplus
}
#endif
#endif
