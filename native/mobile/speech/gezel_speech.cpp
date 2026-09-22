#include "gezel_speech.h"
#include "whisper.h"
#include "onnxruntime_c_api.h"
#include <fstream>
#include <mutex>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

struct gezel_speech {
    std::atomic<bool> cancelled{false};
    std::string error;
    // Guards the run below: cancel() arrives on another thread while
    // synthesis sits inside OrtApi::Run, which is the only way to stop it.
    std::mutex mutex;
    OrtRunOptions *run = nullptr;
};
gezel_speech *gezel_speech_create() { try { return new gezel_speech; } catch (...) { return nullptr; } }
void gezel_speech_cancel(gezel_speech *state) {
    if (!state) return;
    state->cancelled = true;
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->run) return;
    // Nothing useful to do if this fails, and cancel() must not throw.
    const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    if (OrtStatus *status = api->RunOptionsSetTerminate(state->run)) api->ReleaseStatus(status);
}
void gezel_speech_destroy(gezel_speech *state) { delete state; }
const char *gezel_speech_error(gezel_speech *state) { return state ? state->error.c_str() : "Speech allocation failed"; }
void gezel_speech_free(void *data) { std::free(data); }
static bool stopped(void *state) { return static_cast<gezel_speech *>(state)->cancelled.load(); }
static void check(gezel_speech *state) { if (stopped(state)) throw std::runtime_error("Speech stopped"); }
static void require(bool value, const char *message) { if (!value) throw std::runtime_error(message); }

