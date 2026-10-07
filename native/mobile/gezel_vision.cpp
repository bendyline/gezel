// gezel_llama_describe_image: one picture in, a description out, through the
// loaded model's mtmd vision projector. The phone's fallback describer for a
// device whose OS has none (an iPhone without Apple Intelligence).

#include "gezel_engine.h"
#include "chat_formats.h"
#include "utf8_stream.h"
#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

using namespace gezel_mobile;

namespace {
constexpr uint32_t max_image_side = 4096;
constexpr uint32_t max_description_tokens = 1024;
constexpr size_t max_instruction_bytes = 16 * 1024;
constexpr size_t max_prompt_bytes = 64 * 1024;
// The reply needs at least this much of the window after the picture.
constexpr uint32_t minimum_description_tokens = 64;

bool valid_options(const gezel_llama_image_options * options) {
    return options && options->struct_size == sizeof(*options) && options->abi_version == GEZEL_LLAMA_ABI_VERSION &&
        valid_request(options->request_id) && valid_timeout(options->timeout_ms) && options->max_tokens >= 1 &&
        options->max_tokens <= max_description_tokens && options->max_output_bytes >= 1 &&
        options->max_output_bytes <= 1024 * 1024 && std::isfinite(options->temperature) &&
        options->temperature >= 0 && options->temperature <= 2 && options->image_max_tokens <= 4096 &&
        options->max_projector_bytes > 0;
}

bool valid_text(const char * text, size_t & size) {
    size = strnlen(text, max_instruction_bytes + 1);
    return size <= max_instruction_bytes && utf8_stream::valid(text, size);
}

/** The projector is one regular local file, like the model; llama.cpp opens it by name. */
int32_t check_projector(const char * path, uint64_t limit, gezel_llama_error * error) {
    const int descriptor = ::open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    struct stat info{};
    if (descriptor < 0)
        return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Projector path must name a readable regular GGUF file");
    const bool regular = ::fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode) && info.st_size > 0;
    ::close(descriptor);
    if (!regular) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "Projector path must name a readable regular GGUF file");
    if (static_cast<uint64_t>(info.st_size) > limit)
        return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Projector file exceeds the configured byte limit");
    return GEZEL_LLAMA_OK;
}

int32_t open_projector(gezel_llama_engine & engine, const char * path, const gezel_llama_image_options & options,
                       gezel_llama_error * error) {
    // The token cap is a load-time setting, so it is part of what is cached.
    const std::string key = std::string(path) + "#" + std::to_string(options.image_max_tokens);
    if (engine.projector && engine.projector_path == key) return GEZEL_LLAMA_OK;
    engine.unload_projector();
    if (const auto status = check_projector(path, options.max_projector_bytes, error); status) return status;
    auto params = mtmd_context_params_default();
    params.use_gpu = llama_supports_gpu_offload();
    params.print_timings = false;
    params.n_threads = static_cast<int>(std::max(1, llama_n_threads(engine.context)));
    params.warmup = false;
    if (options.image_max_tokens > 0) params.image_max_tokens = static_cast<int>(options.image_max_tokens);
    engine.projector = mtmd_init_from_file(path, engine.model, params);
    if (engine.stopped()) {
        engine.unload_projector();
        return stop_error(engine, error);
    }
    if (!engine.projector) return fail(error, GEZEL_LLAMA_LOAD_FAILED, "llama.cpp could not load the vision projector");
    if (!mtmd_support_vision(engine.projector)) {
        engine.unload_projector();
        return fail(error, GEZEL_LLAMA_UNSUPPORTED, "This projector does not read images");
    }
    engine.projector_path = key;
    return GEZEL_LLAMA_OK;
}

int32_t format_prompt(gezel_llama_engine & engine, const char * system, const char * user, std::string & prompt,
                      gezel_llama_error * error) {
    // The picture leads the turn, the way llama-server places a leading image part.
    const std::string content = std::string(mtmd_default_marker()) + "\n" + user;
    std::vector<llama_chat_message> chat;
    if (system && *system) chat.push_back({"system", system});
    chat.push_back({"user", content.c_str()});
    if (engine.gemma4_turns) {
        prompt = chat_formats::gemma4(chat);
    } else {
        const auto size = llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, nullptr, 0);
        if (size <= 0) return fail(error, GEZEL_LLAMA_UNSUPPORTED, "Chat template cannot format an image turn");
        std::vector<char> buffer(static_cast<size_t>(size) + 1);
        if (llama_chat_apply_template(engine.chat_template.c_str(), chat.data(), chat.size(), true, buffer.data(),
                                      buffer.size()) != size)
            return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Chat template size changed unexpectedly");
        prompt.assign(buffer.data(), static_cast<size_t>(size));
    }
    // A model with a thinking switch (Qwen 3.x) answers straight when its turn
    // opens with an empty reasoning block, which is what its template writes
    // for enable_thinking=false. A description has nothing to reason about.
    if (engine.chat_template.find("<think>") != std::string::npos && prompt.find("<think>") == std::string::npos)
        prompt += "<think>\n\n</think>\n\n";
    if (prompt.size() > max_prompt_bytes) return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Formatted prompt exceeds its byte limit");
    return GEZEL_LLAMA_OK;
}

