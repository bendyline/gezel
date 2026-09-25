# Gezel mobile host

The native app loads the **same `packages/ui` entry point, views, and typed client** as desktop. Projects, named gezels, the Meester, the shared document library, workspace files, artifacts, prompt drafts, and conversations use the ordinary core schemas. The host supplies local files and inference; it does not create another product UX.

To test the full mobile layout with existing projects and documents, resize the
ordinary desktop app to about 400px wide. At 760px and below, its normal navigation
rail becomes the entry screen and the same project/document view fills the window
after selection. Navigation and resizing keep the view and draft mounted. The web
app also accepts `?layout=mobile` to constrain the same application to a 390px frame;
**Exit mobile preview** restores the normal layout without changing user state.
This uses the desktop backend and existing views, and native uses the same views against its offline runtime. Runtime capabilities reflect implemented operations, independently of viewport width.

## Build

For everyday development, run either command from the repository root:

```sh
pnpm android
pnpm ios
```

Each command builds the shared UI and portable packages, syncs the native project
and its assets, then opens Android Studio or Xcode. Select an emulator/simulator
and press **Run** in the IDE to compile, install, and launch the native app.
These commands reuse the existing llama.cpp and speech libraries; the one-time native build
and toolchain setup below must already be complete. They do not install missing
SDKs or dependencies. On Android, select an ARM64 emulator such as the existing
`gezel-api36-tests` device.

When no usable chat model is selected, Gezel opens the shared **First run setup**
page, including in a narrow desktop window. Download a model from the expanded
catalog picker, or import a GGUF file and select it. Choosing a ready model opens
the Meester's workspace; model management also lives in **Settings → Artificial
Intelligence**. Chat model weights are not bundled with the app; the bundled
speech models do not generate chat
replies. If Android's system model is unavailable, use a GGUF model. The first
download needs internet; the selected model then runs offline. A missing-model
message in chat links to these settings and keeps the unsent draft.

Install approved workspace dependencies through the repository's guarded
dependency workflow. Node is needed for development only. The app embeds bundled
web assets and native llama.cpp; it does not run Node or a localhost daemon.

