#include "gezel_llama.h"
#include "utf8_stream.h"
#include "chat_formats.h"
#include "llama.h"
#include "llama-ext.h"
#include "gguf.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#ifdef GEZEL_CPU_VARIANTS
#include <dlfcn.h>
#include "ggml-backend.h"
#ifdef __ANDROID__
#include <android/log.h>
#endif
#endif

using clock_type = std::chrono::steady_clock;
constexpr uint64_t cancelled_bit = uint64_t{1} << 63;
constexpr size_t max_prompt_bytes = 1024 * 1024;
constexpr size_t max_input_bytes = 256 * 1024;
// A phone holding a hybrid or windowed model has memory for 16K of context;
// the host sizes the window to the device (GezelNativeRuntime).
constexpr uint32_t max_context_tokens = 16384;

struct gezel_llama_engine {
    std::mutex mutex;
    std::atomic<uint64_t> active_request{0};
    // Read by gezel_llama_get_progress from any thread; written only by the
    // operation that holds the engine.
    std::atomic<uint32_t> progress_phase{GEZEL_LLAMA_PHASE_IDLE};
    std::atomic<float> progress_load{0.0f};
    std::atomic<uint32_t> progress_prompt{0};
    std::atomic<uint32_t> progress_processed{0};
    std::atomic<uint32_t> progress_reused{0};
    std::atomic<uint32_t> progress_generated{0};
    void begin_progress(uint32_t phase) {
        progress_load.store(0.0f, std::memory_order_relaxed);
        progress_prompt.store(0, std::memory_order_relaxed);
        progress_processed.store(0, std::memory_order_relaxed);
        progress_reused.store(0, std::memory_order_relaxed);
        progress_generated.store(0, std::memory_order_relaxed);
        progress_phase.store(phase, std::memory_order_release);
    }
    clock_type::time_point deadline;
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    FILE * model_file = nullptr;
    uint32_t batch_tokens = 0;
    uint32_t context_tokens = 0;
    std::string chat_template;
    bool gemma4_turns = false;
    // Tokens held in the context's memory, in position order. Only a request
    // that finished cleanly leaves this set; everything else starts empty.
    std::vector<llama_token> cached;
    // Plain attention memory can drop a suffix and keep the rest exactly.
    // Recurrent and hybrid states (Qwen 3.5, LFM2, Granite 4) cannot: their
    // rollback snapshots serve speculative decoding, and reusing them changed
    // greedy output (2026-09-26). A sliding window (Gemma) has already evicted
    // the positions a longer prompt's prefix needs. Both resume from a
    // checkpoint instead.
    bool reusable_memory = false;
    // For those models, a copy of the state attention memory cannot rebuild,
    // taken one token before the end of the last prompt, and the tokens it
    // covers. Every model a 6 GB phone can hold is hybrid or windowed, so
    // without this each tool step re-reads the whole prompt. Qwen 3.5 2B's is 19 MiB at any
    // prompt length; its turn 2 fell from 10.9 s to 0.6 s with identical output.
    std::vector<uint8_t> checkpoint;
    std::vector<llama_token> checkpoint_tokens;

    void unload() {
        if (context) llama_free(context);
        context = nullptr;
        if (model) llama_model_free(model);
        model = nullptr;
        if (model_file) std::fclose(model_file);
        model_file = nullptr;
        chat_template.clear();
        cached.clear();
        checkpoint.clear();
        checkpoint_tokens.clear();
    }
    ~gezel_llama_engine() { unload(); }
    int32_t stopped() const {
        if (active_request.load(std::memory_order_acquire) & cancelled_bit) return GEZEL_LLAMA_CANCELLED;
        if (clock_type::now() >= deadline) return GEZEL_LLAMA_TIMEOUT;
        return GEZEL_LLAMA_OK;
    }
};