int32_t describe_impl(gezel_llama_engine & engine, const char * projector_path, const uint8_t * rgb, uint32_t width,
                      uint32_t height, const char * system, const char * user, const gezel_llama_image_options & options,
                      gezel_llama_chunk_callback callback, void * user_data, gezel_llama_result & result,
                      gezel_llama_error * error) {
    if (const auto status = open_projector(engine, projector_path, options, error); status) return status;
    std::string prompt;
    if (const auto status = format_prompt(engine, system, user, prompt, error); status) return status;

    // Image embeddings are not tokens the next chat request could match, so
    // the call owns the whole memory and gives it back empty.
    llama_memory_clear(llama_get_memory(engine.context), true);
    engine.cached.clear();
    engine.checkpoints.clear();

    std::unique_ptr<mtmd_bitmap, decltype(&mtmd_bitmap_free)> bitmap(mtmd_bitmap_init(width, height, rgb), mtmd_bitmap_free);
    std::unique_ptr<mtmd_input_chunks, decltype(&mtmd_input_chunks_free)> chunks(mtmd_input_chunks_init(),
                                                                                 mtmd_input_chunks_free);
    if (!bitmap || !chunks) return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient memory for the picture");
    const mtmd_input_text text{prompt.c_str(), prompt.size(), true, true};
    const mtmd_bitmap * bitmaps[] = {bitmap.get()};
    if (mtmd_tokenize(engine.projector, chunks.get(), &text, bitmaps, 1) != 0)
        return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "The picture could not be prepared for the model");
    result.prompt_tokens = static_cast<uint32_t>(mtmd_helper_get_n_tokens(chunks.get()));
    engine.progress_prompt.store(result.prompt_tokens, std::memory_order_relaxed);
    const auto positions = static_cast<uint32_t>(std::max<llama_pos>(0, mtmd_helper_get_n_pos(chunks.get())));
    const uint32_t room = positions < engine.context_tokens ? engine.context_tokens - positions : 0;
    if (room < std::min(options.max_tokens, minimum_description_tokens))
        return fail(error, GEZEL_LLAMA_CONTEXT_LIMIT, "The picture needs more context than the loaded model has");
    const uint32_t max_tokens = std::min(options.max_tokens, room);

    llama_pos past = 0;
    const auto evaluated = mtmd_helper_eval_chunks(engine.projector, engine.context, chunks.get(), 0, 0,
                                                   static_cast<int32_t>(std::max<uint32_t>(engine.batch_tokens, 1)),
                                                   true, &past);
    if (engine.stopped()) return stop_error(engine, error);
    if (evaluated != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "The model could not read the picture");
    engine.progress_processed.store(result.prompt_tokens, std::memory_order_relaxed);
    engine.progress_phase.store(GEZEL_LLAMA_PHASE_GENERATING, std::memory_order_release);

    const llama_vocab * vocab = llama_model_get_vocab(engine.model);
    auto params = llama_sampler_chain_default_params();
    params.no_perf = true;
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(llama_sampler_chain_init(params), llama_sampler_free);
    // A sub-1B describer otherwise repeats a phrase until its budget runs out.
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), 64, 1.05f, 0.0f, 0.0f));
    if (options.temperature == 0) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(40));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(0.95f, 1));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(options.temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(options.seed));
    }
    std::unique_ptr<llama_batch, void (*)(llama_batch *)> batch(new llama_batch(llama_batch_init(1, 0, 1)),
        [](llama_batch * value) { llama_batch_free(*value); delete value; });

    utf8_stream decoder;
    auto emit = [&](const std::string & piece) -> int32_t {
        if (piece.empty()) return GEZEL_LLAMA_OK;
        if (piece.size() > options.max_output_bytes - result.output_bytes)
            return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Generated output exceeds its byte limit");
        result.output_bytes += piece.size();
        if (callback(piece.data(), piece.size(), user_data) != 0) gezel_llama_cancel(&engine, options.request_id);
        return GEZEL_LLAMA_OK;
    };
    result.finish_reason = GEZEL_LLAMA_FINISH_LENGTH;
    while (result.generated_tokens < max_tokens) {
        if (const auto stop = engine.stopped()) {
            if (result.generated_tokens == 0) return stop_error(engine, error);
            result.finish_reason = stop == GEZEL_LLAMA_CANCELLED ? GEZEL_LLAMA_FINISH_CANCELLED : GEZEL_LLAMA_FINISH_TIMEOUT;
            break;
        }
        const auto token = llama_sampler_sample(sampler.get(), engine.context, -1);
        if (llama_vocab_is_eog(vocab, token)) {
            result.finish_reason = GEZEL_LLAMA_FINISH_STOP;
            break;
        }
        ++result.generated_tokens;
        engine.progress_generated.store(result.generated_tokens, std::memory_order_relaxed);
        char small[256];
        auto length = llama_token_to_piece(vocab, token, small, sizeof(small), 0, false);
        std::vector<char> large;
        const char * bytes = small;
        if (length < 0) {
            if (length == INT32_MIN || -length > 65536)
                return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Model token piece exceeds 64 KiB");
            large.resize(static_cast<size_t>(-length));
            length = llama_token_to_piece(vocab, token, large.data(), static_cast<int32_t>(large.size()), 0, false);
            bytes = large.data();
        }
        if (length < 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Could not decode a model token");
        if (const auto status = emit(decoder.append(bytes, static_cast<size_t>(length))); status) return status;
        if (result.generated_tokens >= max_tokens) break;
        // Explicit positions: after an M-RoPE picture the next text position
        // is the chunk helper's count, not the memory's highest position + 1.
        batch->n_tokens = 1;
        batch->token[0] = token;
        batch->pos[0] = past++;
        batch->n_seq_id[0] = 1;
        batch->seq_id[0][0] = 0;
        batch->logits[0] = true;
        const auto status = llama_decode(engine.context, *batch);
        if (engine.stopped()) return stop_error(engine, error);
        if (status != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Token decoding failed");
    }
    return emit(decoder.append("", 0, true));
}
}

