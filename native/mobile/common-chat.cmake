# llama.cpp's chat layer, compiled into the bridge.
#
# This is the code llama-server runs for `--jinja` tool calling on desktop:
# each model's own template renders the tools, a lazy grammar holds the call to
# the model's trained syntax, and the per-family parsers turn it back into
# structured tool calls. The phone runs the same sources so both hosts agree on
# every byte. The whole llama-common library would also bring model downloads
# and an HTTP client into the app; the chat path needs neither, so those files
# stay out and LLAMA_BUILD_COMMON stays off.

set(GEZEL_COMMON_DIR "${GEZEL_LLAMA_SOURCE_DIR}/common")
include("${GEZEL_COMMON_DIR}/parsers/sources.cmake")

set(BUILD_COMPILER "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
set(BUILD_TARGET "${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")
configure_file("${GEZEL_COMMON_DIR}/build-info.cpp.in" "${CMAKE_CURRENT_BINARY_DIR}/build-info.cpp")

set(GEZEL_COMMON_CHAT_FILES
    chat-auto-parser-generator.cpp
    chat-auto-parser-helpers.cpp
    chat-diff-analyzer.cpp
    chat-peg-parser.cpp
    chat.cpp
    common.cpp
    debug.cpp
    fit.cpp
    json-schema-to-grammar.cpp
    json-schema.cpp
    json.cpp
    llguidance.cpp
    log.cpp
    ngram-cache.cpp
    ngram-map.cpp
    ngram-mod.cpp
    peg-parser.cpp
    reasoning-budget.cpp
    sampling.cpp
    speculative.cpp
    trie.cpp
    unicode.cpp
    jinja/caps.cpp
    jinja/lexer.cpp
    jinja/parser.cpp
    jinja/runtime.cpp
    jinja/string.cpp
    jinja/value.cpp)
list(TRANSFORM GEZEL_COMMON_CHAT_FILES PREPEND "${GEZEL_COMMON_DIR}/")

add_library(gezel-common-chat OBJECT
    ${LLAMA_CHAT_PARSERS_SOURCES}
    ${GEZEL_COMMON_CHAT_FILES}
    "${CMAKE_CURRENT_BINARY_DIR}/build-info.cpp")
target_compile_features(gezel-common-chat PUBLIC cxx_std_17)
target_include_directories(gezel-common-chat PUBLIC "${GEZEL_COMMON_DIR}")
target_link_libraries(gezel-common-chat PUBLIC llama vendor::nlohmann Threads::Threads)
set_target_properties(gezel-common-chat PROPERTIES POSITION_INDEPENDENT_CODE ON)
