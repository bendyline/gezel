#pragma once
#include <jni.h>
#include <string>

namespace gezel_jni {
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

}
