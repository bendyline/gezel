// OpenAI-shaped chat on the phone, served the way desktop's llama-server serves
// it with --jinja. Everything that decides what the model sees and how its reply
// is read is llama.cpp's own chat layer (common/chat, sampling, parsers), the
// same sources desktop runs. What llama-server adds around them lives in
// tools/server, which also carries the HTTP server and multimodal stack, so the
// few pieces it contributes are ported here from the pinned revision and named
// after their originals:
//
//   oaicompat_chat_params_parse   server-common.cpp  request -> template inputs
//   make_llama_cmpl_schema         server-schema.cpp  fields -> sampling, stops
//   process_token                  server-context.cpp stop words, limits, EOS
//   update_chat_msg                server-task.cpp    streaming parse and diffs
//   to_json_oaicompat_chat_stream  server-task.cpp    chunk and error shapes
//
// Keep them in step with the pin: tests in chat-tests.cpp compare against
// upstream's own fixtures.

#include "gezel_engine.h"

#include "build-info.h"
#include "common.h"
#include "json.h"
#include "json-schema-to-grammar.h"
#include "log.h"
#include "sampling.h"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <functional>
#include <limits>
#include <memory>
#include <new>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using json = common_json;
using namespace gezel_mobile;

namespace {

// ---- server-common: errors, ids, helpers ----------------------------------

enum error_type {
    ERROR_TYPE_INVALID_REQUEST,
    ERROR_TYPE_SERVER,
    ERROR_TYPE_NOT_SUPPORTED,
    ERROR_TYPE_EXCEED_CONTEXT_SIZE,
};

json format_error_response(const std::string & message, error_type type) {
    std::string type_str = "server_error";
    int code = 500;
    switch (type) {
        case ERROR_TYPE_INVALID_REQUEST: type_str = "invalid_request_error"; code = 400; break;
        case ERROR_TYPE_SERVER: type_str = "server_error"; code = 500; break;
        case ERROR_TYPE_NOT_SUPPORTED: type_str = "not_supported_error"; code = 501; break;
        case ERROR_TYPE_EXCEED_CONTEXT_SIZE: type_str = "exceed_context_size_error"; code = 400; break;
    }
    return json{{"code", code}, {"message", message}, {"type", type_str}};
}

/** A request llama-server would answer with an error body. */
struct chat_failure : std::runtime_error {
    error_type type;
    int32_t status;
    int32_t n_prompt_tokens = 0;
    int32_t n_ctx = 0;
    chat_failure(const std::string & message, error_type kind, int32_t code)
        : std::runtime_error(message), type(kind), status(code) {}
};

template <typename T>
T json_value(const json & body, const std::string & key, const T & default_value) {
    // Fallback null to default value
    if (body.contains(key) && !body.at(key).is_null()) {
        try {
            return body.at(key).get<T>();
        } catch (const common_json_error &) {
            return default_value;
        }
    }
    return default_value;
}

std::string random_string() {
    static const std::string chars("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    std::random_device device;
    std::mt19937 generator(device());
    std::string result(32, ' ');
    for (auto & c : result) c = chars[generator() % chars.size()];
    return result;
}

// If validate_utf8(text) == text.size(), the whole text is valid UTF-8.
size_t validate_utf8(const std::string & text) {
    const size_t len = text.size();
    if (len == 0) return 0;
    for (size_t i = 1; i <= 4 && i <= len; ++i) {
        const unsigned char c = text[len - i];
        if ((c & 0xE0) == 0xC0) {
            if (i < 2) return len - i;
        } else if ((c & 0xF0) == 0xE0) {
            if (i < 3) return len - i;
        } else if ((c & 0xF8) == 0xF0) {
            if (i < 4) return len - i;
        }
    }
    return len;
}

json grammar_trigger_to_json(const common_grammar_trigger & trigger) {
    json out{{"type", (int) trigger.type}, {"value", trigger.value}};
    if (trigger.type == COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN) out["token"] = (int) trigger.token;
    return out;
}

common_grammar_trigger grammar_trigger_from_json(const json & in) {
    common_grammar_trigger trigger;
    trigger.type = (common_grammar_trigger_type) in.at("type").get<int>();
    trigger.value = in.at("value").get<std::string>();
    if (trigger.type == COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN) trigger.token = (llama_token) in.at("token").get<int>();
    return trigger;
}

// ---- common: sampling defaults from the model (common_init_sampler_from_model) --

/**
 * llama-server's per-request sampling starts from llama.cpp's defaults with the
 * GGUF's own `general.sampling.*` recommendations laid over them; desktop passes
 * no sampling flags at launch, so requests override exactly these.
 */
common_params_sampling base_sampling(const llama_model * model) {
    common_params_sampling sparams;
    auto get_int32 = [&](const char * key, int32_t & dst) {
        char buf[64] = {0};
        if (llama_model_meta_val_str(model, key, buf, sizeof(buf)) > 0) {
            char * end = nullptr;
            const int32_t v = strtol(buf, &end, 10);
            if (end && end != buf) dst = v;
        }
    };
    auto get_float = [&](const char * key, float & dst) {
        char buf[128] = {0};
        if (llama_model_meta_val_str(model, key, buf, sizeof(buf)) > 0) {
            char * end = nullptr;
            const float v = strtof(buf, &end);
            if (end && end != buf) dst = v;
        }
    };
    {
        char buf[512] = {0};
        if (llama_model_meta_val_str(model, llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_SEQUENCE), buf, sizeof(buf)) > 0) {
            const std::vector<std::string> names = string_split<std::string>(std::string(buf), ';');
            if (!names.empty()) sparams.samplers = common_sampler_types_from_names(names);
        }
    }
    get_int32(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_TOP_K), sparams.top_k);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_TOP_P), sparams.top_p);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_MIN_P), sparams.min_p);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_XTC_PROBABILITY), sparams.xtc_probability);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_XTC_THRESHOLD), sparams.xtc_threshold);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_TEMP), sparams.temp);
    get_int32(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_PENALTY_LAST_N), sparams.penalty_last_n);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_PENALTY_REPEAT), sparams.penalty_repeat);
    get_int32(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_MIROSTAT), sparams.mirostat);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_MIROSTAT_TAU), sparams.mirostat_tau);
    get_float(llama_model_meta_key_str(LLAMA_MODEL_META_KEY_SAMPLING_MIROSTAT_ETA), sparams.mirostat_eta);
    return sparams;
}

