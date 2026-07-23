#!/usr/bin/env bash
# build.sh — Linux + macOS build of llama-server from the pinned
# llama.cpp upstream.
#
# Emits: native/build/<platform>[-<backend>]/gezel-llama-server
#
# Detects the platform and enables the appropriate accelerator:
#   - darwin-arm64: Metal (-DGGML_METAL=ON)
#   - darwin-x64:   CPU (Apple x86_64 can't target Metal)
#   - linux-x64:    auto — CUDA if nvcc on PATH, else Vulkan if SDK, else CPU
#
# Override with LLAMA_BACKEND={metal,vulkan,cuda,cpu}. On Linux the
# release matrix builds all three non-CPU variants separately; the
# auto-detection here is for local iteration only.
#
# Set LLAMA_BACKEND_TAG=1 to emit to `native/build/<platform>-<backend>/`
# instead of `native/build/<platform>/`. Needed when CI builds multiple
# variants per platform and must not clobber.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Ensure upstream is cloned + pinned ──────────────────────────
"$repo_root/native/scripts/fetch-upstream.sh" llama-cpp
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
backend="${LLAMA_BACKEND:-auto}"
if [[ "$backend" == "auto" ]]; then
  case "$platform" in
    darwin-arm64) backend="metal" ;;
    darwin-x64)   backend="cpu" ;;
    linux-x64|linux-arm64)
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
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  # libcurl enables HF-hub pulls from inside llama-server. Gezel
  # does its own model management, so turn it off to drop a runtime
  # dep and shrink the binary.
  -DLLAMA_CURL=OFF
  # Note: -DLLAMA_SERVER_SSL=OFF was tried here but b8892 ignores it —
  # find_package(OpenSSL) runs unconditionally and the binary picks up
  # the system libssl.so.3 / libcrypto.so.3 dynamically. Linux/macOS
  # both ship those as standard system libs, so no bundling needed
  # here (Windows is the exception, handled in build.ps1).
)
case "$backend" in
  metal)
    cmake_flags+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
    ;;
  vulkan)
    cmake_flags+=(-DGGML_VULKAN=ON)
    ;;
  cuda)
    cmake_flags+=(-DGGML_CUDA=ON)
    # CUDA arch selection. The DEFAULT (LLAMA_CUDA_ARCH unset) omits
    # CMAKE_CUDA_ARCHITECTURES and lets llama.cpp's own CMake pick its
    # portable default list — which at CUDA 12.9+ already includes
    # `121a-real` for GB10/DGX Spark (the arm64 CI leg pins cuda_pkg=12-9
    # for exactly this). That default is CI-SAFE: a GPU-less runner cannot
    # resolve `native`, and forcing it there fails the configure — or
    # silently builds sm_52-only (the ds4 lesson). It is also what shipped
    # green through native-v0.1.14. Overrides, all opt-in:
    #   LLAMA_CUDA_ARCH="86;89;120"  explicit CMake arch list (release legs).
    #   LLAMA_CUDA_ARCH=native       ONLY the GPU on THIS host — a lean, fast
    #                                local dev restore; REQUIRES a GPU present.
    #   LLAMA_CUDA_ARCH=spark        empty -arch, antirez cuda-spark style.
    llama_cuda_arch="${LLAMA_CUDA_ARCH:-}"
    if [[ -n "$llama_cuda_arch" && "$llama_cuda_arch" != "spark" ]]; then
      cmake_flags+=("-DCMAKE_CUDA_ARCHITECTURES=$llama_cuda_arch")
    fi
    # F16 CUDA math path — a general decode/prefill speedup the bare
    # -DGGML_CUDA=ON leaves off. FA-all-quants is a heavy compile with
    # uncertain benefit for f16-KV Gemma; opt in via LLAMA_CUDA_FA_ALL_QUANTS=1.
    cmake_flags+=(-DGGML_CUDA_F16=ON)
    if [[ "${LLAMA_CUDA_FA_ALL_QUANTS:-0}" == "1" ]]; then
      cmake_flags+=(-DGGML_CUDA_FA_ALL_QUANTS=ON)
    fi
    ;;
  cpu)
    : # default — no accelerator flags
    ;;
  *)
    echo "unknown LLAMA_BACKEND=$backend (valid: metal, vulkan, cuda, cpu)" >&2
    exit 1
    ;;
