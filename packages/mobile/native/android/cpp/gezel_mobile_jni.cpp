#include <jni.h>
#include "gezel_llama.h"
#include <exception>
#include <string>
#include <vector>

namespace {
gezel_llama_engine * engine(jlong handle) {
    return reinterpret_cast<gezel_llama_engine *>(static_cast<intptr_t>(handle));
}

void fail(JNIEnv * env, const char * message) {
    if (env->ExceptionCheck()) return;
    jclass type = env->FindClass("java/lang/IllegalStateException");
    if (type) env->ThrowNew(type, message);
}

// JNI's GetStringUTFChars uses modified UTF-8, which changes NUL and surrogate
// pairs. Models consume real UTF-8, so use Java's standard encoder instead.
std::string utf8(JNIEnv * env, jstring value) {
    if (env->ExceptionCheck()) return {};
    if (!value) { fail(env, "Text is required"); return {}; }
    jclass type = env->FindClass("java/lang/String");
    if (!type) return {};
    jmethodID encode = env->GetMethodID(type, "getBytes", "(Ljava/lang/String;)[B");
    if (!encode) { env->DeleteLocalRef(type); return {}; }
    jstring charset = env->NewStringUTF("UTF-8");
    if (!charset) { env->DeleteLocalRef(type); return {}; }
    auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(value, encode, charset));
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(type);
    if (!bytes || env->ExceptionCheck()) return {};
    std::string result(static_cast<size_t>(env->GetArrayLength(bytes)), '\0');
    env->GetByteArrayRegion(bytes, 0, static_cast<jsize>(result.size()), reinterpret_cast<jbyte *>(result.data()));
    env->DeleteLocalRef(bytes);
    return result;
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
Java_com_bendyline_gezel_mobile_LlamaRuntime_create(JNIEnv *, jclass) {
    return static_cast<jlong>(reinterpret_cast<intptr_t>(gezel_llama_create()));
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_LlamaRuntime_destroy(JNIEnv *, jclass, jlong handle) {
    gezel_llama_destroy(engine(handle));
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_LlamaRuntime_unload(JNIEnv * env, jclass, jlong handle) {
    gezel_llama_error error{};
    if (gezel_llama_unload(engine(handle), &error) != GEZEL_LLAMA_OK) fail(env, error.message);
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_LlamaRuntime_cancel(JNIEnv *, jclass, jlong handle, jlong request) {
    gezel_llama_cancel(engine(handle), static_cast<uint64_t>(request));
}

extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_LlamaRuntime_load(JNIEnv * env, jclass, jlong handle, jstring path, jlong request, jint context) try {
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
Java_com_bendyline_gezel_mobile_LlamaRuntime_generate(JNIEnv * env, jclass, jlong handle, jobjectArray roles, jobjectArray contents, jlong request, jint maxTokens, jobject callback) try {
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
    gezel_llama_result result{};
    gezel_llama_error error{};
    int32_t status = gezel_llama_generate(engine(handle), messages.data(), messages.size(), &options, chunk, &stream, &result, &error);
    if (status != GEZEL_LLAMA_OK && status != GEZEL_LLAMA_CANCELLED) fail(env, error.message);
    return result.finish_reason;
} catch (...) {
    fail(env, "Native conversation ran out of resources");
    return 0;
}
