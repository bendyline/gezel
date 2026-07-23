# whisper.cpp

Upstream: https://github.com/ggml-org/whisper.cpp — MIT licensed. Sister
project to llama.cpp under the same `ggml-org` umbrella; same author
(Georgi Gerganov), same build system, same GGML weight format.

This directory **does not vendor upstream source**. The build scripts
clone it at the pinned commit (see `VERSION`) into `.upstream/`
(gitignored) and build with CMake.

Status: **integrated**. The native release matrix produces one CPU-oriented
build per platform and the service exposes it through the audio provider.
GPU/Vulkan variants and `whisper-stream` are not currently shipped.

## Produced binary

`whisper-server` — the HTTP server upstream ships under
`examples/server/`. It speaks:

- `POST /inference` — multipart form upload; takes `file=@audio.wav`,
  `temperature`, `response_format`, `language`, `prompt`. Returns JSON
  with `text` plus optional `segments`.
- `GET /health` — what the supervisor polls.

See `packages/service/src/providers/audio/whisper-cpp.ts` for the
client side.

## Platform backends

For the MVP we ship a single CPU build per platform. whisper.cpp
real-time-factor on `base.en` is well below 1× on any modern laptop
CPU, so accelerator coverage isn't the gating concern it was for
llama.cpp.

| Platform       | Variant shipped               |
| -------------- | ----------------------------- |
| `darwin-arm64` | metal (built into the OS SDK; CPU build implicitly uses Accelerate too) |
| `darwin-x64`   | cpu                           |
| `linux-x64`    | cpu                           |
| `linux-arm64`  | cpu                           |
| `win32-x64`    | cpu                           |

Adding CUDA / Vulkan / cuBLAS variants follows the same shape as
llama-cpp's matrix and is expected when audio chat lands (lower
latency on weak hardware is the value).

## Build locally

```sh
# macOS or Linux
./build.sh

# Windows (PowerShell)
pwsh -File .\build.ps1
```

Output lands at `native/build/<platform>/gezel-whisper-server[.exe]`.

### Prerequisites

- `git`, `cmake` ≥ 3.24, a C/C++ toolchain (Xcode CLI / gcc / MSVC Build Tools).
- **macOS**: nothing extra — Apple's Accelerate framework + Metal are
  part of the OS SDK.

### What the script does

1. Ensures `.upstream/` exists and is pinned to `VERSION`'s `commit`.
2. Resolves the platform.
3. Runs `cmake` with `-DWHISPER_BUILD_SERVER=ON
   -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON` (the server
   target lives under `examples/server/` so the examples flag is
   load-bearing for now — if upstream promotes the server to a
   first-class target, drop the flag).
4. Builds the `whisper-server` target.
5. Copies to `native/build/<platform>/gezel-whisper-server[.exe]`.

## Models

GGML quantized model files are pulled at runtime by
`WhisperCppProvider.pullModel()` from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`
into `~/.gezel/engines/whisper-cpp/models/<id>/`. Default catalog
covers `tiny.en` (~75MB), `base.en` (~140MB), `small.en` (~466MB).

## Verifying a build

```sh
./native/build/<platform>/gezel-whisper-server --help
```

Expected: the upstream help text listing the server's flags.

To smoke-test end-to-end against a model:

```sh
./native/build/<platform>/gezel-whisper-server \
  --model ~/.gezel/engines/whisper-cpp/models/base.en/ggml-base.en.bin \
  --host 127.0.0.1 --port 8090

# in another terminal
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8090/inference \
  -F file=@samples/jfk.wav \
  -F response_format=json
```

## License

MIT (inherits from upstream). When bundling GGML weights, respect the
model's own license terms separately — the OpenAI Whisper weights are
MIT-licensed and the GGML conversions on Hugging Face inherit that
license.