esac
echo "[build] platform=$platform backend=$backend"

# ── 4. Configure + build ───────────────────────────────────────────
build_dir="$src/build-$platform-$backend"

# Wipe the CMake tree on a pin bump. llama.cpp ships VERSIONED shared
# libs (libggml-base.so.0.15.3); an incremental reconfigure after a pin
# bump leaves the PREVIOUS pin's versioned .so files in the tree, and
# step 6's `find … *.so.*` then bundles BOTH generations — the
# mixed-libggml `undefined symbol` crash that broke the CUDA engine on
# the b8892→b9843 bump. Stamp the pinned commit into the build dir and
# wipe when it differs (or when a pre-stamp tree is found). Same-pin
# iteration stays incremental. Override with LLAMA_FORCE_CLEAN=1.
pinned_commit="$(sed -n 's/^commit=//p' "$here/VERSION" | head -1)"
build_stamp="$build_dir/.gezel-built-commit"
if [[ -d "$build_dir" ]]; then
  if [[ "${LLAMA_FORCE_CLEAN:-0}" == "1" ]]; then
    echo "[build] LLAMA_FORCE_CLEAN=1 — wiping $build_dir"
    rm -rf "$build_dir"
  elif [[ ! -f "$build_stamp" || "$(cat "$build_stamp" 2>/dev/null)" != "$pinned_commit" ]]; then
    echo "[build] pin changed or unstamped tree — wiping $build_dir to avoid stale versioned .so mixing"
    rm -rf "$build_dir"
  fi
fi

cmake -S "$src" -B "$build_dir" "${cmake_flags[@]}"
# Cap parallelism on every Linux build. GitHub-hosted ubuntu runners
# have 16GB RAM; llama.cpp's template-heavy ggml compile easily eats
# 2-4GB per object file across all backends (not just CUDA/Vulkan —
# the CPU build OOM'd on `-j` = 4 cores in CI, surfacing as "runner
# lost communication with the server"). `-j 2` is slower but
# survives. Override with LLAMA_BUILD_JOBS=N. macOS runners have
# more headroom and aren't constrained here.
jobs_flag="-j"
if [[ "$os" == "Linux" ]]; then
  jobs_flag="-j${LLAMA_BUILD_JOBS:-2}"
elif [[ -n "${LLAMA_BUILD_JOBS:-}" ]]; then
  jobs_flag="-j${LLAMA_BUILD_JOBS}"
fi
echo "[build] parallelism: $jobs_flag"
cmake --build "$build_dir" --config Release --target llama-server $jobs_flag

# Stamp the pin this tree was built at, so the next run can detect a bump
# and wipe (see the wipe guard above).
echo "$pinned_commit" > "$build_stamp"

# ── 5. Locate the produced binary ──────────────────────────────────
found=""
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "$build_dir" -type f -name llama-server -perm -u+x -print0 2>/dev/null || true)

if [[ -z "$found" ]]; then
  echo "error: llama-server binary not produced under $build_dir" >&2
  echo "       inspect the CMake output above — upstream may have renamed the target." >&2
  exit 1
fi
echo "[build] produced: $found"

# Strip debug symbols on Linux (smaller installer). macOS strips at
# codesign time inside the Electron build.
if [[ "$os" == "Linux" ]]; then
  strip -s "$found" 2>/dev/null || true
fi

