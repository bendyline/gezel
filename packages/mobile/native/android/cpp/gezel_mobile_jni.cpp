#include <jni.h>
#include "gezel_speech.h"
#include "jni_helpers.h"
#include <cstring>
#include <vector>

using gezel_jni::fail;
using gezel_jni::utf8;

extern "C" JNIEXPORT jlong JNICALL
Java_com_bendyline_gezel_mobile_SpeechRuntime_create(JNIEnv *, jclass) {
    return reinterpret_cast<jlong>(gezel_speech_create());
}
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_SpeechRuntime_cancel(JNIEnv *, jclass, jlong handle) {
    gezel_speech_cancel(reinterpret_cast<gezel_speech *>(handle));
}
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_mobile_SpeechRuntime_destroy(JNIEnv *, jclass, jlong handle) {
    gezel_speech_destroy(reinterpret_cast<gezel_speech *>(handle));
}
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_bendyline_gezel_mobile_SpeechRuntime_transcribe(JNIEnv *env, jclass, jlong handle,
    jstring model, jbyteArray pcm, jstring language, jstring prompt) try {
    if (!handle || !pcm) { fail(env, "Speech input is required"); return nullptr; }
    auto state = reinterpret_cast<gezel_speech *>(handle);
    auto modelPath = utf8(env, model), lang = language ? utf8(env, language) : "auto", context = prompt ? utf8(env, prompt) : "";
    if (env->ExceptionCheck()) return nullptr;
    auto size = env->GetArrayLength(pcm);
    if (size < 2 || size > 3840000) { fail(env, "Use up to two minutes of speech"); return nullptr; }
    std::vector<uint8_t> samples(size);
    env->GetByteArrayRegion(pcm, 0, size, reinterpret_cast<jbyte *>(samples.data()));
    if (env->ExceptionCheck()) return nullptr;
    char *text = nullptr;
    if (gezel_speech_transcribe(state, modelPath.c_str(), samples.data(), samples.size(), lang.c_str(), context.c_str(), &text)) {
        fail(env, gezel_speech_error(state)); return nullptr;
    }
    auto output = env->NewByteArray(static_cast<jsize>(std::strlen(text)));
    if (output) env->SetByteArrayRegion(output, 0, static_cast<jsize>(std::strlen(text)), reinterpret_cast<jbyte *>(text));
    gezel_speech_free(text);
    return output;
} catch (...) { fail(env, "Speech ran out of resources"); return nullptr; }
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_bendyline_gezel_mobile_SpeechRuntime_synthesize(JNIEnv *env, jclass, jlong handle,
    jstring directory, jintArray tokens, jint voice, jfloat speed) try {
    if (!handle || !tokens) { fail(env, "Speech engine is unavailable"); return nullptr; }
    auto state = reinterpret_cast<gezel_speech *>(handle);
    auto root = utf8(env, directory);
    if (env->ExceptionCheck()) return nullptr;
    // Phoneme ids, already padded by the shared frontend. Two pad frames plus
    // at most 509 phonemes; anything else is a caller bug, not a long phrase.
    const jsize count = env->GetArrayLength(tokens);
    if (count < 3 || count > 511) { fail(env, "Use a shorter phrase"); return nullptr; }
    std::vector<int32_t> ids(static_cast<size_t>(count));
    env->GetIntArrayRegion(tokens, 0, count, reinterpret_cast<jint *>(ids.data()));
    if (env->ExceptionCheck()) return nullptr;
    uint8_t *wav = nullptr; size_t size = 0;
    if (gezel_speech_synthesize(state, root.c_str(), ids.data(), ids.size(), voice, speed, &wav, &size)) {
        fail(env, gezel_speech_error(state)); return nullptr;
    }
    auto output = env->NewByteArray(static_cast<jsize>(size));
    if (output) env->SetByteArrayRegion(output, 0, static_cast<jsize>(size), reinterpret_cast<jbyte *>(wav));
    gezel_speech_free(wav);
    return output;
} catch (...) { fail(env, "Speech ran out of resources"); return nullptr; }
