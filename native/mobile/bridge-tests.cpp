#include "gezel_llama.h"
#include "utf8_stream.h"
#include "ggml.h"
#include "gguf.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <future>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <sys/stat.h>
#include <vector>

static void check(bool condition, const char * expression) {
    if (!condition) throw std::runtime_error(expression);
}
#define CHECK(expression) check((expression), #expression)

// Deterministic, deliberately untrained one-layer Llama fixture. All inputs
// produce token "a". This tests the actual tokenizer/context/decode/stream path
// without downloads or a proprietary model, and makes no model-quality claim.
static void write_fixture(const char * path, const char * chat_template = "chatml", uint16_t splits = 1) {
    auto * context = ggml_init({1024 * 1024, nullptr, false});
    auto * file = gguf_init_empty();
    CHECK(context && file);
    gguf_set_val_str(file, "general.architecture", "llama");
    gguf_set_val_str(file, "general.name", "Gezel deterministic native test fixture");
    gguf_set_val_u32(file, "llama.context_length", 2048);
    gguf_set_val_u32(file, "llama.embedding_length", 32);
    gguf_set_val_u32(file, "llama.block_count", 1);
    gguf_set_val_u32(file, "llama.feed_forward_length", 64);
    gguf_set_val_u32(file, "llama.attention.head_count", 4);
    gguf_set_val_u32(file, "llama.attention.head_count_kv", 4);
    gguf_set_val_u32(file, "llama.rope.dimension_count", 8);
    gguf_set_val_f32(file, "llama.attention.layer_norm_rms_epsilon", 0.00001f);
    gguf_set_val_str(file, "tokenizer.ggml.model", "llama");
    gguf_set_val_str(file, "tokenizer.chat_template", chat_template);
    gguf_set_val_u32(file, "tokenizer.ggml.unknown_token_id", 0);
    gguf_set_val_u32(file, "tokenizer.ggml.bos_token_id", 1);
    gguf_set_val_u32(file, "tokenizer.ggml.eos_token_id", 2);
    gguf_set_val_bool(file, "tokenizer.ggml.add_bos_token", true);
    gguf_set_val_u16(file, "split.count", splits);
    std::vector<std::string> tokens = {"<unk>", "<s>", "</s>", "\xe2\x96\x81", "a"};
    std::vector<int32_t> types = {2, 3, 3, 1, 1};
    for (int byte = 0; byte < 256; ++byte) {
        char value[8];
        std::snprintf(value, sizeof(value), "<0x%02X>", byte);
        tokens.emplace_back(value);
        types.push_back(6);
    }
    std::vector<const char *> pointers;
    for (const auto & token : tokens) pointers.push_back(token.c_str());
    std::vector<float> scores(tokens.size(), 0);
    gguf_set_arr_str(file, "tokenizer.ggml.tokens", pointers.data(), pointers.size());
    gguf_set_arr_data(file, "tokenizer.ggml.scores", GGUF_TYPE_FLOAT32, scores.data(), scores.size());
    gguf_set_arr_data(file, "tokenizer.ggml.token_type", GGUF_TYPE_INT32, types.data(), types.size());
    auto tensor = [&](const char * name, int64_t width, int64_t height, float fill) {
        auto * value = height == 0 ? ggml_new_tensor_1d(context, GGML_TYPE_F32, width) :
            ggml_new_tensor_2d(context, GGML_TYPE_F32, width, height);
        ggml_set_name(value, name);
        std::fill_n(static_cast<float *>(value->data), ggml_nelements(value), fill);
        gguf_add_tensor(file, value);
        return value;
    };
    tensor("token_embd.weight", 32, tokens.size(), 1);
    tensor("output_norm.weight", 32, 0, 1);
    auto * output = tensor("output.weight", 32, tokens.size(), 0);
    std::fill_n(static_cast<float *>(output->data) + 4 * 32, 32, 1);
    tensor("blk.0.attn_norm.weight", 32, 0, 1);
    tensor("blk.0.attn_q.weight", 32, 32, 0);
    tensor("blk.0.attn_k.weight", 32, 32, 0);
    tensor("blk.0.attn_v.weight", 32, 32, 0);
    tensor("blk.0.attn_output.weight", 32, 32, 0);
    tensor("blk.0.ffn_norm.weight", 32, 0, 1);
    tensor("blk.0.ffn_gate.weight", 32, 64, 0);
    tensor("blk.0.ffn_up.weight", 32, 64, 0);
    tensor("blk.0.ffn_down.weight", 64, 32, 0);
    CHECK(gguf_write_to_file(file, path, false));
    gguf_free(file);
    ggml_free(context);
}

