# Gezel mobile foreground preview

A native host for Gezel's shared responsive UI. The application frame, brand,
navigation, project section tabs, characters, and visual tokens come from
`packages/ui`; mobile is not a separate product UX. The portable runtime currently
supports Mira, one local project, and text conversations through imported GGUF
or system models. It does not yet support the desktop's full project/document
operations.

To test the full mobile layout with existing projects and documents, resize the
ordinary desktop app to about 400px wide. At 760px and below, its normal navigation
rail becomes the entry screen and the same project/document view fills the window
after selection. Navigation and resizing keep the view and draft mounted. The web
app also accepts `?layout=mobile` to constrain the same application to a 390px frame;
**Exit mobile preview** restores the normal layout without changing user state.
This uses the desktop backend and existing views, while the native host exposes
only operations its portable backend can actually perform.

## Build

Install approved workspace dependencies through the repository's guarded
dependency workflow. Node is needed for development only. The app embeds bundled
web assets and native llama.cpp; it does not run Node or a localhost daemon.

```sh
# Build the web app and portable core exports.
pnpm mobile:build

# Build the pinned native bridge. The output path matches the Xcode project.
python3 native/mobile/build-llama.py ios --output native/mobile/.build/ios-bridge
pnpm mobile:sync:ios
pnpm --filter @bendyline/gezel-mobile run open:ios

# Android requires a JDK, SDK, and NDK r28+ already installed.
python3 native/mobile/build-llama.py android --ndk /path/to/android-ndk
pnpm mobile:sync:android
pnpm --filter @bendyline/gezel-mobile run open:android
```

The native build driver requires a fresh output directory. Reuse an existing
verified build, or choose a fresh output and update the native project reference.
The desktop build does not build native mobile targets. iOS uses an exact
Capacitor Swift package pin; the current Foundation Models adapter compiles with
Xcode 27, and app deployment requires your signing identity.
Android initially targets arm64-v8a and API 28 or later. Native artifacts stay
ignored and must be built before native sync; `sync-native.mjs` stages Android
libraries and both platforms' native licenses. Android sync also pins Gradle's
NDK version to the native build manifest so JNI and the staged C++ runtime match.

When iOS assets already exist, launch them directly by opening
`ios/App/App.xcodeproj` in Xcode, choosing the **App** scheme and an iPhone/iPad
simulator, then pressing Run. For a physical device, choose a signing team and
enable Developer Mode on the device. After web changes, rerun `pnpm mobile:sync:ios`
before Run; that command also rebuilds the web assets.

For Android, install SDK platform 36, build tools 36.0.0, platform tools, NDK
28.2.13676358 (r28c), and CMake 3.31.6 through Android Studio's SDK Manager. Use
JDK 21 for Gradle, including Android Studio's **Gradle JDK** setting; a newer
bundled Java runtime is not necessarily compatible with the pinned Gradle wrapper.
The JNI build pins CMake 3.31.6. Put the SDK's `cmake/3.31.6/bin` on the shell
PATH for the native build command above. Pass the installed
NDK directory to `--ndk`, sync, then select the **app** configuration and an ARM64
emulator or USB-debugging-enabled phone in Android Studio and press Run. The
current app packages only `arm64-v8a`; an x86_64 emulator cannot run it. After web
changes, rerun `pnpm mobile:sync:android` before Run.

