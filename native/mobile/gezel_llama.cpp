#include "gezel_llama.h"
#include "utf8_stream.h"
#include "llama.h"
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

using clock_type = std::chrono::steady_clock;
constexpr uint64_t cancelled_bit = uint64_t{1} << 63;
constexpr size_t max_prompt_bytes = 1024 * 1024;
constexpr size_t max_input_bytes = 256 * 1024;

struct gezel_llama_engine {
    std::mutex mutex;
    std::atomic<uint64_t> active_request{0};
    clock_type::time_point deadline;
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    FILE * model_file = nullptr;
    uint32_t batch_tokens = 0;
    uint32_t context_tokens = 0;
    std::string chat_template;

    void unload() {
        if (context) llama_free(context);
        context = nullptr;
        if (model) llama_model_free(model);
        model = nullptr;
        if (model_file) std::fclose(model_file);
        model_file = nullptr;
        chat_template.clear();
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
bool load_progress(float, void * data) { return !abort_decode(data); }
bool valid_request(uint64_t id) { return id != 0 && (id & cancelled_bit) == 0; }
bool valid_timeout(uint32_t value) { return value > 0 && value <= 300000; }

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

int32_t load_impl(gezel_llama_engine & engine, const char * path,
                 const gezel_llama_load_options & options, gezel_llama_error * error) {
    engine.unload();
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
    engine.model_file = ::fdopen(descriptor, "rb");
    if (!engine.model_file) {
        ::close(descriptor);
        return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Could not open the model file stream");
    }
    if (static_cast<uint64_t>(info.st_size) > options.max_model_bytes)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model file exceeds the configured byte limit");

    // Refuse multi-file models before llama's loader can open additional files
    // outside the single imported file whose size/ownership the host admitted.
    std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
        gguf_init_from_file_ptr(engine.model_file, {true, nullptr}), gguf_free);
    if (!metadata) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Invalid GGUF model metadata");
    const auto split = gguf_find_key(metadata.get(), "split.count");
    if (split >= 0 && (gguf_get_kv_type(metadata.get(), split) != GGUF_TYPE_UINT16 ||
                      gguf_get_val_u16(metadata.get(), split) > 1))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Split GGUF models are not supported on mobile");
    metadata.reset();
    std::rewind(engine.model_file);
    if (engine.stopped()) return stop_error(engine, error);
    if (options.gpu_layers != 0 && !llama_supports_gpu_offload())
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "This library has no GPU backend; use gpu_layers=0");