# ── 6. Copy into the canonical output tree ─────────────────────────
if [[ "${LLAMA_BACKEND_TAG:-0}" == "1" ]]; then
  out_dir="$repo_root/native/build/$platform-$backend"
else
  out_dir="$repo_root/native/build/$platform"
fi
rm -rf "$out_dir"
mkdir -p "$out_dir"
# Ship the server under a gezel- prefix so it reads as `gezel-llama-server`
# in Windows Task Manager / GPU listings and macOS Activity Monitor —
# attribution to Gezel while keeping the upstream llama.cpp lineage legible.
# The cmake `--target` and the `find` above keep the upstream `llama-server`
# name; only the *installed* file is prefixed.
server_name="gezel-llama-server"
cp "$found" "$out_dir/$server_name"
chmod +x "$out_dir/$server_name"

# Copy llama.cpp's own runtime shared libraries that load lazily
# when the server tries to load a model. Without these alongside
# the exe, `--version` works but model load dies with dlopen errors.
# With LLAMA_BUILD_SERVER=ON, modern llama.cpp produces ggml*, llama,
# mtmd, etc. as shared libs (.so on Linux, .dylib on macOS).
#
# Llama.cpp's cmake puts these in `build/bin/` next to llama-server
# today, but that's an upstream convention — whisper.cpp's cmake
# scatters them across `build/src/`, `build/ggml/src/`, etc. The
# discovery below uses a `find` over the entire build tree so a
# future upstream layout shift here doesn't silently produce a
# non-self-contained bundle (the bug that bit whisper.cpp in
# native-v0.1.10). `cp -P` preserves the symlink chain
# (`libwhisper.so` → `libwhisper.so.1` → `libwhisper.so.1.8.4`) so
# the binary's SONAME-level DT_NEEDED resolves at load time.
#
# Bash 3.2 compatibility: macOS still ships bash 3.2 as /bin/bash
# and GitHub's macos-latest runner resolves `#!/usr/bin/env bash` to
# it. So: no mapfile/readarray (4.0+), no `declare -A` (4.0+), no
# `${arr[@]}` on a potentially-empty array under `set -u` (3.2
# treats that as unbound — same hazard that tripped whisper.cpp's
# earlier glob-only path).
echo "[build] discovering bundled shared libs under $build_dir"
case "$os" in
  Darwin) lib_pattern=( -name '*.dylib' -o -name '*.dylib.*' ) ;;
  *)      lib_pattern=( -name '*.so' -o -name '*.so.*' ) ;;
esac
lib_paths=()
while IFS= read -r -d '' lib; do
  lib_paths+=("$lib")