extern "C" {
gezel_llama_image_options gezel_llama_default_image_options(void) {
    return {sizeof(gezel_llama_image_options), GEZEL_LLAMA_ABI_VERSION, 0, 120000, 400, 64 * 1024, 0.1f, 1, 256,
            uint64_t{2} * 1024 * 1024 * 1024};
}

int32_t gezel_llama_describe_image(gezel_llama_engine * engine, const char * projector_path, const uint8_t * rgb,
                                   uint32_t width, uint32_t height, const char * system_prompt, const char * user_prompt,
                                   const gezel_llama_image_options * options, gezel_llama_chunk_callback on_chunk,
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
    size_t system_size = 0, user_size = 0;
    if (!engine || !projector_path || !rgb || !user_prompt || !on_chunk || !valid_options(options) || width < 1 ||
        height < 1 || width > max_image_side || height > max_image_side ||
        (system_prompt && !valid_text(system_prompt, system_size)) || !valid_text(user_prompt, user_size) ||
        std::strstr(user_prompt, mtmd_default_marker()) != nullptr)
        return finish(fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid image description request or ABI version"));
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return finish(fail(error, GEZEL_LLAMA_BUSY, "Engine is busy"));
    if (!engine->model || !engine->context) return finish(fail(error, GEZEL_LLAMA_NOT_LOADED, "No model is loaded"));
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    engine->begin_progress(GEZEL_LLAMA_PHASE_PROMPT);
    int32_t status;
    try {
        status = describe_impl(*engine, projector_path, rgb, width, height, system_prompt, user_prompt, config, on_chunk,
                               user_data, output, error);
    } catch (const std::bad_alloc &) {
        status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient memory to read the picture");
    } catch (...) {
        status = fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Unexpected native image description failure");
    }
    llama_synchronize(engine->context);
    llama_memory_clear(llama_get_memory(engine->context), true);
    engine->cached.clear();
    engine->last_status = status;
    engine->progress_phase.store(GEZEL_LLAMA_PHASE_IDLE, std::memory_order_release);
    return finish(status);
}
}