```sh
# Build the web app and portable core exports.
pnpm mobile:build

# Build the pinned native bridge. The output path matches the Xcode project.
python3 native/mobile/build-llama.py ios --output native/mobile/.build/ios-bridge
pnpm mobile:build:speech ios --fetch
pnpm mobile:sync:ios
pnpm --filter @bendyline/gezel-mobile run open:ios

# Android requires a JDK, SDK, and NDK r28+ already installed.
python3 native/mobile/build-llama.py android --ndk /path/to/android-ndk
pnpm mobile:build:speech android --ndk /path/to/android-ndk --fetch
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

The speech build's `--fetch` flag downloads checksum-pinned dependencies and the
offline model pack; use it only after authorizing those downloads. Omit it for
subsequent builds from the verified cache. Speech build commands acquire the
repository dependency lease. The initial pack is about 240 MiB before compression
and includes Whisper tiny plus Kokoro voices, so speech can work on first launch
without a connection. The pack's 17 MiB `espeak-ng-data` directory is excluded:
it is GPL-3, and only the retired eSpeak frontend ever read it. See [offline speech](../../docs/mobile-speech.md) for provider
selection, supported voices, tests, and remaining device validation.

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
The runner installs updates in place and leaves the app installed after the
tests restore its product data. It prints the directory containing the native
test log and screenshots; set `GEZEL_ANDROID_TEST_OUTPUT_DIR` to choose one.

For a browser preview, run `pnpm mobile:dev`. Browser
previews persist to a separate IndexedDB database and clearly show that native
models are unavailable. No demo model response or network fallback is installed.
The installed app's **Import a model** action opens the platform document picker;
it copies a selected GGUF into the app's private model library. The web view sees
opaque model IDs, never arbitrary native paths. Models with unsupported chat
templates, context limits, or resource requirements fail with an explicit error.

## Offline workflow

1. Use **Gezellen** to create a named crew member and set their role/about text.
2. Create a project, assign its crew/lead, and write its about/mission.
3. Create or upload files through the ordinary Documents, Workspace, and Artifacts views. Text/Markdown editing uses the same editor as desktop.
4. Choose an imported GGUF or available system model in Settings. Chat with a project crew member. Chat references to local files such as `workspace/brief.md` or `documents/style.md` supply the referenced text to the model; a missing, unsupported, or over-budget file fails explicitly.
5. Use **Save response to project artifacts** on a reply to keep its Markdown as an editable project file. Reopen it from the shared file browser and download it through the normal file controls.
6. Reopen the app: projects, crew, files, drafts, and conversations remain on the device.

The Meester can recruit crew and start a project with a kickoff task. Crew members can read/write permitted files, save memories, and hand off work while the app remains open. Tasks use the desktop task screens, with a **Run step** action on foreground hosts. Completion runs the configured gates. Continuous tasks can advance through foreground steps, role changes, and lifecycle scripts; human steps and questions stop the run for input. Task execution mode uses the shared desktop setting: local models default to stepwise, while explicit generalist mode pins one owner and carries compatible conversation history across steps. Human and explicitly assigned specialist steps keep their assignments. Execution limits and cancellation checkpoint the task before stopping. Compatible craftbooks come from the same pinned Gilde catalog. Unsupported recipes are excluded before packaging.

Search covers local text and saved conversations. Memories use the ordinary daily Markdown and lessons files. In Settings, export a ZIP backup or review an imported backup before choosing which existing items to replace. Exports use the native Save/Files dialog. Backups do not restore credentials, security settings, or model weights. Enable **Show advanced features** to reach the shared Scripts view. Create and edit project or user TypeScript scripts offline, inspect diagnostics, and run them in QuickJS. Standard scripts remain read-only; authored scripts retain the same declared-capability and project-policy checks.

The existing editor's writing tools use the configured Klerk, its selected native model, and the same transform prompts as desktop. Preview the generated text before applying it; cancellation, unavailable models, and exhausted context budgets produce explicit errors. File-editing gezels can append text, replace a matching passage, or replace a line range using the shared desktop edit rules, without rewriting an entire file.

Native hosts can preview HTML artifacts and workspace pages through the shared file viewer. Relative assets are copied into a bounded snapshot; the page has no native bridge, product API, or network access. Classic JavaScript interactions work; external resources and module-based pages must be bundled first. This capability remains unavailable in the ordinary browser preview.

The browser preview uses IndexedDB and reports native inference unavailable. It does not simulate a model or silently use the network. Ordinary narrow desktop windows use the full desktop runtime and retain its capabilities.

## Architecture and persistence

`@bendyline/gezel/runtime` owns the Node-free `PortableStore` and foreground `PortableProductService`. The normal `GezelClient` talks to its injected Fetch/Response adapter, including the normal chat SSE event contracts. Mobile sets the host bridge before dynamically loading `packages/ui/src/main.tsx`. Native model management is composed into the shared Settings screen.

The store writes ordinary files beneath a confined app-owned `product/` directory:

```text
config.json
gezels/<id>/gezel.md
gezels/<id>/about.md
gezels/<id>/poppetje.json
gezels/<id>/sessions/<id>.json
projects/<id>/project.json
projects/<id>/documents/{about,missionObjectives}.md
projects/<id>/{workspace,artifacts}/...
projects/<id>/tasks/<num>/{task.json,about.md,notes.jsonl,execution.json}
projects/<id>/scripts/<name>.ts
projects/<id>/scripts/runs/<date>/<id>.json
projects/<id>/questions.json
scripts/<name>.ts
{gezels,projects}/<id>/memories/{daily/<date>.md,lessons.md}
documents/...
```

The shared document library remains a marked project, identified through config and `isSharedLibraryProject`, not a hard-coded id. Crash-recoverable transaction journals coordinate multi-file writes. Native filesystem adapters enforce confinement, reject symlinks/traversal, atomically replace files, and limit each file to 16 MiB. Browser per-file transactions reject stale writers. There is no prototype snapshot migration: mobile has not shipped.

A user turn and its sent draft metadata are durable before inference starts. Completion, cancellation, and failure persist before terminal chat events. A failed final save retains the response in memory and blocks new mutations until **Retry saving** succeeds. OS termination marks unfinished turns interrupted on reopening; it never automatically reruns a model. Streaming partial text can be lost if the OS kills the process before completion.

Native inference runs off the UI thread and cancels on backgrounding. Only one foreground turn runs at a time. Fresh readiness checks fail without switching providers or falling back to a network service. Provider context limits can reject oversized conversations; successful history is not silently discarded.

Native admission counts the formatted prompt with llama.cpp's tokenizer, ML Kit's request token counter, or Apple's transcript token counter on iOS 26.4 and later. iOS 26.0–26.3 has no public tokenizer, so Apple admission conservatively uses UTF-8 bytes plus transcript overhead and can reject text that a later OS would accept. Requested context and reply budgets remain limits on every provider; no adapter enlarges them to fit a prompt.

The native model library remains separate from product files. Settings also offers immutable, single-file GGUF entries from the pinned desktop catalog. Download preparation resolves the exact content length; native transfers enforce bounded HTTPS redirects, resumable byte ranges, SHA-256 and GGUF validation before publication. Pausing or backgrounding keeps a private partial download for explicit resume. A finished download never changes the selected model. Network policy changes cancel preparation and transfers. Imported GGUFs use opaque model IDs pinned per conversation; removing a pinned model causes an explicit error. Context/reply budgets use the shared configuration keys and are checked at native admission. Apple Foundation Models and the exact-pinned Android ML Kit Prompt API are explicit providers; availability is device/OS dependent. Preparation is user initiated. Their raw native interfaces advertise text only. The product runtime adds a bounded, strict JSON tool protocol with live role/step/policy checks and durable action records; this is not a native structured-output guarantee.

Bundled scripts compile at build time and run in QuickJS inside a terminable Web Worker. The guest receives the capability-checked `gezel` SDK, not the browser or Node environment. Script runs are recorded before effects and marked interrupted after termination; reopening never replays an uncertain effect. Authored TypeScript uses an on-demand offline compiler worker and the same admission path. Source edits are preserved even when invalid, and optimistic hashes prevent stale saves from overwriting newer edits. Arbitrary package imports, subprocesses, and network SDK methods remain unavailable.

Craftbooks retain their embedded script source in the task snapshot and install provenance-marked project copies without overwriting unrelated user scripts. Execution records the source hash and craftbook version. Nested `gezel.script.run` calls use the same project, bounded recursion, parent cancellation, and separate durable child audits. Desktop and mobile recheck live security settings before each SDK effect.

Scripts can read, create, and edit local tasks and call `gezel.task.advance`. Advance returns `held` when a completion gate rejects; passing it runs the ordinary exit hooks and checked task transition. Gate scripts use the shared `decision`, `goto`, and `handoff` contract. Invalid or broken gate scripts pause without consuming a deliverable attempt; declared rejection loops create fresh lifecycle checkpoints while retaining their retry budget. Gate and exit scripts run in child workers with their own step identity and a durable parent audit link. Parent permissions are checked again before the transition commits. Task-bound model scripts cannot change other tasks, and lifecycle/gate scripts cannot create, edit, or advance tasks while owning a hook checkpoint; they can write task notes and return an authored auto-advance result. Script-created tasks cannot dispatch another model turn until the parent script finishes.

Task, script, and compiler deadlines use the shared awake-time clock and release their heartbeat/poll timers when work finishes. Browser or desktop host sleep does not consume the remaining execution budget. Native app backgrounding remains an explicit cancellation, so returning to the app never resumes work automatically.

## Verification

```sh
pnpm mobile:build
pnpm mobile:check
pnpm mobile:test:scripts
pnpm mobile:test:android
```

For the responsive production-browser check, serve the compiled assets in a
separate terminal:

```sh
python3 -m http.server 4178 --bind 127.0.0.1 --directory packages/mobile/dist
```

Then run `pnpm mobile:smoke http://127.0.0.1:4178 /tmp/gezel-mobile-shots`.
Stop the temporary server after the check finishes.

