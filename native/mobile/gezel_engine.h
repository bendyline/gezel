#pragma once

// Internal to the bridge: the engine both the v1 text API (gezel_llama.cpp)
// and the chat API (gezel_chat.cpp) drive. Not installed with the SDK.

#include "gezel_llama.h"
#include "chat.h"
#include "llama.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace gezel_mobile {
using clock_type = std::chrono::steady_clock;
constexpr uint64_t cancelled_bit = uint64_t{1} << 63;

/** What llama-server takes from its launch flags; `gezel_llama_configure_chat` sets it. */
struct chat_config {
    std::string chat_template;
    common_reasoning_format reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
    int reasoning_budget = -1;
    std::string reasoning_budget_message;
    bool enable_thinking = true;
    bool prefill_assistant = true;
    std::map<std::string, std::string> chat_template_kwargs;
};
}

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
    gezel_mobile::clock_type::time_point deadline;
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
    // For those models, copies of the state attention memory cannot rebuild,
    // each taken one token before the end of a prompt, with the tokens it
    // covers; oldest first. Every model a 6 GB phone can hold is hybrid or
    // windowed, so without these each tool step re-reads the whole prompt.
    // Qwen 3.5 2B's is 19 MiB at any prompt length; its turn 2 fell from
    // 10.9 s to 0.6 s with identical output. One is not enough: a transcript
    // re-rendered from an earlier point (a template that drops an older
    // turn's reasoning) no longer starts with the last prompt, and Gemma 4
    // E4B then re-read 5,000 tokens (~150 s) on every third request
    // (2026-09-30). llama-server keeps a list for the same reason.
    struct prompt_checkpoint {
        std::vector<llama_token> tokens;
        std::vector<uint8_t> data;
    };
    std::vector<prompt_checkpoint> checkpoints;
    // llama.cpp's chat layer for the loaded model, created on first use so a
    // template the Jinja renderer cannot parse fails that request, not the load.
    gezel_mobile::chat_config chat;
    common_chat_templates_ptr chat_templates;

    void unload() {
        if (context) llama_free(context);
        context = nullptr;
        if (model) llama_model_free(model);
        model = nullptr;
        if (model_file) std::fclose(model_file);
        model_file = nullptr;
        chat_template.clear();
        chat_templates.reset();
        cached.clear();
        checkpoints.clear();
    }
    ~gezel_llama_engine() { unload(); }
    int32_t stopped() const {
        if (active_request.load(std::memory_order_acquire) & gezel_mobile::cancelled_bit) return GEZEL_LLAMA_CANCELLED;
        if (gezel_mobile::clock_type::now() >= deadline) return GEZEL_LLAMA_TIMEOUT;
        return GEZEL_LLAMA_OK;
    }
};

namespace gezel_mobile {
inline int32_t fail(gezel_llama_error * error, int32_t status, const char * message) {
    if (error) {
        error->code = status;
        std::snprintf(error->message, sizeof(error->message), "%s", message);
    }
    return status;
}

/** Marks the engine busy with one request until it goes out of scope. */
struct operation {
    gezel_llama_engine & engine;
    operation(gezel_llama_engine & value, uint64_t request, uint32_t timeout) : engine(value) {
        engine.deadline = clock_type::now() + std::chrono::milliseconds(timeout);
        engine.active_request.store(request, std::memory_order_release);
    }
    ~operation() { engine.active_request.store(0, std::memory_order_release); }
};

inline bool valid_request(uint64_t id) { return id != 0 && (id & cancelled_bit) == 0; }
// Hosts scale a reply's deadline with its budget (30 s plus 250 ms a token);
// a 4096-token reply needs the full ten minutes on a phone.
inline bool valid_timeout(uint32_t value) { return value > 0 && value <= 600000; }

inline int32_t stop_error(gezel_llama_engine & engine, gezel_llama_error * error) {
    const auto status = engine.stopped();
    return fail(error, status, status == GEZEL_LLAMA_CANCELLED ? "Request cancelled" : "Request timed out");
}

/**
 * Brings the context's memory to exactly `tokens`, reusing what the previous
 * request left where this prompt starts the same way, and decodes the rest. The
 * last token's logits are ready for sampling afterwards. Returns the number of
 * tokens reused through `reused`. For a model whose memory cannot drop a suffix,
 * `checkpoints` are the prompt positions to save state at.
 */
int32_t decode_prompt(gezel_llama_engine & engine, const std::vector<llama_token> & tokens, size_t & reused,
                      gezel_llama_error * error, const std::vector<size_t> & checkpoints);

/** Leaves the engine ready for the next request after one ends. */
void finish_request(gezel_llama_engine & engine, int32_t status);
}