namespace {
int32_t fail(gezel_llama_error * error, int32_t status, const char * message) {
    if (error) {
        error->code = status;
        std::snprintf(error->message, sizeof(error->message), "%s", message);
    }
    return status;
}

struct operation {
    gezel_llama_engine & engine;
    operation(gezel_llama_engine & value, uint64_t request, uint32_t timeout) : engine(value) {
        engine.deadline = clock_type::now() + std::chrono::milliseconds(timeout);
        engine.active_request.store(request, std::memory_order_release);
    }
    ~operation() { engine.active_request.store(0, std::memory_order_release); }
};

bool abort_decode(void * data) { return static_cast<gezel_llama_engine *>(data)->stopped() != GEZEL_LLAMA_OK; }
bool load_progress(float fraction, void * data) {
    static_cast<gezel_llama_engine *>(data)->progress_load.store(fraction, std::memory_order_relaxed);
    return !abort_decode(data);
}
bool valid_request(uint64_t id) { return id != 0 && (id & cancelled_bit) == 0; }
bool valid_timeout(uint32_t value) { return value > 0 && value <= 300000; }
bool valid_load_options(const gezel_llama_load_options * options) {
    return options && options->struct_size == sizeof(*options) && options->abi_version == GEZEL_LLAMA_ABI_VERSION &&
        options->context_tokens >= 256 && options->context_tokens <= max_context_tokens &&
        options->batch_tokens >= 1 && options->batch_tokens <= 512 && options->batch_tokens <= options->context_tokens &&
        options->threads >= 1 && options->threads <= 8 && options->gpu_layers >= -1 && options->gpu_layers <= 256 &&
        options->max_model_bytes != 0 && options->max_model_bytes <= uint64_t{8} * 1024 * 1024 * 1024;
}

/**
 * Map a stop signal to a finish reason once generation has begun.
 *
 * Before the first token there is nothing to keep, so a stop is an error. After
 * it, discarding the text the model already produced — and that the host has
 * already streamed to the screen — throws away real work. The caller is told
 * how it ended and decides what to do with it.
 */
int32_t finish_for_stop(int32_t status) {
    return status == GEZEL_LLAMA_CANCELLED ? GEZEL_LLAMA_FINISH_CANCELLED
                                           : GEZEL_LLAMA_FINISH_TIMEOUT;
}

int32_t stop_error(gezel_llama_engine & engine, gezel_llama_error * error) {
    const auto status = engine.stopped();
    return fail(error, status, status == GEZEL_LLAMA_CANCELLED ? "Request cancelled" : "Request timed out");
}

/**
 * Android ships one ggml CPU library per instruction-set level and loads the
 * best one this CPU supports. A single ARMv8.0 build left a phone's dot-product
 * units idle: 11 tok/s prompt reading on a Galaxy S20 FE against 68 for the
 * dot-product build, and 27 against 218 on a Galaxy S26+ (2026-09-26). The
 * libraries stay inside the APK (extractNativeLibs=false), where ggml's own
 * directory scan cannot see them, so each is opened by name through the app's
 * linker namespace and asked for its score, as ggml_backend_load_best does.
 */
void load_cpu_variant() {
#ifdef GEZEL_CPU_VARIANTS
    // build-llama.py's ANDROID_CPU_VARIANTS: no SVE/SME, which scored highest
    // and ran slowest on a Galaxy S26+.
    static const char * const variants[] = {
        "libggml-cpu-android_armv8.6_1.so", "libggml-cpu-android_armv8.2_2.so",
        "libggml-cpu-android_armv8.2_1.so", "libggml-cpu-android_armv8.0_1.so",
    };
    const char * best = nullptr;
    int best_score = 0;
    for (const char * name : variants) {
        void * handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
        if (!handle) continue;
        const auto score = reinterpret_cast<int (*)()>(dlsym(handle, "ggml_backend_score"));
        const int value = score ? score() : 0;
        if (value > best_score) { best_score = value; best = name; }
        dlclose(handle);
    }
    const bool loaded = best && ggml_backend_load(best);
#ifdef __ANDROID__
    __android_log_print(loaded ? ANDROID_LOG_INFO : ANDROID_LOG_ERROR, "GezelLlama", "CPU backend %s (score %d)",
                        loaded ? best : "unavailable", best_score);
#else
    (void) loaded;
#endif
#endif
}

/** Opens the one regular GGUF file a load or estimate may read, positioned at its start. */
int32_t open_model(const char * path, uint64_t max_model_bytes, FILE *& file, gezel_llama_error * error) {
    // A mistaken FIFO/device path must fail without waiting in fopen before the
    // regular-file check or before cooperative deadlines can observe it.
    const int descriptor = ::open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    struct stat info{};
    if (descriptor < 0)
        return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Model path must name a readable regular GGUF file");
    if (::fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0) {
        ::close(descriptor);
        return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Model path must name a readable regular GGUF file");
    }
    file = ::fdopen(descriptor, "rb");
    if (!file) {
        ::close(descriptor);
        return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Could not open the model file stream");
    }
    if (static_cast<uint64_t>(info.st_size) > max_model_bytes)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model file exceeds the configured byte limit");

    // Refuse multi-file models before llama's loader can open additional files
    // outside the single imported file whose size/ownership the host admitted.
    std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
        gguf_init_from_file_ptr(file, {true, nullptr}), gguf_free);
    if (!metadata) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Invalid GGUF model metadata");
    const auto split = gguf_find_key(metadata.get(), "split.count");
    if (split >= 0 && (gguf_get_kv_type(metadata.get(), split) != GGUF_TYPE_UINT16 ||
                      gguf_get_val_u16(metadata.get(), split) > 1))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Split GGUF models are not supported on mobile");
    metadata.reset();
    std::rewind(file);
    if (ggml_backend_dev_count() == 0)
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "No inference library in this app supports this device's processor");
    return GEZEL_LLAMA_OK;
}