int gezel_speech_transcribe(gezel_speech *state, const char *model, const uint8_t *pcm,
    size_t bytes, const char *language, const char *prompt, char **text) {
    if (!state || !text) return 1;
    *text = nullptr;
    try {
        check(state);
        require(model && pcm && bytes > 0 && bytes % 2 == 0 && bytes <= 16000 * 2 * 120, "Use up to two minutes of mono 16 kHz speech");
        std::vector<float> samples(bytes / 2);
        for (size_t i = 0; i < samples.size(); ++i)
            samples[i] = static_cast<int16_t>(uint16_t(pcm[i * 2]) | (uint16_t(pcm[i * 2 + 1]) << 8)) / 32768.f;
        auto context_params = whisper_context_default_params();
        context_params.use_gpu = false;
        std::unique_ptr<whisper_context, decltype(&whisper_free)> context(whisper_init_from_file_with_params(model, context_params), whisper_free);
        require(bool(context), "Whisper could not load the installed model");
        check(state);
        auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads = 2; params.print_progress = false; params.print_realtime = false;
        params.print_timestamps = false; params.print_special = false; params.no_context = true;
        std::string lang = language ? language : "auto";
        lang = lang.substr(0, lang.find_first_of("-_"));
        require(lang == "auto" || whisper_lang_id(lang.c_str()) >= 0, "Unsupported Whisper language");
        params.language = lang.c_str(); params.initial_prompt = prompt;
        params.abort_callback = stopped; params.abort_callback_user_data = state;
        int result = whisper_full(context.get(), params, samples.data(), static_cast<int>(samples.size()));
        check(state); require(result == 0, "Whisper transcription failed");
        std::string output;
        for (int i = 0; i < whisper_full_n_segments(context.get()); ++i) {
            const char *part = whisper_full_get_segment_text(context.get(), i);
            if (part) output += part;
            require(output.size() <= 256000, "Speech transcript is too large");
        }
        *text = static_cast<char *>(std::malloc(output.size() + 1));
        require(*text != nullptr, "Speech allocation failed");
        std::memcpy(*text, output.c_str(), output.size() + 1);
        return 0;
    } catch (const std::exception &error) { state->error = error.what(); return stopped(state) ? 2 : 1; }
    catch (...) { state->error = "Whisper failed"; return 1; }
}
static void u32(uint8_t *at, uint32_t value) { for (int i = 0; i < 4; ++i) at[i] = uint8_t(value >> (8 * i)); }
// Kokoro synthesis on ONNX Runtime.
//
// The phoneme ids arrive already built: the shared TypeScript frontend
// (@bendyline/gezel/kokoro) turns text into them using the voice pack's own
// dictionary, the same way the desktop daemon does. Nothing here parses text,
// which is what lets the app drop eSpeak NG (GPL-3) and sherpa-onnx with it.
//
// The model takes three inputs — `tokens`, `style`, `speed` — and returns
// `audio` at 24 kHz. `style` is one 256-float vector chosen by voice and by
// phoneme count, read straight out of voices.bin at its offset rather than
// loading the whole 28 MB table.
namespace {

constexpr int kStyleVectors = 510;   // per voice, indexed by phoneme count
constexpr int kStyleDim = 256;       // floats per vector
constexpr int kVoices = 54;          // voices stored in voices.bin
constexpr int kSampleRate = 24000;
constexpr size_t kMaxWavBytes = 16 * 1024 * 1024;
constexpr size_t kMaxSamples = (kMaxWavBytes - 44) / 2;

const OrtApi &ort() { return *OrtGetApiBase()->GetApi(ORT_API_VERSION); }

/** Turn an OrtStatus into an exception, releasing it either way. */
void checkStatus(OrtStatus *status) {
    if (!status) return;
    std::string message = ort().GetErrorMessage(status);
    ort().ReleaseStatus(status);
    throw std::runtime_error(message.empty() ? "Kokoro failed" : message);
}

/** Release helper so every ONNX Runtime handle unwinds on an exception. */
template <typename T, void (*Release)(T *)> struct Owned {
    T *value = nullptr;
    ~Owned() { if (value) Release(value); }
    T **out() { return &value; }
    operator T *() const { return value; }
};

void releaseEnv(OrtEnv *v) { ort().ReleaseEnv(v); }
void releaseSessionOptions(OrtSessionOptions *v) { ort().ReleaseSessionOptions(v); }
void releaseSession(OrtSession *v) { ort().ReleaseSession(v); }
void releaseValue(OrtValue *v) { ort().ReleaseValue(v); }
void releaseMemoryInfo(OrtMemoryInfo *v) { ort().ReleaseMemoryInfo(v); }
void releaseRunOptions(OrtRunOptions *v) { ort().ReleaseRunOptions(v); }
void releaseShapeInfo(OrtTensorTypeAndShapeInfo *v) { ort().ReleaseTensorTypeAndShapeInfo(v); }

/** Read one style vector without mapping the whole voice table. */
std::vector<float> readStyle(const std::string &path, int voice, size_t phonemes) {
    std::ifstream file(path, std::ios::binary);
    require(file.good(), "Kokoro could not open the installed voices");
    const size_t index = size_t(voice) * kStyleVectors + phonemes;
    file.seekg(std::streamoff(index * kStyleDim * sizeof(float)), std::ios::beg);
    require(file.good(), "Kokoro voice data is incomplete");
    std::vector<float> style(kStyleDim);
    file.read(reinterpret_cast<char *>(style.data()), std::streamsize(style.size() * sizeof(float)));
    require(file.gcount() == std::streamsize(style.size() * sizeof(float)),
            "Kokoro voice data is incomplete");
    return style;
}

/** Hold the run options where cancel() can reach them, and clear them after. */
struct RunRegistration {
    gezel_speech *state;
    RunRegistration(gezel_speech *owner, OrtRunOptions *options) : state(owner) {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->run = options;
    }
    ~RunRegistration() {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->run = nullptr;
    }
};

}  // namespace

