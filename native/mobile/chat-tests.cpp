// Contract tests for the bridge's chat API: llama.cpp's own chat layer, as
// desktop's llama-server runs it. Rendering and parsing use upstream's real
// template fixtures (models/templates); generation uses the tiny synthetic GGUF,
// which always emits "a", so it checks the stream's shape, not model quality.

#include "gezel_llama.h"
#include "chat.h"
#include "json.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#define CHECK(condition) \
    do { \
        if (!(condition)) throw std::runtime_error(std::string("check failed at line ") + std::to_string(__LINE__) + ": " #condition); \
    } while (0)

using json = common_json;

static std::string read_file(const std::string & path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("missing fixture: " + path);
    std::stringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

static int32_t collect(const char * text, size_t length, void * user) {
    static_cast<std::vector<std::string> *>(user)->emplace_back(text, length);
    return 0;
}

static int32_t cancel_after_first(const char * text, size_t length, void * user) {
    auto & events = *static_cast<std::vector<std::string> *>(user);
    events.emplace_back(text, length);
    return events.size() >= 1 ? 1 : 0;
}

struct chat_run {
    int32_t status;
    gezel_llama_result result;
    std::vector<json> events;
};

static chat_run chat(gezel_llama_engine * engine, const std::string & request, uint32_t flags = 0,
                     gezel_llama_json_callback callback = collect) {
    static uint64_t request_id = 100;
    auto options = gezel_llama_default_chat_options();
    options.request_id = ++request_id;
    options.timeout_ms = 60000;
    options.flags = flags;
    std::vector<std::string> raw;
    chat_run run{};
    gezel_llama_error error{};
    run.status = gezel_llama_chat(engine, request.data(), request.size(), &options, callback, &raw, &run.result, &error);
    for (const auto & text : raw) run.events.push_back(json::parse(text));
    return run;
}

static void configure(gezel_llama_engine * engine, const json & config) {
    const std::string text = config.dump();
    gezel_llama_error error{};
    CHECK(gezel_llama_configure_chat(engine, text.data(), text.size(), &error) == GEZEL_LLAMA_OK);
}

static const char * TOOLS =
    R"([{"type":"function","function":{"name":"read_file","description":"Read a workspace text file.",)"
    R"("parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}])";

static std::string tool_request(const std::string & tool_choice = "auto") {
    return std::string(R"({"messages":[{"role":"system","content":"You help."},{"role":"user","content":"Read notes.md."}],"tools":)") +
        TOOLS + R"(,"tool_choice":")" + tool_choice + R"("})";
}

static bool contains_trigger(const json & triggers, const std::string & value) {
    for (const auto & trigger : triggers)
        if (trigger.value("value", std::string()) == value) return true;
    return false;
}

/** Each phone family's own template renders the tools and arms its own grammar. */
static void render_tests(gezel_llama_engine * engine, const std::string & templates) {
    // Llama 3.2 goes through upstream's generic autoparser, which arms no
    // grammar for its template; desktop's llama-server behaves the same.
    struct family { const char * file; const char * trigger; bool grammar; };
    const family families[] = {
        {"Qwen3.5-4B.jinja", "<tool_call>", true},
        {"google-gemma-4-31B-it.jinja", "<|tool_call>", true},
        {"LFM2.5-Instruct.jinja", "<|tool_call_start|>", true},
        {"openbmb-MiniCPM5-1B.jinja", nullptr, true},
        {"meta-llama-Llama-3.2-3B-Instruct.jinja", nullptr, false},
    };
    for (const auto & f : families) {
        configure(engine, json{{"chat_template", read_file(templates + "/" + f.file)}});
        auto run = chat(engine, tool_request(), GEZEL_LLAMA_CHAT_RENDER_ONLY);
        CHECK(run.status == GEZEL_LLAMA_OK);
        CHECK(run.events.size() == 1);
        const auto & rendered = run.events[0];
        const std::string prompt = rendered.at("prompt").get<std::string>();
        CHECK(prompt.find("read_file") != std::string::npos);
        CHECK(prompt.find("Read notes.md.") != std::string::npos);
        if (f.grammar && rendered.at("grammar").get<std::string>().empty()) {
            std::fprintf(stderr, "%s rendered without a grammar\n", f.file);
            CHECK(!rendered.at("grammar").get<std::string>().empty());
        }
        if (f.trigger) {
            CHECK(rendered.at("grammar_lazy").get<bool>());
            CHECK(contains_trigger(rendered.at("grammar_triggers"), f.trigger));
        }
        // A tool result from an earlier step renders through the same template.
        const std::string replay =
            R"({"messages":[{"role":"user","content":"Read notes.md."},)"
            R"({"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes.md\"}"}}]},)"
            R"({"role":"tool","tool_call_id":"call-1","content":"buy milk"}],"tools":)" + std::string(TOOLS) + "}";
        auto replayed = chat(engine, replay, GEZEL_LLAMA_CHAT_RENDER_ONLY);
        CHECK(replayed.status == GEZEL_LLAMA_OK);
        CHECK(replayed.events[0].at("prompt").get<std::string>().find("buy milk") != std::string::npos);
    }
    // tool_choice "required" holds the whole reply to a call (Qwen: not lazy).
    configure(engine, json{{"chat_template", read_file(templates + "/Qwen3.5-4B.jinja")}});
    auto required = chat(engine, tool_request("required"), GEZEL_LLAMA_CHAT_RENDER_ONLY);
    CHECK(required.status == GEZEL_LLAMA_OK);
    CHECK(!required.events[0].at("grammar_lazy").get<bool>());
}

