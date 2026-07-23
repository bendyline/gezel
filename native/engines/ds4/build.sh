#!/usr/bin/env bash
# build.sh — Linux + macOS build of ds4-server (DwarfStar / DeepSeek-V4)
# from the pinned antirez/ds4 upstream.
#
# Emits: native/build/<platform>/gezel-ds4-server
#
# ds4 is GPU-only (its CPU path is diagnostics-only and crashes the macOS
# kernel), so — unlike llama-server — there is exactly ONE shippable
# backend per platform and no `-<backend>` output suffix:
#   - darwin-arm64: Metal      (`make ds4-server`)
#   - linux-x64:    CUDA        (`make ds4-server CUDA_ARCH=<arch>`)
#   - linux-arm64:  CUDA / DGX Spark (`make ds4-server CUDA_ARCH=`)
#   - darwin-x64 / win32: UNSUPPORTED (no artifact produced)
#
# CUDA arch: local dev defaults to `native` (nvcc detects the present GPU).
# CI cross-builds (no GPU) MUST set DS4_CUDA_ARCH to an explicit value, e.g.
#   DS4_CUDA_ARCH=sm_90        (H100-class)
#   DS4_CUDA_ARCH=sm_121       (GB10 / DGX Spark)
# For the Spark, antirez's own `make cuda-spark` uses an empty CUDA_ARCH;
# pass DS4_CUDA_ARCH=spark here to reproduce that (empty -arch).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Ensure upstream is cloned + pinned ──────────────────────────
"$repo_root/native/scripts/fetch-upstream.sh" ds4
src="$here/.upstream"

# ── 2. Resolve target platform ─────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64) platform="darwin-arm64" ;;
      x86_64)
        echo "[build] ds4 is not supported on Intel macOS (no unified-memory Metal target;" >&2
        echo "[build] the CPU path crashes the macOS kernel). No artifact produced." >&2
        exit 0
        ;;
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
    echo "[build] ds4 is not supported on $os (no Windows/MSVC build upstream)." >&2
    echo "[build] Windows users with capable NVIDIA hardware can run the linux-x64" >&2
    echo "[build] build inside WSL2. No artifact produced." >&2
    exit 0
    ;;
esac

# ── 3. Build (make-based; one GPU backend per platform) ────────────
make_args=(ds4-server)
case "$platform" in
  darwin-arm64)
    backend="metal"
    # default target = Metal on Darwin; no extra flags
    ;;
  linux-x64|linux-arm64)
    backend="cuda"
    cuda_arch="${DS4_CUDA_ARCH:-native}"
    if [[ "$cuda_arch" == "spark" ]]; then
      make_args+=("CUDA_ARCH=")          # antirez cuda-spark style (empty -arch)
    else
      make_args+=("CUDA_ARCH=$cuda_arch")
    fi
    ;;
esac
echo "[build] platform=$platform backend=$backend  make ${make_args[*]}"

jobs_flag="-j"
if [[ "$os" == "Linux" ]]; then
  jobs_flag="-j${DS4_BUILD_JOBS:-2}"     # match llama-cpp's CI RAM caution
elif [[ -n "${DS4_BUILD_JOBS:-}" ]]; then
  jobs_flag="-j${DS4_BUILD_JOBS}"
fi
# CUDA_ARCH / backend flags are not part of make's dependency graph upstream.
# Without `-B`, rerunning this wrapper for a different GPU can print
# "ds4-server is up to date" and silently reuse objects compiled for the
# previous architecture. Native CI starts from a clean checkout, but local
# builds and iterative release debugging do not. Force the small ds4 target
# graph to rebuild so the requested backend/architecture is authoritative.
make -C "$src" $jobs_flag -B "${make_args[@]}"

found="$src/ds4-server"
if [[ ! -x "$found" ]]; then
  echo "error: ds4-server binary not produced at $found" >&2
  exit 1
fi
echo "[build] produced: $found"

# ── 4. Stage into the canonical output tree ────────────────────────
out_dir="$repo_root/native/build/$platform"
mkdir -p "$out_dir"
# Ship under a gezel- prefix (gezel-ds4-server) for process attribution while
# preserving the ds4 / DwarfStar lineage. Only the installed file is prefixed.
server_name="gezel-ds4-server"
cp "$found" "$out_dir/$server_name"
chmod +x "$out_dir/$server_name"

if [[ "$os" == "Linux" ]]; then
  strip -s "$out_dir/$server_name" 2>/dev/null || true
fi

# ── 5. macOS: stage Metal shader sources (NOT self-contained) ──────
# ds4-server links only system frameworks, BUT it is not self-contained: it
# compiles its Metal shaders from `./metal/*.metal` (19 source files) at
# runtime, resolved relative to the WORKING DIRECTORY. Without them it aborts
# with "metal backend unavailable; aborting startup". So the bundle must carry
# the `metal/` dir next to the binary, and the supervisor launches ds4-server
# with cwd = this dir (see buildDs4Provider). No dylib / @rpath fixup is needed
# (only system frameworks are linked).
if [[ "$os" == "Darwin" ]]; then
  if [[ ! -d "$src/metal" ]]; then
    echo "[build] error: $src/metal not found — ds4 Metal shader sources missing" >&2
    exit 1
  fi
  rm -rf "$out_dir/metal"
  cp -R "$src/metal" "$out_dir/metal"
  echo "[build] staged $(ls "$out_dir/metal"/*.metal 2>/dev/null | wc -l | tr -d ' ') Metal shader sources → $out_dir/metal/"
  echo "[build] darwin linkage (only system frameworks; shaders load from ./metal at runtime):"
  otool -L "$out_dir/$server_name" | sed 's/^/[build]   /'

# ── 5b. Linux: bundle the CUDA runtime so the tarball is portable ──
# ds4-server dynamically links libcudart / libcublas from $CUDA_HOME.
# Bundle them next to the binary with an $ORIGIN rpath so a user box
# without a matching CUDA toolkit install can still run it (the NVIDIA
# *driver* is still required, but the runtime libs travel with us).
elif [[ "$os" == "Linux" ]]; then
  cuda_home="${CUDA_HOME:-/usr/local/cuda}"
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "[build] installing patchelf for rpath fixup"
    sudo apt-get install -y --no-install-recommends patchelf || true
  fi
  for libglob in libcudart libcublas libcublasLt; do
    for cand in "$cuda_home"/targets/*/lib "$cuda_home/lib64" "$cuda_home/lib"; do
      for so in "$cand/$libglob".so.*; do
        [[ -e "$so" ]] || continue
        cp -P "$so" "$out_dir/" && echo "[build] bundled $(basename "$so") (from $cand)"
      done
    done
  done
  patchelf --set-rpath '$ORIGIN' "$out_dir/$server_name" 2>/dev/null || true
  echo "[build] patchelf set rpath \$ORIGIN on $server_name"
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
