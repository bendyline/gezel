#!/usr/bin/env bash
# build.sh — Linux + macOS build of sd-server from the pinned
# stable-diffusion.cpp upstream.
#
# Emits: native/build/<platform>/gezel-sd-server
#
# Detects the platform and enables the appropriate accelerator:
#   - darwin-arm64: Metal (-DSD_METAL=ON)
#   - darwin-x64:   CPU (Apple x86_64 can't target Metal)
#   - linux-x64:    Vulkan if the SDK is present, otherwise CPU
#
# Override the accelerator with SD_BACKEND={metal,vulkan,cuda,cpu}.
# Useful when testing a specific backend or when the autodetection
# picks the wrong one on an unusual host.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Ensure upstream is cloned + pinned ──────────────────────────
"$repo_root/native/scripts/fetch-upstream.sh" sd-cpp
src="$here/.upstream"

# ── 2. Resolve target platform ─────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64) platform="darwin-arm64" ;;
      x86_64) platform="darwin-x64" ;;
      *) echo "unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64) platform="linux-x64" ;;
      aarch64) platform="linux-arm64" ;;
      *) echo "unsupported Linux arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "unsupported OS: $os (use build.ps1 for Windows)" >&2
    exit 1
    ;;
esac

# ── 3. Resolve accelerator ─────────────────────────────────────────
backend="${SD_BACKEND:-auto}"
if [[ "$backend" == "auto" ]]; then
  case "$platform" in
    darwin-arm64) backend="metal" ;;
    darwin-x64)   backend="cpu" ;;
    linux-x64|linux-arm64)
      # Same detection order as llama-cpp's build.sh: prefer CUDA when
      # the toolkit is present (Jetson / DGX-class hosts), then Vulkan,
      # then CPU. CI runners have neither nvcc nor vulkaninfo, so the
      # shipped default binary stays CPU — only local rebuilds on
      # CUDA-capable hosts pick up the fast path.
      if command -v nvcc >/dev/null 2>&1; then
        backend="cuda"
      elif command -v vulkaninfo >/dev/null 2>&1; then
        backend="vulkan"
      else
        backend="cpu"
      fi
      ;;
  esac
fi

cmake_flags=(
  -DCMAKE_BUILD_TYPE=Release
  # Upstream's examples/server/CMakeLists.txt auto-builds the
  # sdcpp-webui React frontend via `pnpm install && pnpm run
  # build` whenever `pnpm` is on PATH. CI's ubuntu-latest runner
  # doesn't have pnpm so it silently skips this; a dev host with
  # corepack-enabled pnpm tries to build and dies with `vite: not
  # found` because gezel's own pnpm-workspace.yaml further up the
  # tree makes pnpm treat the frontend's package.json as an
  # unmanaged dir. Gezel's UI talks to sd-server via its HTTP API
  # and doesn't load the built-in web UI, so disable the frontend
  # bundle outright — keeps the build deterministic across hosts
  # and matches the no-frontend binaries we already ship from CI.
  -DSD_SERVER_BUILD_FRONTEND=OFF
)
# NOTE: upstream removed the `SD_BUILD_SERVER` option (commit
# .../examples/CMakeLists.txt now unconditionally
# `add_subdirectory(server)`); passing it produces a "manually-
# specified variables were not used" CMake warning. Don't restore it.
case "$backend" in
  metal)  cmake_flags+=(-DSD_METAL=ON) ;;
  vulkan) cmake_flags+=(-DSD_VULKAN=ON) ;;
  cuda)   cmake_flags+=(-DSD_CUDA=ON) ;;
  cpu)    : ;;
  *) echo "unknown SD_BACKEND=$backend (valid: metal, vulkan, cuda, cpu)" >&2; exit 1 ;;
esac
echo "[build] platform=$platform backend=$backend"

# ── 4. Configure + build ───────────────────────────────────────────
build_dir="$src/build-$platform-$backend"
cmake -S "$src" -B "$build_dir" "${cmake_flags[@]}"
cmake --build "$build_dir" --config Release --target sd-server -j

# ── 5. Locate + strip the produced binary ──────────────────────────
found=""
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "$build_dir" -type f \( -name sd-server -o -name 'sd-server.exe' \) -perm -u+x -print0 2>/dev/null || true)

if [[ -z "$found" ]]; then
  echo "error: sd-server binary not produced under $build_dir" >&2
  echo "       inspect the CMake output above to see what target name upstream is using." >&2
  exit 1
fi
echo "[build] produced: $found"

# Strip debug symbols (smaller installer, same functionality). On macOS
# we strip after codesign at app-build time, so only strip on Linux
# here.
if [[ "$os" == "Linux" ]]; then
  strip -s "$found" 2>/dev/null || true
fi

# ── 6. Copy into the canonical output tree ─────────────────────────
out_dir="$repo_root/native/build/$platform"
mkdir -p "$out_dir"
# Ship under a gezel- prefix (gezel-sd-server) for process attribution while
# preserving the stable-diffusion.cpp lineage. Only the installed file is
# prefixed — the cmake `--target`/`find` above keep the upstream name.
server_name="gezel-sd-server"
cp "$found" "$out_dir/$server_name"
chmod +x "$out_dir/$server_name"
echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