static int32_t collect(const char * bytes, size_t length, void * data) {
    static_cast<std::string *>(data)->append(bytes, length);
    return 0;
}
static int32_t callback(const char * bytes, size_t length, void * data) {
    return (*static_cast<std::function<int32_t(const char *, size_t)> *>(data))(bytes, length);
}

static void utf8_tests() {
    const std::string unicode = "a\xe2\x82\xac\xf0\x9f\x98\x80z";
    gezel_mobile::utf8_stream stream;
    std::string joined;
    for (const char value : unicode) {
        const auto chunk = stream.append(&value, 1);
        CHECK(gezel_mobile::utf8_stream::valid(chunk.data(), chunk.size()));
        joined += chunk;
    }
    CHECK(joined == unicode);
    CHECK(stream.append("\xe2\x82", 2).empty());
    CHECK(stream.append("", 0, true) == "\xef\xbf\xbd");
    CHECK(!gezel_mobile::utf8_stream::valid("\xc0\x80", 2));
    CHECK(!gezel_mobile::utf8_stream::valid("\xed\xa0\x80", 3));
    CHECK(!gezel_mobile::utf8_stream::valid("\xf4\x90\x80\x80", 4));
    CHECK(!gezel_mobile::utf8_stream::valid("\xe2z", 2));
}