// ---- server-common: oaicompat_chat_params_parse ----------------------------

json chat_params_parse(json body, const chat_config & opt, const common_chat_templates * tmpls) {
    json llama_params;

    auto tools = json_value(body, "tools", json());
    auto tool_choice = json_value(body, "tool_choice", std::string("auto"));

    // Handle "stop" field
    if (body.contains("stop") && body.at("stop").is_string()) {
        llama_params["stop"] = json::array({body.at("stop").get<std::string>()});
    } else {
        llama_params["stop"] = json_value(body, "stop", json::array());
    }

    auto json_schema = json_value(body, "json_schema", json());
    auto grammar = json_value(body, "grammar", std::string());
    if (!json_schema.is_null() && !grammar.empty()) throw std::runtime_error("Cannot use both json_schema and grammar");

    // Handle "response_format" field
    if (body.contains("response_format")) {
        json response_format = json_value(body, "response_format", json::object());
        std::string response_type = json_value(response_format, "type", std::string());
        if (response_type == "json_object") {
            if (response_format.contains("schema") || json_schema.empty())
                json_schema = json_value(response_format, "schema", json::object());
        } else if (response_type == "json_schema") {
            auto schema_wrapper = json_value(response_format, "json_schema", json::object());
            json_schema = json_value(schema_wrapper, "schema", json::object());
        } else if (!response_type.empty() && response_type != "text") {
            throw std::invalid_argument("response_format type must be one of \"text\" or \"json_object\", but got: " +
                                        response_type);
        }
    }
    // an absent or empty schema means any object
    if (json_schema.is_object() && json_schema.empty()) json_schema["type"] = "object";

    if (!body.contains("messages")) throw std::invalid_argument("'messages' is required");
    json & messages = body.at("messages");
    if (!messages.is_array()) throw std::invalid_argument("Expected 'messages' to be an array");
    for (auto & msg : messages) {
        std::string role = json_value(msg, "role", std::string());
        if (role != "assistant" && !msg.contains("content"))
            throw std::invalid_argument("All non-assistant messages must contain 'content'");
        if (role == "assistant") {
            if (!msg.contains("content") && !msg.contains("tool_calls"))
                throw std::invalid_argument("Assistant message must contain either 'content' or 'tool_calls'!");
            if (!msg.contains("content")) continue;
        }
        json & content = msg.at("content");
        if (content.is_string() || content.is_null()) continue;
        if (!content.is_array()) throw std::invalid_argument("Expected 'content' to be a string or an array");
        for (auto & p : content) {
            std::string type = json_value(p, "type", std::string());
            // The phone has no multimodal projector yet: llama-server without an
            // mmproj answers exactly these.
            if (type == "image_url")
                throw std::runtime_error("image input is not supported - hint: if this is unexpected, you may need to provide the mmproj");
            if (type == "input_audio")
                throw std::runtime_error("audio input is not supported - hint: if this is unexpected, you may need to provide the mmproj");
            if (type == "input_video")
                throw std::runtime_error("video input is not supported - hint: if this is unexpected, you may need to provide the mmproj");
            if (type != "text") throw std::invalid_argument("unsupported content[].type");
        }
    }

    auto caps = common_chat_templates_get_caps(tmpls);

    common_chat_templates_inputs inputs;
    inputs.messages = common_chat_msgs_parse_oaicompat(messages);
    inputs.tools = common_chat_tools_parse_oaicompat(tools);
    inputs.tool_choice = common_chat_tool_choice_parse_oaicompat(tool_choice);
    inputs.json_schema = json_schema.is_null() ? "" : json_schema.dump();
    inputs.grammar = grammar;
    inputs.use_jinja = true;
    inputs.parallel_tool_calls = json_value(body, "parallel_tool_calls", caps["supports_parallel_tool_calls"]);
    inputs.add_generation_prompt = json_value(body, "add_generation_prompt", true);
    inputs.continue_final_message = body.contains("continue_final_message")
        ? common_chat_continuation_parse(body.at("continue_final_message"))
        : COMMON_CHAT_CONTINUATION_NONE;
    if (inputs.continue_final_message == COMMON_CHAT_CONTINUATION_NONE && opt.prefill_assistant &&
        !inputs.messages.empty() && inputs.messages.back().role == "assistant") {
        if (inputs.messages.size() >= 2 && inputs.messages[inputs.messages.size() - 2].role == "assistant")
            throw std::invalid_argument("Cannot have 2 or more assistant messages at the end of the list.");
        inputs.continue_final_message = COMMON_CHAT_CONTINUATION_AUTO;
        inputs.add_generation_prompt = false;
    }
    if (inputs.continue_final_message != COMMON_CHAT_CONTINUATION_NONE && inputs.add_generation_prompt)
        throw std::invalid_argument("Cannot set both add_generation_prompt and continue_final_message to true.");
    if (inputs.continue_final_message != COMMON_CHAT_CONTINUATION_NONE && !inputs.messages.empty() &&
        inputs.messages.back().role == "assistant" && !inputs.messages.back().tool_calls.empty())
        throw std::invalid_argument("Cannot continue an assistant message that contains tool calls.");
    inputs.reasoning_format = opt.reasoning_format;
    if (body.contains("reasoning_format"))
        inputs.reasoning_format = common_reasoning_format_from_name(body.at("reasoning_format").get<std::string>());
    // llama-server: thinking is on unless reasoning is switched off, and only
    // when the template supports it (server-context.cpp, at template load).
    inputs.enable_thinking = opt.enable_thinking && common_chat_templates_support_enable_thinking(tmpls);
    if (!inputs.tools.empty() && inputs.tool_choice != COMMON_CHAT_TOOL_CHOICE_NONE) {
        if (body.contains("grammar")) throw std::invalid_argument("Cannot use custom grammar constraints with tools.");
        llama_params["parse_tool_calls"] = true;
    }

    // merge the template args provided from command line with the args provided in the user request
    auto chat_template_kwargs_object = json_value(body, "chat_template_kwargs", json::object());
    inputs.chat_template_kwargs = opt.chat_template_kwargs;
    for (const auto & item : chat_template_kwargs_object.items())
        inputs.chat_template_kwargs[item.key()] = item.value().dump();

    // parse the "enable_thinking" kwarg to override the default value
    // (The kwargs map holds each value as its JSON text: `true`, `"true"`.)
    const auto kwarg = inputs.chat_template_kwargs.find("enable_thinking");
    const std::string enable_thinking_kwarg = kwarg == inputs.chat_template_kwargs.end() ? "" : kwarg->second;
    if (enable_thinking_kwarg == "true") {
        inputs.enable_thinking = true;
    } else if (enable_thinking_kwarg == "false") {
        inputs.enable_thinking = false;
    } else if (!enable_thinking_kwarg.empty() && enable_thinking_kwarg[0] == '"') {
        throw std::invalid_argument("invalid type for \"enable_thinking\" (expected boolean, got string)");
    }

    // Parse the OAI "reasoning_effort" field; "none" disables reasoning.
    if (body.contains("reasoning_effort")) {
        auto reasoning_effort = json_value(body, "reasoning_effort", std::string(""));
        if (reasoning_effort == "none") {
            inputs.enable_thinking = false;
            inputs.chat_template_kwargs.erase("reasoning_effort");
        } else if (!reasoning_effort.empty()) {
            inputs.chat_template_kwargs["reasoning_effort"] = json(reasoning_effort).dump();
        }
    }

    // Apply chat template to the list of messages
    auto chat_params = common_chat_templates_apply(tmpls, inputs);

    llama_params["chat_format"] = static_cast<int>(chat_params.format);
    llama_params["prompt"] = chat_params.prompt;
    if (!chat_params.grammar.empty()) {
        llama_params["grammar"] = chat_params.grammar;
        llama_params["grammar_type"] = std::string("tool_calls");
    }
    llama_params["grammar_lazy"] = chat_params.grammar_lazy;
    auto grammar_triggers = json::array();
    for (const auto & trigger : chat_params.grammar_triggers) grammar_triggers.push_back(grammar_trigger_to_json(trigger));
    llama_params["grammar_triggers"] = grammar_triggers;
    llama_params["preserved_tokens"] = chat_params.preserved_tokens;
    llama_params["generation_prompt"] = chat_params.generation_prompt;
    for (const auto & stop : chat_params.additional_stops) llama_params["stop"].push_back(stop);
    llama_params["message_delimiters"] = chat_params.message_delimiters.to_json();
    if (!chat_params.parser.empty()) llama_params["chat_parser"] = chat_params.parser;

    // Reasoning budget: pass parameters through to sampling layer
    {
        int reasoning_budget = json_value(body, "reasoning_budget_tokens", json_value(body, "thinking_budget_tokens", -1));
        if (reasoning_budget == -1) reasoning_budget = opt.reasoning_budget;
        if (!chat_params.thinking_end_tags.empty()) {
            llama_params["reasoning_budget_tokens"] = reasoning_budget;
            llama_params["reasoning_budget_start_tag"] = chat_params.thinking_start_tag;
            llama_params["reasoning_budget_end_tags"] = chat_params.thinking_end_tags;
            llama_params["reasoning_budget_message"] =
                json_value(body, "reasoning_budget_message", opt.reasoning_budget_message);
            llama_params["reasoning_control"] = json_value(body, "reasoning_control", false);
        }
    }

    // Copy remaining properties to llama_params
    for (const auto & item : body.items()) {
        // Exception: if "n_predict" is present, we overwrite the value specified earlier by "max_tokens"
        if (!llama_params.contains(item.key()) || item.key() == "n_predict") llama_params[item.key()] = item.value();
    }
    return llama_params;
}

