# Mobile native boundary

The Capacitor `GezelMobile` plugin owns app-private JSON state, document-picker
GGUF imports, model selection, and one foreground native generation. JavaScript
exchanges opaque model IDs, never paths. Imported files are copied into the app
container; iOS excludes replaceable model weights from backups and Android
disables app backup. State writes use atomic replacement and reject invalid JSON
or data larger than 16 MiB. The portable TypeScript runtime validates the product
schema before saving it.

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

The app-hosted XCTest verifies the packaged worker finishes startup and native
providers appear in the actual chooser. It changes the provider through the
rendered form, submits a message, and checks the saved assistant response and
provider ID. On a supported system it uses Apple's actual on-device model;
otherwise it exercises the imported synthetic model. Additional native checks
cover reasoned Apple unavailability without fallback, streaming, cross-provider
serialization, cancellation barriers, invalid state writes, model release/removal,
and background availability. Eight deterministic llama tokens must stream exactly,
and its engine must immediately accept another request after cancellation. The
test restores prior conversation state and model inventory and removes its imported
fixture afterward. Use a dedicated simulator so test conversations remain separate
from everyday use. A simulator reporting Apple support is useful integration
coverage, not evidence about physical-device memory, thermal behavior, or battery.

For unsigned device compilation, use scheme `App` with
`-destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`. This confirms
device linkage, including Metal; runtime inference on physical hardware still
requires signing and a device test.
