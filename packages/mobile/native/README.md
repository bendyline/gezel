# Mobile native boundary

The Capacitor `GezelMobile` plugin owns app-private product files, document-picker
GGUF imports, model selection, and one foreground native generation. Model calls
exchange opaque model IDs. Imported files are copied into the app
container; iOS excludes replaceable model weights from backups and Android
disables app backup. Product writes use atomic replacement and reject data larger
than 16 MiB. The shared portable Store validates product schemas before saving.

The shared portable Store uses `MobileHost.files` for the same `config.json`,
`projects/`, `gezels/`, and `documents/` layout beneath a separate app-private
`product/` directory. The six product-file plugin methods accept relative paths
only; they reject traversal, absolute paths, NULs, backslashes, symbolic links,
and special files. Root removal/rename is forbidden. Writes replace files
atomically; rename supports files and directories and never overwrites a
destination. All plugin file operations run on the storage queue. Individual
files are limited to 16 MiB and native directory listings/subtree operations to
10,000 entries. The browser preview uses per-file IndexedDB records with atomic
transactions, a 10,000-entry total limit, and revision checks that reject stale
tabs rather than lose updates. Imported HTML never receives these bridge ports.

Both plugins serialize llama calls off the UI thread, stream `chatDelta` events
tagged by request ID, and settle generation with its final text and stop reason.
Explicit cancellation resolves once the matching operation has ended; entering
the background cancels active work and prevents new generations until the app
returns. No platform file path or arbitrary module loader is exposed to scripts.
The privileged webview blocks navigation away from its packaged localhost origin.

