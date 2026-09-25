cmake_minimum_required(VERSION 3.24)
project(gezel-mobile-llama LANGUAGES C CXX)

if(NOT EXISTS "${GEZEL_LLAMA_SOURCE_DIR}/include/llama.h")
    message(FATAL_ERROR "GEZEL_LLAMA_SOURCE_DIR must point at the verified upstream export")
endif()
add_subdirectory("${GEZEL_LLAMA_SOURCE_DIR}" llama)

add_library(gezel-llama gezel_llama.cpp)
target_compile_features(gezel-llama PUBLIC cxx_std_17)
target_include_directories(gezel-llama PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(gezel-llama PUBLIC llama)
set_target_properties(gezel-llama PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

option(GEZEL_MOBILE_TESTS "Build native bridge contract tests" OFF)
if(GEZEL_MOBILE_TESTS)
    enable_testing()
    add_executable(gezel-llama-tests bridge-tests.cpp)
    target_link_libraries(gezel-llama-tests PRIVATE gezel-llama)
    add_test(NAME mobile-bridge COMMAND gezel-llama-tests "${CMAKE_BINARY_DIR}/fixture.gguf")
    set_tests_properties(mobile-bridge PROPERTIES TIMEOUT 30)
endif()
