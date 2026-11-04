#include "gezel_speech.h"
#include "whisper.h"
#include "onnxruntime_c_api.h"
#include <fstream>
#include <mutex>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
const OrtApi &ort() { return *OrtGetApiBase()->GetApi(ORT_API_VERSION); }
}  // namespace

struct gezel_speech {
    std::atomic<bool> cancelled{false};
    std::string error;
    // Guards the run below: cancel() arrives on another thread while
    // synthesis sits inside OrtApi::Run, which is the only way to stop it.
    std::mutex mutex;
    OrtRunOptions *run = nullptr;
    // Loaded models stay warm for the engine's lifetime, so narration does not
    // reload Kokoro for every sentence. Requests on one engine are serial.
    OrtEnv *env = nullptr;
    OrtSession *session = nullptr;
    std::string sessionPath, tokensInput, audioOutput;
    bool durations = false;
    whisper_context *whisper = nullptr;
    std::string whisperPath;
    OrtSession *encoder = nullptr;
    std::string encoderPath, encoderOutput;
    std::vector<std::string> encoderInputs;
    void releaseKokoro() {
        if (session) ort().ReleaseSession(session);
        session = nullptr; sessionPath.clear();
    }
    void releaseWhisper() {
        if (whisper) whisper_free(whisper);
        whisper = nullptr; whisperPath.clear();
    }
    void releaseEncoder() {
        if (encoder) ort().ReleaseSession(encoder);
        encoder = nullptr; encoderPath.clear();
    }
    ~gezel_speech() {
        releaseKokoro(); releaseWhisper(); releaseEncoder();
        if (env) ort().ReleaseEnv(env);
    }
};
int gezel_speech_abi() { return GEZEL_SPEECH_ABI; }
gezel_speech *gezel_speech_create() { try { return new gezel_speech; } catch (...) { return nullptr; } }
void gezel_speech_cancel(gezel_speech *state) {
    if (!state) return;
    state->cancelled = true;
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->run) return;
    // Nothing useful to do if this fails, and cancel() must not throw.
    if (OrtStatus *status = ort().RunOptionsSetTerminate(state->run)) ort().ReleaseStatus(status);
}
void gezel_speech_begin(gezel_speech *state) { if (state) state->cancelled = false; }
void gezel_speech_release(gezel_speech *state) {
    if (!state) return;
    state->releaseKokoro(); state->releaseWhisper(); state->releaseEncoder();
}
void gezel_speech_destroy(gezel_speech *state) { delete state; }
const char *gezel_speech_error(gezel_speech *state) { return state ? state->error.c_str() : "Speech allocation failed"; }
void gezel_speech_free(void *data) { std::free(data); }
static bool stopped(void *state) { return static_cast<gezel_speech *>(state)->cancelled.load(); }
static void check(gezel_speech *state) { if (stopped(state)) throw std::runtime_error("Speech stopped"); }
static void require(bool value, const char *message) { if (!value) throw std::runtime_error(message); }

static char *copy(const std::string &value) {
    auto out = static_cast<char *>(std::malloc(value.size() + 1));
    require(out != nullptr, "Speech allocation failed");
    std::memcpy(out, value.c_str(), value.size() + 1);
    return out;
}

static void json(std::string &out, const char *text) {
    out += '"';
    for (const unsigned char *at = reinterpret_cast<const unsigned char *>(text); *at; ++at) {
        if (*at == '"' || *at == '\\') { out += '\\'; out += char(*at); }
        else if (*at < 0x20) { char escaped[8]; std::snprintf(escaped, sizeof escaped, "\\u%04x", *at); out += escaped; }
        else out += char(*at);
    }
    out += '"';
}

static void seconds(std::string &out, int64_t centiseconds) {
    char value[32];
    std::snprintf(value, sizeof value, "%.2f", std::max<int64_t>(0, centiseconds) / 100.0);
    out += value;
}