    auto params = llama_model_default_params();
    params.n_gpu_layers = options.gpu_layers;
    params.progress_callback = load_progress;
    params.progress_callback_user_data = &engine;
    engine.model = llama_model_load_from_file_ptr(engine.model_file, params);
    if (engine.stopped()) return stop_error(engine, error);
    if (!engine.model) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "llama.cpp could not load the model");
    if (llama_model_has_encoder(engine.model) || !llama_model_has_decoder(engine.model))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Only decoder text models are supported");
    if (llama_model_n_ctx_train(engine.model) < static_cast<int32_t>(options.context_tokens))
        return fail(error, GEZEL_LLAMA_CONTEXT_LIMIT, "Requested context exceeds the model's trained context");
    const char * chat = llama_model_chat_template(engine.model, nullptr);
    if (!chat || !*chat) return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model does not declare a chat template");
    if (strnlen(chat, max_prompt_bytes + 1) > max_prompt_bytes)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model chat template exceeds the byte limit");
    const llama_chat_message probe[] = {{"user", "Hello"}};
    if (llama_chat_apply_template(chat, probe, 1, true, nullptr, 0) < 0)
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model chat template requires an unsupported Jinja renderer");
    engine.chat_template = chat;
    auto context = llama_context_default_params();
    context.n_ctx = options.context_tokens;
    context.n_batch = options.batch_tokens;
    context.n_ubatch = options.batch_tokens;
    context.n_threads = options.threads;
    context.n_threads_batch = options.threads;
    context.n_seq_max = 1;
    context.abort_callback = abort_decode;
    context.abort_callback_data = &engine;
    context.no_perf = true;
    engine.context = llama_init_from_model(engine.model, context);
    if (engine.stopped()) return stop_error(engine, error);
    if (!engine.context) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Could not allocate the model context");
    if (!llama_get_memory(engine.context))
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Model does not support the required decoder memory");
    engine.context_tokens = std::min(options.context_tokens, llama_n_ctx(engine.context));
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
    const auto size = llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, nullptr, 0);
    if (size < 0) return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Chat template cannot format this transcript");
    if (size == 0 || static_cast<size_t>(size) > max_prompt_bytes)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Formatted prompt exceeds its byte limit");
    std::vector<char> prompt(static_cast<size_t>(size) + 1);
    if (llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, prompt.data(), prompt.size()) != size)
        return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Chat template size changed unexpectedly");
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
    llama_memory_clear(llama_get_memory(engine.context), true);
    for (size_t offset = 0; offset < tokens.size(); offset += engine.batch_tokens) {
        if (engine.stopped()) return stop_error(engine, error);
        const auto n = static_cast<int32_t>(std::min<size_t>(engine.batch_tokens, tokens.size() - offset));
        const auto status = llama_decode(engine.context, llama_batch_get_one(tokens.data() + offset, n));
        if (engine.stopped()) return stop_error(engine, error);
        if (status != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Prompt decoding failed");
    }
    auto params = llama_sampler_chain_default_params();
    params.no_perf = true;
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(llama_sampler_chain_init(params), llama_sampler_free);
    if (options.temperature == 0) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(40));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(0.95f, 1));
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
    return {sizeof(gezel_llama_generation_options), GEZEL_LLAMA_ABI_VERSION, 0, 256, 60000, 1024 * 1024, 0.0f, 1};
}
gezel_llama_engine * gezel_llama_create(void) {
    try {
        // The global backend registry outlives individual engine handles. Freeing
        // it when one handle closes could invalidate another handle's inference.
        static std::once_flag initialized;
        std::call_once(initialized, [] { llama_backend_init(); });
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
    if (!engine || !path || !options || options->struct_size != sizeof(*options) || options->abi_version != GEZEL_LLAMA_ABI_VERSION ||
        !valid_request(options->request_id) || !valid_timeout(options->timeout_ms) ||
        options->context_tokens < 256 || options->context_tokens > 8192 || options->batch_tokens < 1 ||
        options->batch_tokens > 512 || options->batch_tokens > options->context_tokens ||
        options->threads < 1 || options->threads > 8 || options->gpu_layers < -1 || options->gpu_layers > 256 ||
        options->max_model_bytes == 0 || options->max_model_bytes > uint64_t{8} * 1024 * 1024 * 1024)
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid model load options or ABI version");
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return fail(error, GEZEL_LLAMA_BUSY, "Engine is busy");
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    int32_t status;
    try { status = load_impl(*engine, path, config, error); }
    catch (const std::bad_alloc &) { status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient memory to load the model"); }
    catch (...) { status = fail(error, GEZEL_LLAMA_LOAD_FAILED, "Unexpected native model loading failure"); }
    if (status != GEZEL_LLAMA_OK) engine->unload();
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
        !std::isfinite(options->temperature) || options->temperature < 0 || options->temperature > 2)
        return finish(fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid generation options or ABI version"));
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return finish(fail(error, GEZEL_LLAMA_BUSY, "Engine is busy"));
    if (!engine->model || !engine->context) return finish(fail(error, GEZEL_LLAMA_NOT_LOADED, "No model is loaded"));
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    int32_t status;
    try { status = generate_impl(*engine, messages, count, config, callback, user_data, output, error); }
    catch (const std::bad_alloc &) { status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient inference memory"); }
    catch (...) { status = fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Unexpected native inference failure"); }
    // Aborted decode may leave partially evaluated batches. No state from a
    // failed or completed request may affect the next full-transcript request.
    // Metal decode can return before GPU work completes; wait before clearing
    // buffers, including when cancellation skipped the next logits read.
    llama_synchronize(engine->context);
    llama_memory_clear(llama_get_memory(engine->context), true);
    return finish(status);
}
}