Shared-runtime tests drive the real `GezelClient` through crew/project/document/chat/artifact creation and reopen, fault-injected writes, confinement, and ordinary timeline contracts. Store tests exercise transaction replay, draft operations, shared-library identity, and binary files. Shared UI tests run desktop defaults and restricted-host capability profiles. Browser smoke uses the actual app at phone/tablet widths. Native filesystem and inference suites exercise real Swift/Java implementations; Android's WebView smoke uses the generated tiny llama.cpp fixture.

## Remaining scope

The offline runtime supports foreground crew/tool work, authored and bundled scripts, durable user questions, and continuous tasks with lifecycle hooks and deterministic/script gates. Background scheduling, fanout, model-reviewed gates, semantic indexing, cloud credentials, and desktop companion authorization remain unavailable. Capability flags hide their controls; unsupported API requests fail explicitly. Catalog selection is deliberately conservative: text/file recipes must exclude unavailable tool domains in their authored policies.

The Node daemon still owns desktop orchestration; this increment shares schemas, domain helpers, storage conventions, client/event contracts, and the entire UI. Further extraction should move desktop business rules into shared runtime modules behind host ports, rather than add mobile-only views or imitate daemon endpoints with dummy results.

Physical-device resource/quality testing, comprehensive accessibility/keyboard checks, signing, and distribution remain release work. Native CI now builds Android ARM64 app/test APKs and runs iOS simulator tests; Android instrumentation runs locally on the dedicated ARM64 emulator. Tiny-fixture inference proves mechanics, not trained-model quality. The detailed [parity status](../../docs/mobile-parity.md) separates working features from these remaining release gates.