done < <(find "$build_dir" \( "${lib_pattern[@]}" \) -print0 2>/dev/null || true)
if [[ ${#lib_paths[@]} -eq 0 ]]; then
  echo "[build] error: no shared libraries (.so/.dylib) found under $build_dir" >&2
  echo "[build]        llama.cpp may have changed its build output layout — update build.sh" >&2
  exit 1
fi
# String-based "seen" sentinel for de-dup (bash 3.2 lacks
# associative arrays). Bracketed delimiters prevent false-positive
# substring matches between basenames sharing prefixes
# (e.g. `libggml.so.0` vs `libggml-base.so.0`).
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

# ── 6b. Version-consistency guard ──────────────────────────────────
# Catch the mixed-generation bundle at its source: if two DIFFERENT
# versioned copies of the same soname base landed (e.g.
# libggml-base.so.0.10.0 AND .0.15.3), the loader resolves symbols
# across incompatible ggml builds → `undefined symbol` at spawn. This is
# exactly the class that broke the CUDA engine on the b8892→b9843 bump;
# fail loudly here rather than ship a corrupt bundle. (The wipe guard in
# step 4 prevents it; this is the belt-and-suspenders check.)
echo "[build] checking bundled shared libs for version mixing"
seen_bases="|"
dup=""
shopt -s nullglob
for so in "$out_dir"/*.so.*; do
  # Only REAL versioned files, not the .so / .so.MAJOR symlinks.
  [[ -L "$so" ]] && continue
  fn="$(basename "$so")"
  base="${fn%%.so.*}"
  case "$seen_bases" in
    *"|${base}=="*)
      prev="${seen_bases#*|${base}==}"; prev="${prev%%|*}"
      [[ "$prev" != "$fn" ]] && dup="$dup ${base}[${prev} vs ${fn}]"
      ;;
    *)
      seen_bases="${seen_bases}${base}==${fn}|"
      ;;
  esac
done
shopt -u nullglob
if [[ -n "$dup" ]]; then
  echo "[build] error: mixed shared-lib versions bundled:$dup" >&2
  echo "[build]        this is the mixed-libggml corruption class — the CMake tree was not" >&2
  echo "[build]        wiped on a pin bump. Run: LLAMA_FORCE_CLEAN=1 $0" >&2
  exit 1
fi
echo "[build] version-consistency guard passed"

# ── 7. Linux CUDA runtime bundling ─────────────────────────────────
# The NVIDIA driver (`libcuda.so.1`) is supplied by the user's system,
# but the CUDA toolkit runtime libraries must match the major version
# used at build time. Bundle them beside `libggml-cuda.so` so a CUDA 12
# release still starts on a CUDA 13 host with a compatible driver.
if [[ "$os" == "Linux" && "$backend" == "cuda" ]]; then
  cuda_home="${CUDA_HOME:-${CUDA_PATH:-/usr/local/cuda}}"
  runtime_found=0
  for libglob in libcudart libcublas libcublasLt; do
    lib_found=0
    for cand in "$cuda_home"/targets/*/lib "$cuda_home/lib64" "$cuda_home/lib"; do
      for so in "$cand/$libglob".so*; do
        [[ -e "$so" ]] || continue
        cp -P "$so" "$out_dir/"
        echo "[build] bundled $(basename "$so") (from $cand)"
        lib_found=1
        runtime_found=1
      done
    done
    if [[ "$lib_found" -eq 0 ]]; then
      echo "[build] error: $libglob.so* not found under $cuda_home" >&2
      echo "[build] install CUDA toolkit runtime packages or set CUDA_HOME / CUDA_PATH" >&2
      exit 1
    fi
  done
  if [[ "$runtime_found" -eq 0 ]]; then
    echo "[build] error: no CUDA runtime libraries found under $cuda_home" >&2
    exit 1
  fi
fi

# ── 8. OpenSSL bundling ────────────────────────────────────────────
# llama.cpp at b8892 calls find_package(OpenSSL) unconditionally —
# `-DLLAMA_SERVER_SSL=OFF` is silently ignored — so the binary
# statically links libssl + libcrypto whether we want it to or not.
# We bundle them so the produced tarball is self-contained on user
# machines that don't have OpenSSL 3 installed (modern macOS doesn't
# ship it; minimal Linux containers may not have it).
if [[ "$os" == "Linux" ]]; then
  openssl_lib_dir=""
  # Debian-style multiarch dirs come first (the libssl3 deb lands
  # libs there on both x86_64 and arm64 Ubuntu); /usr/lib64 covers
  # RPM-family hosts; /usr/lib is the last-resort fallback.
  for candidate in \
      /usr/lib/x86_64-linux-gnu \
      /usr/lib/aarch64-linux-gnu \
      /usr/lib64 \
      /usr/lib; do
    if [[ -f "$candidate/libssl.so.3" && -f "$candidate/libcrypto.so.3" ]]; then
      openssl_lib_dir="$candidate"
      break
    fi
  done
  if [[ -z "$openssl_lib_dir" ]]; then
    echo "[build] error: libssl.so.3 / libcrypto.so.3 not found in /usr/lib/{x86_64,aarch64}-linux-gnu, /usr/lib64, /usr/lib" >&2
    echo "[build] install with: sudo apt-get install -y libssl3" >&2
    exit 1
  fi
  for lib in libssl.so.3 libcrypto.so.3; do
    cp -L "$openssl_lib_dir/$lib" "$out_dir/"
    echo "[build] bundled $lib (from $openssl_lib_dir)"
  done

elif [[ "$os" == "Darwin" ]]; then
  openssl_lib_dir=""
  # GitHub macos-latest is Apple Silicon (Homebrew at /opt/homebrew);
  # /usr/local/opt path covers Intel Mac dev hosts.
  for candidate in /opt/homebrew/opt/openssl@3/lib /usr/local/opt/openssl@3/lib; do
    if [[ -f "$candidate/libssl.3.dylib" && -f "$candidate/libcrypto.3.dylib" ]]; then
      openssl_lib_dir="$candidate"
      break
    fi
  done
  if [[ -z "$openssl_lib_dir" ]]; then
    echo "[build] error: libssl.3.dylib / libcrypto.3.dylib not found." >&2
    echo "[build] install with: brew install openssl@3" >&2
    exit 1
  fi
  for lib in libssl.3.dylib libcrypto.3.dylib; do
    cp "$openssl_lib_dir/$lib" "$out_dir/"
    chmod u+w "$out_dir/$lib"
    # Set the dylib's own install_name to @rpath/<basename>; the
    # rpath rewrite step below redirects loaders looking for the
    # absolute Homebrew path here instead.
    install_name_tool -id "@rpath/$lib" "$out_dir/$lib"
    echo "[build] bundled $lib (from $openssl_lib_dir)"
  done
fi

# ── 9. Rewrite rpath / install_names so the bundle is relocatable ──
# After bundling, every binary + shared lib in $out_dir needs to
# look for its peers IN THE SAME DIRECTORY rather than at the
# absolute build-time paths cmake baked in. Otherwise the tarball
# only works on machines whose filesystem layout matches the build
# host, which is to say, ours.
if [[ "$os" == "Linux" ]]; then
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "[build] installing patchelf for rpath fixup"
    sudo apt-get install -y --no-install-recommends patchelf
  fi
  # $ORIGIN means "directory containing this ELF file" — applied to
  # the binary AND every bundled .so so a libllama.so loading
  # libggml.so finds it next to itself, not in the build dir.
  patchelf --set-rpath '$ORIGIN' "$out_dir/$server_name"
  echo "[build] patchelf set rpath \$ORIGIN on $server_name"
  shopt -s nullglob
  for so in "$out_dir"/*.so "$out_dir"/*.so.*; do
    patchelf --set-rpath '$ORIGIN' "$so" 2>/dev/null || true
  done
  shopt -u nullglob

elif [[ "$os" == "Darwin" ]]; then
  # @loader_path is the dir containing the loader (binary or dylib),
  # so it works for both the main exe and for one dylib resolving
  # another dylib's path. Add it as an rpath; rewrite each load
  # command pointing at a peer in $out_dir to use @rpath/<basename>.
  rewrite_macho() {
    local target="$1"
    install_name_tool -add_rpath "@loader_path" "$target" 2>/dev/null || true
    # otool prints absolute paths; we rewrite any whose basename
    # matches a file we just bundled.
    while read -r dep; do
      base=$(basename "$dep")
      if [[ -f "$out_dir/$base" && "$dep" != "@rpath/$base" ]]; then
        install_name_tool -change "$dep" "@rpath/$base" "$target"
      fi
    done < <(otool -L "$target" | awk 'NR>1 && /^\s/{print $1}')
  }
  rewrite_macho "$out_dir/$server_name"
  shopt -s nullglob
  for dylib in "$out_dir"/*.dylib; do
    rewrite_macho "$dylib"
  done
  shopt -u nullglob
  echo "[build] install_name_tool fixup complete on $server_name + bundled dylibs"
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
