# uv

Upstream: https://github.com/astral-sh/uv — Apache 2.0 / MIT dual-licensed.

`uv` is Astral's Rust-based Python package manager. Gezel bundles it as
a **general-purpose Python bootstrap** that any feature needing a
Python venv can lean on (MLX inference is the first consumer; future
Whisper / STT / Python-based MCP servers will reuse the same binary).

Unlike llama-cpp and sd-cpp, this directory does not compile from
source. The build scripts **download** the appropriate precompiled
binary from astral-sh/uv's GitHub Releases, verify it against a
pinned sha256, and drop it in the canonical native-build tree.

## Produced binary

`uv` (or `uv.exe` on Windows) — Astral's single static binary. Speaks:

- `uv venv <path> --python 3.11` — create an isolated Python
  environment, downloading the requested interpreter if the host
  doesn't have it.
- `uv pip install --python <path>/bin/python <specs>` — install
  packages into a pre-created venv (no activation needed).
- `uv python install <version>` — stash a managed Python under
  uv's cache for later use.

## Platform matrix

| Platform       | Release asset                              | Variant |
| -------------- | ------------------------------------------ | ------- |
| `darwin-arm64` | `uv-aarch64-apple-darwin.tar.gz`           | — (single variant) |
| `darwin-x64`   | `uv-x86_64-apple-darwin.tar.gz`            | — |
| `linux-x64`    | `uv-x86_64-unknown-linux-gnu.tar.gz`       | — |
| `linux-arm64`  | `uv-aarch64-unknown-linux-gnu.tar.gz`      | — |
| `win32-x64`    | `uv-x86_64-pc-windows-msvc.zip`            | — |

No GPU variants — uv is pure userspace. One binary per platform.

## Build locally

```sh
# macOS / Linux
./build.sh

# Windows (PowerShell)
pwsh -File .\build.ps1

# Both honor UV_ARCHIVE_OVERRIDE=<abspath> to skip the download when
# testing against a pre-fetched tarball (airgapped CI, etc.). The
# sha256 check is skipped on overrides — trust the caller.
```

Output lands at `native/build/<platform>/uv[.exe]`.

## VERSION format

Differs from the llama-cpp / sd-cpp format because we don't clone
upstream. See [VERSION](./VERSION) for the shape — a `tag=`, a
`commit=` (satisfies the shared CI preflight's "unpinned → skip"
check), and per-platform `sha256_*` digests.

## How the service finds it

The Electron supervisor resolves the bundled binary via
[`resolveNativeBinaryPath('uv', ...)`](../../../packages/app/src/supervisor/native-bin.ts)
and exports `GEZEL_UV_BIN=<abs path>` before starting the service —
same pattern as `GEZEL_LLAMA_SERVER_BIN` and `GEZEL_SD_SERVER_BIN`.

The service's [`UvRuntime`](../../../packages/service/src/python/uv-runtime.ts)
prefers `GEZEL_UV_BIN` over system `uv` and `python3`. This keeps packaged
Gezel self-contained and avoids invoking macOS's developer-tools `python3`
shim; system runtimes remain fallbacks for source/dev launches.

## Why uv rather than embedded Python

Shipping a Python runtime ourselves (python-build-standalone) would
solve the "does the user have Python" problem but not the "which
packages do they have" problem — we'd still need to manage venvs. uv
does both in one ~15 MB binary and is what Apple's own `mlx-lm`
documentation increasingly points users toward.

## License

uv: Apache 2.0 / MIT dual-licensed (inherited from upstream).