// ---- server-schema: make_llama_cmpl_schema (fields the chat path reads) ------

struct chat_task {
    common_params_sampling sampling;
    common_chat_parser_params parser;
    int32_t n_predict = -1;
    std::vector<std::string> antiprompt;
    bool stream = false;
    bool include_usage = false;
    bool timings_per_token = false;
    std::string prompt;
};

// treat a null value as absent so clients can send null to request the server default
bool has_value(const json & data, const char * name) { return data.contains(name) && !data.at(name).is_null(); }

void with_field(const char * name, const std::function<void()> & handler) {
    try {
        handler();
    } catch (const std::exception & e) {
        throw std::invalid_argument(string_format("Field '%s': %s", name, e.what()));
    }
}

template <typename T>
void num_field(const json & data, std::initializer_list<const char *> names, T & value) {
    for (const char * name : names) {
        if (!has_value(data, name)) continue;
        with_field(name, [&] { value = data.at(name).template get<T>(); });
        return;
    }
}

template <typename T>
void hard_num_field(const json & data, std::initializer_list<const char *> names, T & value, T min, T max) {
    for (const char * name : names) {
        if (!has_value(data, name)) continue;
        with_field(name, [&] {
            const T tmp = data.at(name).template get<T>();
            if (tmp < min || tmp > max)
                throw std::invalid_argument(std::string("Value must be between ") + std::to_string(min) +
                                            " <= value <= " + std::to_string(max) + ", but got " + std::to_string(tmp));
            value = tmp;
        });
        return;
    }
}

void bool_field(const json & data, const char * name, bool & value) {
    if (!has_value(data, name)) return;
    with_field(name, [&] { value = data.at(name).get<bool>(); });
}