llama_model_params model_params(const gezel_llama_load_options & options) {
    auto params = llama_model_default_params();
    params.n_gpu_layers = options.gpu_layers;
    return params;
}

llama_context_params context_params(const gezel_llama_load_options & options) {
    auto context = llama_context_default_params();
    context.n_ctx = options.context_tokens;
    context.n_batch = options.batch_tokens;
    context.n_ubatch = options.batch_tokens;
    context.n_threads = options.threads;
    context.n_threads_batch = options.threads;
    context.n_seq_max = 1;
    context.no_perf = true;
    return context;
}

int32_t check_model(const llama_model * model, const gezel_llama_load_options & options, gezel_llama_error * error) {
    if (llama_model_has_encoder(model) || !llama_model_has_decoder(model))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Only decoder text models are supported");
    if (llama_model_n_ctx_train(model) < static_cast<int32_t>(options.context_tokens))
        return fail(error, GEZEL_LLAMA_CONTEXT_LIMIT, "Requested context exceeds the model's trained context");
    return GEZEL_LLAMA_OK;
}

bool maps_weights(const llama_model * model) {
    if (!llama_supports_mmap()) return false;
    for (int32_t index = 0; index < llama_model_n_devices(model); ++index) {
        ggml_backend_dev_props props{};
        ggml_backend_dev_get_props(llama_model_get_device(model, index), &props);
        if (!props.caps.mmap_support) return false;
    }
    return true;
}

/**
 * The memory a load with these options would take, from llama.cpp's own
 * accounting of a metadata-only load (the way upstream's --fit sizes a
 * context). Hosts used to charge a flat 64 KiB per context token plus 256 MiB
 * of scratch: four times the real KV of a hybrid Qwen 3.5 2B, which a 6 GB
 * Galaxy S20 FE then refused in 4 of 7 trials although it ran the model at
 * 27 s to first token (2026-09-27), and under the real KV of a dense Llama 3.2
 * 3B. Weights are sized as this build places them, so the copies the CPU
 * backend repacks for dot-product kernels are counted.
 */
int32_t estimate_impl(const char * path, const gezel_llama_load_options & options,
                      gezel_llama_memory_estimate & estimate, gezel_llama_error * error) {
    FILE * raw = nullptr;
    const auto opened = open_model(path, options.max_model_bytes, raw, error);
    std::unique_ptr<FILE, decltype(&std::fclose)> file(raw, std::fclose);
    if (opened != GEZEL_LLAMA_OK) return opened;
    if (options.gpu_layers != 0 && !llama_supports_gpu_offload())
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "This library has no GPU backend; use gpu_layers=0");
    auto params = model_params(options);
    params.no_alloc = true;
    params.load_mode = LLAMA_LOAD_MODE_NONE;
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
        llama_model_load_from_file_ptr(file.get(), params), llama_model_free);
    if (!model) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "llama.cpp could not read the model");
    if (const auto status = check_model(model.get(), options, error); status) return status;
    std::unique_ptr<llama_context, decltype(&llama_free)> context(
        llama_init_from_model(model.get(), context_params(options)), llama_free);
    if (!context) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Could not size the model context");
    // A real load maps the tensors that stay in the CPU's default buffer from
    // the file (llama.cpp's AUTO load mode, when every device can map); the
    // CPU's repacked copies and GPU buffers are allocated. Every buffer type
    // counts toward the total: a phone's GPU shares the same memory.
    const auto cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    const auto mapped = cpu && maps_weights(model.get()) ? ggml_backend_dev_buffer_type(cpu) : nullptr;
    for (const auto & [type, bytes] : llama_get_memory_breakdown(context.get())) {
        estimate.model_bytes += bytes.model;
        if (type == mapped) estimate.mapped_model_bytes += bytes.model;
        estimate.context_bytes += bytes.context;
        estimate.compute_bytes += bytes.compute;
    }
    return GEZEL_LLAMA_OK;
}

