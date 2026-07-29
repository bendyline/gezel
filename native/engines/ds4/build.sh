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
src="$here/.upstream"
cuda_float_patch="$here/patches/cuda-float-max.patch"
truncation_finish_patch="$here/patches/repaired-truncation-finish-length.patch"
prefill_cancel_patch="$here/patches/prefill-client-cancel.patch"

# ── 1. Ensure upstream is cloned + pinned ──────────────────────────
# Recover from an interrupted earlier build that applied our exact patches but
# did not reach the EXIT cleanup below. Do this before fetch-upstream so a
# later pin bump cannot be blocked by those ignored checkout modifications.
if [[ -d "$src/.git" ]] &&
   ! git -C "$src" diff --quiet -- ds4_cuda.cu &&
   git -C "$src" apply --reverse --check "$cuda_float_patch"; then
  git -C "$src" apply --reverse "$cuda_float_patch"
  echo "[build] removed stale ds4 CUDA FLT_MAX compatibility patch"
fi
if [[ -d "$src/.git" ]] &&
   ! git -C "$src" diff --quiet -- ds4_server.c &&
   git -C "$src" apply --reverse --check "$truncation_finish_patch"; then
  git -C "$src" apply --reverse "$truncation_finish_patch"
  echo "[build] removed stale ds4 repaired-truncation finish_reason patch"
fi
if [[ -d "$src/.git" ]] &&
   ! git -C "$src" diff --quiet -- ds4_server.c &&
   git -C "$src" apply --reverse --check "$prefill_cancel_patch"; then
  git -C "$src" apply --reverse "$prefill_cancel_patch"
  echo "[build] removed stale ds4 prefill client-cancel patch"
fi
"$repo_root/native/scripts/fetch-upstream.sh" ds4

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

# The pinned upstream CUDA source uses FLT_MAX without including the header
# that defines it. Apply a visible, pin-scoped patch only for the Linux build,
# then restore the ignored upstream checkout so later pin bumps stay clean.
cuda_float_patch_applied=false
truncation_finish_patch_applied=false
prefill_cancel_patch_applied=false
restore_patches() {
  status=$?
  if [[ "$prefill_cancel_patch_applied" == true ]] &&
     ! git -C "$src" apply --reverse "$prefill_cancel_patch"; then
    echo "[build] error: failed to restore ds4_server.c after prefill client-cancel patch" >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  if [[ "$cuda_float_patch_applied" == true ]] &&
     ! git -C "$src" apply --reverse "$cuda_float_patch"; then
    echo "[build] error: failed to restore ds4_cuda.cu after compatibility patch" >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  if [[ "$truncation_finish_patch_applied" == true ]] &&
     ! git -C "$src" apply --reverse "$truncation_finish_patch"; then
    echo "[build] error: failed to restore ds4_server.c after finish_reason patch" >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  trap - EXIT
  exit "$status"
}
trap restore_patches EXIT
if [[ "$platform" == linux-* ]] &&
   ! grep -Eq '^#include <(float\.h|cfloat)>' "$src/ds4_cuda.cu"; then
  git -C "$src" apply "$cuda_float_patch"
  cuda_float_patch_applied=true
  echo "[build] applied ds4 CUDA FLT_MAX compatibility patch"
fi
# Upstream promotes a tool call salvaged from a generation-cap cutoff to
# finish_reason=tool_calls, which hides the truncation from clients. Gezel's
# provider keys its truncated-write recovery off finish_reason=length, so
# patch the promotion to preserve "length" for repaired truncated calls
# (all platforms). Pin-scoped: a bump that touches these lines fails the
# apply loudly instead of silently dropping the fix.
git -C "$src" apply "$truncation_finish_patch"
truncation_finish_patch_applied=true
echo "[build] applied ds4 repaired-truncation finish_reason patch"

# Upstream never arms ds4_session_set_cancel during prefill, so a turn whose
# client already disconnected kept prefilling the whole prompt (~150s on a large
# SSD-streamed context) before the closed socket was noticed, blocking the next
# turn behind a zombie. Wire the socket half-close into the cooperative-cancel
# hook so prefill unwinds at the next chunk boundary (all platforms).
git -C "$src" apply "$prefill_cancel_patch"
prefill_cancel_patch_applied=true
echo "[build] applied ds4 prefill client-cancel patch"

