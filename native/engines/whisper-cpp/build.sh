#!/usr/bin/env bash
# build.sh — Linux + macOS build of whisper-server from the pinned
# whisper.cpp upstream.
#
# Emits: native/build/<platform>/gezel-whisper-server
#
# Single CPU build per platform for the narration MVP. macOS picks up
# Accelerate + Metal automatically because they're part of the OS SDK;
# Linux is plain CPU. Future audio-chat work likely adds CUDA / Vulkan
# variants, mirroring llama-cpp's matrix.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Ensure upstream is cloned + pinned ──────────────────────────
"$repo_root/native/scripts/fetch-upstream.sh" whisper-cpp
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
echo "[build] platform=$platform"

# ── 3. Configure + build ───────────────────────────────────────────
# whisper-server lives under examples/server/, so WHISPER_BUILD_EXAMPLES
# is load-bearing here (unlike llama.cpp where the server is a
# first-class target). On macOS arm64, Metal is enabled by default and
# we leave it on — Accelerate too — because they're shipped with the
# OS and Make small inference noticeably faster.
cmake_flags=(
  -DCMAKE_BUILD_TYPE=Release
  # Keep the CI checkout path out of __FILE__ assert strings; see the
  # longer note in native/engines/llama-cpp/build.sh. Unix-only.
  "-DCMAKE_C_FLAGS=-ffile-prefix-map=$src=whisper.cpp"
  "-DCMAKE_CXX_FLAGS=-ffile-prefix-map=$src=whisper.cpp"
  # Drops the unbundled libgomp.so.1 / VCOMP140.DLL load-time dependency
  # ggml's default OPENMP=ON bakes into libggml-base + libggml-cpu. See
  # the longer note in native/engines/llama-cpp/build.sh.
  -DGGML_OPENMP=OFF
  -DWHISPER_BUILD_SERVER=ON
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
)

build_dir="$src/build-$platform"
cmake -S "$src" -B "$build_dir" "${cmake_flags[@]}"

# Cap parallelism on Linux for the same OOM reason as llama-cpp:
# GitHub's ubuntu runners only have 16 GB of RAM.
jobs_flag="-j"
if [[ "$os" == "Linux" ]]; then
  jobs_flag="-j${WHISPER_BUILD_JOBS:-2}"
elif [[ -n "${WHISPER_BUILD_JOBS:-}" ]]; then
  jobs_flag="-j${WHISPER_BUILD_JOBS}"
fi
echo "[build] parallelism: $jobs_flag"
cmake --build "$build_dir" --config Release --target whisper-server $jobs_flag

# ── 4. Locate the produced binary ──────────────────────────────────
found=""
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "$build_dir" -type f -name whisper-server -perm -u+x -print0 2>/dev/null || true)

if [[ -z "$found" ]]; then
  echo "error: whisper-server binary not produced under $build_dir" >&2
  echo "       inspect the CMake output above — upstream may have renamed the target." >&2
  exit 1
fi
echo "[build] produced: $found"

if [[ "$os" == "Linux" ]]; then
  strip -s "$found" 2>/dev/null || true
fi

# ── 5. Copy + bundled shared libs ──────────────────────────────────
out_dir="$repo_root/native/build/$platform"
mkdir -p "$out_dir"
# Ship under a gezel- prefix (gezel-whisper-server) for process attribution
# while preserving the whisper.cpp lineage. Only the installed file is prefixed.
server_name="gezel-whisper-server"
cp "$found" "$out_dir/$server_name"
chmod +x "$out_dir/$server_name"