int32_t load_impl(gezel_llama_engine & engine, const char * path,
                 const gezel_llama_load_options & options, gezel_llama_error * error) {
    engine.unload();
    if (const auto status = open_model(path, options.max_model_bytes, engine.model_file, error); status)
        return status;
    if (engine.stopped()) return stop_error(engine, error);
    if (options.gpu_layers != 0 && !llama_supports_gpu_offload())
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "This library has no GPU backend; use gpu_layers=0");

    auto params = model_params(options);
    params.progress_callback = load_progress;
    params.progress_callback_user_data = &engine;
    engine.model = llama_model_load_from_file_ptr(engine.model_file, params);
    if (engine.stopped()) return stop_error(engine, error);
    if (!engine.model) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "llama.cpp could not load the model");
    if (const auto status = check_model(engine.model, options, error); status) return status;
    const char * chat = llama_model_chat_template(engine.model, nullptr);
    if (!chat || !*chat) return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model does not declare a chat template");
    if (strnlen(chat, max_prompt_bytes + 1) > max_prompt_bytes)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model chat template exceeds the byte limit");
    const llama_chat_message probe[] = {{"user", "Hello"}};
    engine.gemma4_turns = gezel_mobile::chat_formats::is_gemma4(chat);
    if (!engine.gemma4_turns && llama_chat_apply_template(chat, probe, 1, true, nullptr, 0) < 0)
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model chat template requires an unsupported Jinja renderer");
    engine.chat_template = chat;
    auto context = context_params(options);
    context.abort_callback = abort_decode;
    context.abort_callback_data = &engine;
    engine.context = llama_init_from_model(engine.model, context);
    if (engine.stopped()) return stop_error(engine, error);
    if (!engine.context) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Could not allocate the model context");
    if (!llama_get_memory(engine.context))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model does not support the required decoder memory");
    engine.context_tokens = std::min(options.context_tokens, llama_n_ctx(engine.context));
    engine.reusable_memory = !llama_model_is_recurrent(engine.model) && !llama_model_is_hybrid(engine.model) &&
        llama_model_n_swa(engine.model) == 0;
    engine.batch_tokens = options.batch_tokens;
    return GEZEL_LLAMA_OK;
}

