#include "gezel_speech.h"
#include "whisper.h"
#include "sherpa-onnx/c-api/c-api.h"
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

struct gezel_speech { std::atomic<bool> cancelled{false}; std::string error; };
gezel_speech *gezel_speech_create() { try { return new gezel_speech; } catch (...) { return nullptr; } }
void gezel_speech_cancel(gezel_speech *state) { if (state) state->cancelled = true; }
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
struct SpeechProgress { gezel_speech *state; size_t samples = 0; bool too_large = false; };
static int32_t progress(const float *, int32_t count, float, void *data) {
    auto *work = static_cast<SpeechProgress *>(data);
    work->samples += size_t(std::max(0, count));
    work->too_large = work->samples > (16 * 1024 * 1024 - 44) / 2;
    return stopped(work->state) || work->too_large ? 0 : 1;
}
int gezel_speech_synthesize(gezel_speech *state, const char *directory, const char *text,
    int voice, float speed, uint8_t **wav, size_t *bytes) {
    if (!state || !wav || !bytes) return 1;
    *wav = nullptr; *bytes = 0;
    try {
        check(state);
        require(directory && text && std::strlen(text) > 0 && std::strlen(text) <= 48000, "Use up to 12,000 characters of speech");
        require(((voice >= 0 && voice <= 27) || (voice >= 45 && voice <= 52)) && std::isfinite(speed) && speed >= .5f && speed <= 2.f, "Invalid Kokoro voice or speed");
        const bool british = voice >= 20 && voice <= 27;
        std::string root(directory), model = root + "/model.int8.onnx", voices = root + "/voices.bin",
            tokens = root + "/tokens.txt", data = root + "/espeak-ng-data",
            lexicon = root + (british ? "/lexicon-gb-en.txt," : "/lexicon-us-en.txt,") + root + "/lexicon-zh.txt";
        SherpaOnnxOfflineTtsConfig config{};
        config.model.kokoro.model = model.c_str(); config.model.kokoro.voices = voices.c_str();
        config.model.kokoro.tokens = tokens.c_str(); config.model.kokoro.data_dir = data.c_str();
        config.model.kokoro.lexicon = lexicon.c_str(); config.model.kokoro.length_scale = 1;
        // eSpeak selects the installed voice by name; British English is "en".
        config.model.kokoro.lang = british ? "en" : "en-us";
        config.model.num_threads = 2; config.model.provider = "cpu"; config.max_num_sentences = 1;
        std::unique_ptr<const SherpaOnnxOfflineTts, decltype(&SherpaOnnxDestroyOfflineTts)> tts(SherpaOnnxCreateOfflineTts(&config), SherpaOnnxDestroyOfflineTts);
        require(bool(tts), "Kokoro could not load the installed voices"); check(state);
        SherpaOnnxGenerationConfig generation{}; generation.sid = voice; generation.speed = speed; generation.silence_scale = 1;
        SpeechProgress work{state};
        std::unique_ptr<const SherpaOnnxGeneratedAudio, decltype(&SherpaOnnxDestroyOfflineTtsGeneratedAudio)> audio(
            SherpaOnnxOfflineTtsGenerateWithConfig(tts.get(), text, &generation, progress, &work), SherpaOnnxDestroyOfflineTtsGeneratedAudio);
        check(state);
        require(!work.too_large, "Kokoro output exceeds the supported audio size");
        require(audio && audio->samples && audio->sample_rate == 24000 && audio->n > 0, "Kokoro could not synthesize this text");
        require(audio->n <= (16 * 1024 * 1024 - 44) / 2, "Kokoro output exceeds the supported audio size");
        *bytes = 44 + size_t(audio->n) * 2;
        auto output = static_cast<uint8_t *>(std::calloc(*bytes, 1)); require(output != nullptr, "Speech allocation failed");
        std::memcpy(output, "RIFF", 4); u32(output + 4, uint32_t(*bytes - 8)); std::memcpy(output + 8, "WAVEfmt ", 8);
        u32(output + 16, 16); output[20] = 1; output[22] = 1; u32(output + 24, 24000); u32(output + 28, 48000);
        output[32] = 2; output[34] = 16; std::memcpy(output + 36, "data", 4); u32(output + 40, uint32_t(*bytes - 44));
        for (int i = 0; i < audio->n; ++i) {
            float sample = std::isfinite(audio->samples[i]) ? std::clamp(audio->samples[i], -1.f, 1.f) : 0.f;
            int16_t value = static_cast<int16_t>(std::round(sample * (sample < 0 ? 32768.f : 32767.f)));
            output[44 + 2 * i] = uint8_t(value); output[45 + 2 * i] = uint8_t(uint16_t(value) >> 8);
        }
        *wav = output; return 0;
    } catch (const std::exception &error) { state->error = error.what(); return stopped(state) ? 2 : 1; }
    catch (...) { state->error = "Kokoro failed"; return 1; }
}