chat_task task_from_params(const json & data, const llama_vocab * vocab, const common_params_sampling & defaults,
                           const chat_config & opt) {
    chat_task task;
    task.sampling = defaults;
    task.parser.reasoning_format = opt.reasoning_format;
    task.prompt = data.at("prompt").get<std::string>();

    bool_field(data, "timings_per_token", task.timings_per_token);
    bool_field(data, "stream", task.stream);
    if (data.contains("stream_options") && data.at("stream_options").is_object())
        bool_field(data.at("stream_options"), "include_usage", task.include_usage);
    hard_num_field(data, {"n_predict", "max_completion_tokens", "max_tokens"}, task.n_predict, -1, INT32_MAX);
    num_field(data, {"top_k"}, task.sampling.top_k);
    num_field(data, {"top_p"}, task.sampling.top_p);
    num_field(data, {"min_p"}, task.sampling.min_p);
    num_field(data, {"top_n_sigma"}, task.sampling.top_n_sigma);
    num_field(data, {"xtc_probability"}, task.sampling.xtc_probability);
    num_field(data, {"xtc_threshold"}, task.sampling.xtc_threshold);
    num_field(data, {"typical_p"}, task.sampling.typ_p);
    num_field(data, {"temperature"}, task.sampling.temp);
    num_field(data, {"dynatemp_range"}, task.sampling.dynatemp_range);
    num_field(data, {"dynatemp_exponent"}, task.sampling.dynatemp_exponent);
    hard_num_field(data, {"repeat_last_n"}, task.sampling.penalty_last_n, 0, INT32_MAX);
    num_field(data, {"repeat_penalty"}, task.sampling.penalty_repeat);
    num_field(data, {"frequency_penalty"}, task.sampling.penalty_freq);
    num_field(data, {"presence_penalty"}, task.sampling.penalty_present);
    num_field(data, {"dry_multiplier"}, task.sampling.dry_multiplier);
    num_field(data, {"dry_base"}, task.sampling.dry_base);
    hard_num_field(data, {"dry_allowed_length"}, task.sampling.dry_allowed_length, 0, INT32_MAX);
    hard_num_field(data, {"dry_penalty_last_n"}, task.sampling.dry_penalty_last_n, 0, INT32_MAX);
    num_field(data, {"mirostat"}, task.sampling.mirostat);
    num_field(data, {"mirostat_tau"}, task.sampling.mirostat_tau);
    num_field(data, {"mirostat_eta"}, task.sampling.mirostat_eta);
    num_field(data, {"seed"}, task.sampling.seed);
    hard_num_field(data, {"min_keep"}, task.sampling.min_keep, 0, INT32_MAX);

    if (has_value(data, "dry_sequence_breakers")) {
        with_field("dry_sequence_breakers", [&] {
            task.sampling.dry_sequence_breakers = json_value(data, "dry_sequence_breakers", std::vector<std::string>());
            if (task.sampling.dry_sequence_breakers.empty())
                throw std::runtime_error("Error: dry_sequence_breakers must be a non-empty array of strings");
        });
    }

    // handle both "json_schema" and "grammar"
    for (const char * name : {"json_schema", "grammar"}) {
        if (!has_value(data, name)) continue;
        with_field(name, [&] {
            if (data.contains("json_schema") && !data.contains("grammar")) {
                try {
                    auto schema = json_value(data, "json_schema", json::object());
                    if (schema.is_object() && schema.empty()) schema["type"] = "object";
                    task.sampling.grammar = {COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT, json_schema_to_grammar(schema)};
                } catch (const std::exception & e) {
                    throw std::runtime_error(std::string("\"json_schema\": ") + e.what());
                }
            } else {
                std::string grammar_str = json_value(data, "grammar", std::string());
                if (!grammar_str.empty()) {
                    std::string grammar_type = json_value(data, "grammar_type", std::string());
                    task.sampling.grammar = {grammar_type == "tool_calls" ? COMMON_GRAMMAR_TYPE_TOOL_CALLS
                                                                          : COMMON_GRAMMAR_TYPE_USER,
                                             std::move(grammar_str)};
                }
            }
        });
        break;
    }
    bool_field(data, "grammar_lazy", task.sampling.grammar_lazy);

    if (has_value(data, "chat_format"))
        with_field("chat_format", [&] {
            task.parser.format = static_cast<common_chat_format>(data.at("chat_format").get<int>());
        });
    if (has_value(data, "reasoning_format"))
        with_field("reasoning_format", [&] {
            task.parser.reasoning_format =
                common_reasoning_format_from_name(data.at("reasoning_format").get<std::string>());
        });
    if (has_value(data, "generation_prompt"))
        with_field("generation_prompt", [&] {
            const std::string s = data.at("generation_prompt").get<std::string>();
            task.parser.generation_prompt = s;
            task.sampling.generation_prompt = s;
        });
    bool_field(data, "parse_tool_calls", task.parser.parse_tool_calls);
    if (has_value(data, "chat_parser"))
        with_field("chat_parser", [&] { task.parser.parser.load(data.at("chat_parser").get<std::string>()); });
    if (has_value(data, "continue_final_message"))
        with_field("continue_final_message", [&] {
            task.parser.is_continuation =
                common_chat_continuation_parse(data.at("continue_final_message")) != COMMON_CHAT_CONTINUATION_NONE;
        });

    if (has_value(data, "preserved_tokens"))
        with_field("preserved_tokens", [&] {
            for (const auto & t : data.at("preserved_tokens")) {
                auto ids = common_tokenize(vocab, t.get<std::string>(), false, true);
                if (ids.size() == 1) task.sampling.preserved_tokens.insert(ids[0]);
            }
        });
    if (has_value(data, "grammar_triggers"))
        with_field("grammar_triggers", [&] {
            for (const auto & t : data.at("grammar_triggers")) {
                auto trigger = grammar_trigger_from_json(t);
                if (trigger.type == COMMON_GRAMMAR_TRIGGER_TYPE_WORD) {
                    const auto & word = trigger.value;
                    auto ids = common_tokenize(vocab, word, false, true);
                    if (ids.size() == 1) {
                        auto token = ids[0];
                        if (task.sampling.preserved_tokens.find(token) == task.sampling.preserved_tokens.end())
                            throw std::runtime_error("Grammar trigger word should be marked as preserved token: " + word);
                        common_grammar_trigger by_token;
                        by_token.type = COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN;
                        by_token.value = word;
                        by_token.token = token;
                        task.sampling.grammar_triggers.push_back(std::move(by_token));
                    } else {
                        task.sampling.grammar_triggers.push_back({COMMON_GRAMMAR_TRIGGER_TYPE_WORD, word});
                    }
                } else {
                    task.sampling.grammar_triggers.emplace_back(std::move(trigger));
                }
            }
            if (task.sampling.grammar_lazy && task.sampling.grammar_triggers.empty())
                throw std::runtime_error("Error: no triggers set for lazy grammar!");
        });

    bool_field(data, "reasoning_control", task.sampling.reasoning_control);
    hard_num_field(data, {"reasoning_budget_tokens"}, task.sampling.reasoning_budget_tokens, -1, INT32_MAX);
    if (has_value(data, "reasoning_budget_start_tag"))
        with_field("reasoning_budget_start_tag", [&] {
            task.sampling.reasoning_budget_start =
                common_tokenize(vocab, data.at("reasoning_budget_start_tag").get<std::string>(), false, true);
        });
    for (const char * name : {"reasoning_budget_end_tags", "reasoning_budget_end_tag"}) {
        if (!has_value(data, name)) continue;
        with_field(name, [&] {
            task.sampling.reasoning_budget_end.clear();
            if (data.contains("reasoning_budget_end_tags")) {
                for (const auto & t : data.at("reasoning_budget_end_tags")) {
                    std::string tag = t.get<std::string>();
                    if (!tag.empty()) task.sampling.reasoning_budget_end.push_back(common_tokenize(vocab, tag, false, true));
                }
            } else if (data.contains("reasoning_budget_end_tag")) {
                std::string tag = data.at("reasoning_budget_end_tag").get<std::string>();
                if (!tag.empty()) task.sampling.reasoning_budget_end.push_back(common_tokenize(vocab, tag, false, true));
            }
        });
        break;
    }
    if (has_value(data, "reasoning_budget_message"))
        with_field("reasoning_budget_message", [&] {
            if (!task.sampling.reasoning_budget_end.empty()) {
                llama_tokens end_tag = task.sampling.reasoning_budget_end.front();
                std::string message = json_value(data, "reasoning_budget_message", std::string());
                if (!message.empty()) {
                    llama_tokens message_tokens = common_tokenize(vocab, message, false, true);
                    end_tag.insert(end_tag.begin(), message_tokens.begin(), message_tokens.end());
                }
                task.sampling.reasoning_budget_forced = std::move(end_tag);
            }
        });

    if (has_value(data, "stop"))
        with_field("stop", [&] {
            task.antiprompt.clear();
            const auto & stop = data.at("stop");
            if (stop.is_array()) {
                for (const auto & word : stop) {
                    if (!word.empty()) task.antiprompt.push_back(word.get<std::string>());
                }
            } else if (stop.is_string()) {
                task.antiprompt.push_back(stop.get<std::string>());
            }
        });
    if (has_value(data, "samplers"))
        with_field("samplers", [&] {
            const auto & samplers = data.at("samplers");
            if (samplers.is_array())
                task.sampling.samplers = common_sampler_types_from_names(samplers.get<std::vector<std::string>>());
            else if (samplers.is_string())
                task.sampling.samplers = common_sampler_types_from_chars(samplers.get<std::string>());
        });
    return task;
}