int32_t generate_impl(gezel_llama_engine & engine, const gezel_llama_message * messages,
                     size_t count, const gezel_llama_generation_options & options,
                     gezel_llama_chunk_callback callback, void * user_data,
                     gezel_llama_result & result, gezel_llama_error * error) {
    std::vector<llama_chat_message> chat;
    size_t input_bytes = 0;
    for (size_t index = 0; index < count; ++index) {
        const auto & message = messages[index];
        if (!message.role || !message.content || strnlen(message.role, 16) >= 16)
            return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Every message requires a role and UTF-8 content");
        const std::string role(message.role);
        if (role != "system" && role != "user" && role != "assistant")
            return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Only system, user and assistant messages are supported");
        if (role == "system" && index != 0)
            return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "System message must be first");
        const size_t size = strnlen(message.content, max_input_bytes + 1);
        input_bytes += size;
        if (input_bytes > max_input_bytes)
            return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Transcript exceeds 256 KiB");
        if (!gezel_mobile::utf8_stream::valid(message.content, size))
            return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Transcript contains invalid UTF-8");
        chat.push_back({message.role, message.content});
    }
    if (std::strcmp(messages[count - 1].role, "user") != 0)
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Transcript must end with a user message");
    std::vector<char> prompt;
    int32_t size;
    if (engine.gemma4_turns) {
        const auto text = gezel_mobile::chat_formats::gemma4(chat);
        if (text.size() > max_prompt_bytes)
            return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Formatted prompt exceeds its byte limit");
        prompt.assign(text.begin(), text.end());
        prompt.push_back('\0');
        size = static_cast<int32_t>(text.size());
    } else {
        size = llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, nullptr, 0);
        if (size < 0) return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Chat template cannot format this transcript");
        if (size == 0 || static_cast<size_t>(size) > max_prompt_bytes)
            return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Formatted prompt exceeds its byte limit");
        prompt.resize(static_cast<size_t>(size) + 1);
        if (llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, prompt.data(), prompt.size()) != size)
            return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Chat template size changed unexpectedly");
    }
    const llama_vocab * vocab = llama_model_get_vocab(engine.model);
    const auto required = llama_tokenize(vocab, prompt.data(), size, nullptr, 0, true, true);
    if (required == INT32_MIN || required >= 0)
        return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Could not tokenize the chat transcript");
    const auto token_count = static_cast<uint32_t>(-required);
    result.prompt_tokens = token_count;
    if (token_count >= engine.context_tokens || options.max_tokens > engine.context_tokens - token_count)
        return fail(error, GEZEL_LLAMA_CONTEXT_LIMIT, "Prompt plus requested output exceeds the context; shorten the transcript or output");
    std::vector<llama_token> tokens(token_count);
    if (llama_tokenize(vocab, prompt.data(), size, tokens.data(), tokens.size(), true, true) != static_cast<int32_t>(tokens.size()))
        return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Could not tokenize the chat transcript");
    // Keep what the previous request left in memory where this transcript starts
    // the same way. A phone re-reading a ~3,000-token system prompt on every tool
    // step spent about 2.5 minutes per step (Galaxy S20 FE, 2026-09-26).
    // Greedy output can still differ from a fresh prefill at a near-tie: the
    // previous reply was decoded one token at a time, and single-token and
    // batched CPU kernels round differently. On Llama 3.2 3B the reused state
    // moved logits by at most 0.37, inside the 0.41 that separates two fresh
    // prefills of different batch shapes.
    auto memory = llama_get_memory(engine.context);
    size_t reuse = 0;
    while (reuse < engine.cached.size() && reuse < tokens.size() && engine.cached[reuse] == tokens[reuse]) ++reuse;
    if (!engine.reusable_memory) {
        // Attention memory still holds the checkpoint's positions only if the
        // cached tokens agree that far; the checkpoint restores the rest.
        const auto & covered = engine.checkpoint_tokens;
        const bool resumable = !engine.checkpoint.empty() && covered.size() <= reuse && covered.size() < tokens.size() &&
            std::equal(covered.begin(), covered.end(), tokens.begin());
        reuse = resumable && llama_state_seq_set_data_ext(engine.context, engine.checkpoint.data(), engine.checkpoint.size(), 0,
                                                          LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY) == engine.checkpoint.size()
            ? covered.size() : 0;
    }
    // Decode at least one token so the sampler reads fresh logits.
    reuse = std::min(reuse, tokens.size() - 1);
    // A sliding window keeps only its last positions; if the window ending at
    // `reuse` was already evicted, what remains cannot continue the prefix.
    const auto window = llama_model_n_swa(engine.model);
    if (window > 0 && reuse > 0 &&
        llama_memory_seq_pos_min(memory, 0) > std::max<llama_pos>(0, static_cast<llama_pos>(reuse) - window))
        reuse = 0;
    if (reuse == 0 || !llama_memory_seq_rm(memory, 0, static_cast<llama_pos>(reuse), -1)) {
        llama_memory_clear(memory, true);
        reuse = 0;
    }
    engine.cached.assign(tokens.begin(), tokens.begin() + static_cast<std::ptrdiff_t>(reuse));
    engine.progress_prompt.store(static_cast<uint32_t>(tokens.size()), std::memory_order_relaxed);
    engine.progress_reused.store(static_cast<uint32_t>(reuse), std::memory_order_relaxed);
    engine.progress_processed.store(static_cast<uint32_t>(reuse), std::memory_order_relaxed);
    engine.progress_phase.store(GEZEL_LLAMA_PHASE_PROMPT, std::memory_order_release);
    // A checkpoint needs a token left to decode after it, so the prompt's last
    // token goes in its own batch.
    const size_t checkpoint_at = engine.reusable_memory ? 0 : tokens.size() - 1;
    for (size_t offset = reuse; offset < tokens.size();) {
        if (engine.stopped()) return stop_error(engine, error);
        if (offset == checkpoint_at && checkpoint_at > 0) {
            const auto bytes = llama_state_seq_get_size_ext(engine.context, 0, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
            engine.checkpoint.resize(bytes);
            const bool saved = bytes > 0 &&
                llama_state_seq_get_data_ext(engine.context, engine.checkpoint.data(), bytes, 0, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY) == bytes;
            if (saved) engine.checkpoint_tokens.assign(tokens.begin(), tokens.begin() + static_cast<std::ptrdiff_t>(offset));
            else { engine.checkpoint.clear(); engine.checkpoint_tokens.clear(); }
        }
        const auto end = offset < checkpoint_at ? checkpoint_at : tokens.size();
        const auto n = static_cast<int32_t>(std::min<size_t>(engine.batch_tokens, end - offset));
        const auto status = llama_decode(engine.context, llama_batch_get_one(tokens.data() + offset, n));
        if (engine.stopped()) return stop_error(engine, error);
        if (status != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Prompt decoding failed");
        engine.cached.insert(engine.cached.end(), tokens.begin() + static_cast<std::ptrdiff_t>(offset),
                             tokens.begin() + static_cast<std::ptrdiff_t>(offset + static_cast<size_t>(n)));
        offset += static_cast<size_t>(n);
        engine.progress_processed.store(static_cast<uint32_t>(offset), std::memory_order_relaxed);
    }
    engine.progress_phase.store(GEZEL_LLAMA_PHASE_GENERATING, std::memory_order_release);
    auto params = llama_sampler_chain_default_params();
    params.no_perf = true;
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(llama_sampler_chain_init(params), llama_sampler_free);
    // The catalog's per-model sampling reaches phones through these fields;
    // before 2026-09-27 no host set them and every phone reply was greedy, so
    // a 0.8B model re-emitted an identical tool call until the turn's action
    // limit. The penalty runs before greedy selection as well as sampling.
    if (options.repeat_penalty != 1.0f && options.repeat_last_n > 0)
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_penalties(
            llama_vocab_n_tokens(llama_model_get_vocab(engine.model)),
            static_cast<int32_t>(options.repeat_last_n), options.repeat_penalty, 0.0f, 0.0f));
    if (options.temperature == 0) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        if (options.top_k > 0)
            llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(static_cast<int32_t>(options.top_k)));
        if (options.top_p < 1.0f) llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(options.top_p, 1));
        if (options.min_p > 0.0f) llama_sampler_chain_add(sampler.get(), llama_sampler_init_min_p(options.min_p, 1));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(options.temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(options.seed));
    }
    gezel_mobile::utf8_stream decoder;
    auto emit = [&](const std::string & text) -> int32_t {
        if (text.empty()) return GEZEL_LLAMA_OK;
        if (engine.stopped()) return stop_error(engine, error);
        if (text.size() > options.max_output_bytes - result.output_bytes)
            return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Generated output exceeds its byte limit");
        result.output_bytes += text.size();
        if (callback(text.data(), text.size(), user_data) != 0) gezel_llama_cancel(&engine, options.request_id);
        // The caller asked to stop after receiving this chunk; the loop above
        // notices and ends the reply gracefully with what has been produced.
        return GEZEL_LLAMA_OK;
    };
    result.finish_reason = GEZEL_LLAMA_FINISH_LENGTH;
    while (result.generated_tokens < options.max_tokens) {
        // Past the first token a stop ends the reply rather than failing it.
        if (const auto stop = engine.stopped()) {
            if (result.generated_tokens == 0) return stop_error(engine, error);
            result.finish_reason = finish_for_stop(stop);
            break;
        }
        auto token = llama_sampler_sample(sampler.get(), engine.context, -1);
        if (const auto stop = engine.stopped()) {
            if (result.generated_tokens == 0) return stop_error(engine, error);
            result.finish_reason = finish_for_stop(stop);
            break;
        }
        if (llama_vocab_is_eog(vocab, token)) { result.finish_reason = GEZEL_LLAMA_FINISH_STOP; break; }
        ++result.generated_tokens;
        engine.progress_generated.store(result.generated_tokens, std::memory_order_relaxed);
        char small[256];
        auto length = llama_token_to_piece(vocab, token, small, sizeof(small), 0, false);
        std::vector<char> large;
        const char * bytes = small;
        if (length < 0) {
            if (length == INT32_MIN || -length > 65536)
                return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model token piece exceeds 64 KiB");
            large.resize(-length);
            length = llama_token_to_piece(vocab, token, large.data(), large.size(), 0, false);
            bytes = large.data();
        }
        if (length < 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Could not decode a model token");
        if (const auto status = emit(decoder.append(bytes, length)); status) return status;
        if (result.generated_tokens < options.max_tokens) {
            const auto status = llama_decode(engine.context, llama_batch_get_one(&token, 1));
            if (engine.stopped()) return stop_error(engine, error);
            if (status != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Token decoding failed");
            engine.cached.push_back(token);
        }
    }
    if (engine.stopped()) return stop_error(engine, error);
    return emit(decoder.append("", 0, true));
}
}

