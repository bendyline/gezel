# Gezel for Capacitor

`@bendyline/gezel-capacitor` connects the existing Gezel App SDK to an iOS or
Android app's own on-device runtime. No daemon, HTTP server, account, product
workspace, or speech pack is required. The package contains prebuilt llama.cpp
binaries; installing apps do not build the engine.

```ts
import { connect, GezelRuntime } from '@bendyline/gezel-capacitor';

// Show a system file picker. The model is copied into this app's private storage.
const { model } = await GezelRuntime.importModel();
if (model) {
  const app = connect(); // GezelApp<'portable'>, using the existing SDK client
  try {
    const stream = await app.chat({
      model: `llama-cpp:${model.id}`,
      messages: [{ role: 'user', content: 'Summarize these notes: …' }],
      stream: true,
      max_tokens: 512,
    });
    for await (const chunk of stream) {
      console.log(chunk.choices[0]?.delta.content ?? '');
    }
  } finally {
    await app.close();
  }
}
```

`app.models()` lists imported models and system providers with availability,
capabilities and qualified model IDs. Use the ID of the model the person chose.
Apple Foundation Models and Android ML Kit use the same `chat` method. An
unavailable provider is an error; there is no implicit model or cloud fallback.

`app.ensureModel({ model })` checks readiness. It never downloads implicitly.
`GezelRuntime.prepareProvider({ providerId: 'android-mlkit' })` explicitly asks
ML Kit to prepare its model; iOS manages Apple model preparation in Settings.
The native API also exposes pinned-source resolution, resumable GGUF downloads,
selection, removal, and `releaseModel()`. It is separate from ordinary inference
so an availability probe cannot start a large download.

## System models in a model picker

The system provider for the current platform is included in `app.models()` even
when it is unavailable. Keep it visible with its `unavailable_reason` instead of
filtering it out; only enable selection when `availability === 'available'`.
The qualified IDs are `apple-foundation-models:apple-foundation-models` for Apple
Foundation Models and `android-mlkit:android-mlkit` for Gemini Nano through ML Kit.
Use the returned IDs rather than constructing a choice for a different platform.
Both run through the same `app.chat({ model: selectedId, ... })` call as a GGUF.

Apple readiness depends on supported hardware, OS version, Apple Intelligence
settings, and system preparation. The app cannot download Apple's model itself.
ML Kit can report `download-required` or `downloading`; offer an explicit action
that awaits `GezelRuntime.prepareProvider({ providerId: 'android-mlkit' })`, then
refresh `app.models()`. Listing and `ensureModel` never authorize preparation.
Refresh after returning from system Settings. If a saved choice becomes
unavailable, preserve it and show the reason; do not silently pick another model.

## Contract and lifecycle

- Text messages (`system`, `user`, `assistant`), streaming, explicit model ID,
  and `max_tokens` are supported. Tools, images, JSON constraints, sampling
  options and other unsupported controls reject with `unsupported_capability`.
- Without `max_tokens`, a reply may use up to half the context window (at most
  4096 tokens on llama.cpp, 1024 on the system models). On llama.cpp that is a
  ceiling within whatever room the prompt leaves, not a reservation.
- Replies preserve `stop`, `length`, and `cancelled`. Usage is absent when the
  provider cannot measure it. Desktop's existing `GezelApp` default types remain
  unchanged; portable clients use `GezelApp<'portable'>`.
- Pass `{ signal }` as the second `chat` argument to cancel. Breaking out of a
  stream or closing its client also cancels and waits for native release.
- `enginePhase` events report `loading_model`, `prefill`, and `generating` for a
  `requestId`, with load progress and prompt/processed/reused/output token
  counts where the engine measures them. They are advisory: older native builds
  and platform providers send fewer, so never wait on one.
- Clients share one process runtime and admission gate. Closing an idle client
  does not stop another client's generation. `releaseModel()` is explicitly
  process-wide and may cancel active work. A closed client cannot be reused.
- Backgrounding cancels inference and pauses downloads; foregrounding does not
  automatically restart either. Memory/thermal admission remains native.
- Model files belong to the host app's sandbox. Two apps that embed this
  package do **not** share their live model files or permissions.
- The embedding application owns WebView navigation and content trust, as with
  other Capacitor native plugins. Keep untrusted pages out of the privileged
  app bridge; this plugin does not override the application's navigation policy.

`connectRuntime(plugin)` accepts an injected implementation for alternate native
bridges and contract tests. `connect()` requires a native Capacitor platform;
there is no browser runtime stub pretending to run a local model.

## Offline speech