# Bundle GGML / whisper shared libraries that load lazily when the
# server tries to load a model. Without these alongside the exe,
# `--help` works but transcription dies with dlopen errors.
#
# Modern whisper.cpp's cmake scatters these across the build tree
# (libwhisper.so.1 in build/src/, libggml.so.0 in build/ggml/src/,
# libggml-cpu.so in build/ggml/src/ggml-cpu/, libggml-metal.dylib in
# build/ggml/src/ggml-metal/, etc.). Globbing only the binary's
# parent (build/bin/) misses all of them — `ldd` then flags
# `libwhisper.so.1 => not found` on Linux, and on macOS bash 3.2
# `${empty_arr[@]}` under `set -u` aborts the script outright. Use
# `find` over the whole build dir so cmake layout shifts (which keep
# happening upstream) don't silently produce a non-self-contained
# bundle.
#
# Include symlinks alongside the real files. cmake produces a three-
# level chain — `libwhisper.so` → `libwhisper.so.1` → `libwhisper.so.1.8.4`
# — and the binary's DT_NEEDED records the SONAME (`libwhisper.so.1`),
# which is itself a symlink. Copying only the concrete file leaves the
# loader looking for `libwhisper.so.1` and finding nothing. `cp -P`
# preserves the symlinks as symlinks; since the chain's targets are
# *relative* and every level lands in $out_dir, the chain still
# resolves at load time without rewriting the link targets.
#
# Bash 3.2 compatibility: macOS still ships bash 3.2 as /bin/bash and
# GitHub's macos-latest runner resolves `#!/usr/bin/env bash` to it
# despite Homebrew bash 5.x being installed (this is what made the
# earlier `${lib_glob[@]}: unbound variable` trip in CI). So: no
# mapfile/readarray (4.0+), no `declare -A` (4.0+), no `${arr[@]}` on
# a potentially-empty array under `set -u` (3.2 treats that as
# unbound). The structure below holds for any bash from 3.2 forward.
echo "[build] discovering bundled shared libs under $build_dir"
case "$os" in
  Darwin) lib_pattern=( -name '*.dylib' -o -name '*.dylib.*' ) ;;
  *)      lib_pattern=( -name '*.so' -o -name '*.so.*' ) ;;
esac
#
# Prune vendored dependency trees before matching. whisper.cpp has no
# npm-installing web UI today, so nothing strays in yet — but this sweep
# is the same deliberately-broad shape that made llama.cpp bundle a 15 MB
# `libvips-cpp` out of `tools/ui/ui-src/node_modules/` in native-v0.1.18.
# Keep the two scripts in step so the next upstream that vendors a JS
# toolchain doesn't reintroduce it here.
lib_paths=()
while IFS= read -r -d '' lib; do
  lib_paths+=("$lib")
done < <(find "$build_dir" \
  \( -name node_modules -o -name .git \) -prune -o \
  \( "${lib_pattern[@]}" \) -print0 2>/dev/null || true)