For automated Android checks, use `pnpm mobile:test:android` with a dedicated
ARM64 test emulator and the tiny host-generated GGUF fixture. See the
[Android testing setup](native/android/README.md#verification) for emulator,
fixture, and JDK requirements. The suite includes native inference, storage
recovery, and a real WebView chat flow; it does not require Android system AI.

For a browser preview, run `pnpm mobile:dev`. Browser
previews persist to a separate IndexedDB database and clearly show that native
models are unavailable. No demo model response or network fallback is installed.
The installed app's **Import a model** action opens the platform document picker;
it copies a selected GGUF into the app's private model library. The web view sees
opaque model IDs, never arbitrary native paths. Models with unsupported chat
templates, context limits, or resource requirements fail with an explicit error.

## Providers and conversation controls

In the native host, select the project from the shared navigation to open Chat.
Conversations live inside that project, and model setup lives in **Settings →
Models**. Documents remain visibly unavailable until their native runtime exists.

The model chooser keeps an explicit selection and checks readiness before every
turn. It offers imported llama.cpp models plus Apple Foundation Models on iOS or
ML Kit on Android when usable. Availability includes a reason when the device,
OS, model assets, or current foreground/resource state prevents inference. A
failed provider never changes the selection or sends the conversation elsewhere.
All three adapters currently advertise foreground text only: no tools, images,
or structured output.

Apple's model is managed by the OS. Android preparation starts only when the
user presses **Download**, with a **Cancel download** control; preparation does
not change the selected provider. Android can retain or finish system-managed
assets after the app cancels its observer. The approved ML Kit dependency is
pinned to `com.google.mlkit:genai-prompt:1.0.0-beta4`; see the
[Android integration notes](native/android/README.md) for SDK behavior and terms.

Imported models have bounded metadata, size/count limits, and disk checks.
**Remove model** asks for confirmation, removes the app's copy, and clears its
selection without choosing a replacement. Conversation history remains intact.
GGUF loading can still reject a model that passed import checks.

Conversations can be searched locally by title or message, renamed, or deleted
with confirmation. No search text leaves the app. Navigation and model changes
wait for durable saves, and deleting the final conversation creates an empty one.

## Boundaries and persistence

`src/runtime` is the foreground product slice. It accepts atomic storage and
inference ports; it has no Node, DOM, or Capacitor imports. Core's
`MobileStateSchema` owns the versioned shape and reuses existing crew, project,
and session fields. The poppetje's generated slots are persisted explicitly.

The React screen calls a typed client. Request/reply and snapshot events connect
that client to `runtime-worker.ts`, a dedicated Web Worker. A main-thread adapter
forwards only declared storage/inference operations to the native plugin. This
small client is not a compatibility implementation of all desktop HTTP routes.
The full desktop ChatManager and Store are not imported into the app.

Swift/Java own a confined `state.json`, atomic replacement, and a separate model
inventory. Swift uses Application Support/Gezel; Android uses the app's private
files directory. These files are a mobile v1 snapshot, not a desktop-home backup
format. Do not copy them into `~/.gezel`. There is no account sync or transfer yet.
Unrecognized/corrupt state is reported and retained, never silently overwritten.
Older v1 records default to the imported-model provider; new assistant messages
record the provider that produced them. Browser storage uses compare-and-write
transactions so a stale preview tab cannot overwrite another tab's changes.

Before inference, the runtime durably saves the user message and an unfinished
assistant placeholder. Successful/failed/stopped results are persisted before the
client resolves. Streamed partial text stays in memory until then; process death
can lose that partial text, but recovery marks the saved placeholder interrupted
and never retries inference automatically. A failed final save keeps the text
visible, blocks a new turn, and exposes **Retry save** without rerunning inference
or changing the result's completion status. Other failed mutations leave durable
state unchanged; **Check storage** tests a write before the user retries the action.

Only one turn may run. Request IDs isolate late events; cancellation waits for
the native operation to release before allowing a new turn. If cancellation
fails, the turn stays reserved until it settles or **Retry stop** succeeds.
Native inference
runs on a serial background queue and cancels when the app enters the background.
The native bridge has separate token, output, memory-related, and time bounds.
See [its ABI contract](../../native/mobile/README.md). Imported files are not
guaranteed to fit a physical device just because they pass the file-size limit.

The mobile runtime bounds state to four million UTF-16 code units, 100
conversations, 400 messages per conversation, 16,000 input characters, 24,000
prompt characters, and 64,000 response characters. Provider context limits can
reduce the prompt budget further. Native adapters apply token admission where
the API supports it, with a conservative byte estimate on older Apple APIs.
Failed and empty interrupted turns are excluded as whole user/assistant pairs;
nonempty interrupted replies remain context. Long conversations ask for a new
conversation rather than silently removing successful history.

## Verification

```sh
# Typecheck and runtime/adapter tests under the shared dependency read lease:
pnpm mobile:check

# Native contract suite uses a generated untrained tiny GGUF, with real llama decode.
python3 native/mobile/build-llama.py host
python3 -m unittest discover -s native/mobile -p 'test_*.py'
swift test --package-path packages/mobile/native/ios

# After serving the built dist/ on loopback, using the workspace UI's Playwright:
pnpm mobile:smoke http://127.0.0.1:4178 /tmp/gezel-mobile-shots
```

Runtime tests cover provider pinning/readiness, legacy records, durable turn
boundaries, retryable failed writes, cancellation failure, local search and
atomic conversation changes. Adapter tests cover descriptor validation and
cancellation while native listener setup is pending; a transport test connects
the actual worker handlers and client. The browser smoke loads the actual worker
at phone/tablet widths and verifies persistence, search, rename, confirmed delete,
unavailable-provider controls, and stale-tab overwrite prevention. Native storage
tests check atomic JSON handling, bounded model inventory, removal, interrupted
import cleanup, and confinement. The mobile CI workflow builds the web app and
runs typechecks, tests, and browser smoke independently of the desktop bundle.

The iOS app builds for simulator and unsigned device targets against the real
XCFramework. The [app-hosted simulator test](native/README.md) verifies worker
startup, native persistence, streamed inference, cancellation, and engine reuse.
The Apple adapter has also produced a real streamed response in an iOS simulator;
its availability and cancellation paths are exercised there. Android builds for
ARM64 with JDK 21 and NDK r28c. Its API 36 emulator suite exercises real JNI
streaming/cancellation, storage recovery and confinement, and the packaged
WebView's model selection, native chat, conversation management, and reload.
Tiny-fixture llama inference verifies mechanics, not model quality. Android
system-AI inference still requires an eligible physical device. Physical-device
memory/thermal measurements, distribution
review, and representative trained-model quality tests remain release gates.

## Remaining scope

This preview supports one Meester/default project and text chat. It does not yet
execute tools, scripts, craftbooks, imported documents, or desktop companion
requests. QuickJS remains the separately tested foundation from the first phase.
Resumable verified GGUF catalog downloads, measured device admission tiers,
capability-filtered catalog content, cloud/paired inference with scoped native
credentials, crew creation, conversation export/import, and mobile task execution
remain in the [mobile plan](../../docs/mobile-plan.md). This increment does not
complete the broader provider/product hardening phase or its physical-device
quality gates.