/** The per-family parsers read each model's native call syntax back as structured calls. */
static void parse_tests(const std::string & templates) {
    struct sample { const char * file; const char * output; };
    const sample samples[] = {
        {"Qwen3.5-4B.jinja",
         "<tool_call>\n<function=read_file>\n<parameter=path>\nnotes.md\n</parameter>\n</function>\n</tool_call>"},
        {"google-gemma-4-31B-it.jinja", "<|tool_call>call:read_file{path:<|\"|>notes.md<|\"|>}<tool_call|>"},
        {"LFM2.5-Instruct.jinja", "<|tool_call_start|>[read_file(path=\"notes.md\")]<|tool_call_end|>"},
    };
    for (const auto & s : samples) {
        auto templates_ptr = common_chat_templates_init(nullptr, read_file(templates + "/" + s.file));
        common_chat_templates_inputs inputs;
        common_chat_msg user;
        user.role = "user";
        user.content = "Read notes.md.";
        inputs.messages = {user};
        inputs.tools = common_chat_tools_parse_oaicompat(json::parse(TOOLS));
        inputs.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
        auto params = common_chat_templates_apply(templates_ptr.get(), inputs);
        common_chat_parser_params parser(params);
        parser.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
        if (!params.parser.empty()) parser.parser.load(params.parser);
        const auto msg = common_chat_parse(s.output, false, parser);
        CHECK(msg.tool_calls.size() == 1);
        CHECK(msg.tool_calls[0].name == "read_file");
        CHECK(msg.tool_calls[0].arguments.find("notes.md") != std::string::npos);
    }
}

static const char * CHATML =
    "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}"
    "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}";

static std::string content_of(const std::vector<json> & events) {
    std::string text;
    for (const auto & event : events) {
        if (!event.contains("choices")) continue;
        for (const auto & choice : event.at("choices")) {
            const auto & delta = choice.at("delta");
            if (delta.contains("content") && delta.at("content").is_string()) text += delta.at("content").get<std::string>();
        }
    }
    return text;
}

static std::string finish_of(const std::vector<json> & events) {
    for (const auto & event : events) {
        if (!event.contains("choices")) continue;
        for (const auto & choice : event.at("choices"))
            if (choice.contains("finish_reason") && choice.at("finish_reason").is_string())
                return choice.at("finish_reason").get<std::string>();
    }
    return "";
}

