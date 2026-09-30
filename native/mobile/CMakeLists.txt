cmake_minimum_required(VERSION 3.24)
project(gezel-mobile-llama LANGUAGES C CXX)

if(NOT EXISTS "${GEZEL_LLAMA_SOURCE_DIR}/include/llama.h")
    message(FATAL_ERROR "GEZEL_LLAMA_SOURCE_DIR must point at the verified upstream export")
endif()
add_subdirectory("${GEZEL_LLAMA_SOURCE_DIR}" llama)
find_package(Threads REQUIRED)
include(common-chat.cmake)

add_library(gezel-llama gezel_llama.cpp gezel_chat.cpp $<TARGET_OBJECTS:gezel-common-chat>)
target_compile_features(gezel-llama PUBLIC cxx_std_17)
target_include_directories(gezel-llama PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
# llama-ext.h (llama_get_memory_breakdown, for gezel_llama_estimate_memory).
target_include_directories(gezel-llama PRIVATE "${GEZEL_LLAMA_SOURCE_DIR}/src" "${GEZEL_COMMON_DIR}")
target_link_libraries(gezel-llama PUBLIC llama PRIVATE vendor::nlohmann Threads::Threads)
set_target_properties(gezel-llama PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
# Android ships one ggml CPU library per instruction-set level; the bridge
# loads the best one the device supports (see load_cpu_variant).
if(GGML_BACKEND_DL)
    target_compile_definitions(gezel-llama PRIVATE GEZEL_CPU_VARIANTS=1)
    if(ANDROID)
        target_link_libraries(gezel-llama PRIVATE dl log)
    endif()
endif()

option(GEZEL_MOBILE_TESTS "Build native bridge contract tests" OFF)
if(GEZEL_MOBILE_TESTS)
    enable_testing()
    add_executable(gezel-llama-tests bridge-tests.cpp)
    target_link_libraries(gezel-llama-tests PRIVATE gezel-llama)
    add_test(NAME mobile-bridge COMMAND gezel-llama-tests "${CMAKE_BINARY_DIR}/fixture.gguf")
    set_tests_properties(mobile-bridge PROPERTIES TIMEOUT 30)
    # The chat layer against upstream's own template fixtures, no model needed.
    add_executable(gezel-chat-tests chat-tests.cpp)
    target_link_libraries(gezel-chat-tests PRIVATE gezel-llama)
    target_include_directories(gezel-chat-tests PRIVATE "${GEZEL_COMMON_DIR}")
    add_test(NAME mobile-chat-fixture COMMAND gezel-llama-tests --write-fixture "${CMAKE_BINARY_DIR}/chat-fixture.gguf")
    set_tests_properties(mobile-chat-fixture PROPERTIES FIXTURES_SETUP chat-fixture)
    add_test(NAME mobile-chat COMMAND gezel-chat-tests "${GEZEL_LLAMA_SOURCE_DIR}/models/templates" "${CMAKE_BINARY_DIR}/chat-fixture.gguf")
    set_tests_properties(mobile-chat PROPERTIES TIMEOUT 120 FIXTURES_REQUIRED chat-fixture)
endif()