int gezel_speech_synthesize(gezel_speech *state, const char *directory, const int32_t *tokens,
    size_t count, int voice, float speed, uint8_t **wav, size_t *bytes) {
    if (!state || !wav || !bytes) return 1;
    *wav = nullptr; *bytes = 0;
    try {
        check(state);
        require(directory && tokens, "Kokoro needs phonemes to speak");
        // The frontend pads with one leading and one trailing frame, and the
        // style table has a vector per phoneme count below kStyleVectors.
        require(count >= 3 && count - 2 < size_t(kStyleVectors), "Use a shorter phrase");
        require(voice >= 0 && voice < kVoices, "Invalid Kokoro voice");
        require(std::isfinite(speed) && speed >= .5f && speed <= 2.f, "Invalid Kokoro speed");
        const size_t phonemes = count - 2;

        const std::string root(directory);
        std::vector<float> style = readStyle(root + "/voices.bin", voice, phonemes);
        std::vector<int64_t> ids(count);
        for (size_t i = 0; i < count; ++i) ids[i] = tokens[i];
        check(state);

        Owned<OrtEnv, releaseEnv> env;
        checkStatus(ort().CreateEnv(ORT_LOGGING_LEVEL_ERROR, "gezel-kokoro", env.out()));
        Owned<OrtSessionOptions, releaseSessionOptions> options;
        checkStatus(ort().CreateSessionOptions(options.out()));
        checkStatus(ort().SetIntraOpNumThreads(options, 2));
        checkStatus(ort().SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL));
        Owned<OrtSession, releaseSession> session;
        const std::string model = root + "/model.int8.onnx";
        checkStatus(ort().CreateSession(env, model.c_str(), options, session.out()));
        check(state);

        Owned<OrtMemoryInfo, releaseMemoryInfo> memory;
        checkStatus(ort().CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, memory.out()));
        const int64_t tokenShape[2] = {1, int64_t(count)};
        const int64_t styleShape[2] = {1, kStyleDim};
        const int64_t speedShape[1] = {1};
        Owned<OrtValue, releaseValue> tokenValue, styleValue, speedValue;
        checkStatus(ort().CreateTensorWithDataAsOrtValue(memory, ids.data(),
            ids.size() * sizeof(int64_t), tokenShape, 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, tokenValue.out()));
        checkStatus(ort().CreateTensorWithDataAsOrtValue(memory, style.data(),
            style.size() * sizeof(float), styleShape, 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, styleValue.out()));
        checkStatus(ort().CreateTensorWithDataAsOrtValue(memory, &speed, sizeof(float),
            speedShape, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, speedValue.out()));

        const char *inputNames[] = {"tokens", "style", "speed"};
        const char *outputNames[] = {"audio"};
        const OrtValue *inputs[] = {tokenValue, styleValue, speedValue};
        Owned<OrtValue, releaseValue> output;
        Owned<OrtRunOptions, releaseRunOptions> runOptions;
        checkStatus(ort().CreateRunOptions(runOptions.out()));
        {
            // Registered before the run so a cancel arriving mid-inference
            // terminates it rather than waiting for the phrase to finish.
            RunRegistration registration(state, runOptions);
            check(state);
            checkStatus(ort().Run(session, runOptions, inputNames, inputs, 3, outputNames, 1,
                output.out()));
        }
        check(state);

        Owned<OrtTensorTypeAndShapeInfo, releaseShapeInfo> info;
        checkStatus(ort().GetTensorTypeAndShape(output, info.out()));
        size_t sampleCount = 0;
        checkStatus(ort().GetTensorShapeElementCount(info, &sampleCount));
        float *samples = nullptr;
        checkStatus(ort().GetTensorMutableData(output, reinterpret_cast<void **>(&samples)));
        require(samples && sampleCount > 0, "Kokoro could not synthesize this text");
        require(sampleCount <= kMaxSamples, "Kokoro output exceeds the supported audio size");

        *bytes = 44 + sampleCount * 2;
        auto out = static_cast<uint8_t *>(std::calloc(*bytes, 1));
        require(out != nullptr, "Speech allocation failed");
        std::memcpy(out, "RIFF", 4); u32(out + 4, uint32_t(*bytes - 8));
        std::memcpy(out + 8, "WAVEfmt ", 8);
        u32(out + 16, 16); out[20] = 1; out[22] = 1;
        u32(out + 24, kSampleRate); u32(out + 28, kSampleRate * 2);
        out[32] = 2; out[34] = 16;
        std::memcpy(out + 36, "data", 4); u32(out + 40, uint32_t(*bytes - 44));
        for (size_t i = 0; i < sampleCount; ++i) {
            float sample = std::isfinite(samples[i]) ? std::clamp(samples[i], -1.f, 1.f) : 0.f;
            int16_t value = static_cast<int16_t>(std::round(sample * (sample < 0 ? 32768.f : 32767.f)));
            out[44 + 2 * i] = uint8_t(value);
            out[45 + 2 * i] = uint8_t(uint16_t(value) >> 8);
        }
        *wav = out;
        return 0;
    } catch (const std::exception &error) { state->error = error.what(); return stopped(state) ? 2 : 1; }
    catch (...) { state->error = "Kokoro failed"; return 1; }
}