iOS supports arm64 devices and Apple Silicon simulators, minimum iOS 16.4.
Build with Xcode 27 or later. Its weak-linked Foundation Models adapter requires
iOS 26 and explicitly selects `SystemLanguageModel.default`. The provider chooser
reports the SDK's current availability and reason; Apple controls model preparation
in Settings. The app never substitutes a cloud model or another provider. Imported
GGUF and Apple generation share one foreground-only admission gate, with bounded
input/output and cancellation barriers. See [iOS provider details](ios/README.md).
The iOS 26 streaming API exposes no terminal token count, so normal Apple completion
reports `stop` even when its configured token budget ended generation; iOS 27 usage
can identify that limit.
Android currently targets arm64-v8a, minimum API 28. The app and JNI libraries
compile with JDK 21, SDK 36, and NDK r28c; real native inference and storage tests
run on an ARM64 API 36 emulator. See the [Android verification instructions](android/README.md#verification)
for the repeatable native/WebView suite. Device signing and provisioning are
separate from unsigned builds.

## Native storage tests

From the repository root:

```sh
swift test --package-path packages/mobile/native/ios
```

These Foundation-only tests cover durable JSON reopening, invalid and oversized
state, bounded model inventories, copied model selection, interrupted imports,
symlink escape rejection, safe removal, and recovery after an interrupted removal.
The product filesystem tests also cover binary reopening, directory rename, atomic
replacement, size bounds, traversal rejection, and preserving outside files.

## Packaged iOS bridge regression

Build the web app, Capacitor project assets and native XCFramework as described in
[the mobile README](../README.md). The Xcode project links the native output at
`native/mobile/.build/ios-bridge/GezelLlama.xcframework`. `cap sync ios` retains the
custom scene controller and source references; run `scripts/sync-native.mjs ios`
after syncing to include native licenses. This script is included in `sync:ios`.

Generate the deterministic test model without downloading weights:

```sh
python3 native/mobile/build-llama.py host
native/mobile/.build/host/build/gezel-llama-tests \
  --write-fixture native/mobile/.build/ios-fixture.gguf
```

If the host build uses `--output`, use that output's `build/gezel-llama-tests`.
The fixture is compiled into the test bundle only. It exercises actual inference
and always emits `a`; it makes no model quality claim.

Create a dedicated simulator using an installed runtime/device type from
`xcrun simctl list`, then run:

```sh
xcodebuild -project packages/mobile/ios/App/App.xcodeproj \
  -scheme AppSmoke -configuration Debug \
  -destination 'platform=iOS Simulator,id=YOUR_TEST_SIMULATOR_UUID' \
  -derivedDataPath /tmp/gezel-mobile-ios-build \
  CODE_SIGNING_ALLOWED=NO test
```

The app-hosted XCTest runs the shared React App and portable service. It seeds a
project, crew assignment, shared document, and artifact through the authenticated
product API, then opens the real navigation, model Settings, project chat, and
file viewers. It verifies a streamed native reply, reload persistence, and the
ordinary config/project/session files. The shared chat uses the deterministic
GGUF fixture; Apple inference is checked separately when the OS reports it ready.
Additional checks cover reasoned Apple unavailability without fallback, streaming,
cross-provider serialization, cancellation barriers, model release/removal, and
background availability. Eight deterministic llama tokens must stream exactly,
and the engine must accept another request after cancellation. The test restores
the prior product tree and model inventory and removes its imported fixture.
Use the dedicated test simulator. Simulator coverage does not establish
physical-device memory, thermal behavior, or battery use.

For unsigned device compilation, use scheme `App` with
`-destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`. This confirms
device linkage, including Metal; runtime inference on physical hardware still
requires signing and a device test.


The iOS bridge requires an explicit `modelId` for llama.cpp requests. Conversations
retain this identity when Settings chooses a different default; removed models
fail without substitution. Default request limits are 4096 context / 1024 output,
with explicit 512–8192 / 1–4096 limits and room reserved for input. Apple retains
its reported context and 1024-output cap. The ordinary model tuning/context fields
persist Settings choices across restarts. The smoke fixture sets its trained
8192-token context explicitly and verifies a 512-token reply as well as short
streaming and cancellation.


Backups use `beginExport`, ordered `appendExport` chunks (256 KiB decoded max),
then `saveExport`. The app-private temporary ZIP is bounded to 72 MiB and passed
to the system Files export picker. Cancellation clears staging and is surfaced as
an uncompleted export. The WebView never receives a native filesystem path.


## Verified model downloads

The native download manager accepts canonical catalog provenance, never a URL or
filesystem destination from the WebView: catalog id/version, source id,
Hugging Face repository, immutable 40-character revision, GGUF filename and
SHA-256. `resolveModelSource` performs an explicitly requested HEAD lookup to
resolve exact bytes; an approximate catalog size is only a display estimate.
Only HTTPS Hugging Face/CDN redirects are accepted. Gated or inaccessible sources
fail explicitly; the existing Files import remains available.

`startModelDownload` and `resumeModelDownload` return a durable download record.
`listModelDownloads` exposes progress, state, errors and the installed opaque model
id. One foreground transfer runs at a time, streamed to a private partial outside
the model inventory. Resume requires a matching strong ETag and exact byte range;
a server returning a full response restarts from zero. Every activation verifies
exact length, streamed SHA-256 and GGUF magic before atomically publishing the
inventory entry with its source provenance. A crash between final rename and
inventory publication is recoverable by rehashing the complete staged file.
Downloading never changes the selected model or an existing conversation's model.

`cancelModelDownload` pauses and preserves its partial. Suspension also pauses
both a body transfer and pending source lookup; reopening never resumes either
automatically. `cancelModelSourceResolution` cancels the separate metadata request.
`removeModelDownload` removes only the partial/journal; dismissing a completed
record cannot remove the installed model. Inventory removal is a separate action.
Downloads are capped at 4 GiB per model and sixteen saved records, with a 64 MiB
free-space reserve. Models and partials stay outside portable product backups.

`ModelDownloadsTests` in the Foundation package and Android's `ModelDownloadsTest`
use injected transport responses. They cover restart, cancellation before headers,
Range/If-Range, changed validators, wrong ranges, checksum/length failure, safe
activation/dismissal, publication recovery, and rejected staging links. These
regressions do not download model weights or establish real-device throughput.

## Offline HTML previews

The shared desktop file viewer uses a host snapshot publisher on mobile. It reads
HTML and relative assets through the ordinary authenticated portable file API,
confines references to the selected page's directory, and embeds bounded copies
of CSS, classic JavaScript, images, fonts, and media. External references, modules
that need a bundler, page RPC, and product-file access are not supported inside
these snapshots. Limits are 2 MiB per input file, 64 input files, 16 MiB of source
bytes, and 8 MiB after embedding. Native caches retain at most four snapshots and
16 MiB for ten minutes; closing or refreshing the preview revokes its token.

Snapshots use unpredictable `/__gezel_preview/<UUID>/index.html` URLs on the
existing app scheme. Native responses have their own strict CSP and sandbox;
the privileged app's CSP is unchanged. The iframe has `allow-scripts` without
`allow-same-origin`, no network/form/worker/frame authority, and no permissions
for camera, microphone, geolocation or clipboard. Every-frame document-start
injection seals WebRTC and object-URL constructors before authored scripts,
including fresh srcdoc/blank frames. iOS additionally denies nested navigation.
Only the exact packaged main document may call the native bridge. Legacy Android
cookie/HTTP interfaces are removed, and unsupported WebViews fail closed instead
of exposing unidentifiable JavaScript-interface calls. Browser-only development
keeps HTML preview unavailable until it has an equivalent host boundary.

`PreviewBoundaryTest` (Android), `testPreviewFramesCannotReachNativeBridge`
(iOS), and the shared test-only `mobile-preview-security.js` verify this in real
WebViews. `test-html-preview.mjs` verifies relative assets and escaping in Chromium;
shared UI tests verify snapshot disposal and that forged page RPC is ignored.

Android system Back dispatches the cancelable `gezel:back` event to the packaged
main document. The shared responsive UI dismisses overlays first, then reveals
navigation while preserving the mounted draft. An unhandled event (or a stalled
renderer) delegates to Android's ordinary Back behavior; native code does not own
a separate navigation model. The Android UI smoke uses real system Back actions
and checks both a popover and the shared backup dialog before reopening the draft.