if [[ ${#lib_paths[@]} -eq 0 ]]; then
  # Hard fail rather than ship a half-bundle. If upstream stops
  # building shared libs entirely (e.g. switches back to static),
  # this script needs an update — the smoke test would surface it
  # later, but earlier is better.
  echo "[build] error: no shared libraries (.so/.dylib) found under $build_dir" >&2
  echo "[build]        whisper.cpp may have changed its build output layout — update build.sh" >&2
  exit 1
fi
# String-based "seen" sentinel for de-dup since `declare -A` is bash
# 4.0+. Bracketed delimiters (`|name|`) prevent false-positive
# substring matches between basenames that share prefixes (e.g.
# `libggml.so.0` should not match `libggml-base.so.0`).
seen="|"
for lib in "${lib_paths[@]}"; do
  base="$(basename "$lib")"
  case "$seen" in
    *"|${base}|"*) continue ;;
  esac
  seen="${seen}${base}|"
  cp -P "$lib" "$out_dir/"
  if [[ -L "$lib" ]]; then
    echo "[build] bundled $base → $(readlink "$lib") (from ${lib#$build_dir/})"
  else
    echo "[build] bundled $base (from ${lib#$build_dir/})"
  fi
done

# ── 5b. Foreign-library guard ──────────────────────────────────────
# Pruning known offenders above is not a durable fix on its own: the
# next tree someone vendors into the build will have a different name,
# and the failure mode is silent — the bundle just gets bigger and the
# smoke test still passes because nothing links the stray. So require
# every bundled library to belong to a known family. A legitimate new
# upstream library means adding it here, in the same change.
echo "[build] checking bundled shared libs for foreign entries"
foreign=""
shopt -s nullglob
for lib in "$out_dir"/*.so "$out_dir"/*.so.* "$out_dir"/*.dylib "$out_dir"/*.dylib.*; do
  case "$(basename "$lib")" in
    # whisper.cpp's own outputs.
    libwhisper*|libggml*) ;;
    # Staged by sibling engines when a local build puts several into one
    # platform directory. sd-cpp shares this exact out_dir and bundles
    # libvulkan.so.1 beside its Vulkan build.
    libssl*|libcrypto*|libcudart*|libcublas*|libllama*|libmtmd*|libvulkan*) ;;
    *) foreign="${foreign} $(basename "$lib")" ;;
  esac
done
shopt -u nullglob
if [[ -n "$foreign" ]]; then
  echo "[build] error: unexpected shared libraries in the bundle:${foreign}" >&2
  echo "[build]        These matched the discovery sweep but are not engine" >&2
  echo "[build]        outputs. If one is a genuine new upstream library, add" >&2
  echo "[build]        it to the allowlist in this script. If it was vendored" >&2
  echo "[build]        into the build tree by something unrelated, prune it in" >&2
  echo "[build]        the find above." >&2
  exit 1
fi

# ── 5c. Strip our own bundled libraries (Linux) ────────────────────
# The server binary is stripped above; its peers were not, so they shipped
# full .symtab. --strip-unneeded drops that and keeps .dynsym, which is what
# the loader resolves against. Restricted to the families we compile so a
# sibling engine's vendor library staged into this same platform directory
# is never modified — same rule as signing.
if [[ "$os" == "Linux" ]]; then
  shopt -s nullglob
  for so in "$out_dir"/*.so "$out_dir"/*.so.*; do
    [[ -L "$so" ]] && continue
    case "$(basename "$so")" in
      libggml*|libwhisper*)
        strip --strip-unneeded "$so" 2>/dev/null || true
        ;;
    esac
  done
  shopt -u nullglob
  echo "[build] stripped bundled first-party shared libs"
fi

# ── 6. Rewrite rpath / install_names so the bundle is relocatable ──
if [[ "$os" == "Linux" ]]; then
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "[build] installing patchelf for rpath fixup"
    sudo apt-get install -y --no-install-recommends patchelf
  fi
  patchelf --set-rpath '$ORIGIN' "$out_dir/$server_name"
  shopt -s nullglob
  for so in "$out_dir"/*.so "$out_dir"/*.so.*; do
    patchelf --set-rpath '$ORIGIN' "$so" 2>/dev/null || true
  done
  shopt -u nullglob

elif [[ "$os" == "Darwin" ]]; then
  rewrite_macho() {
    local target="$1"
    install_name_tool -add_rpath "@loader_path" "$target" 2>/dev/null || true
    # Delete the absolute LC_RPATH CMake baked in (the .upstream build
    # dir — on CI a /Users/runner/… path leaked into a shipping binary;
    # native-v0.1.19 shipped with it). @loader_path covers every bundled
    # peer. Backstopped by the workflow's "Assert no absolute rpaths
    # (macOS)" step.
    while read -r rp; do
      [[ "$rp" == @* ]] && continue
      install_name_tool -delete_rpath "$rp" "$target" 2>/dev/null || true
    done < <(otool -l "$target" | awk '/cmd LC_RPATH/{p=1} p && $1 == "path" {print $2; p=0}')
    while read -r dep; do
      base=$(basename "$dep")
      if [[ -f "$out_dir/$base" && "$dep" != "@rpath/$base" ]]; then
        install_name_tool -change "$dep" "@rpath/$base" "$target"
      fi
    done < <(otool -L "$target" | awk 'NR>1 && /^[[:space:]]/{print $1}')
  }
  rewrite_macho "$out_dir/$server_name"
  shopt -s nullglob
  for dylib in "$out_dir"/*.dylib; do
    rewrite_macho "$dylib"
  done
  # install_name_tool invalidates the linker-added ad-hoc signature
  # on Apple Silicon. Re-sign concrete Mach-O files after relocation
  # so local and unsigned CI artifacts remain executable; release CI
  # may replace these with Developer ID signatures later.
  for dylib in "$out_dir"/*.dylib; do
    [[ -L "$dylib" ]] && continue
    codesign --force --sign - "$dylib"
  done
  shopt -u nullglob
  codesign --force --sign - "$out_dir/$server_name"
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