/** The stream, finish reasons, usage and error bodies llama-server produces. */
static void bridge_tests(const char * fixture) {
    gezel_llama_engine * engine = gezel_llama_create();
    CHECK(engine);
    auto load = gezel_llama_default_load_options();
    load.context_tokens = 512;
    load.request_id = 1;
    gezel_llama_error error{};
    CHECK(gezel_llama_load(engine, fixture, &load, &error) == GEZEL_LLAMA_OK);
    configure(engine, json{{"chat_template", CHATML}});

    auto run = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}],"max_tokens":8,"stream":true,"stream_options":{"include_usage":true}})");
    CHECK(run.status == GEZEL_LLAMA_OK);
    CHECK(run.result.finish_reason == GEZEL_LLAMA_FINISH_LENGTH);
    CHECK(run.events.front().at("choices").at(0).at("delta").at("role").get<std::string>() == "assistant");
    CHECK(content_of(run.events) == "aaaaaaaa");
    CHECK(finish_of(run.events) == "length");
    const auto & tail = run.events.back();
    CHECK(tail.at("choices").empty());
    CHECK(tail.at("usage").at("completion_tokens").get<int>() == 8);
    CHECK(tail.at("timings").at("predicted_n").get<int>() == 8);
    CHECK(tail.at("object").get<std::string>() == "chat.completion.chunk");

    // Partial chunks carry running timings only when asked, as desktop asks.
    for (size_t i = 0; i + 2 < run.events.size(); ++i) CHECK(!run.events[i].contains("timings"));
    auto timed = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}],"max_tokens":8,"timings_per_token":true})");
    CHECK(timed.status == GEZEL_LLAMA_OK);
    int decoded = 0;
    for (size_t i = 0; i + 1 < timed.events.size(); ++i) {
        if (!timed.events[i].contains("timings")) continue;
        const int n = timed.events[i].at("timings").at("predicted_n").get<int>();
        CHECK(n > decoded);
        decoded = n;
    }
    CHECK(decoded == 8);

    // The same prompt again reuses what the first request left in memory.
    auto again = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}],"max_tokens":8})");
    CHECK(again.status == GEZEL_LLAMA_OK);
    CHECK(again.events.back().at("timings").at("cache_n").get<int>() > 0);

    // A stop word ends the reply and never reaches the text.
    auto stopped = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}],"max_tokens":8,"stop":["aaa"]})");
    CHECK(stopped.status == GEZEL_LLAMA_OK);
    CHECK(content_of(stopped.events).empty());
    CHECK(finish_of(stopped.events) == "stop");

    // Request errors arrive as llama-server's error body, and fail the call.
    auto broken = chat(engine, "{");
    CHECK(broken.status == GEZEL_LLAMA_INVALID_ARGUMENT);
    CHECK(broken.events.size() == 1);
    CHECK(broken.events[0].at("error").at("code").get<int>() == 400);
    CHECK(broken.events[0].at("error").at("type").get<std::string>() == "invalid_request_error");
    auto missing = chat(engine, R"({"max_tokens":8})");
    CHECK(missing.events[0].at("error").at("message").get<std::string>() == "'messages' is required");
    auto image = chat(engine, R"({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:,"}}]}]})");
    CHECK(image.events[0].at("error").at("message").get<std::string>().find("image input is not supported") == 0);

    // A prompt at or over the window: desktop's overflow recovery reads these fields.
    std::string crowded(3000, ' ');
    for (size_t i = 0; i < crowded.size(); i += 6) crowded.replace(i, 5, "Hello");
    auto overflow = chat(engine, R"({"messages":[{"role":"user","content":")" + crowded + R"("}]})");
    CHECK(overflow.status == GEZEL_LLAMA_CONTEXT_LIMIT);
    const auto & body = overflow.events[0].at("error");
    CHECK(body.at("type").get<std::string>() == "exceed_context_size_error");
    CHECK(body.at("n_ctx").get<int>() == 512);
    CHECK(body.at("n_prompt_tokens").get<int>() >= 512);
    CHECK(body.at("message").get<std::string>().find("exceeds the available context size") != std::string::npos);

    // Stopping from the event callback ends without a finish chunk.
    auto cancelled = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}],"max_tokens":64})", 0, cancel_after_first);
    CHECK(cancelled.status == GEZEL_LLAMA_CANCELLED);
    CHECK(finish_of(cancelled.events).empty());

    // Without a limit the reply runs to the edge of the window, as llama-server does.
    auto unbounded = chat(engine, R"({"messages":[{"role":"user","content":"Hello"}]})");
    CHECK(unbounded.status == GEZEL_LLAMA_OK);
    CHECK(finish_of(unbounded.events) == "length");
    CHECK(unbounded.result.prompt_tokens + unbounded.result.generated_tokens + 1 >= 512);

    gezel_llama_destroy(engine);
}

/**
 * A real hybrid or windowed model (Qwen 3.5, LFM2, Gemma) keeps using what
 * earlier prompts left in memory when a later transcript re-renders an older
 * turn differently. Runs only when GEZEL_CHAT_TEST_MODEL names a GGUF.
 */