## Packaged evaluations

`pnpm mobile:eval` drives test-only instrumentation inside the installed native app; it does not add test routes to the product. Run after syncing the current web assets. Use the dedicated test simulator/emulator explicitly:

```sh
pnpm mobile:eval --platform android --device emulator-5554 --contracts-only
pnpm mobile:eval --platform ios --device <simulator-uuid> --contracts-only
pnpm mobile:eval --platform ios --device <simulator-uuid> --provider apple-foundation-models
pnpm mobile:eval --platform android --device emulator-5554 --provider llama-cpp --trained-model /absolute/path/model.gguf
```

The contracts run real TypeScript compilation, QuickJS artifact writing, durable questions, and reopen checks without inference. Quality runs require an available real provider; synthetic GGUF fixtures do not qualify. Reports retain native logs, configuration, tool/session traces, artifacts, and deterministic grading. Ten canonical core adapters preserve their setup, prompts, frozen evidence, and host-side graders. A test-only mailbox sends exact canonical repair feedback through the ordinary native product client and keeps per-trial grading receipts. The host runs TypeScript/Vitest/acceptance checks on copies of device-authored files; it never writes candidate fixes. `petshop` remains explicitly unsupported because the mobile runtime has no real image-generation engine. A portable subset passing does not establish that all 11 core scenarios passed. Model-quality execution takes the same device lease as desktop evals.

## Unsigned release artifacts

```sh
pnpm mobile:package android 1
pnpm mobile:package ios 1
```

These rebuild and sync the product before compiling release artifacts using already installed native engines and toolchains. Sync verifies the upstream pin, current bridge source, payload hashes, and exact native file inventory. Android produces an unsigned APK and AAB and checks every packaged ELF library's actual ARM64 architecture, 16 KiB alignment and dependencies, APK ZIP alignment, required production assets, and exclusion of eval fixtures. iOS produces an unsigned device archive and verifies its ARM64 executables, embedded dependencies, deployment target, privacy/license assets, and absence of eval fixtures. Both platform verifiers also require every compiled web file to be present and byte-identical in the packaged public assets, and record the matched file count and entry digest. Candidates are built and verified in staging; a failed verification preserves the last verified release. Publication replaces the artifacts before writing their success manifest, so an interrupted publication cannot leave a stale success record. The manifest records verification results and artifact hashes, including a digest of the entire iOS app payload. Outputs go to `.build/release/<platform>` inside this package. Increase the build number for distribution; the marketing version follows core.

Use `JAVA_HOME` for JDK 21 and `ANDROID_HOME` for the installed SDK. `GEZEL_MOBILE_IOS_BUILD_DIR` and `GEZEL_MOBILE_SPM_DIR` can reuse existing Xcode and resolved Swift package caches. No signing key is generated or selected automatically. Signing, provisioning, store declarations, and physical-device release qualification remain separate release gates.