// ---- server-task: streaming parse and chunk shapes ------------------------

json diff_to_json(const common_chat_msg_diff & diff) {
    json delta = json::object();
    if (!diff.reasoning_content_delta.empty()) delta["reasoning_content"] = diff.reasoning_content_delta;
    if (!diff.content_delta.empty()) delta["content"] = diff.content_delta;
    if (diff.tool_call_index != std::string::npos) {
        json tool_call;
        tool_call["index"] = diff.tool_call_index;
        if (!diff.tool_call_delta.id.empty()) {
            tool_call["id"] = diff.tool_call_delta.id;
            tool_call["type"] = "function";
        }
        if (!diff.tool_call_delta.name.empty() || !diff.tool_call_delta.arguments.empty()) {
            json function = json::object();
            if (!diff.tool_call_delta.name.empty()) function["name"] = diff.tool_call_delta.name;
            if (!diff.tool_call_delta.arguments.empty()) function["arguments"] = diff.tool_call_delta.arguments;
            tool_call["function"] = function;
        }
        delta["tool_calls"] = json::array({tool_call});
    }
    return delta;
}

struct stream_state {
    common_chat_parser_params parser;
    std::string generated_text;
    common_chat_msg chat_msg;
    std::vector<std::string> generated_tool_call_ids;
    std::string cmpl_id = "chatcmpl-" + random_string();
    std::time_t created = std::time(nullptr);

    common_chat_msg update(const std::string & text_added, bool is_partial, std::vector<common_chat_msg_diff> & diffs) {
        generated_text += text_added;
        auto previous = chat_msg;
        auto next = common_chat_parse(generated_text, is_partial, parser);
        if (!next.empty()) {
            next.set_tool_call_ids(generated_tool_call_ids, random_string);
            chat_msg = next;
            diffs = common_chat_msg_diff::compute_diffs(previous, chat_msg);
        }
        return chat_msg;
    }

    json chunk(const json & choices) const {
        return json{{"choices", choices},
                    {"created", created},
                    {"id", cmpl_id},
                    {"model", std::string("gezel-mobile")},
                    {"system_fingerprint", std::string(llama_build_info())},
                    {"object", "chat.completion.chunk"}};
    }
    json delta_chunk(const json & delta) const {
        return chunk(json::array({json{{"finish_reason", nullptr}, {"index", 0}, {"delta", delta}}}));
    }
};

/** llama-server's server_slot_stats: the `timings` object, with its time bases. */
struct slot_stats {
    uint64_t n_prompt_cached = 0;
    uint64_t n_prompt_processed = 0;
    uint64_t n_gen = 0;
    // absolute timestamps in us; start -> prompt -> gen
    int64_t t_start = 0;
    int64_t t_prompt_last = 0;
    int64_t t_gen_last = 0;

