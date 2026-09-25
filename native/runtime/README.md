# Reusable native provider and model host

This layer owns the mobile model library, verified downloads, llama.cpp and
platform-provider routing, cancellation barriers, and resource lifecycle. It
contains no Capacitor, product filesystem, speech or UI implementation. The
thin [`@bendyline/gezel-capacitor`](../../packages/capacitor) package adapts these
operations and events to `GezelApp`.

`GezelNativeRuntime.shared()` in Swift / `shared(context)` in Java returns the
process-owned host. Configure a different private root once with
`shared(root:)` / `shared(context, root)` before attaching a plugin. A second
explicit root is rejected. The default is Application Support/Gezel on iOS and
filesDir/gezel on Android; both are inside the embedding app's sandbox.

Native callers use `NativeCall` with a JSON options object and exactly-once
resolve/reject callbacks. The methods match the typed
[plugin contract](../../packages/capacitor/src/definitions.ts); `listen` returns
a removable event subscription. Results do not include invented token usage.
Provider implementations are internal; callers select an explicit provider and
model through the host so they cannot bypass its shared admission gate.

iOS observes application foreground/background, memory pressure and thermal
notifications. A native Android host forwards its foreground/background lifecycle
to `onForeground()` / `onBackground()`; the Capacitor adapter does this itself.
The Android host registers memory-pressure callbacks and checks thermal state
on admission. `releaseModel` waits for cancellation and native cleanup. The
singleton lives for the process lifetime; client teardown removes listeners and
cancels only its own request, not another client's work.

## Producer staging (no publication needed)

First stage verified low-level engine packages using
[`native/mobile/stage-sdk.py`](../mobile/SDK.md). Then wrap those packages:

```sh
python3 native/runtime/stage-sdk.py ios \
  --sdk /path/to/low-level-ios-sdk --output /path/to/ios-runtime

JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk \
python3 native/runtime/stage-sdk.py android \
  --sdk /path/to/low-level-android-sdk --output /path/to/android-runtime
```

Choose a new output path for each staging run. The input SDK inventory is
verified before use. Outputs record engine provenance, wrapper source hashes
and artifact hashes. Android compiles the Java host and publishes
`com.bendyline.gezel:gezel-runtime:<version>` plus its prebuilt `gezel-llama`
dependency into the output's `maven/` folder. It does not build llama.cpp.
`--offline` uses already-cached Gradle/ML Kit dependencies. The generated POM
declares ML Kit; consumers still resolve ordinary Android dependencies.

The iOS output itself is a Swift package exporting `GezelRuntime` and
`GezelModelStorage`, backed by `GezelLlama.xcframework`. It has no checkout paths
or environment requirements. Point a Swift consumer's local package dependency
at that folder, or stage it inside the Capacitor package. The *development*
manifest under `ios/` additionally accepts `GEZEL_LLAMA_PACKAGE` for compiling
directly against a staged low-level package.

No registry is necessary for these local integrations. Later, distribute Swift
source/package metadata with a versioned repository and binary release assets,
and the Android artifacts through a Maven repository. GitHub release assets can
hold binaries, but an AAR by itself is not a Maven dependency with its POM and
transitive dependencies.

Gezel mobile consumes the same Capacitor package as an external app. Its
product-only storage adapters retain the existing paths and legacy state format;
the reusable runtime has no access to projects, credentials or product files.
Stage native artifacts before `cap sync`. `GEZEL_MOBILE_NATIVE_BUILD` can select
a verified engine build outside the default `.build` folder when syncing Gezel's
remaining app-owned native assets. Speech still has its separate build gate.

## Independent consumer checks

Copy `consumers/swift` outside the checkout, extract the Capacitor npm tarball
beside it, and run from the copied Swift folder:

```sh
GEZEL_CAPACITOR_PACKAGE=/path/to/extracted/package \
  xcodebuild -scheme RuntimeConsumer \
  -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -derivedDataPath /tmp/gezel-consumer-derived ARCHS=arm64 CODE_SIGNING_ALLOWED=NO test
```

The tests cover shared ownership, model admission, release barriers, background
events, and the actual Capacitor call bridge. To include the import/generate/
stream/release/remove test, copy the tiny generated native contract model
(`native/mobile/.build/ios-fixture.gguf`) into the fixture's
`Tests/RuntimeConsumerTests/Fixtures/` directory before building.

Copy `consumers/android` outside the checkout and build it with Gradle 8.14.3,
JDK 21, and the Android SDK:

```sh
gradle -p /path/to/copied/android \
  -PgezelCapacitor=/path/to/extracted/package \
  -PcapacitorAndroid=/path/to/node_modules/@capacitor/android/capacitor \
  assembleRelease
```

This is a release consumer with R8 enabled. It contains no Gezel app source,
speech dependency, CMake build or NDK dependency. Standard Capacitor/Android
dependencies still need to be cached or downloadable.

Validated locally on 2026-09-22: the extracted tarball passed six iOS simulator
tests including real synthetic-model inference; the minified Android APK built
and passed ELF dependency closure plus 16 KB ELF/ZIP alignment checks for all
seven engine libraries. A fresh offline JavaScript consumer using the local
tarballs passed models, completion and streaming checks, and bundled for the
browser without Node, undici or service imports. Physical-device ML Kit/Apple
inference and inference quality are not qualified by these checks.
