// JNI for com.bendyline.gezel.speech.SpeechRuntime in @bendyline/gezel-capacitor.
// Compiled into libGezelSpeech on Android so the plugin loads prebuilt
// libraries only; installing apps never build native code.
#include <jni.h>
#include "gezel_speech.h"
#include "jni_helpers.h"
#include <cstring>
#include <vector>

using gezel_jni::fail;
using gezel_jni::utf8;

namespace {
gezel_speech *engine(jlong handle) { return reinterpret_cast<gezel_speech *>(handle); }

/** 2 is a cancelled request; anything else is a failure with a message. */
void raise(JNIEnv *env, gezel_speech *state, int result) {
    if (result == 2) {
        jclass type = env->FindClass("java/util/concurrent/CancellationException");
        if (type) env->ThrowNew(type, "Speech stopped");
        return;
    }
    fail(env, gezel_speech_error(state));
}
}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_abi(JNIEnv *, jclass) { return gezel_speech_abi(); }
extern "C" JNIEXPORT jlong JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_create(JNIEnv *, jclass) {
    return reinterpret_cast<jlong>(gezel_speech_create());
}
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_begin(JNIEnv *, jclass, jlong handle) { gezel_speech_begin(engine(handle)); }
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_cancel(JNIEnv *, jclass, jlong handle) { gezel_speech_cancel(engine(handle)); }
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_release(JNIEnv *, jclass, jlong handle) { gezel_speech_release(engine(handle)); }
extern "C" JNIEXPORT void JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_destroy(JNIEnv *, jclass, jlong handle) { gezel_speech_destroy(engine(handle)); }

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_transcribe(JNIEnv *env, jclass, jlong handle,
    jstring model, jbyteArray pcm, jstring language, jstring prompt, jboolean words) try {
    if (!handle || !pcm) { fail(env, "Speech input is required"); return nullptr; }
    auto modelPath = utf8(env, model), lang = language ? utf8(env, language) : "auto", context = prompt ? utf8(env, prompt) : "";
    if (env->ExceptionCheck()) return nullptr;
    auto size = env->GetArrayLength(pcm);
    if (size < 2 || size > 3840000) { fail(env, "Use up to two minutes of speech"); return nullptr; }
    std::vector<uint8_t> samples(size);
    env->GetByteArrayRegion(pcm, 0, size, reinterpret_cast<jbyte *>(samples.data()));
    if (env->ExceptionCheck()) return nullptr;
    char *json = nullptr;
    if (int result = gezel_speech_transcribe_json(engine(handle), modelPath.c_str(), samples.data(), samples.size(),
            lang.c_str(), context.empty() ? nullptr : context.c_str(), words ? 1 : 0, &json)) {
        raise(env, engine(handle), result); return nullptr;
    }
    auto length = static_cast<jsize>(std::strlen(json));
    auto output = env->NewByteArray(length);
    if (output) env->SetByteArrayRegion(output, 0, length, reinterpret_cast<jbyte *>(json));
    gezel_speech_free(json);
    return output;
} catch (...) { fail(env, "Speech ran out of resources"); return nullptr; }

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_kokoro(JNIEnv *env, jclass, jlong handle,
    jstring model, jstring voices, jint voice, jintArray tokens, jfloat speed) try {
    if (!handle || !tokens) { fail(env, "Speech engine is unavailable"); return nullptr; }
    auto modelPath = utf8(env, model), voicePath = utf8(env, voices);
    if (env->ExceptionCheck()) return nullptr;
    // Phoneme ids, already padded by the shared frontend. Two pad frames plus
    // at most 509 phonemes; anything else is a caller bug, not a long phrase.
    const jsize count = env->GetArrayLength(tokens);
    if (count < 3 || count > 511) { fail(env, "Use a shorter phrase"); return nullptr; }
    std::vector<int32_t> ids(static_cast<size_t>(count));
    env->GetIntArrayRegion(tokens, 0, count, reinterpret_cast<jint *>(ids.data()));
    if (env->ExceptionCheck()) return nullptr;
    float *samples = nullptr, *durations = nullptr;
    size_t sampleCount = 0, durationCount = 0;
    if (int result = gezel_speech_kokoro(engine(handle), modelPath.c_str(), voicePath.c_str(), voice,
            ids.data(), ids.size(), speed, &samples, &sampleCount, &durations, &durationCount)) {
        raise(env, engine(handle), result); return nullptr;
    }
    jclass floats = env->FindClass("[F");
    jobjectArray output = floats ? env->NewObjectArray(2, floats, nullptr) : nullptr;
    jfloatArray audio = output ? env->NewFloatArray(static_cast<jsize>(sampleCount)) : nullptr;
    jfloatArray timing = audio ? env->NewFloatArray(static_cast<jsize>(durationCount)) : nullptr;
    if (timing) {
        env->SetFloatArrayRegion(audio, 0, static_cast<jsize>(sampleCount), samples);
        if (durationCount) env->SetFloatArrayRegion(timing, 0, static_cast<jsize>(durationCount), durations);
        env->SetObjectArrayElement(output, 0, audio);
        env->SetObjectArrayElement(output, 1, timing);
    }
    gezel_speech_free(samples);
    gezel_speech_free(durations);
    return timing ? output : nullptr;
} catch (...) { fail(env, "Speech ran out of resources"); return nullptr; }

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_bendyline_gezel_speech_SpeechRuntime_embed(JNIEnv *env, jclass, jlong handle,
    jstring model, jlongArray ids) try {
    if (!handle || !ids) { fail(env, "Speech engine is unavailable"); return nullptr; }
    auto modelPath = utf8(env, model);
    if (env->ExceptionCheck()) return nullptr;
    const jsize count = env->GetArrayLength(ids);
    if (count < 1 || count > 8192) { fail(env, "Invalid text for the query model"); return nullptr; }
    std::vector<int64_t> tokens(static_cast<size_t>(count));
    env->GetLongArrayRegion(ids, 0, count, reinterpret_cast<jlong *>(tokens.data()));
    if (env->ExceptionCheck()) return nullptr;
    float *vector = nullptr;
    size_t dimensions = 0;
    if (int result = gezel_speech_embed(engine(handle), modelPath.c_str(), tokens.data(), tokens.size(), &vector, &dimensions)) {
        raise(env, engine(handle), result); return nullptr;
    }
    jfloatArray output = env->NewFloatArray(static_cast<jsize>(dimensions));
    if (output) env->SetFloatArrayRegion(output, 0, static_cast<jsize>(dimensions), vector);
    gezel_speech_free(vector);
    return output;
} catch (...) { fail(env, "Speech ran out of resources"); return nullptr; }