    void update_prompt_start() { t_start = ggml_time_us(); }
    void update_prompt_last() { t_prompt_last = ggml_time_us(); }
    void update_gen_last() { t_gen_last = ggml_time_us(); }
    double t_prompt_ms() const { return t_prompt_last == 0 ? 0.0 : (t_prompt_last - t_start) / 1000.0; }
    int64_t t_gen_us() const {
        // clamp to 1 us, the first token can land in the same us as t_prompt_last
        return t_gen_last == 0 ? 0 : std::max<int64_t>(1, t_gen_last - t_prompt_last);
    }
    double t_gen_ms() const { return t_gen_us() / 1000.0; }
    // the first token is free, it comes from the logits of the last prompt batch
    uint64_t n_gen_steps() const { return n_gen > 0 ? n_gen - 1 : 0; }
    double t_prompt_per_token_ms() const { return n_prompt_processed > 0 ? t_prompt_ms() / n_prompt_processed : 0.0; }
    double t_gen_per_token_ms() const { return n_gen_steps() > 0 ? t_gen_ms() / n_gen_steps() : 0.0; }
    double n_prompt_tps() const {
        const double t_ms = t_prompt_ms();
        return t_ms > 0.0 ? 1e3 / t_ms * n_prompt_processed : 0.0;
    }
    double n_gen_tps() const {
        const double t_ms = t_gen_ms();
        return t_ms > 0.0 ? 1e3 / t_ms * n_gen_steps() : 0.0;
    }
    json to_json() const {
        return json{
            {"cache_n", n_prompt_cached},
            {"prompt_n", n_prompt_processed},
            {"prompt_ms", t_prompt_ms()},
            {"prompt_per_token_ms", t_prompt_per_token_ms()},
            {"prompt_per_second", n_prompt_tps()},
            {"predicted_n", n_gen},
            {"predicted_ms", t_gen_ms()},
            {"predicted_per_token_ms", t_gen_per_token_ms()},
            {"predicted_per_second", n_gen_tps()},
        };
    }
};

/** Emits one JSON object to the host; a non-zero reply asks to stop. */
struct emitter {
    gezel_llama_engine & engine;
    uint64_t request_id;
    gezel_llama_json_callback callback;
    void * user_data;
    void operator()(const json & value) const {
        const std::string text = value.dump();
        if (callback(text.data(), text.size(), user_data) != 0) gezel_llama_cancel(&engine, request_id);
    }
};

common_chat_templates * templates_for(gezel_llama_engine & engine) {
    if (!engine.chat_templates) {
        try {
            engine.chat_templates = common_chat_templates_init(engine.model, engine.chat.chat_template);
        } catch (const std::exception & e) {
            throw chat_failure(std::string("Failed to load the model's chat template: ") + e.what(), ERROR_TYPE_SERVER,
                               GEZEL_LLAMA_UNSUPPORTED);
        }
    }
    return engine.chat_templates.get();
}

