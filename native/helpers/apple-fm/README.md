# gezel-apple-fm

Serves Apple's on-device model (Apple Intelligence, the `FoundationModels`
framework) to the gezel daemon on Apple silicon Macs. The daemon's
`apple-foundation-models` provider
([packages/service/src/providers/apple-foundation-models/](../../../packages/service/src/providers/apple-foundation-models/))
spawns one long-lived helper and multiplexes every session through it. Apple
runs the model in its own system service, so the helper holds no weights and
no model memory.

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
| `{"type":"hello"}` | `{"type":"hello","available","reason?","contextTokens","maxOutputTokens","version","os"}` |
| `{"type":"generate","id","messages","tools","maxTokens","contextSize"}` | `{"type":"delta","id","text"}`, then `done` (`stopReason`) or `error` (`code`, `message`) |
| — | `{"type":"tool_call","id","callId","name","arguments"}` (Apple's own tool loop, mid-generation) |
| `{"type":"tool_result","id","callId","output","endTurn?"}` or `{…,"error"}` | — |
| `{"type":"cancel","id"}` | `{"type":"done","id","stopReason":"cancelled"}` |
| `{"type":"count","id","messages","tools"}` | `{"type":"count","id","tokens"}` (macOS 26.4+) |

`endTurn` stops generation after that result (a handoff, a question, a
terminal tool). Closing stdin cancels everything and exits, so a daemon that
dies cannot leave the helper generating.

## Building

```sh
native/helpers/apple-fm/build.sh
```

Needs Xcode 27 (the macOS 27 SDK: the shared adapter reads OS 27 token usage
behind a runtime check). The binary targets the shared macOS 13.3 floor with
`FoundationModels` weak-linked; on macOS 25 and earlier it answers every
request as unavailable. `--help` and `--self-test` work without the model, so
build machines without Apple Intelligence can verify it. The build writes
`native/build/darwin-arm64/gezel-apple-fm`; the Electron supervisor finds it
there in development, and headless daemons read `GEZEL_APPLE_FM_BIN`.

## Shipping

Not yet part of a native release. To ship it: add an `apple-fm` helper row
for `darwin-arm64` to `.github/workflows/build-native.yml` (runner `xcode-27`,
`script: build.sh`, `artifact: gezel-apple-fm`), add `gezel-apple-fm` to
`NATIVE_PAYLOAD['darwin-arm64']` and `ENGINE_FOR_BINARY` (`null`) in
`scripts/native-payload.mjs`, then cut and pin a native release. All three go
together: the payload test holds the matrix and payload in step, and the
Electron and Mac App Store releases check the fetched payload. The App Store
lane runs helpers sandboxed; confirm Foundation Models works there first.