/** Run Whisper over the take, leaving the result in the engine's context. */
static whisper_context *recognize(gezel_speech *state, const char *model, const uint8_t *pcm,
    size_t bytes, const char *language, const char *prompt, bool tokens) {
    check(state);
    require(model && pcm && bytes > 0 && bytes % 2 == 0 && bytes <= 16000 * 2 * 120, "Use up to two minutes of mono 16 kHz speech");
    std::vector<float> samples(bytes / 2);
    for (size_t i = 0; i < samples.size(); ++i)
        samples[i] = static_cast<int16_t>(uint16_t(pcm[i * 2]) | (uint16_t(pcm[i * 2 + 1]) << 8)) / 32768.f;
    if (!state->whisper || state->whisperPath != model) {
        state->releaseWhisper();
        auto context_params = whisper_context_default_params();
        context_params.use_gpu = false;
        state->whisper = whisper_init_from_file_with_params(model, context_params);
        require(state->whisper != nullptr, "Whisper could not load the installed model");
        state->whisperPath = model;
    }
    check(state);
    auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = 2; params.print_progress = false; params.print_realtime = false;
    params.print_timestamps = false; params.print_special = false; params.no_context = true;
    params.token_timestamps = tokens;
    std::string lang = language ? language : "auto";
    lang = lang.substr(0, lang.find_first_of("-_"));
    require(lang == "auto" || whisper_lang_id(lang.c_str()) >= 0, "Unsupported Whisper language");
    params.language = lang.c_str(); params.initial_prompt = prompt;
    params.abort_callback = stopped; params.abort_callback_user_data = state;
    int result = whisper_full(state->whisper, params, samples.data(), static_cast<int>(samples.size()));
    check(state); require(result == 0, "Whisper transcription failed");
    return state->whisper;
}

int gezel_speech_transcribe(gezel_speech *state, const char *model, const uint8_t *pcm,
    size_t bytes, const char *language, const char *prompt, char **text) {
    if (!state || !text) return 1;
    *text = nullptr;
    try {
        whisper_context *context = recognize(state, model, pcm, bytes, language, prompt, false);
        std::string output;
        for (int i = 0; i < whisper_full_n_segments(context); ++i) {
            const char *part = whisper_full_get_segment_text(context, i);
            if (part) output += part;
            require(output.size() <= 256000, "Speech transcript is too large");
        }
        *text = copy(output);
        return 0;
    } catch (const std::exception &error) { state->error = error.what(); return stopped(state) ? 2 : 1; }
    catch (...) { state->error = "Whisper failed"; return 1; }
}

