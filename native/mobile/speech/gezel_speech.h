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
typedef struct gezel_speech gezel_speech;
GEZEL_SPEECH_API gezel_speech *gezel_speech_create(void);
GEZEL_SPEECH_API void gezel_speech_cancel(gezel_speech *);
GEZEL_SPEECH_API void gezel_speech_destroy(gezel_speech *);
GEZEL_SPEECH_API const char *gezel_speech_error(gezel_speech *);
GEZEL_SPEECH_API void gezel_speech_free(void *);
// Input is mono 16 kHz PCM16, normalized by the shared portable adapter.
GEZEL_SPEECH_API int gezel_speech_transcribe(gezel_speech *, const char *model,
    const uint8_t *pcm, size_t bytes, const char *language, const char *prompt, char **text);
// Phoneme ids come from the shared @bendyline/gezel/kokoro frontend, already
// padded. Nothing here reads text, which is what lets the app ship without
// eSpeak NG (GPL-3) or sherpa-onnx.
GEZEL_SPEECH_API int gezel_speech_synthesize(gezel_speech *, const char *directory,
    const int32_t *tokens, size_t count, int voice, float speed, uint8_t **wav, size_t *bytes);
#ifdef __cplusplus
}
#endif