static void bridge_tests(const char * path) {
    using engine_ptr = std::unique_ptr<gezel_llama_engine, decltype(&gezel_llama_destroy)>;
    engine_ptr engine(gezel_llama_create(), gezel_llama_destroy);
    CHECK(engine != nullptr);
    CHECK(gezel_llama_abi_version() == 1);
    gezel_llama_error error{};
    gezel_llama_result result{};
    auto load = gezel_llama_default_load_options();
    load.context_tokens = 512;
    load.request_id = 1;
    auto generation = gezel_llama_default_generation_options();
    generation.max_tokens = 8;
    generation.request_id = 2;
    const gezel_llama_message message[] = {{"system", "Brief replies."}, {"user", "Hello"}};
    std::string text;
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_NOT_LOADED);
    CHECK(gezel_llama_load(engine.get(), "/does/not/exist.gguf", &load, &error) == GEZEL_LLAMA_LOAD_FAILED);
    const std::string fifo = std::string(path) + ".fifo";
    CHECK(::mkfifo(fifo.c_str(), 0600) == 0);
    CHECK(gezel_llama_load(engine.get(), fifo.c_str(), &load, &error) == GEZEL_LLAMA_LOAD_FAILED);
    CHECK(std::remove(fifo.c_str()) == 0);
    write_fixture(path);
    CHECK(gezel_llama_load(engine.get(), path, &load, &error) == GEZEL_LLAMA_OK);
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_OK);
    CHECK(text == "aaaaaaaa");
    CHECK(result.generated_tokens == 8 && result.output_bytes == 8);
    CHECK(result.prompt_tokens > 10 && result.finish_reason == GEZEL_LLAMA_FINISH_LENGTH);
    const auto first_tokens = result.prompt_tokens;

    const gezel_llama_message transcript[] = {{"user", "Hi"}, {"assistant", "Hello"}, {"user", "Again"}};
    text.clear();
    ++generation.request_id;
    CHECK(gezel_llama_generate(engine.get(), transcript, 3, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_OK);
    CHECK(text == "aaaaaaaa" && result.prompt_tokens != first_tokens);
    generation.max_tokens = 512;
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_CONTEXT_LIMIT);
    generation.max_tokens = 8;
    generation.max_output_bytes = 2;
    text.clear();
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_RESOURCE_LIMIT);
    CHECK(text == "aa" && result.output_bytes == 2);
    generation.max_output_bytes = 1024;

    // Hold the native callback while a second thread attempts unload/generate,
    // then issue cancellation from that other thread without touching llama state.
    ++generation.request_id;
    std::promise<void> chunk_seen, release_chunk;
    auto seen = chunk_seen.get_future();
    auto release = release_chunk.get_future();
    std::function<int32_t(const char *, size_t)> paused = [&](const char *, size_t) {
        chunk_seen.set_value();
        release.wait();
        return 0;
    };
    auto running = std::async(std::launch::async, [&] {
        return gezel_llama_generate(engine.get(), message, 2, &generation, callback, &paused, &result, &error);
    });
    if (seen.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
        release_chunk.set_value();
        CHECK(running.get() == GEZEL_LLAMA_OK);
        CHECK(false);
    }
    gezel_llama_error concurrent_error{};
    const auto unload_status = gezel_llama_unload(engine.get(), &concurrent_error);
    gezel_llama_result concurrent_result{};
    const auto overlapping_status = gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &concurrent_result, &concurrent_error);
    gezel_llama_cancel(engine.get(), generation.request_id);
    release_chunk.set_value();
    CHECK(running.get() == GEZEL_LLAMA_CANCELLED);
    CHECK(unload_status == GEZEL_LLAMA_BUSY && overlapping_status == GEZEL_LLAMA_BUSY);
    CHECK(result.finish_reason == GEZEL_LLAMA_FINISH_CANCELLED && result.generated_tokens == 1);

    const auto cancelled_id = generation.request_id++;
    std::function<int32_t(const char *, size_t)> stale_cancel = [&](const char * bytes, size_t size) {
        gezel_llama_cancel(engine.get(), cancelled_id);
        text.append(bytes, size);
        return 0;
    };
    text.clear();
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, callback, &stale_cancel, &result, &error) == GEZEL_LLAMA_OK);
    CHECK(text == "aaaaaaaa");
    std::function<int32_t(const char *, size_t)> cancel_now = [](const char *, size_t) { return 1; };
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, callback, &cancel_now, &result, &error) == GEZEL_LLAMA_CANCELLED);
    generation.timeout_ms = 10;
    std::function<int32_t(const char *, size_t)> slow = [](const char *, size_t) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20)); return 0;
    };
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, callback, &slow, &result, &error) == GEZEL_LLAMA_TIMEOUT);
    generation.timeout_ms = 60000;
    const gezel_llama_message invalid[] = {{"user", "\xff"}};
    CHECK(gezel_llama_generate(engine.get(), invalid, 1, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_INVALID_ARGUMENT);
    CHECK(gezel_llama_unload(engine.get(), &error) == GEZEL_LLAMA_OK);
    CHECK(gezel_llama_unload(engine.get(), &error) == GEZEL_LLAMA_OK);
    load.max_model_bytes = 1;
    CHECK(gezel_llama_load(engine.get(), path, &load, &error) == GEZEL_LLAMA_RESOURCE_LIMIT);
    load.max_model_bytes = 1024 * 1024;
    write_fixture(path, "custom-unsupported-template");
    CHECK(gezel_llama_load(engine.get(), path, &load, &error) == GEZEL_LLAMA_UNSUPPORTED);
    write_fixture(path, "chatml", 2);
    CHECK(gezel_llama_load(engine.get(), path, &load, &error) == GEZEL_LLAMA_UNSUPPORTED);
    write_fixture(path);
    CHECK(gezel_llama_load(engine.get(), path, &load, &error) == GEZEL_LLAMA_OK);
    CHECK(gezel_llama_generate(engine.get(), message, 2, &generation, collect, &text, &result, &error) == GEZEL_LLAMA_OK);
}

int main(int argc, char ** argv) {
    try {
        if (argc == 3 && std::strcmp(argv[1], "--write-fixture") == 0) {
            write_fixture(argv[2]);
            std::puts("Synthetic GGUF fixture written (always emits a; not a quality model)");
            return 0;
        }
        CHECK(argc == 2);
        utf8_tests();
        bridge_tests(argv[1]);
        std::remove(argv[1]);
        std::puts("Native bridge contract tests passed (synthetic GGUF, not a quality eval)");
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "Native bridge test failed: %s\n", error.what());
        return 1;
    }
}