int gezel_speech_transcribe_json(gezel_speech *state, const char *model, const uint8_t *pcm,
    size_t bytes, const char *language, const char *prompt, int words, char **output) {
    if (!state || !output) return 1;
    *output = nullptr;
    try {
        whisper_context *context = recognize(state, model, pcm, bytes, language, prompt, words != 0);
        std::string out = "{\"language\":";
        const char *detected = whisper_lang_str(whisper_full_lang_id(context));
        if (detected) json(out, detected); else out += "null";
        out += ",\"segments\":[";
        const whisper_token end = whisper_token_eot(context);
        for (int i = 0; i < whisper_full_n_segments(context); ++i) {
            if (i) out += ',';
            out += "{\"start\":"; seconds(out, whisper_full_get_segment_t0(context, i));
            out += ",\"end\":"; seconds(out, whisper_full_get_segment_t1(context, i));
            out += ",\"text\":";
            const char *text = whisper_full_get_segment_text(context, i);
            json(out, text ? text : "");
            if (words) {
                // Sub-word tokens with their times; the binding joins them into words.
                out += ",\"tokens\":[";
                bool first = true;
                for (int j = 0; j < whisper_full_n_tokens(context, i); ++j) {
                    whisper_token_data data = whisper_full_get_token_data(context, i, j);
                    const char *piece = whisper_full_get_token_text(context, i, j);
                    if (data.id >= end || !piece || !*piece) continue;
                    if (!first) out += ',';
                    first = false;
                    out += "{\"start\":"; seconds(out, data.t0);
                    out += ",\"end\":"; seconds(out, data.t1);
                    out += ",\"text\":"; json(out, piece);
                    out += '}';
                }
                out += ']';
            }
            out += '}';
            require(out.size() <= 1024 * 1024, "Speech transcript is too large");
        }
        out += "]}";
        *output = copy(out);
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
// Both supported exports take three inputs — phoneme ids (`tokens` or
// `input_ids`), `style`, `speed` — and return audio at 24 kHz. The
// timestamped export adds `durations`, one prediction per token. `style` is
// one 256-float vector chosen by voice and by phoneme count, read straight
// out of the voice table at its offset rather than loading the whole table.
namespace {

constexpr int kStyleVectors = 510;   // per voice, indexed by phoneme count
constexpr int kStyleDim = 256;       // floats per vector
constexpr int kVoices = 54;          // voices stored in the bundled voices.bin
constexpr int kSampleRate = 24000;
constexpr size_t kMaxWavBytes = 16 * 1024 * 1024;
constexpr size_t kMaxSamples = (kMaxWavBytes - 44) / 2;

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

void releaseSessionOptions(OrtSessionOptions *v) { ort().ReleaseSessionOptions(v); }
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

std::vector<std::string> names(OrtSession *session, bool inputs) {
    OrtAllocator *allocator = nullptr;
    checkStatus(ort().GetAllocatorWithDefaultOptions(&allocator));
    size_t count = 0;
    checkStatus(inputs ? ort().SessionGetInputCount(session, &count) : ort().SessionGetOutputCount(session, &count));
    std::vector<std::string> result;
    for (size_t i = 0; i < count; ++i) {
        char *name = nullptr;
        checkStatus(inputs ? ort().SessionGetInputName(session, i, allocator, &name)
                           : ort().SessionGetOutputName(session, i, allocator, &name));
        result.emplace_back(name);
        checkStatus(ort().AllocatorFree(allocator, name));
    }
    return result;
}

/** Load (or keep) the session for `model` and learn which export it is. */
void loadKokoro(gezel_speech *state, const std::string &model) {
    if (state->session && state->sessionPath == model) return;
    state->releaseKokoro();
    if (!state->env) checkStatus(ort().CreateEnv(ORT_LOGGING_LEVEL_ERROR, "gezel-kokoro", &state->env));
    Owned<OrtSessionOptions, releaseSessionOptions> options;
    checkStatus(ort().CreateSessionOptions(options.out()));
    checkStatus(ort().SetIntraOpNumThreads(options, 4));
    checkStatus(ort().SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL));
    checkStatus(ort().CreateSession(state->env, model.c_str(), options, &state->session));
    state->sessionPath = model;
    std::vector<std::string> inputs = names(state->session, true), outputs = names(state->session, false);
    auto has = [](const std::vector<std::string> &list, const char *name) {
        return std::find(list.begin(), list.end(), name) != list.end();
    };
    state->tokensInput = has(inputs, "input_ids") ? "input_ids" : "tokens";
    state->durations = has(outputs, "durations");
    state->audioOutput.clear();
    for (const std::string &name : outputs) if (name != "durations") { state->audioOutput = name; break; }
    if (!has(inputs, state->tokensInput.c_str()) || !has(inputs, "style") || !has(inputs, "speed") || state->audioOutput.empty()) {
        state->releaseKokoro();
        throw std::runtime_error("The installed Kokoro model is not a supported export");
    }
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

std::vector<float> floats(OrtValue *value, size_t limit, const char *message) {
    Owned<OrtTensorTypeAndShapeInfo, releaseShapeInfo> info;
    checkStatus(ort().GetTensorTypeAndShape(value, info.out()));
    size_t count = 0;
    checkStatus(ort().GetTensorShapeElementCount(info, &count));
    float *data = nullptr;
    checkStatus(ort().GetTensorMutableData(value, reinterpret_cast<void **>(&data)));
    require(data && count > 0 && count <= limit, message);
    return std::vector<float>(data, data + count);
}

}  // namespace

int gezel_speech_kokoro(gezel_speech *state, const char *model, const char *voices, int voice,
    const int32_t *tokens, size_t count, float speed, float **samples, size_t *sample_count,
    float **durations, size_t *duration_count) {
    if (!state || !samples || !sample_count || !durations || !duration_count) return 1;
    *samples = nullptr; *sample_count = 0; *durations = nullptr; *duration_count = 0;
    try {
        check(state);
        require(model && voices && tokens, "Kokoro needs phonemes to speak");
        // The frontend pads with one leading and one trailing frame, and the
        // style table has a vector per phoneme count below kStyleVectors.
        require(count >= 3 && count - 2 < size_t(kStyleVectors), "Use a shorter phrase");
        require(voice >= 0 && voice < kVoices, "Invalid Kokoro voice");
        require(std::isfinite(speed) && speed >= .5f && speed <= 2.f, "Invalid Kokoro speed");
        std::vector<float> style = readStyle(voices, voice, count - 2);
        std::vector<int64_t> ids(count);
        for (size_t i = 0; i < count; ++i) ids[i] = tokens[i];
        check(state);
        loadKokoro(state, model);
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

        const char *inputNames[] = {state->tokensInput.c_str(), "style", "speed"};
        const char *outputNames[] = {state->audioOutput.c_str(), "durations"};
        const size_t outputCount = state->durations ? 2 : 1;
        const OrtValue *inputs[] = {tokenValue, styleValue, speedValue};
        Owned<OrtValue, releaseValue> audio, timing;
        OrtValue *outputs[2] = {nullptr, nullptr};
        Owned<OrtRunOptions, releaseRunOptions> runOptions;
        checkStatus(ort().CreateRunOptions(runOptions.out()));
        {
            // Registered before the run so a cancel arriving mid-inference
            // terminates it rather than waiting for the phrase to finish.
            RunRegistration registration(state, runOptions);
            check(state);
            OrtStatus *status = ort().Run(state->session, runOptions, inputNames, inputs, 3,
                outputNames, outputCount, outputs);
            *audio.out() = outputs[0];
            *timing.out() = outputs[1];
            checkStatus(status);
        }
        check(state);

        std::vector<float> pcm = floats(audio, kMaxSamples, "Kokoro could not synthesize this text");
        *samples = static_cast<float *>(std::malloc(pcm.size() * sizeof(float)));
        require(*samples != nullptr, "Speech allocation failed");
        std::memcpy(*samples, pcm.data(), pcm.size() * sizeof(float));
        *sample_count = pcm.size();
        if (timing) {
            // Timing is optional metadata; a shape this binding does not expect drops it, not the audio.
            std::vector<float> predicted = floats(timing, size_t(-1), "Kokoro returned no timing");
            if (predicted.size() == count) {
                *durations = static_cast<float *>(std::malloc(count * sizeof(float)));
                require(*durations != nullptr, "Speech allocation failed");
                std::memcpy(*durations, predicted.data(), count * sizeof(float));
                *duration_count = count;
            }
        }
        return 0;
    } catch (const std::exception &error) {
        std::free(*samples); *samples = nullptr; *sample_count = 0;
        state->error = error.what(); return stopped(state) ? 2 : 1;
    } catch (...) { state->error = "Kokoro failed"; return 1; }
}

int gezel_speech_synthesize(gezel_speech *state, const char *directory, const int32_t *tokens,
    size_t count, int voice, float speed, uint8_t **wav, size_t *bytes) {
    if (!state || !wav || !bytes) return 1;
    *wav = nullptr; *bytes = 0;
    if (!directory) { state->error = "Kokoro needs phonemes to speak"; return 1; }
    const std::string root(directory);
    float *samples = nullptr, *durations = nullptr;
    size_t sampleCount = 0, durationCount = 0;
    int result = gezel_speech_kokoro(state, (root + "/model.int8.onnx").c_str(),
        (root + "/voices.bin").c_str(), voice, tokens, count, speed, &samples, &sampleCount,
        &durations, &durationCount);
    std::free(durations);
    if (result) return result;
    *bytes = 44 + sampleCount * 2;
    auto out = static_cast<uint8_t *>(std::calloc(*bytes, 1));
    if (!out) { std::free(samples); *bytes = 0; state->error = "Speech allocation failed"; return 1; }
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
    std::free(samples);
    *wav = out;
    return 0;
}

// The query encoder: BERT-family graphs (e5, bge) take ids, an attention mask
// and sometimes token types, and return per-token hidden states. One query is
// one unpadded sequence, so every token counts in the mean.
namespace {

void loadEncoder(gezel_speech *state, const std::string &model) {
    if (state->encoder && state->encoderPath == model) return;
    state->releaseEncoder();
    if (!state->env) checkStatus(ort().CreateEnv(ORT_LOGGING_LEVEL_ERROR, "gezel-encoder", &state->env));
    Owned<OrtSessionOptions, releaseSessionOptions> options;
    checkStatus(ort().CreateSessionOptions(options.out()));
    checkStatus(ort().SetIntraOpNumThreads(options, 4));
    checkStatus(ort().SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL));
    checkStatus(ort().CreateSession(state->env, model.c_str(), options, &state->encoder));
    state->encoderPath = model;
    state->encoderInputs = names(state->encoder, true);
    std::vector<std::string> outputs = names(state->encoder, false);
    auto hidden = std::find(outputs.begin(), outputs.end(), "last_hidden_state");
    state->encoderOutput = hidden != outputs.end() ? *hidden : outputs.empty() ? "" : outputs[0];
    for (const std::string &name : state->encoderInputs)
        if (name != "input_ids" && name != "attention_mask" && name != "token_type_ids") {
            state->releaseEncoder();
            throw std::runtime_error("The installed query model takes inputs this device does not provide");
        }
    if (state->encoderOutput.empty()) {
        state->releaseEncoder();
        throw std::runtime_error("The installed query model has no output");
    }
}

}  // namespace

int gezel_speech_embed(gezel_speech *state, const char *model, const int64_t *ids, size_t count,
    float **vector, size_t *dimensions) {
    if (!state || !vector || !dimensions) return 1;
    *vector = nullptr; *dimensions = 0;
    try {
        check(state);
        require(model && ids && count > 0 && count <= 8192, "Invalid text for the query model");
        loadEncoder(state, model);
        check(state);
        Owned<OrtMemoryInfo, releaseMemoryInfo> memory;
        checkStatus(ort().CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, memory.out()));
        const int64_t shape[2] = {1, int64_t(count)};
        std::vector<int64_t> tokens(ids, ids + count), mask(count, 1), types(count, 0);
        std::vector<Owned<OrtValue, releaseValue>> values(state->encoderInputs.size());
        std::vector<const char *> inputNames;
        std::vector<const OrtValue *> inputs;
        for (size_t i = 0; i < state->encoderInputs.size(); ++i) {
            const std::string &name = state->encoderInputs[i];
            std::vector<int64_t> &data = name == "input_ids" ? tokens : name == "attention_mask" ? mask : types;
            checkStatus(ort().CreateTensorWithDataAsOrtValue(memory, data.data(),
                data.size() * sizeof(int64_t), shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
                values[i].out()));
            inputNames.push_back(name.c_str());
            inputs.push_back(values[i]);
        }
        const char *outputNames[] = {state->encoderOutput.c_str()};
        Owned<OrtValue, releaseValue> output;
        Owned<OrtRunOptions, releaseRunOptions> runOptions;
        checkStatus(ort().CreateRunOptions(runOptions.out()));
        {
            RunRegistration registration(state, runOptions);
            check(state);
            checkStatus(ort().Run(state->encoder, runOptions, inputNames.data(), inputs.data(),
                inputs.size(), outputNames, 1, output.out()));
        }
        check(state);
        Owned<OrtTensorTypeAndShapeInfo, releaseShapeInfo> info;
        checkStatus(ort().GetTensorTypeAndShape(output, info.out()));
        size_t rank = 0;
        checkStatus(ort().GetDimensionsCount(info, &rank));
        require(rank == 3, "The query model returned an unexpected shape");
        int64_t dims[3] = {0, 0, 0};
        checkStatus(ort().GetDimensions(info, dims, 3));
        require(dims[0] == 1 && dims[1] == int64_t(count) && dims[2] > 0 && dims[2] <= 8192,
                "The query model returned an unexpected shape");
        float *hidden = nullptr;
        checkStatus(ort().GetTensorMutableData(output, reinterpret_cast<void **>(&hidden)));
        const size_t width = size_t(dims[2]);
        std::vector<double> mean(width, 0.0);
        for (size_t token = 0; token < count; ++token)
            for (size_t d = 0; d < width; ++d) mean[d] += hidden[token * width + d];
        double norm = 0.0;
        for (double &value : mean) { value /= double(count); norm += value * value; }
        norm = std::sqrt(norm);
        require(std::isfinite(norm) && norm > 0, "The query model returned an empty vector");
        *vector = static_cast<float *>(std::malloc(width * sizeof(float)));
        require(*vector != nullptr, "Speech allocation failed");
        for (size_t d = 0; d < width; ++d) (*vector)[d] = float(mean[d] / norm);
        *dimensions = width;
        return 0;
    } catch (const std::exception &error) { state->error = error.what(); return stopped(state) ? 2 : 1; }
    catch (...) { state->error = "The query model failed"; return 1; }
}