int32_t chat_impl(gezel_llama_engine & engine, const std::string & request, const gezel_llama_chat_options & options,
                  const emitter & emit, gezel_llama_result & result, gezel_llama_error * error) {
    json body;
    try {
        body = json::parse(request);
    } catch (const std::exception & e) {
        throw chat_failure(e.what(), ERROR_TYPE_INVALID_REQUEST, GEZEL_LLAMA_INVALID_ARGUMENT);
    }
    if (!body.is_object()) throw chat_failure("request body must be a JSON object", ERROR_TYPE_INVALID_REQUEST, GEZEL_LLAMA_INVALID_ARGUMENT);

    auto tmpls = templates_for(engine);
    const llama_vocab * vocab = llama_model_get_vocab(engine.model);
    chat_task task;
    common_chat_msg_delimiters delimiters;
    try {
        const json params = chat_params_parse(body, engine.chat, tmpls);
        task = task_from_params(params, vocab, base_sampling(engine.model), engine.chat);
        delimiters = common_chat_msg_delimiters_parse(json_value(params, "message_delimiters", json::array()));
        if (options.flags & GEZEL_LLAMA_CHAT_RENDER_ONLY) {
            json out{{"prompt", params.at("prompt")},
                     {"chat_format", common_chat_format_name(task.parser.format)},
                     {"grammar", json_value(params, "grammar", std::string())},
                     {"grammar_lazy", json_value(params, "grammar_lazy", false)},
                     {"grammar_triggers", json_value(params, "grammar_triggers", json::array())},
                     {"preserved_tokens", json_value(params, "preserved_tokens", json::array())},
                     {"stop", json_value(params, "stop", json::array())},
                     {"generation_prompt", json_value(params, "generation_prompt", std::string())}};
            emit(out);
            return GEZEL_LLAMA_OK;
        }
    } catch (const chat_failure &) {
        throw;
    } catch (const std::exception & e) {
        throw chat_failure(e.what(), ERROR_TYPE_INVALID_REQUEST, GEZEL_LLAMA_INVALID_ARGUMENT);
    }

    const auto tokens = common_tokenize(vocab, task.prompt, true, true);
    result.prompt_tokens = static_cast<uint32_t>(tokens.size());
    const auto n_ctx = static_cast<int32_t>(engine.context_tokens);
    if (tokens.empty()) throw chat_failure("empty prompt", ERROR_TYPE_INVALID_REQUEST, GEZEL_LLAMA_INVALID_ARGUMENT);
    if (static_cast<int32_t>(tokens.size()) >= n_ctx) {
        chat_failure failure(string_format("request (%d tokens) exceeds the available context size (%d tokens), try increasing it",
                                           (int) tokens.size(), n_ctx),
                             ERROR_TYPE_EXCEED_CONTEXT_SIZE, GEZEL_LLAMA_CONTEXT_LIMIT);
        failure.n_prompt_tokens = static_cast<int32_t>(tokens.size());
        failure.n_ctx = n_ctx;
        throw failure;
    }

    std::unique_ptr<common_sampler, decltype(&common_sampler_free)> sampler(
        common_sampler_init(engine.model, task.sampling), common_sampler_free);
    if (!sampler) throw chat_failure("Failed to initialize the sampler", ERROR_TYPE_INVALID_REQUEST, GEZEL_LLAMA_INVALID_ARGUMENT);

    slot_stats stats;
    stats.update_prompt_start();
    // Checkpoints where llama-server takes them: at the last user message,
    // which an older turn re-rendered differently still starts the same way,
    // and a few tokens before the end, ahead of a generation prompt that
    // renders differently once the reply is history.
    delimiters.tokenize(vocab);
    const auto last_user = delimiters.split(tokens).last_user_message_pos();
    std::vector<size_t> checkpoints;
    if (last_user > 0) checkpoints.push_back(static_cast<size_t>(last_user));
    if (tokens.size() > 4) checkpoints.push_back(tokens.size() - 4);
    size_t reused = 0;
    if (const auto status = decode_prompt(engine, tokens, reused, error, checkpoints); status) return status;
    stats.n_prompt_cached = reused;
    stats.n_prompt_processed = tokens.size() - reused;
    stats.update_prompt_last();
    // The prompt tokens are now in context; the sampler's penalties and grammar
    // see the reply only, as in llama-server.
    engine.progress_phase.store(GEZEL_LLAMA_PHASE_GENERATING, std::memory_order_release);

    stream_state state;
    state.parser = task.parser;
    if (state.parser.is_continuation) state.chat_msg = common_chat_parse("", true, state.parser);
    auto emit_diffs = [&](const std::vector<common_chat_msg_diff> & diffs) {
        for (const auto & diff : diffs) emit(state.delta_chunk(diff_to_json(diff)));
    };
    // One token's partial result: the chunks it produced, the last carrying the
    // running timings when the request asked for them per token.
    auto emit_partial = [&](std::vector<json> chunks) {
        if (chunks.empty()) return;
        if (task.timings_per_token) chunks.back()["timings"] = stats.to_json();
        for (const auto & chunk : chunks) emit(chunk);
    };

    std::string generated_text;
    size_t n_sent_text = 0;
    int32_t n_decoded = 0;
    bool stopped_by_word = false;
    bool stopped_by_eos = false;
    bool stopped_by_limit = false;
    int32_t n_past = static_cast<int32_t>(tokens.size());
    for (;;) {
        if (const auto stop = engine.stopped()) return stop_error(engine, error);
        const llama_token token = common_sampler_sample(sampler.get(), engine.context, -1);
        common_sampler_accept(sampler.get(), token, true);
        if (const auto stop = engine.stopped()) return stop_error(engine, error);
        ++n_decoded;
        stats.n_gen = static_cast<uint64_t>(n_decoded);
        if (n_decoded == 1) stats.update_prompt_last();
        stats.update_gen_last();
        result.generated_tokens = static_cast<uint32_t>(n_decoded);
        engine.progress_generated.store(result.generated_tokens, std::memory_order_relaxed);
        const bool special = task.sampling.preserved_tokens.find(token) != task.sampling.preserved_tokens.end();
        const std::string token_str = common_token_to_piece(engine.context, token, special);
        generated_text += token_str;
        const bool is_eog = llama_vocab_is_eog(vocab, token);
        bool has_next_token = true;

        // process_token: stop words, context and length limits, EOS
        std::string text_to_send;
        const bool incomplete = validate_utf8(generated_text) < generated_text.size();
        if (!incomplete) {
            size_t pos = std::min(n_sent_text, generated_text.size());
            const std::string str_test = generated_text.substr(pos);
            bool send_text = true;
            size_t stop_pos = std::string::npos;
            for (const auto & word : task.antiprompt) {
                const size_t tmp = word.size() + token_str.size();
                const size_t from_pos = str_test.size() > tmp ? str_test.size() - tmp : 0;
                const size_t found = str_test.find(word, from_pos);
                if (found != std::string::npos && (stop_pos == std::string::npos || found < stop_pos)) stop_pos = found;
            }
            if (stop_pos != std::string::npos) {
                stopped_by_word = true;
                has_next_token = false;
                generated_text.erase(generated_text.begin() + static_cast<std::ptrdiff_t>(pos + stop_pos), generated_text.end());
                pos = std::min(n_sent_text, generated_text.size());
            } else if (!is_eog) {
                size_t partial = std::string::npos;
                for (const auto & word : task.antiprompt) {
                    const size_t found = string_find_partial_stop(str_test, word);
                    if (found != std::string::npos && (partial == std::string::npos || found < partial)) partial = found;
                }
                send_text = partial == std::string::npos;
            }
            if (send_text) {
                text_to_send = generated_text.substr(pos, std::string::npos);
                n_sent_text += text_to_send.size();
            }
            if (result.output_bytes + text_to_send.size() > options.max_output_bytes)
                return fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Generated output exceeds its byte limit");
            result.output_bytes += static_cast<uint32_t>(text_to_send.size());
            std::vector<json> chunks;
            // We have to send an initial update to conform to openai behavior
            if (n_decoded == 1) {
                json first = json::object();
                first["role"] = "assistant";
                first["content"] = nullptr;
                chunks.push_back(state.delta_chunk(first));
            }
            std::vector<common_chat_msg_diff> diffs;
            state.update(text_to_send, true, diffs);
            for (const auto & diff : diffs) chunks.push_back(state.delta_chunk(diff_to_json(diff)));
            emit_partial(std::move(chunks));
        }
        // context shift is off in llama-server by default: stop at the edge
        if (n_past + 1 >= n_ctx) {
            stopped_by_limit = true;
            has_next_token = false;
        }
        if (has_next_token && task.n_predict != -1 && n_decoded >= task.n_predict) {
            stopped_by_limit = true;
            has_next_token = false;
        }
        if (is_eog) {
            stopped_by_eos = true;
            has_next_token = false;
        }
        if (!has_next_token) break;
        const auto status = llama_decode(engine.context, llama_batch_get_one(const_cast<llama_token *>(&token), 1));
        if (engine.stopped()) return stop_error(engine, error);
        if (status != 0) return fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Token decoding failed");
        engine.cached.push_back(token);
        ++n_past;
    }

    // Final: a full (non-partial) parse, then the finish and usage chunks.
    std::vector<common_chat_msg_diff> diffs;
    const auto msg = state.update("", false, diffs);
    emit_diffs(diffs);
    std::string finish_reason = "length";
    if (stopped_by_word || stopped_by_eos) finish_reason = msg.tool_calls.empty() ? "stop" : "tool_calls";
    (void) stopped_by_limit;
    result.finish_reason = finish_reason == "tool_calls" ? GEZEL_LLAMA_FINISH_TOOL_CALLS
        : finish_reason == "stop"                          ? GEZEL_LLAMA_FINISH_STOP
                                                           : GEZEL_LLAMA_FINISH_LENGTH;
    json finish = state.chunk(json::array({json{{"finish_reason", finish_reason}, {"index", 0}, {"delta", json::object()}}}));
    const int32_t prompt_tokens = static_cast<int32_t>(tokens.size());
    json usage{{"completion_tokens", n_decoded},
               {"prompt_tokens", prompt_tokens},
               {"total_tokens", n_decoded + prompt_tokens},
               {"prompt_tokens_details", json{{"cached_tokens", stats.n_prompt_cached}}}};
    if (task.include_usage) {
        emit(finish);
        json tail = state.chunk(json::array());
        tail["usage"] = usage;
        tail["timings"] = stats.to_json();
        emit(tail);
    } else {
        finish["timings"] = stats.to_json();
        emit(finish);
    }
    return GEZEL_LLAMA_OK;
}