static void checkpoint_tests(const char * model) {
    gezel_llama_engine * engine = gezel_llama_create();
    CHECK(engine);
    auto load = gezel_llama_default_load_options();
    load.context_tokens = 4096;
    load.request_id = 1;
    gezel_llama_error error{};
    CHECK(gezel_llama_load(engine, model, &load, &error) == GEZEL_LLAMA_OK);
    configure(engine, json::object());
    std::string system = "You help plan a community repair cafe.";
    for (int i = 0; i < 40; ++i) system += " Volunteers fix lamps, kettles and bicycles every month.";
    const auto request = [&](const json & messages) {
        return chat(engine, json{{"messages", messages}, {"max_tokens", 4}, {"temperature", 0}}.dump());
    };
    const json head = json::array({{{"role", "system"}, {"content", system}}, {{"role", "user"}, {"content", "When do we meet?"}}});
    auto first = request(head);
    CHECK(first.status == GEZEL_LLAMA_OK);
    const int first_prompt = first.events.back().at("timings").at("prompt_n").get<int>();
    auto second_messages = head;
    second_messages.push_back({{"role", "assistant"}, {"content", "Saturday at ten."}});
    second_messages.push_back({{"role", "user"}, {"content", "Where?"}});
    auto second = request(second_messages);
    CHECK(second.status == GEZEL_LLAMA_OK);
    CHECK(second.events.back().at("timings").at("cache_n").get<int>() > 0);
    // The earlier reply now reads differently, as a template that drops an
    // older turn's reasoning renders it: the second prompt is no longer a
    // prefix, but the first one still is.
    auto third_messages = head;
    third_messages.push_back({{"role", "assistant"}, {"content", "We meet on Saturday."}});
    third_messages.push_back({{"role", "user"}, {"content", "Where?"}});
    third_messages.push_back({{"role", "assistant"}, {"content", "Maple Hall."}});
    third_messages.push_back({{"role", "user"}, {"content", "Thanks."}});
    auto third = request(third_messages);
    CHECK(third.status == GEZEL_LLAMA_OK);
    const int reused = third.events.back().at("timings").at("cache_n").get<int>();
    std::printf("checkpoint reuse: first prompt %d tokens, third request reused %d\n", first_prompt, reused);
    CHECK(reused >= first_prompt / 2);
    gezel_llama_destroy(engine);
}

/** Prints each streamed delta of one real request, for diagnosing a model's output. */
static int replay(const char * model, const char * request_path, const char * config_json, uint32_t context) {
    gezel_llama_engine * engine = gezel_llama_create();
    auto load = gezel_llama_default_load_options();
    load.context_tokens = context;
    load.request_id = 1;
    gezel_llama_error error{};
    if (gezel_llama_load(engine, model, &load, &error) != GEZEL_LLAMA_OK) {
        std::fprintf(stderr, "load failed: %s\n", error.message);
        return 1;
    }
    configure(engine, json::parse(config_json));
    std::ifstream in(request_path);
    std::stringstream body;
    body << in.rdbuf();
    auto options = gezel_llama_default_chat_options();
    options.request_id = 2;
    options.timeout_ms = 600000;
    gezel_llama_result result{};
    const auto print = [](const char * text, size_t length, void *) -> int32_t {
        const auto event = json::parse(std::string(text, length));
        if (event.contains("choices") && !event.at("choices").empty()) {
            const auto & delta = event.at("choices").at(0).at("delta");
            for (const char * key : {"reasoning_content", "content"})
                if (delta.contains(key) && delta.at(key).is_string()) std::printf("[%s]%s\n", key, delta.at(key).get<std::string>().c_str());
            if (delta.contains("tool_calls")) std::printf("[tool_calls]%s\n", delta.at("tool_calls").dump().c_str());
            const auto & finish = event.at("choices").at(0).at("finish_reason");
            if (finish.is_string()) std::printf("[finish]%s\n", finish.get<std::string>().c_str());
        } else if (event.contains("error")) {
            std::printf("[error]%s\n", event.dump().c_str());
        }
        if (event.contains("timings")) std::printf("[timings]%s\n", event.at("timings").dump().c_str());
        std::fflush(stdout);
        return 0;
    };
    const std::string text = body.str();
    const int32_t status = gezel_llama_chat(engine, text.data(), text.size(), &options, print, nullptr, &result, &error);
    std::printf("[status]%d generated=%u %s\n", status, result.generated_tokens, error.message);
    gezel_llama_destroy(engine);
    return status == GEZEL_LLAMA_OK ? 0 : 1;
}

int main(int argc, char ** argv) {
    try {
        if (argc >= 4 && std::strcmp(argv[1], "--replay") == 0)
            return replay(argv[2], argv[3], argc >= 5 ? argv[4] : "{}", argc >= 6 ? static_cast<uint32_t>(std::atoi(argv[5])) : 16384);
        if (argc != 3) throw std::runtime_error("usage: gezel-chat-tests <models/templates dir> <fixture.gguf>");
        {
            gezel_llama_engine * engine = gezel_llama_create();
            CHECK(engine);
            auto load = gezel_llama_default_load_options();
            load.context_tokens = 512;
            load.request_id = 1;
            gezel_llama_error error{};
            CHECK(gezel_llama_load(engine, argv[2], &load, &error) == GEZEL_LLAMA_OK);
            render_tests(engine, argv[1]);
            gezel_llama_destroy(engine);
        }
        parse_tests(argv[1]);
        bridge_tests(argv[2]);
        if (const char * model = std::getenv("GEZEL_CHAT_TEST_MODEL")) checkpoint_tests(model);
        std::puts("Native chat contract tests passed (upstream templates, synthetic GGUF)");
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "Native chat test failed: %s\n", error.what());
        return 1;
    }
}
