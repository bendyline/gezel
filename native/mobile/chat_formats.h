#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "llama.h"

namespace gezel_mobile {

/**
 * Chat formats llama.cpp's built-in template renderer does not know. The
 * bridge accepts only text transcripts of system, user and assistant turns,
 * so each format here covers exactly that subset of its model's Jinja
 * template: no tools, no media, thinking off.
 */
struct chat_formats {
    /** Gemma 4 turns (`<|turn>role ... <turn|>`). Its template is the only one
     * that uses both markers. Every Gemma 4 model the mobile catalog offered
     * was refused as "requires an unsupported Jinja renderer" (2026-09-26). */
    static bool is_gemma4(const char * chat_template) {
        return std::strstr(chat_template, "<|turn>") && std::strstr(chat_template, "<turn|>");
    }

    static std::string gemma4(const std::vector<llama_chat_message> & chat) {
        std::string out;
        size_t first = 0;
        if (!chat.empty() && std::strcmp(chat[0].role, "system") == 0) {
            out += "<|turn>system\n" + trim(chat[0].content) + "<turn|>\n";
            first = 1;
        }
        for (size_t index = first; index < chat.size(); ++index) {
            const bool model = is_assistant(chat[index]);
            // Consecutive assistant messages share one model turn.
            if (!(model && index > first && is_assistant(chat[index - 1])))
                out += std::string("<|turn>") + (model ? "model" : chat[index].role) + "\n";
            out += model ? strip_thinking(chat[index].content) : trim(chat[index].content);
            if (!(model && index + 1 < chat.size() && is_assistant(chat[index + 1]))) out += "<turn|>\n";
        }
        return out + "<|turn>model\n";
    }

private:
    static bool is_assistant(const llama_chat_message & message) { return std::strcmp(message.role, "assistant") == 0; }

    static std::string trim(const std::string & text) {
        const char * space = " \t\n\r\f\v";
        const auto begin = text.find_first_not_of(space);
        if (begin == std::string::npos) return "";
        return text.substr(begin, text.find_last_not_of(space) - begin + 1);
    }

    /** The template drops `<|channel>...<channel|>` thinking from model turns. */
    static std::string strip_thinking(const std::string & text) {
        static const std::string close = "<channel|>", open = "<|channel>";
        std::string kept;
        for (size_t start = 0;;) {
            const auto end = text.find(close, start);
            const auto part = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
            const auto thinking = part.find(open);
            kept += thinking == std::string::npos ? part : part.substr(0, thinking);
            if (end == std::string::npos) break;
            start = end + close.size();
        }
        return trim(kept);
    }
};

}  // namespace gezel_mobile
