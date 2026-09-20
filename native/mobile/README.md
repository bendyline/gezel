# Mobile llama.cpp libraries

This is the first native feasibility slice of the [mobile plan](../../docs/mobile-plan.md).
It builds the C API from Gezel's existing [`VERSION`](../engines/llama-cpp/VERSION)
pin as an iOS XCFramework or Android shared libraries. It does not build a server,
ship an app, or implement the Swift/JNI inference bridge yet.

## Build

Requires Python 3.9+, Git, CMake, and Make. Start with the existing upstream
checkout, or fetch it explicitly with `native/scripts/fetch-upstream.sh llama-cpp`.
The mobile driver itself never fetches, switches, or patches that checkout.
It verifies both the exact commit and complete build ancestry, then exports the
pinned Git tree into its own output directory. Local desktop patches cannot leak
into the mobile source. It disables upstream Git discovery inside the export and
passes the verified version metadata explicitly.

```sh
# macOS with full Xcode, iOS device SDK, and iOS simulator SDK installed
python3 native/mobile/build-llama.py ios --check
python3 native/mobile/build-llama.py ios

# macOS or Linux x64 with an installed Android NDK r28 or newer
python3 native/mobile/build-llama.py android --ndk /path/to/android-ndk --check
python3 native/mobile/build-llama.py android --ndk /path/to/android-ndk

# Optional emulator ABI or Intel Mac simulator
python3 native/mobile/build-llama.py android --ndk /path/to/android-ndk \
  --abi arm64-v8a x86_64 --output /tmp/gezel-android-libraries
python3 native/mobile/build-llama.py ios --simulator-arch x86_64 \
  --output /tmp/gezel-ios-intel-simulator
```

`ANDROID_NDK_HOME` (or `ANDROID_NDK`) can replace `--ndk`. The default output is
`native/mobile/.build/<target>/`; an existing output must be empty. Choose a fresh
`--output` for a clean rerun. Outputs are separate from desktop release artifacts
and are not picked up by the desktop fetch/bundle scripts. Builds use two compiler
jobs by default; `--jobs` changes this. No packages or toolchains are installed.

## Output and integration

**iOS:** `GezelLlama.xcframework`, minimum iOS 16.4, arm64 device with Metal plus
arm64 CPU simulator by default. Static llama/ggml archives are combined into each
slice. Metal kernel source is embedded in the archive, matching the pinned
upstream's `GGML_METAL_EMBED_LIBRARY` path; a separate `.metallib` resource is not
required. Headers include a `GezelLlama` Clang module map. Link C++, Accelerate,
Foundation, Metal, and MetalKit when integrating from C/C++; the module map
declares these dependencies for Swift/Clang modules. No signing identity is
required to build these libraries. The final application still needs ordinary
Apple signing/provisioning.

**Android:** `jniLibs/<abi>/` contains `libllama.so`, `libggml.so`,
`libggml-base.so`, `libggml-cpu.so`, and the matching NDK's `libc++_shared.so`;
public headers are in `include/`. The initial baseline is API 28, arm64-v8a, CPU.
The mobile app must package every library and use the same C++ runtime for its
JNI bridge. GPU backends, OpenMP, network dependencies, runtime backend loading,
and host-specific instruction selection are disabled. The NDK and every packaged
ELF library are checked for 16 KB page compatibility. APK/AAB zip alignment and
device startup remain application-level checks; these library checks do not
establish that the eventual APK supports 16 KB devices.

`manifest.json` records the upstream pin, actual toolchain versions, configuration,
payload checksums, and verification status. The upstream llama and ggml license
files accompany it. A build failure never produces a success manifest. Builds
are repeatable from a fixed source/configuration; binary-for-binary reproducibility
across different Xcode/NDK/compiler versions is not claimed.

## Verification and limits

Each iOS slice must link a small C API executable before packaging. Android builds
must link the same probe and verify each shared object's ELF LOAD alignment.
These catch missing transitive native libraries. The probes do not run inference.

```sh
python3 -m unittest discover -s native/mobile -p 'test_*.py'
```

The initial build excludes `llama-common`, server chat templates/tool parsing,
multimodal tools, and the desktop Muse compatibility patch (which modifies
common/server behavior). It is intentionally the upstream low-level C API.
Agent chat/tool parity still requires a versioned Gezel bridge, conversation
formatting, streaming UTF-8 handling, cancellation, model admission, and real-device
tests. A successful XCFramework link is not evidence of model quality, memory
headroom, runtime Metal support, or a working mobile application.

Build choices follow the pinned upstream's
[`build-xcframework.sh`](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/build-xcframework.sh) and
[`docs/android.md`](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/docs/android.md),
[Apple's XCFramework guide](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle),
and [Android's 16 KB page guidance](https://developer.android.com/guide/practices/page-sizes).
