# Offline mobile speech

The mobile host implements the desktop speech API through a `PortableSpeech`
port. The shared composer, narration controls, Audio settings, and per-gezel
`frontmatter.voice` remain the product surfaces. The host runs speech natively;
the portable product service owns admission, config, project artifact paths,
and the ordinary `/api/audio/*` response shapes. Browser previews do not advertise
native speech.

## Selection and offline behavior

- Automatic recognition prefers the platform's **offline** recognizer for the
  requested language. Android uses ML Kit Speech Recognition Basic; iOS uses
  `SFSpeechRecognizer` with `requiresOnDeviceRecognition`.
- If local recognition or its language assets are unavailable, automatic mode
  uses the bundled multilingual Whisper tiny model through whisper.cpp. It does
  not download assets or switch to a server. Model availability is probed before
  inference and checked again by the adapter.
- Denied permission, malformed input, cancellation, and unrelated recognition
  failures remain explicit errors. Audio settings offers Automatic, system-only,
  and Whisper, so the user can choose Whisper without enabling the system speech
  service. An explicitly selected model is authoritative.
- Kokoro supplies TTS on both platforms through sherpa-onnx/ONNX Runtime. There
  is no system-TTS replacement. The initial pack exposes 36 named US English,
  British English, and Mandarin voices, preserving desktop voice IDs. A voice
  unavailable in this pack produces an error instead of silently changing the
  gezel's voice. Default voice: `af_heart`.

The first build bundles approximately 260 MiB of uncompressed model data. It
therefore does not require an initial network download. Android verifies and
copies model assets to private, non-backup storage before loading them; iOS reads
the application bundle. Model files do not enter project data or product backups.
Readiness checks do not ask for permission, warm a model, or download anything.

## Build and run

The normal llama.cpp setup is still required; see `packages/mobile/README.md`.
After approving dependency downloads:

```sh
pnpm mobile:build:speech android --fetch --ndk /path/to/android-ndk
pnpm mobile:build:speech ios --fetch
pnpm android
# Or:
pnpm ios
```

For this checkout on macOS, the installed Android NDK is
`$HOME/Library/Android/sdk/ndk/28.2.13676358`. Subsequent speech builds omit
`--fetch`; cached inputs are checked against `native/mobile/speech/pins.json`.
Sync verifies the native sources and built payload, then stages models, voices,
and license notices. Missing or stale speech builds fail sync rather than
producing an app with nonfunctional speech controls. Android packages ARM64 only;
the iOS framework contains device ARM64 and simulator ARM64 slices.

Open Settings → Audio to preview voices or choose recognition. The ordinary
chat microphone and narration controls use these same providers. The speech pack
is supplied with the app in this phase, so its download/delete controls are hidden.

## Execution boundaries

The shared composer converts recordings to PCM WAV. The mobile adapter validates
and normalizes mono/stereo 16-bit WAV at 8–96 kHz to mono 16 kHz PCM. Recordings
are limited to two minutes; the bridge limits audio bytes and synthesis text.
Android feeds the recorded PCM to ML Kit at the required real-time rate through
a pipe. It never uses a microphone-source fallback for a failed file input.

Speech does not overlap a chat turn, script, task step, or model preparation in
the portable runtime. Native inference runs off the main thread. Abort and
backgrounding cancel the request; admission remains held until native work has
settled. The runtime uses an awake-time deadline and discards late cancelled
output before artifact persistence. Kokoro releases its model after each request;
Whisper does the same. Thermal and Android memory checks can refuse a request.
Long Kokoro output is bounded during generation as well as before encoding.

Synthesis uses the normal WAV artifact and SSE completion contracts. Initial
mobile synthesis sends loading progress and a final result; it does not yet emit
sentence audio chunks while native Kokoro is generating.

## Verification

`pnpm mobile:check` covers portable routing, explicit model/voice selection,
fallback eligibility, cancellation, saved artifacts, PCM conversion, and native
bridge validation. The shared UI's Audio tests cover bundled-model capabilities
and the existing voice preview/narration controls.

With only the dedicated `gezel-api36-tests` ARM64 emulator connected:

```sh
pnpm mobile:test:speech:android
```

The native test synthesizes a fixed sentence with `af_heart` and `bm_george`, then
checks that real Whisper recognizes its key words. It also checks cancelled
contexts and invalid voice IDs. The WebView test exercises the shared product
API, saved audio artifacts, and Audio settings, using isolated product files.
This focused command needs no chat-model fixture. To repeat the offline check,
disable Wi-Fi and mobile data in the test emulator before running it, then restore
those settings afterward.

In Xcode select **AppSmoke**, an ARM64 simulator, and run
`MobileBridgeTests.testOfflineSpeechPackRoundTrip`. This invokes the real iOS
plugin with both voices and transcribes the resulting PCM with Whisper. It does
not assert that simulator system recognition is available.

Package verifiers check speech asset hashes and native-library presence in the
actual APK/AAB or device archive. Android additionally checks every ELF library
for 16 KiB page alignment and packaged dependencies.

## Remaining release validation

This is an initial working implementation, not a full speech quality benchmark.
The round-trip tests cover two English voices; they do not establish recognition
accuracy across accents, languages, noise, or device microphones. Physical-device
airplane-mode tests are still required for Apple recognition and Android ML Kit,
along with permission denial/revocation, language-asset removal, thermal pressure,
Bluetooth interruptions, and sustained latency/battery measurements. ML Kit's
speech dependency is an alpha release. The newer Apple SpeechAnalyzer path is
not implemented in this phase.

Before store distribution, choose bundled versus separately installed model
delivery and complete the native dependency license/source-distribution review.
The pinned sherpa build includes piper-phonemize and eSpeak NG; the latter's GPL
license is included under `native/mobile/speech/licenses`. Upstream notices and
their source URLs/hashes are staged with the app. Collecting notices alone does
not finish the distribution review.
