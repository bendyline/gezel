# Mobile llama.cpp libraries

This is the first native feasibility slice of the [mobile plan](../../docs/mobile-plan.md).
It builds the C API from Gezel's existing [`VERSION`](../engines/llama-cpp/VERSION)
pin as an iOS XCFramework or Android shared libraries. It also exposes the
versioned [`gezel_llama.h`](gezel_llama.h) C ABI for bounded text conversations.
Native Swift/JNI plugins can call it without depending on llama.cpp's changing
struct layouts. It does not build a server or promise server/tool-call parity.

For local Swift-package and Maven/AAR consumption of these prebuilt libraries,
see [Local mobile runtime packages](SDK.md). The SDK packager builds only the
small Android JNI binding; downstream apps do not rebuild llama.cpp.

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

# Host CPU contract tests with a generated tiny GGUF; no model download needed
python3 native/mobile/build-llama.py host

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
`libggml-base.so`, `libggml-cpu.so`, `libgezel-llama.so`, and the matching NDK's `libc++_shared.so`;
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
The `host` target separately runs the real llama.cpp inference path against a
generated, untrained one-layer model that always emits `a`. It checks role-aware
prompt formatting, token/context/byte bounds, fresh-transcript reuse, invalid
UTF-8, unsupported templates, missing/split/oversized models, reload, overlapping
operations, callback cancellation, cross-thread cancellation, stale cancellation,
and deadlines. UTF-8 tests split multibyte characters across individual bytes and
check malformed/truncated input. These are runtime contract tests, not model
quality or real-device performance tests.

The host test executable can also retain the same deterministic model for an
app-host simulator smoke test. The fixture is a test output, never a shipped
model. After a default `host` build, run:

```sh
native/mobile/.build/host/build/gezel-llama-tests \
  --write-fixture /tmp/gezel-mobile-fixture.gguf
```

Use the corresponding executable path if the host build used `--output`.
Any short user prompt should produce only `a` characters with greedy sampling;
the smoke tests explicitly request a 256-token output budget and expect 256
characters and a length stop. The ordinary app default is 1,024 output tokens,
with per-model settings and a maximum of 4,096.

```sh
python3 -m unittest discover -s native/mobile -p 'test_*.py'
```

The initial build excludes `llama-common`, server chat templates/tool parsing,
multimodal tools, and the desktop Muse compatibility patch (which modifies
common/server behavior). The bridge supports only the built-in templates that
`llama_chat_apply_template` recognizes. A missing or unsupported model template
fails explicitly; there is no silent fallback to another chat format. Tool-call
parity, richer template rendering, device admission, and real-device tests remain.
A successful XCFramework link is not evidence of model quality, memory
headroom, runtime Metal support, or a working mobile application.

## C ABI ownership and limits

Start with `gezel_llama_create`, obtain options using the default-options functions,
and set a unique request ID before each load or generation. IDs are in
`1..INT64_MAX`. Pass role/content messages (`system`, `user`, `assistant`) ending
with a user message. Inputs remain caller-owned for the entire synchronous call.
Each generation starts from the full transcript with cleared decoder memory.
Run loading and generation on a background serial queue; overlapping load,
generate, or unload calls return `GEZEL_LLAMA_BUSY`.

The chunk callback runs synchronously on that queue. Its bytes are borrowed until
the callback returns, contain complete UTF-8 scalars, and must be copied before
dispatching onto another queue. Malformed model-output byte sequences become
U+FFFD. Returning nonzero cancels generation. `gezel_llama_cancel(engine, id)` can
also be called from another thread and only affects the matching active request;
an older request ID cannot cancel a later operation. Cancellation before a call
starts has no effect. CPU decode has an abort callback; GPU kernels and portions
of model loading can delay cancellation/deadline observation until their next
safe point. Native timeouts use the platform's steady clock.

Every generation writes status, finish reason, and partial prompt/generated-token
and output-byte counts. Errors have a bounded message and numeric status. After
failure or cancellation, the context is cleared before it can be reused. A failed
load releases the previously loaded model once admitted; validation/BUSY errors
preserve it. Unload is idempotent. Destroy requires
exclusive lifetime ownership: first finish loading/generation and stop concurrent
cancel callers. Backend registration is process-wide and outlives engine handles;
individual model/context allocations are released on unload/destroy.

Version 1 admits 256–8,192 context tokens (also bounded by the model's trained
context), 1–512 batch tokens, 1–8 threads, up to 128 messages/256 KiB transcript,
up to 4,096 generated tokens, and up to 4 MiB output. Defaults are conservative;
the caller must reserve prompt plus requested output within the context. Model
file limits default to 4 GiB and cannot exceed 8 GiB; split GGUF models are rejected.
These are allocation/input bounds, **not a hard resident-memory budget**: model
architecture, KV cache, backend buffers, and app/UI memory still require measured
device admission. Models must be app-owned immutable files; the opened file
descriptor remains with the engine until unload. No API here provides downloads,
filesystem tools, network access, or script execution.

Build choices follow the pinned upstream's
[`build-xcframework.sh`](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/build-xcframework.sh) and
[`docs/android.md`](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/docs/android.md),
[Apple's XCFramework guide](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle),
and [Android's 16 KB page guidance](https://developer.android.com/guide/practices/page-sizes).