bool valid_chat_options(const gezel_llama_chat_options * options) {
    return options && options->struct_size == sizeof(*options) && options->abi_version == GEZEL_LLAMA_ABI_VERSION &&
        valid_request(options->request_id) && valid_timeout(options->timeout_ms) && options->max_output_bytes >= 1 &&
        options->max_output_bytes <= 4 * 1024 * 1024 && (options->flags & ~GEZEL_LLAMA_CHAT_RENDER_ONLY) == 0;
}

void quiet_common_log() {
    static std::once_flag once;
    std::call_once(once, [] { common_log_set_verbosity_thold(-1); });
}
}

extern "C" {
gezel_llama_chat_options gezel_llama_default_chat_options(void) {
    return {sizeof(gezel_llama_chat_options), GEZEL_LLAMA_ABI_VERSION, 0, 600000, 1024 * 1024, 0};
}

int32_t gezel_llama_configure_chat(gezel_llama_engine * engine, const char * config_json, size_t length,
                                   gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    if (!engine || !config_json || length > 256 * 1024)
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Chat configuration must be a JSON object under 256 KiB");
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return fail(error, GEZEL_LLAMA_BUSY, "Engine is busy");
    try {
        const json config = json::parse(std::string(config_json, length));
        if (!config.is_object()) return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Chat configuration must be a JSON object");
        chat_config next;
        next.chat_template = json_value(config, "chat_template", std::string());
        if (config.contains("reasoning_format"))
            next.reasoning_format = common_reasoning_format_from_name(json_value(config, "reasoning_format", std::string("deepseek")));
        next.reasoning_budget = json_value(config, "reasoning_budget", -1);
        next.reasoning_budget_message = json_value(config, "reasoning_budget_message", std::string());
        next.enable_thinking = json_value(config, "enable_thinking", true);
        next.prefill_assistant = json_value(config, "prefill_assistant", true);
        for (const auto & item : json_value(config, "chat_template_kwargs", json::object()).items())
            next.chat_template_kwargs[item.key()] = item.value().dump();
        if (next.chat_template != engine->chat.chat_template) engine->chat_templates.reset();
        engine->chat = std::move(next);
    } catch (const std::exception & e) {
        return fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, e.what());
    }
    return GEZEL_LLAMA_OK;
}

int32_t gezel_llama_chat(gezel_llama_engine * engine, const char * request_json, size_t length,
                         const gezel_llama_chat_options * options, gezel_llama_json_callback on_event, void * user_data,
                         gezel_llama_result * result, gezel_llama_error * error) {
    fail(error, GEZEL_LLAMA_OK, "");
    gezel_llama_result local{};
    auto & output = result ? *result : local;
    output = {};
    auto finish = [&](int32_t status) {
        output.status = status;
        if (status != GEZEL_LLAMA_OK) output.finish_reason = status == GEZEL_LLAMA_CANCELLED ? GEZEL_LLAMA_FINISH_CANCELLED
            : status == GEZEL_LLAMA_TIMEOUT                                                   ? GEZEL_LLAMA_FINISH_TIMEOUT
                                                                                              : GEZEL_LLAMA_FINISH_ERROR;
        return status;
    };
    if (!engine || !request_json || !on_event || length == 0 || length > 1024 * 1024 || !valid_chat_options(options))
        return finish(fail(error, GEZEL_LLAMA_INVALID_ARGUMENT, "Invalid chat request, options or ABI version"));
    std::unique_lock<std::mutex> lock(engine->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return finish(fail(error, GEZEL_LLAMA_BUSY, "Engine is busy"));
    if (!engine->model || !engine->context) return finish(fail(error, GEZEL_LLAMA_NOT_LOADED, "No model is loaded"));
    quiet_common_log();
    const auto config = *options;
    operation active(*engine, config.request_id, config.timeout_ms);
    engine->begin_progress(GEZEL_LLAMA_PHASE_PROMPT);
    const emitter emit{*engine, config.request_id, on_event, user_data};
    int32_t status;
    try {
        status = chat_impl(*engine, std::string(request_json, length), config, emit, output, error);
    } catch (const chat_failure & failure) {
        json body = format_error_response(failure.what(), failure.type);
        if (failure.type == ERROR_TYPE_EXCEED_CONTEXT_SIZE) {
            body["n_prompt_tokens"] = failure.n_prompt_tokens;
            body["n_ctx"] = failure.n_ctx;
        }
        emit(json{{"error", body}});
        status = fail(error, failure.status, failure.what());
    } catch (const std::bad_alloc &) {
        status = fail(error, GEZEL_LLAMA_RESOURCE_LIMIT, "Insufficient inference memory");
        emit(json{{"error", format_error_response("Insufficient inference memory", ERROR_TYPE_SERVER)}});
    } catch (const std::exception & e) {
        status = fail(error, GEZEL_LLAMA_INFERENCE_FAILED, e.what());
        emit(json{{"error", format_error_response(e.what(), ERROR_TYPE_SERVER)}});
    } catch (...) {
        status = fail(error, GEZEL_LLAMA_INFERENCE_FAILED, "Unexpected native inference failure");
        emit(json{{"error", format_error_response("Unexpected native inference failure", ERROR_TYPE_SERVER)}});
    }
    finish_request(*engine, status);
    return finish(status);
}
}