extern "C" {
uint32_t gezel_llama_abi_version(void) { return GEZEL_LLAMA_ABI_VERSION; }
gezel_llama_load_options gezel_llama_default_load_options(void) {
    return {sizeof(gezel_llama_load_options), GEZEL_LLAMA_ABI_VERSION, 0, 2048, 128, 2, 0, uint64_t{4} * 1024 * 1024 * 1024, 120000};
}
gezel_llama_generation_options gezel_llama_default_generation_options(void) {
    return {sizeof(gezel_llama_generation_options), GEZEL_LLAMA_ABI_VERSION, 0, 256, 60000, 1024 * 1024, 0.0f, 1,
            40, 0.95f, 0.0f, 1.0f, 64};
}
gezel_llama_engine * gezel_llama_create(void) {
    try {
        // The global backend registry outlives individual engine handles. Freeing
        // it when one handle closes could invalidate another handle's inference.
        static std::once_flag initialized;
        std::call_once(initialized, [] {
            load_cpu_variant();
            llama_backend_init();
        });
        return new gezel_llama_engine;
    } catch (...) { return nullptr; }
}
void gezel_llama_destroy(gezel_llama_engine * engine) { delete engine; }
void gezel_llama_cancel(gezel_llama_engine * engine, uint64_t request_id) {
    if (!engine || !valid_request(request_id)) return;
    engine->active_request.compare_exchange_strong(request_id, request_id | cancelled_bit, std::memory_order_acq_rel);
}
int32_t gezel_llama_unload(gezel_llama_engine * engine, gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    if (!engine) return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Engine is required");
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return fail(error, GEZEL_LLAMA_BUSY, "Engine is busy");
    engine->unload();
    return GEZEL_LLAMA_OK;
}
int32_t gezel_llama_load(gezel_llama_engine * engine, const char * path,
                       const gezel_llama_load_options * options, gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    if (!engine || !path || !valid_load_options(options) || !valid_request(options->request_id) ||
        !valid_timeout(options->timeout_ms))
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid model load options or ABI version");
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return fail(error, GEZEL_LLAMA_BUSY, "Engine is busy");
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    engine->begin_progress(GEZEL_LLAMA_PHASE_LOADING);
    int32_t status;
    try { status = load_impl(*engine, path, config, error); }
    catch (const std::bad_alloc &) { status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient memory to load the model"); }
    catch (...) { status = fail(error, GEZEL_LLAMA_LOAD_FAILED, "Unexpected native model loading failure"); }
    if (status != GEZEL_LLAMA_OK) engine->unload();
    engine->progress_phase.store(GEZEL_LLAMA_PHASE_IDLE, std::memory_order_release);
    return status;
}
int32_t gezel_llama_get_progress(gezel_llama_engine * engine, gezel_llama_progress * progress) {
    if (!engine || !progress || progress->struct_size != sizeof(*progress) ||
        progress->abi_version != GEZEL_LLAMA_ABI_VERSION)
        return GEZEL_LLAMA_INVALID_ARGUMENT;
    progress->phase = engine->progress_phase.load(std::memory_order_acquire);
    progress->load_fraction = engine->progress_load.load(std::memory_order_relaxed);
    progress->prompt_tokens = engine->progress_prompt.load(std::memory_order_relaxed);
    progress->processed_tokens = engine->progress_processed.load(std::memory_order_relaxed);
    progress->reused_tokens = engine->progress_reused.load(std::memory_order_relaxed);
    progress->generated_tokens = engine->progress_generated.load(std::memory_order_relaxed);
    return GEZEL_LLAMA_OK;
}
int32_t gezel_llama_estimate_memory(gezel_llama_engine * engine, const char * path,
                                  const gezel_llama_load_options * options,
                                  gezel_llama_memory_estimate * estimate, gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    if (!engine || !path || !valid_load_options(options) || !estimate ||
        estimate->struct_size != sizeof(*estimate) || estimate->abi_version != GEZEL_LLAMA_ABI_VERSION)
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid memory estimate options or ABI version");
    gezel_llama_memory_estimate result{sizeof(result), GEZEL_LLAMA_ABI_VERSION, 0, 0, 0, 0};
    int32_t status;
    try { status = estimate_impl(path, *options, result, error); }
    catch (const std::bad_alloc &) { status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient memory to size the model"); }
    catch (...) { status = fail(error, GEZEL_LLAMA_LOAD_FAILED, "Unexpected native model sizing failure"); }
    if (status == GEZEL_LLAMA_OK) *estimate = result;
    return status;
}
int32_t gezel_llama_generate(gezel_llama_engine * engine, const gezel_llama_message * messages, size_t count,
                           const gezel_llama_generation_options * options, gezel_llama_chunk_callback callback,
                           void * user_data, gezel_llama_result * result, gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    gezel_llama_result local{};
    auto & output = result ? *result : local;
    output = {};
    auto finish = [&](int32_t status) {
        output.status = status;
        if (status != GEZEL_LLAMA_OK) output.finish_reason = status == GEZEL_LLAMA_CANCELLED ? GEZEL_LLAMA_FINISH_CANCELLED :
            status == GEZEL_LLAMA_TIMEOUT ? GEZEL_LLAMA_FINISH_TIMEOUT : GEZEL_LLAMA_FINISH_ERROR;
        return status;
    };
    if (!engine || !messages || !callback || count == 0 || count > 128 || !options || options->struct_size != sizeof(*options) ||
        options->abi_version != GEZEL_LLAMA_ABI_VERSION || !valid_request(options->request_id) ||
        !valid_timeout(options->timeout_ms) || options->max_tokens < 1 || options->max_tokens > 4096 ||
        options->max_output_bytes < 1 || options->max_output_bytes > 4 * 1024 * 1024 ||
        !std::isfinite(options->temperature) || options->temperature < 0 || options->temperature > 2 ||
        options->top_k > 1000 || !std::isfinite(options->top_p) || options->top_p <= 0 || options->top_p > 1 ||
        !std::isfinite(options->min_p) || options->min_p < 0 || options->min_p >= 1 ||
        !std::isfinite(options->repeat_penalty) || options->repeat_penalty < 1 || options->repeat_penalty > 2 ||
        options->repeat_last_n > 4096)
        return finish(fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid generation options or ABI version"));
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return finish(fail(error, GEZEL_LLAMA_BUSY, "Engine is busy"));
    if (!engine->model || !engine->context) return finish(fail(error, GEZEL_LLAMA_NOT_LOADED, "No model is loaded"));
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    engine->begin_progress(GEZEL_LLAMA_PHASE_PROMPT);
    int32_t status;
    try { status = generate_impl(*engine, messages, count, config, callback, user_data, output, error); }
    catch (const std::bad_alloc &) { status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient inference memory"); }
    catch (...) { status = fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Unexpected native inference failure"); }
    // Metal decode can return before GPU work completes; wait before touching
    // memory, including when cancellation skipped the next logits read.
    llama_synchronize(engine->context);
    // An aborted decode may leave partially evaluated batches, so only a request
    // that finished cleanly keeps its memory for the next one to reuse. A reply
    // stopped after its first token still finished cleanly: every decoded token
    // is in `cached`, and nothing else is in memory.
    if (status != GEZEL_LLAMA_OK) {
        llama_memory_clear(llama_get_memory(engine->context), true);
        engine->cached.clear();
    }
    engine->progress_phase.store(GEZEL_LLAMA_PHASE_IDLE, std::memory_order_release);
    return finish(status);
}
}
