# gezel-apple-fm

Serves Apple's on-device model (Apple Intelligence, the `FoundationModels`
framework) to the gezel daemon on Apple silicon Macs. The daemon's
`apple-foundation-models` provider
([packages/service/src/providers/apple-foundation-models/](../../../packages/service/src/providers/apple-foundation-models/))
spawns one long-lived helper and multiplexes every session through it. Apple
runs the model in its own system service, so the helper bundles no weights.
Apple still consumes system memory and compute. This helper belongs to the
per-user daemon, not Gezel's machine-wide engine broker.

The model code is shared with the iOS app:
[AppleFoundationProvider.swift](../../runtime/ios/Sources/GezelRuntime/AppleFoundationProvider.swift)
builds the transcript and budgets the prompt, and
[AppleNativeTools.swift](../../runtime/ios/Sources/GezelRuntime/AppleNativeTools.swift)
turns core's ordered tool schemas (`packages/core/src/tools/native-tools.ts`)
into Foundation Models tools. Both hosts therefore see the same prompts, tool
definitions and error codes.

## Protocol

JSON lines on stdin/stdout. The daemon owns conversations, prompts and tool
execution; the helper turns one request into one generation.

| Daemon → helper | Helper → daemon |
| --- | --- |
| `{"type":"hello"}` | `{"type":"hello","available","reason?","contextTokens","maxOutputTokens","version","os","modelCapabilities?","supportsTokenUsage?"}` |
| `{"type":"generate","id","messages","tools","maxTokens","contextSize"}` | `{"type":"delta","id","text"}`, then `done` (`stopReason`) or `error` (`code`, `message`) |
| — | `{"type":"usage","id","inputTokens","outputTokens"}` (protocol 2, OS 27 stream usage) |
| — | `{"type":"tool_call","id","callId","name","arguments"}` (Apple's own tool loop, mid-generation) |
| `{"type":"tool_result","id","callId","output","endTurn?"}` or `{…,"error"}` | — |
| `{"type":"cancel","id"}` | `{"type":"done","id","stopReason":"cancelled"}` |
| `{"type":"count","id","messages","tools"}` | `{"type":"count","id","tokens"}` (macOS 26.4+) |

`endTurn` stops generation after that result (a handoff, a question, a
terminal tool). Closing stdin cancels everything and exits, so a daemon that
dies cannot leave the helper generating.

Readiness is refreshed on each request; concurrent checks coalesce. The client
bounds readiness and token counting to 15 seconds of awake time, and stops an
unresponsive helper five seconds after cancellation. A generation is reserved
before launching its Swift task, preventing cancellation/registration races.
Usage is optional for compatibility with OS 26 and earlier helper versions;
the provider falls back to its token estimate when the SDK returns none (for
example a terminal tool). Model capability flags describe Apple's model, not
features exposed by the current text/tool adapter.

## Building

```sh
native/helpers/apple-fm/build.sh
bash native/helpers/apple-fm/check-mobile.sh
```

Needs Xcode 27 (the macOS 27 SDK: the shared adapter reads OS 27 token usage
behind a runtime check). The binary targets the shared macOS 13.3 floor with
`FoundationModels` weak-linked; on macOS 25 and earlier it answers every
request as unavailable. `--help` and `--self-test` work without the model, so
build machines without Apple Intelligence can verify it. The build writes
`native/build/darwin-arm64/gezel-apple-fm`; the Electron supervisor finds it
there in development. Headless daemons read `GEZEL_APPLE_FM_BIN`, or resolve the
helper under `GEZEL_NATIVE_BIN_DIR/darwin-arm64/`. The second command typechecks
the exact shared sources against physical-device and simulator iOS SDKs.

## Live parity smoke check

After building, run from the repository root with workspace dependencies installed:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node native/helpers/apple-fm/smoke.ts
```

This uses the desktop TypeScript transport and the same Swift model/tool code
as iOS. It checks actual availability, token counting with tool definitions,
streaming, conversation replay, a synthetic tool round trip, terminal tools,
context rejection, cancellation followed by another request, and a real
desktop provider session with usage reporting. It prints
JSON-line results and exits nonzero on failure. Deadlines use awake time.
`GEZEL_APPLE_FM_BIN` optionally selects another helper binary.

It requires Apple Intelligence to be ready and macOS 26.4+ for token counting.
Run it in the logged-in user's session. Its test tool returns a fixed parcel
pickup code; it does not access projects, change settings, or run MCP tools.
These are live integration checks, not a quality or throughput benchmark, and
they do not establish signed-app, App Store sandbox, or physical iOS parity.

See [service boundaries](../../../docs/service-boundaries.md) for provider
ownership and the limits of service-account and logged-out access.

## Shipping

The `apple-fm` helper is in `.github/workflows/build-native.yml` on `xcode-27`,
and `gezel-apple-fm` is required by the `darwin-arm64` native payload contract.
The lane compiles both Apple hosts and runs model-independent self-tests,
including after Developer ID signing. Tagged builds also notarize the payload.
CI needs the SDK, not an enabled Apple Intelligence model.

After pushing the source changes, an artifact-only test build can be started:

```sh
gh workflow run build-native.yml --ref <pushed-ref> -f engines=apple-fm -f mobile=none
```

A normal `build-native.yml` run also builds both mobile SDKs. Select mobile
platforms on an artifact-only run with `-f mobile=all|ios|android|none`; native
release tags always build both. `mobile-native.yml` is the reusable implementation
and remains a standalone PR/manual check (`-f platform=ios|android|all`).

Native releases include `gezel-mobile-<version>-ios.tar.gz` (Swift runtime,
shared Apple adapter, static llama XCFramework and privacy resources) and
`gezel-mobile-<version>-android.tar.gz` (folder Maven repository with llama.cpp
and `android-mlkit`, Gemini Nano through ML Kit/AICore). The ML Kit adapter is
compiled into the Android runtime, not a standalone helper binary. SDKs are
unsigned reusable libraries; final apps use their own developer's signing.

Unsigned APK/AAB and iOS app archives remain separate CI artifacts on non-tagged
runs and are excluded from native releases. See the
[public SDK distribution review](../../runtime/PUBLIC-DISTRIBUTION.md) for
licenses, signatures, privacy manifests and provider terms.

The published native release pin is unchanged until a complete new release
exists. Cut, validate and publish that release, then run
`node scripts/pin-native-release.mjs <version> --macos-notarized` to pin its
real archives and file manifest. An `apple-fm`-only test artifact is not a
complete native release. The existing pin lacks the helper, so production Mac
packaging will require the new release before its payload gate passes. Verify
model access from the signed packaged app and the Mac App Store sandbox before
claiming those deployment modes work.
