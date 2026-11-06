cmake_minimum_required(VERSION 3.22)
project(gezel_mobile LANGUAGES CXX)

get_filename_component(GEZEL_REPO_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../.." ABSOLUTE)
add_library(gezel_mobile SHARED gezel_mobile_jni.cpp)
target_compile_features(gezel_mobile PRIVATE cxx_std_17)
target_include_directories(gezel_mobile PRIVATE "${GEZEL_REPO_ROOT}/native/mobile/android")
target_link_options(gezel_mobile PRIVATE "-Wl,-z,max-page-size=16384")
# libGezelSpeech reaches the APK in @bendyline/gezel-capacitor's gezel-speech AAR,
# from the same build as this payload. Link it by name, not as an IMPORTED
# target: AGP packages IMPORTED libraries, and that copy would collide with the AAR's.
target_include_directories(gezel_mobile PRIVATE "${GEZEL_REPO_ROOT}/native/mobile/speech")
target_link_options(gezel_mobile PRIVATE "-L${GEZEL_REPO_ROOT}/native/mobile/.build/speech-android/payload")
target_link_libraries(gezel_mobile PRIVATE GezelSpeech)