# ── 3. Build (make-based; one GPU backend per platform) ────────────
make_args=(ds4-server)
source_map_flags="-ffile-prefix-map=$src=ds4 -fmacro-prefix-map=$src=ds4 -fdebug-prefix-map=$src=ds4"
make_cc="${CC:-cc} $source_map_flags"
case "$platform" in
  darwin-arm64)
    backend="metal"
    macos_deployment_target="${MACOSX_DEPLOYMENT_TARGET:-13.3}"
    make_cc+=" -mmacosx-version-min=$macos_deployment_target"
    ;;
  linux-x64|linux-arm64)
    backend="cuda"
    cuda_arch="${DS4_CUDA_ARCH:-native}"
    if [[ "$cuda_arch" == "spark" ]]; then
      make_args+=("CUDA_ARCH=")          # antirez cuda-spark style (empty -arch)
    else
      make_args+=("CUDA_ARCH=$cuda_arch")
    fi
    # Upstream defaults CUDA release builds to `-g -lineinfo`, which embeds
    # hosted-runner source paths and ships debug metadata we do not consume.
    # Keep the release optimization/architecture flags while passing prefix
    # maps to nvcc's host compiler for __FILE__ and debug-path hygiene.
    native_cpu_flag="${NATIVE_CPU_FLAG:--march=native}"
    nvcc_flags="-O3 --use_fast_math"
    if [[ "$cuda_arch" != "spark" && -n "$cuda_arch" ]]; then
      nvcc_flags+=" -arch=$cuda_arch"
    fi
    nvcc_flags+=" -Xcompiler=$native_cpu_flag -Xcompiler=-pthread"
    nvcc_flags+=" -Xcompiler=-ffile-prefix-map=$src=ds4"
    nvcc_flags+=" -Xcompiler=-fmacro-prefix-map=$src=ds4"
    nvcc_flags+=" -Xcompiler=-fdebug-prefix-map=$src=ds4"
    make_args+=("NVCCFLAGS=$nvcc_flags")
    ;;
esac
make_args+=("CC=$make_cc")
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
# On Linux ds4 is a CUDA engine, so it emits into the `-cuda` key alongside
# llama-server's CUDA build and shares its NVIDIA redistributables — see the
# note in scripts/native-payload.mjs. macOS ds4 is Metal and stays in the bare
# platform key. Must agree with the workflow's `outdir` step, which derives the
# same path from `matrix.variant`.
if [[ "$os" == "Linux" ]]; then
  out_dir="$repo_root/native/build/$platform-cuda"
else
  out_dir="$repo_root/native/build/$platform"
fi
mkdir -p "$out_dir"
# Ship under a gezel- prefix (gezel-ds4-server) for process attribution while
# preserving the ds4 / DwarfStar lineage. Only the installed file is prefixed.
server_name="gezel-ds4-server"
cp "$found" "$out_dir/$server_name"
chmod +x "$out_dir/$server_name"

if [[ "$os" == "Linux" ]]; then
  strip -s "$out_dir/$server_name" 2>/dev/null || true
elif [[ "$os" == "Darwin" ]]; then
  # -S drops the debug map only, leaving the symbol table the loader needs.
  # Without it the binary ships ~3800 STABS entries (OSO/SO/FUN records)
  # naming object files under the CI checkout — `.upstream/ds4_server.o` and
  # friends, which exist on no user's machine. Dead weight and a needless
  # build-path leak. Safe here: CI codesigns after this script runs.
  strip -S "$out_dir/$server_name" 2>/dev/null || true
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

# ── 5b. Linux: rpath only — llama's CUDA leg owns the redistributables ──
# ds4-server dynamically links libcudart / libcublas, and $ORIGIN still finds
# them: this build emits into the `-cuda` key, where llama-server's CUDA leg
# already stages libcudart / libcublas / libcublasLt from the same toolkit.
#
# This step used to stage its own copies from $CUDA_HOME. That is what made
# the bare and -cuda keys each carry a full set — 828 MB of byte-identical
# duplication per install on x64. It also staged them from a DIFFERENT path
# than llama's leg (`$CUDA_HOME/targets/*/lib` vs llama's resolution), which
# produced two different libcudart.so.12.8.90 builds of the same version:
# 728,800 bytes here against 746,033 from llama. Now that both engines land
# in one directory, two writers would make the merge order decide which
# survives — so there is exactly one writer, and the draft-release job
# asserts the redistributables are present in every `-cuda` key.
elif [[ "$os" == "Linux" ]]; then
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "[build] installing patchelf for rpath fixup"
    sudo apt-get install -y --no-install-recommends patchelf || true
  fi
  patchelf --set-rpath '$ORIGIN' "$out_dir/$server_name" 2>/dev/null || true
  echo "[build] patchelf set rpath \$ORIGIN on $server_name"
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
