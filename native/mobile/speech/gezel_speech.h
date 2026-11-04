#pragma once
#include <stddef.h>
#include <stdint.h>
#if defined(__GNUC__)
#define GEZEL_SPEECH_API __attribute__((visibility("default")))
#else
#define GEZEL_SPEECH_API
#endif
#ifdef __cplusplus
extern "C" {
#endif
// Bumped whenever a function below changes shape; bindings refuse other values.
#define GEZEL_SPEECH_ABI 3
typedef struct gezel_speech gezel_speech;
GEZEL_SPEECH_API int gezel_speech_abi(void);
GEZEL_SPEECH_API gezel_speech *gezel_speech_create(void);
GEZEL_SPEECH_API void gezel_speech_cancel(gezel_speech *);
// Clears an earlier cancel so a long-lived engine can serve the next request.
// Hosts serialize begin() with cancel() so a cancel is never lost.
GEZEL_SPEECH_API void gezel_speech_begin(gezel_speech *);
// Models stay loaded between requests; this frees them and keeps the engine.
GEZEL_SPEECH_API void gezel_speech_release(gezel_speech *);
GEZEL_SPEECH_API void gezel_speech_destroy(gezel_speech *);
GEZEL_SPEECH_API const char *gezel_speech_error(gezel_speech *);
GEZEL_SPEECH_API void gezel_speech_free(void *);
// Input is mono 16 kHz PCM16, normalized by the shared portable adapter.
GEZEL_SPEECH_API int gezel_speech_transcribe(gezel_speech *, const char *model,
    const uint8_t *pcm, size_t bytes, const char *language, const char *prompt, char **text);
// The same recognition with timing, as UTF-8 JSON:
// {"language":"en","segments":[{"start":0,"end":1.2,"text":" Hi","words":[...]}]}
// Nonzero `words` adds {"start","end","text"} per word to each segment.
GEZEL_SPEECH_API int gezel_speech_transcribe_json(gezel_speech *, const char *model,
    const uint8_t *pcm, size_t bytes, const char *language, const char *prompt, int words,
    char **json);
// Phoneme ids come from the shared @bendyline/gezel/kokoro frontend, already
// padded. Nothing here reads text, which is what lets the app ship without
// eSpeak NG (GPL-3) or sherpa-onnx.
GEZEL_SPEECH_API int gezel_speech_synthesize(gezel_speech *, const char *directory,
    const int32_t *tokens, size_t count, int voice, float speed, uint8_t **wav, size_t *bytes);
// Kokoro from one ONNX model file and a style table of 510 x 256 float32
// vectors per voice (`voice` indexes the voices stored in `voices`). Returns
// 24 kHz mono samples. A model that reports per-token durations (the
// timestamped export) returns those too, one per token; otherwise
// `durations` is NULL.
GEZEL_SPEECH_API int gezel_speech_kokoro(gezel_speech *, const char *model, const char *voices,
    int voice, const int32_t *tokens, size_t count, float speed, float **samples,
    size_t *sample_count, float **durations, size_t *duration_count);
// A text encoder for knowledge queries: token ids in (already prefixed and
// truncated by the profile's tokenizer), the mean of the model's last hidden
// states over the tokens out, L2-normalized.
GEZEL_SPEECH_API int gezel_speech_embed(gezel_speech *, const char *model, const int64_t *ids,
    size_t count, float **vector, size_t *dimensions);
#ifdef __cplusplus
}
#endif
