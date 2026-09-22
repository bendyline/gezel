#include <jni.h>
#include "gezel_llama.h"
#include "jni_helpers.h"
#include <algorithm>
#include <vector>

using gezel_jni::fail;
using gezel_jni::utf8;

namespace {
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

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_load(JNIEnv * env, jclass, jlong handle, jstring path, jlong request, jint context) try {
    std::string nativePath = utf8(env, path);
    if (env->ExceptionCheck()) return;
    auto options = gezel_llama_default_load_options();
    options.request_id = static_cast<uint64_t>(request);
    options.context_tokens = static_cast<uint32_t>(context);
    gezel_llama_error error{};
    if (gezel_llama_load(engine(handle), nativePath.c_str(), &options, &error) != GEZEL_LLAMA_OK) fail(env, error.message);
} catch (...) {
    fail(env, "Native model loading ran out of resources");
}

extern "C" JNIEXPORT jint JNICALL
Java_com_bendyline_gezel_llama_LlamaRuntime_generate(JNIEnv * env, jclass, jlong handle, jobjectArray roles, jobjectArray contents, jlong request, jint maxTokens, jobject callback) try {
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

