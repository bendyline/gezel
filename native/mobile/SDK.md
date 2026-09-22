# Local mobile runtime packages

The first packaging slice produces a local Swift package and a folder Maven
repository from verified prebuilt llama libraries. Consumers compile their own
app code; they do not compile llama.cpp. Nothing is published or downloaded by
the packager.

These remain **low-level text runtime previews**: the Swift product exposes
Gezel's C ABI and the Android AAR exposes its synchronous JNI binding. For
provider routing, model management and lifecycle ownership, use the
[reusable native host](../runtime/README.md) built over these packages, or
[the Capacitor package](../../packages/capacitor/README.md) connected to the
existing `GezelApp` client. No `createIntelligence` API or separate App SDK
intelligence module is introduced.

## Build once, stage locally

Build each native target once with the [existing pinned builder](README.md).
Reusing current verified output is sufficient; staging rejects stale source
hashes, changed payloads, missing notices, and unverified extra native files.
Choose new output directories and a unique version for each preview.

```sh
# Only needed when a matching prebuilt runtime is not available.
python3 native/mobile/build-llama.py ios --output native/mobile/.build/sdk-ios
python3 native/mobile/build-llama.py android --ndk "$ANDROID_NDK_HOME" \
  --output native/mobile/.build/sdk-android

python3 native/mobile/stage-sdk.py ios \
  --build native/mobile/.build/sdk-ios \
  --output /tmp/gezel-sdk-ios-0.1.0-local.1 --version 0.1.0-local.1

python3 native/mobile/stage-sdk.py android \
  --build native/mobile/.build/sdk-android \
  --output /tmp/gezel-sdk-android-0.1.0-local.1 --version 0.1.0-local.1 \
  --ndk "$ANDROID_NDK_HOME" --javac "$JAVA_HOME/bin/javac"
```

Staging requires Python 3.9+ and Node. Android staging also needs CMake, Make,
JDK 21, and the exact NDK r28+ revision recorded in the prebuilt manifest. This
compiles only the small Gezel JNI/Java binding, once for the package producer.
The consuming Android app needs neither CMake nor an NDK for this dependency.

Each output contains `sdk-manifest.json` with package version, artifact hashes,
ABI and scope, plus `runtime-manifest.json` with upstream pin, native toolchains,
targets, original checksums and build verification. Android also records the
binding's sources and compiler versions. Licenses accompany the package. Staging
uses a temporary directory and publishes the output only after success; it
refuses to overwrite an existing preview. Preserve the entire staged output when
sharing it with another developer or CI.

## Swift consumption

Add `/tmp/gezel-sdk-ios-0.1.0-local.1/swift/GezelLlama` as a local package in
Xcode, or use `.package(path: ...)` and the `GezelLlama` product in a consuming
Swift package. Application source imports `GezelLlama`. The binary target uses
a relative XCFramework path, so the staged package can move to another machine.
Only `gezel_llama.h` is exposed; upstream llama/ggml headers are private.

The current default artifact contains iOS/iPadOS arm64 device (Metal) and arm64
simulator (CPU), minimum iOS 16.4. A build selecting an Intel simulator remains
an Intel-simulator artifact; staging does not invent additional slices. No macOS,
tvOS or visionOS support is implied. The manifest requires Swift tools 6.0;
the checked consumer build used Xcode 27, not a qualification of every older SDK.

The [isolated Swift consumer](consumers/ios/Package.swift) compiles and links the
ABI without any Gezel source dependency. Copy it to a fresh folder and set
`GEZEL_LLAMA_PACKAGE` to the staged package. For a simulator link check:

```sh
GEZEL_LLAMA_PACKAGE=/tmp/gezel-sdk-ios-0.1.0-local.1/swift/GezelLlama \
  xcrun swift build --package-path /path/to/copied/ios \
  --triple arm64-apple-ios16.4-simulator \
  --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)"
```

This is an executable link fixture, not a signed iOS app or an inference test.

## Android consumption

The folder repository carries
`com.bendyline.gezel:gezel-llama:0.1.0-local.1` as an AAR with its POM and SHA-256
sidecars. Configure the consumer's repositories and dependencies:

```groovy
repositories {
    maven {
        url = uri('/tmp/gezel-sdk-android-0.1.0-local.1/maven')
        content { includeGroup 'com.bendyline.gezel' }
    }
}
dependencies {
    implementation 'com.bendyline.gezel:gezel-llama:0.1.0-local.1'
}
```

Import `com.bendyline.gezel.llama.LlamaRuntime`. The AAR includes `classes.jar`,
consumer R8 rules, the JNI library, llama/ggml libraries and `libc++_shared.so` for
every ABI listed in the build manifest. The current default is arm64-v8a/API 28.
JNI and all transitive ELF libraries are checked for 16 KB LOAD alignment and
missing dependencies during staging. Final APK/AAB alignment remains a consumer
release check. If another native dependency supplies `libc++_shared.so`, establish
a compatible runtime version; do not hide the conflict with arbitrary `pickFirst`.

The [isolated Android consumer](consumers/android/build.gradle) has no NDK,
CMake, `externalNativeBuild`, `jniLibs` copy step, or Gezel source paths. Copy the
consumer folder outside this checkout, then run with Gradle 8.14.3/JDK 21 and the
Android SDK installed:

```sh
gradle -p /path/to/copied/android --offline \
  -PgezelMavenRepository=/tmp/gezel-sdk-android-0.1.0-local.1/maven \
  -PgezelVersion=0.1.0-local.1 assembleRelease
```

`--offline` assumes the normal Android Gradle dependencies are already cached.
The fixture enables R8 in release. On launch, it creates/destroys the native
engine; if its private files directory contains the deterministic `fixture.gguf`
from the native contract harness, it also checks a short generation and the JNI
callback. These device checks are separate from building the APK.

## Ownership and remaining integration

Call native load/generate on a background serial executor. Own the engine's
lifetime, wait for generation and cancellation to finish before destroy, and
keep model files immutable and app-private. The C ABI's allocation and operation
bounds still apply. These low-level packages do not provide the app-wide
admission, foreground lifecycle and model download manager required by the
finished SDK; consumers should use the forthcoming extracted host wrapper for
those policies. No shared installed Gezel app or shared mobile model directory
is assumed.

The TypeScript bridge now has a narrow browser-safe entry,
`@bendyline/gezel/mobile-inference`. `createNativeInference(plugin)` adapts an
injected native plugin to the existing `PortableInference` port without importing
Capacitor, UI, product storage, or speech. Gezel mobile uses this same adapter.
Calls sharing one plugin object share admission and a cancellation release
barrier; the native process must still enforce admission across all callers.
The existing runtime export of `PortableInference` remains compatible.

Remaining work before Qualla/DocBlocks can consume a simple mobile App SDK:

1. Extract provider/model/lifecycle ownership into native host libraries and a
   thin Capacitor package, with Gezel itself consuming those packages.
2. Adapt that runtime to the existing `GezelApp` browser transport; expose
   readiness/capabilities and preserve native stop reasons and unknown usage.
3. Stage consumable npm tarballs and run the same supported SDK contract fixtures
   on desktop and mobile.
4. Integrate the first Qualla and DocBlocks features, then qualify physical
   devices and publish coordinated previews.
