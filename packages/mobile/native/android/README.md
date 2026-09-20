# Android on-device providers

`GezelMobilePlugin` offers `llama-cpp` (a selected app-private GGUF) and
`android-mlkit` (Android AICore/Gemini Nano through ML Kit). Requests specify
`providerId`; omission retains the existing llama.cpp behavior. A failed or
unavailable provider never falls back to another model.

The Gradle dependency is exactly `com.google.mlkit:genai-prompt:1.0.0-beta4`.
The implementation is Java and needs no Kotlin Gradle plugin. The SDK itself
transitively depends on Kotlin and coroutines. Its AAR contributes the AICore
binding permission/package query; the app permits network access for model
preparation and SDK services. ML Kit is governed by its
[terms](https://developers.google.com/ml-kit/terms), including its SDK data
collection disclosures. Conversation inference uses the on-device API.

- `providers()` returns availability and text-only capabilities. Checks neither
  download nor warm the model. A selected GGUF must still exist, match its
  recorded size, and have a GGUF header; actual model loading can still reject an
  unsupported architecture/template. ML Kit checks device support and its token
  limit. Availability checks share the inference queue to keep SDK-client close
  separate from running inference.
- `prepareProvider({providerId: 'android-mlkit'})` is the only path that starts a
  model download. It must follow an explicit user action. Unsupported devices
  remain unavailable. Android owns these system model assets; removing an
  imported GGUF does not remove AICore's model.
- `cancelProviderPreparation({providerId: 'android-mlkit'})` cancels the current
  preparation observer and waits for its client to close and its reservation to
  release. It does not target a later generation. Availability reports the
  current preparation as downloading immediately, without waiting in its queue.
- `generate({requestId, providerId, messages, maxTokens?, contextSize?})` processes
  one foreground request at a time. ML Kit receives a fresh transcript encoded
  as role/content JSON. The first system message uses `SystemInstruction` when
  supported; otherwise it is included as instructions in the prompt. No hidden
  chat session, prefix cache, tools, images, or structured output is exposed.
- `cancel({requestId})` cancels only the current matching request. The promise
  resolves after generation exits and provider cleanup completes. Cancellation
  captures the specific ML Kit future before releasing the request lock. It
  cannot cancel a newer turn. Late deltas are discarded by request ID.
- `removeModel({id})` unloads local weights before removing the imported file and
  library entry. Removing the selected model clears selection; it never chooses
  another model. Chat history is retained.

ML Kit admission reserves a maximum of 256 output tokens against its reported
limit, capped at 4096 total tokens, and rejects inputs counted at 4000 tokens or
more. This deliberately conservative check may reserve output twice on SDK
versions whose count already includes it. Streams and final text are capped at
64,000 UTF-16 code units. Generation waits at most 120 seconds after token
admission; individual SDK checks have 15-second deadlines, and explicit
preparation has a 10-minute download deadline. System cancellation and resource
release use the SDK's future cancellation and synchronous `close`; these are not
claims about exact hardware interruption latency. Backgrounding or memory
pressure cancels work, closes the SDK client, and unloads GGUF weights. Android
may retain or finish system-managed assets after a download observer is cancelled.

Model metadata is bounded to 1 MiB and 100 entries, with unique canonical UUIDs,
200-character names, and sizes from 4 bytes through 4 GiB. Imports stream through
private `.partial` files, enforce the byte cap independently of document-provider
metadata, preserve 64 MiB of free space, and check a five-minute elapsed budget
between reads. A stalled external document provider can still delay a read.
State replacement uses `AtomicFile` and recovers backup-only transactions before
checking absence. Interrupted imports clean up `.partial` files at next launch.
Removal commits metadata before deleting bytes; a process kill in that gap may
leave an unlisted GGUF file, but cannot select a replacement or erase history.

## Verification

Install SDK platform 36, build tools 36.0.0, NDK 28.2.13676358, CMake 3.31.6,
and the API 36 Google APIs ARM64 system image using Android Studio's SDK Manager.
Use JDK 21 for Gradle. Build the pinned Android native libraries as described in
the [mobile build instructions](../../README.md#build), then build the host
fixture generator once. In Device Manager, create a phone-sized ARM64 API 36
emulator named `gezel-api36-tests`, start it, and disconnect other Android devices.
Run from the repository root with `JAVA_HOME` pointing to JDK 21:

```sh
python3 native/mobile/build-llama.py host
pnpm mobile:test:android
```

Reuse an existing successful host build instead of rebuilding into its nonempty
output directory. For a fixture already generated by a host build elsewhere,
set `GEZEL_ANDROID_TEST_FIXTURE` to its GGUF path. The staging helper includes this
small untrained model only in the test APK. It is never bundled with the app.

The guarded test command builds and syncs current web assets, stages the fixture,
and runs Android instrumentation. It requires exactly one connected ARM64
emulator with the expected name so Gradle cannot install tests on an unrelated
device. Set `GEZEL_ANDROID_TEST_AVD` to use a differently named test emulator.
Gradle writes its report under
`android/app/build/reports/androidTests/connected/debug/index.html`.
Screenshots are retained under
`android/app/build/outputs/connected_android_test_additional_output/debugAndroidTest/connected/`.
Use hardware/automatic graphics for visual checks. On this Apple Silicon host,
the emulator's SwiftShader backend produced stale white WebView tiles; `-gpu host`
rendered the same app correctly. Software WebView captures alone would have
missed the window-compositing issue.

`MobileStoreTest` covers atomic recovery, import/select/reopen, corrupt metadata,
failed-import cleanup, and removing a selected model while preserving history.
It accepts Android's equivalent app-directory paths while rejecting symlinked
storage directories and model files without changing files outside app storage.
`LlamaRuntimeTest` exercises the production JNI libraries with real deterministic
inference, Unicode paths, streaming, cancellation, concurrent-operation rejection,
callback failures, and next-turn reuse. Native tests use isolated cache folders.
`MobileUiSmokeTest` launches the actual Capacitor WebView and checks shared phone
navigation, model Settings, a native chat reply, conversation management, and
durable reload. It restores the saved state and model inventory after testing.

ML Kit hardware tests must still use an eligible physical device and exercise
preparation, streaming, stop/next-turn reuse, and background interruption. The
deterministic fixture checks runtime contracts, not trained-model quality or
physical-device memory/performance limits.

The implementation's 27 used public method/constant contracts were checked
against the approved Google Maven AAR bytecode. Inspected SHA-256 values:

- `genai-prompt:1.0.0-beta4`: `675192b6ba91334ddbfb8cc429a8afb94cba370d927d7dba79525818b7186f6d`
- `genai-common:1.0.0-beta4`: `2926c5e3f19fc679a0eba8cab2edadeb0c0f1ae2ba14de9bac6bd7a352ae5a56`

No AAR, model, or SDK binary is committed. Android compilation and all 15
instrumentation tests (five JNI, nine storage, one complete WebView flow) passed
on the ARM64 API 36 emulator using JDK 21, Gradle 8.14.3, NDK 28.2.13676358, and
CMake 3.31.6. The five captured screens were checked with host graphics. Testing
caught and fixed a model
import failure caused by Android's equivalent app-directory paths. All seven
packaged native libraries pass 16 KiB ELF alignment checks, and the APK passes
`zipalign -c -P 16 4`. The emulator uses a 4 KiB kernel; startup on a 16 KiB
physical device remains a separate release check.

References: [ML Kit setup](https://developers.google.com/ml-kit/genai/prompt/android/get-started),
[Java futures API](https://developers.google.com/android/reference/com/google/mlkit/genai/prompt/java/GenerativeModelFutures),
[model lifecycle](https://developers.google.com/android/reference/com/google/mlkit/genai/prompt/GenerativeModel).
