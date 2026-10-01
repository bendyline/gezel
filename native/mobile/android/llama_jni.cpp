#include <jni.h>
#include "gezel_llama.h"
#include "jni_helpers.h"
#include <algorithm>
#include <cstdio>
#include <vector>

using gezel_jni::fail;
using gezel_jni::utf8;

namespace {
/**
 * One thread per performance core. The bridge default of 2 left half of a
 * Galaxy S20 FE's big cores idle (prompt reading 11 tok/s at 2 threads, 20 at
 * 4), and little cores slow a matrix multiply that waits on its slowest
 * thread. Cores within 70% of the fastest core's clock count; 2 to 6.
 */
uint32_t performance_threads() {
    std::vector<long> clocks;
    for (int cpu = 0; cpu < 64; ++cpu) {
        char path[96];
        std::snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/cpufreq/cpuinfo_max_freq", cpu);
        FILE * file = std::fopen(path, "r");
        if (!file) continue;
        long clock = 0;
        if (std::fscanf(file, "%ld", &clock) == 1 && clock > 0) clocks.push_back(clock);
        std::fclose(file);
    }
    if (clocks.empty()) return 4;
    const long fastest = *std::max_element(clocks.begin(), clocks.end());
    const auto fast = std::count_if(clocks.begin(), clocks.end(), [&](long clock) { return clock * 10 >= fastest * 7; });
    return static_cast<uint32_t>(std::clamp<long>(fast, 2, 6));
}

gezel_llama_engine * engine(jlong handle) {
    return reinterpret_cast<gezel_llama_engine *>(static_cast<intptr_t>(handle));
}

struct Stream { JNIEnv * env; jobject callback; jmethodID method; };
int32_t chunk(const char * bytes, size_t length, void * opaque) {
    auto & stream = *static_cast<Stream *>(opaque);
    jbyteArray data = stream.env->NewByteArray(static_cast<jsize>(length));
    if (!data) return 1;
    stream.env->SetByteArrayRegion(data, 0, static_cast<jsize>(length), reinterpret_cast<const jbyte *>(bytes));
    if (stream.env->ExceptionCheck()) { stream.env->DeleteLocalRef(data); return 1; }
    jboolean keep = stream.env->CallBooleanMethod(stream.callback, stream.method, data);
    stream.env->DeleteLocalRef(data);
    return stream.env->ExceptionCheck() || !keep ? 1 : 0;
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_create(JNIEnv *, jclass) {
    return static_cast<jlong>(reinterpret_cast<intptr_t>(gezel_llama_create()));
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_destroy(JNIEnv *, jclass, jlong handle) {
    gezel_llama_destroy(engine(handle));
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_unload(JNIEnv * env, jclass, jlong handle) {
    gezel_llama_error error{};
    if (gezel_llama_unload(engine(handle), &error) != GEZEL_LLAMA_OK) fail(env, error.message);
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_cancel(JNIEnv *, jclass, jlong handle, jlong request) {
    gezel_llama_cancel(engine(handle), static_cast<uint64_t>(request));
}

/** {phase, load per-mille, prompt, processed, reused, generated}; never throws. */
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_progress(JNIEnv * env, jclass, jlong handle) {
    gezel_llama_progress progress{};
    progress.struct_size = sizeof(progress);
    progress.abi_version = GEZEL_LLAMA_ABI_VERSION;
    if (gezel_llama_get_progress(engine(handle), &progress) != GEZEL_LLAMA_OK) return nullptr;
    const jlong values[] = {static_cast<jlong>(progress.phase),
                            static_cast<jlong>(progress.load_fraction * 1000.0f),
                            static_cast<jlong>(progress.prompt_tokens),
                            static_cast<jlong>(progress.processed_tokens),
                            static_cast<jlong>(progress.reused_tokens),
                            static_cast<jlong>(progress.generated_tokens)};
    jlongArray result = env->NewLongArray(6);
    if (result) env->SetLongArrayRegion(result, 0, 6, values);
    return result;
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_load(JNIEnv * env, jclass, jlong handle, jstring path, jlong request, jint context) try {
    std::string nativePath = utf8(env, path);
    if (env->ExceptionCheck()) return;
    auto options = gezel_llama_default_load_options();
    options.request_id = static_cast<uint64_t>(request);
    options.context_tokens = static_cast<uint32_t>(context);
    options.threads = performance_threads();
    gezel_llama_error error{};
    if (gezel_llama_load(engine(handle), nativePath.c_str(), &options, &error) != GEZEL_LLAMA_OK) fail(env, error.message);
} catch (...) {
    fail(env, "Native model loading ran out of resources");
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_estimate(JNIEnv * env, jclass, jlong handle, jstring path, jint context) try {
    std::string nativePath = utf8(env, path);
    if (env->ExceptionCheck()) return nullptr;
    auto options = gezel_llama_default_load_options();
    options.context_tokens = static_cast<uint32_t>(context);
    options.threads = performance_threads();
    gezel_llama_memory_estimate estimate{sizeof(estimate), GEZEL_LLAMA_ABI_VERSION, 0, 0, 0, 0};
    gezel_llama_error error{};
    if (gezel_llama_estimate_memory(engine(handle), nativePath.c_str(), &options, &estimate, &error) != GEZEL_LLAMA_OK) {
        fail(env, error.message);
        return nullptr;
    }
    const jlong values[] = {static_cast<jlong>(estimate.model_bytes), static_cast<jlong>(estimate.mapped_model_bytes),
                            static_cast<jlong>(estimate.context_bytes), static_cast<jlong>(estimate.compute_bytes)};
    jlongArray result = env->NewLongArray(4);
    if (result) env->SetLongArrayRegion(result, 0, 4, values);
    return result;
} catch (...) {
    fail(env, "Native model sizing ran out of resources");
    return nullptr;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_generate(JNIEnv * env, jclass, jlong handle, jobjectArray roles, jobjectArray contents, jlong request, jint maxTokens,
        jfloat temperature, jint topK, jfloat topP, jfloat minP, jfloat repeatPenalty, jint repeatLastN, jint seed, jobject callback) try {
    if (!roles || !contents || !callback) { fail(env, "Conversation and stream callback are required"); return 0; }
    jsize count = env->GetArrayLength(roles);
    if (count != env->GetArrayLength(contents) || count < 1 || count > 128) { fail(env, "Invalid conversation"); return 0; }
    std::vector<std::string> roleStrings, contentStrings;
    roleStrings.reserve(count); contentStrings.reserve(count);
    for (jsize index = 0; index < count; ++index) {
        auto role = static_cast<jstring>(env->GetObjectArrayElement(roles, index));
        if (env->ExceptionCheck()) return 0;
        auto content = static_cast<jstring>(env->GetObjectArrayElement(contents, index));
        if (env->ExceptionCheck()) return 0;
        roleStrings.push_back(utf8(env, role));
        if (env->ExceptionCheck()) return 0;
        contentStrings.push_back(utf8(env, content));
        env->DeleteLocalRef(role); env->DeleteLocalRef(content);
        if (env->ExceptionCheck()) return 0;
    }
    std::vector<gezel_llama_message> messages;
    messages.reserve(count);
    for (jsize index = 0; index < count; ++index) messages.push_back({roleStrings[index].c_str(), contentStrings[index].c_str()});
    jclass callbackType = env->GetObjectClass(callback);
    if (!callbackType) return 0;
    jmethodID method = env->GetMethodID(callbackType, "onDelta", "([B)Z");
    env->DeleteLocalRef(callbackType);
    if (!method) return 0;
    Stream stream{env, callback, method};
    auto options = gezel_llama_default_generation_options();
    options.request_id = static_cast<uint64_t>(request);
    options.max_tokens = static_cast<uint32_t>(maxTokens);
    options.temperature = temperature;
    options.top_k = static_cast<uint32_t>(topK);
    options.top_p = topP;
    options.min_p = minP;
    options.repeat_penalty = repeatPenalty;
    options.repeat_last_n = static_cast<uint32_t>(repeatLastN);
    options.seed = static_cast<uint32_t>(seed);
    // The library's default deadline is a flat minute covering prompt
    // processing as well as decoding, which a long reply on a phone passes
    // routinely. Scale it with the reply actually asked for, and keep a
    // ceiling so a wedged decode still ends.
    options.timeout_ms = static_cast<uint32_t>(
        std::min<int64_t>(600000, 30000 + static_cast<int64_t>(maxTokens) * 250));
    gezel_llama_result result{};
    gezel_llama_error error{};
    int32_t status = gezel_llama_generate(engine(handle), messages.data(), messages.size(), &options, chunk, &stream, &result, &error);
    if (status != GEZEL_LLAMA_OK && status != GEZEL_LLAMA_CANCELLED) fail(env, error.message);
    return result.finish_reason;
} catch (...) {
    fail(env, "Native conversation ran out of resources");
    return 0;
}


extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_configureChat(JNIEnv * env, jclass, jlong handle, jstring config) try {
    const std::string json = utf8(env, config);
    if (env->ExceptionCheck()) return;
    gezel_llama_error error{};
    if (gezel_llama_configure_chat(engine(handle), json.data(), json.size(), &error) != GEZEL_LLAMA_OK) fail(env, error.message);
} catch (...) {
    fail(env, "Native chat configuration ran out of resources");
}

/**
 * One OpenAI-shaped chat request (see gezel_llama_chat). Each object llama-server
 * would stream reaches `callback.onEvent` as UTF-8 bytes, including an error body
 * when the request fails, so a failed request is not an exception here: the
 * status code says how it ended. Only a call the engine refuses outright (busy,
 * nothing loaded) throws.
 */
extern "C" JNIEXPORT jint JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_chat(JNIEnv * env, jclass, jlong handle, jstring request, jlong requestId,
        jint timeoutMs, jobject callback) try {
    if (!request || !callback) { fail(env, "Chat request and event callback are required"); return 0; }
    const std::string json = utf8(env, request);
    if (env->ExceptionCheck()) return 0;
    jclass callbackType = env->GetObjectClass(callback);
    if (!callbackType) return 0;
    jmethodID method = env->GetMethodID(callbackType, "onEvent", "([B)Z");
    env->DeleteLocalRef(callbackType);
    if (!method) return 0;
    Stream stream{env, callback, method};
    auto options = gezel_llama_default_chat_options();
    options.request_id = static_cast<uint64_t>(requestId);
    options.timeout_ms = static_cast<uint32_t>(std::clamp<jint>(timeoutMs, 1, 600000));
    gezel_llama_result result{};
    gezel_llama_error error{};
    const int32_t status = gezel_llama_chat(engine(handle), json.data(), json.size(), &options, chunk, &stream, &result, &error);
    if (status == GEZEL_LLAMA_BUSY || status == GEZEL_LLAMA_NOT_LOADED) fail(env, error.message);
    return status;
} catch (...) {
    fail(env, "Native chat ran out of resources");
    return 0;
}