`createMobileSpeech()` adds Whisper dictation and Kokoro narration on the device,
through the `GezelOfflineSpeech` plugin and the gezel-speech runtime
(whisper.cpp and ONNX Runtime, built by
[`native/mobile/speech/build.py`](https://github.com/bendyline/gezel/blob/main/native/mobile/speech/build.py)). The
published package carries the runtime from the same native release as its
engines. A checkout packed without one still builds, and `status()` reports
speech unavailable.

```ts
import { createMobileSpeech } from '@bendyline/gezel-capacitor';

// The dictionaries ship in this package under kokoro-lexicon/; serve them as
// web assets and hand back the inflated text.
const speech = createMobileSpeech({ lexicon: (language) => fetchLexiconText(language) });
await speech.install('whisper-base.en', { onProgress: console.log }); // explicit, resumable
const transcript = await speech.transcribe({ wav, model: 'whisper-base.en', words: true });
await speech.synthesize({ text, voice: 'af_heart', onChunk: play });
```

- **Models.** `MOBILE_SPEECH_MODELS` downloads the same pinned Whisper files and
  Kokoro voices as `@bendyline/gezel/speech-models` (a test holds them in step),
  and Kokoro's int8 export of the same timestamped model (92 MB instead of
  326 MB), so word timings survive. Native code stores only declared files in
  app-private, no-backup storage, verifies each SHA-256, and resumes partial files
  with `Range`. JavaScript names models and files; it never supplies paths.
  `install()` retries interrupted transfers while they keep saving bytes.
- **Narration.** Phonemes are planned in JavaScript by `@bendyline/gezel/kokoro`
  from the dictionaries in `kokoro-lexicon/`, so no eSpeak NG (GPL-3) ships.
  Each sentence comes back as 24 kHz PCM with word timings from the model's
  durations.
- **Lifecycle.** One request runs at a time and `AbortSignal` cancels it natively.
  Models stay loaded between requests, are released after two idle minutes, and
  are released, with any request stopped and any download paused, when the app
  leaves the foreground.
- **Staging.** `pnpm pack` stages the pinned native release's runtime under
  `native/speech-<platform>`. In this repository, `pnpm mobile:build:speech
  ios|android` builds one from source and stages it there instead (as
  `0.0.0-local`, or `--package VERSION`); the Gezel app links speech through
  this package like any other app. Android adds the `gezel-speech` AAR
  (it loads `libc++_shared.so` from `gezel-llama` of the same NDK); iOS adds the
  `GezelSpeech` binary target. The JNI binding is compiled into the library, so
  apps build no native code. `GEZEL_SPEECH_ABI` pairs the plugins with the
  library.

## Knowledge catalogs

`createMobileKnowledge()` is the App SDK's knowledge client (`state`, `update`,
`retrieve`) for Gilde knowledge catalogs on the device, with the daemon routes'
semantics: give it to an embedding connection as `knowledge`, and
`knowledgeContext()` grounds requests exactly as it does on a desktop.

```ts
import { connectEmbeddingRuntime, createMobileKnowledge } from '@bendyline/gezel-capacitor';

// Serve dist/knowledge-worker.js and dist/sqlite3.wasm as web assets.
const knowledge = createMobileKnowledge({
  workerUrl: '/assets/knowledge-worker.js',
  wasmUrl: '/assets/sqlite3.wasm',
  readDisabled: () => JSON.parse(localStorage.getItem('knowledge-off') ?? '[]'),
  writeDisabled: (ids) => localStorage.setItem('knowledge-off', JSON.stringify(ids)),
});
const connection = { ...(await connectEmbeddingRuntime()), knowledge };
```

- **Catalogs.** `mobileKnowledgeCatalogs` is a snapshot of Gilde's catalog
  items (`scripts/refresh-knowledge-catalog.ts`), each pinned to an immutable
  Hugging Face revision, SHA-256 and size. The `GezelKnowledge` plugin downloads
  one `.gezk` archive per catalog into app-private, no-backup storage, verifies
  it, and resumes with `Range` like speech models; an update replaces the
  version it supersedes only once it is verified.
- **Reading in place.** Every archive entry is stored uncompressed, so nothing is
  extracted. A Web Worker runs the daemon's catalog host over Gezel's own
  catalog reader on sqlite-wasm, whose read-only VFS fetches 64 KB blocks with
  synchronous range requests: from `/_gezel_knowledge/` on Android (the app's
  `WebViewClient` must call `KnowledgeFiles.intercept` first) and from
  Capacitor's file URL on iOS.
- **Search.** The daemon's `searchUnifiedCatalogs`, with its vector floors.
  Each catalog's embedding profile downloads its pinned query model with the
  archive. Questions are tokenized by the profile's own tokenizer and embedded
  by the speech runtime's ONNX Runtime (`gezel_speech_embed`), so query vectors
  match the desktop's. Without the relevance model, `retrieve` admits only what
  Gezel's bar for unjudged passages admits, which is vector evidence; until the
  query model is installed a catalog is searched by keyword and contributes no
  passages. `rerank: 'required'` and `prepare-reranker` are refused.
- **Licenses.** The worker and the tokenizer compile third-party code into
  `dist/`; the build stages their license texts in `dist/licenses/npm/`.

## Install

```sh
npm install @bendyline/gezel-capacitor @capacitor/core
npx cap sync
```

The package carries the prebuilt engines and speech runtime for both
platforms: a self-contained Swift package for iOS and a folder Maven repository
for Android. `npx cap sync` adds them to the app's native projects; nothing is
built from source and no sibling checkout is needed.

Use Capacitor 8.5.2, Android API 28+ (compile SDK 36), and iOS 16.4+ with a current
Xcode toolchain supporting the Foundation Models adapter. System AI availability
depends on OS, hardware, configuration and model readiness. The engines cover
arm64 Android, arm64 iOS devices and arm64 iOS simulators.

### Building from a Gezel checkout

To change the native runtime itself, stage it with
`packages/capacitor/scripts/stage-native.mjs` and pack this package from the
checkout, as [the native host guide](https://github.com/bendyline/gezel/blob/main/native/runtime/README.md)
describes. The `prepack` check verifies both native payloads and refuses
versions that do not match the pinned native release.

Native generation on physical devices, store distribution, and third-party
application adoption remain qualification steps; package compilation alone is
not an inference-quality certification.

## Application embedding wrapper

For opt-in lifecycle, model readiness/preparation, cancellation, and packaging, see
[the embedding guide](https://github.com/bendyline/gezel/blob/main/docs/embedding-sdk.md).
The existing low-level connection APIs remain available.
