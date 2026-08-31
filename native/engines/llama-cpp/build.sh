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

source_map_flags="-ffile-prefix-map=$src=llama.cpp -fmacro-prefix-map=$src=llama.cpp -fdebug-prefix-map=$src=llama.cpp"
cmake_flags=(
  -DCMAKE_BUILD_TYPE=Release
  # Rewrite the absolute checkout path baked into __FILE__ by every
  # GGML_ASSERT/abort message, so shipped binaries say
  # `llama.cpp/src/llama-arch.cpp` rather than
  # `/home/runner/work/gezel/gezel/native/engines/llama-cpp/.upstream/src/...`.
  # Cosmetic, but it is the CI layout of a private repo embedded in a
  # user-facing artifact, and it reads better in a bug report too.
  # Include macro + debug maps so both __FILE__ and compiler metadata stay
  # stable. Windows deliberately does not use MSVC's experimental /pathmap.
  "-DCMAKE_C_FLAGS=$source_map_flags"
  "-DCMAKE_CXX_FLAGS=$source_map_flags"
  # ggml defaults GGML_OPENMP=ON, which puts a hard load-time dependency
  # on libgomp.so.1 (Linux) / VCOMP140.DLL (Windows) into libggml-base
  # and libggml-cpu. We bundle neither, so on a host without the GCC
  # OpenMP runtime or the MSVC redistributable the dynamic linker kills
  # the process before main(). CI cannot see it: every runner has a
  # toolchain installed, so ldd always resolves.
  #
  # ggml carries a complete native threadpool on the #ifndef
  # GGML_USE_OPENMP path (atomic barriers, condvars, worker join), and
  # upstream ships OPENMP=OFF presets for Android, Snapdragon and
  # arm64-windows. macOS has always built this way because AppleClang
  # finds no OpenMP — so OFF is a configuration we already ship and test,
  # just not yet everywhere. Keep every platform on it.
  -DGGML_OPENMP=OFF
  # Portable CPU code. ggml defaults GGML_NATIVE=ON, which compiles the
  # CPU backend with `-march=native` (GCC/Clang) or the host's detected
  # SIMD level (MSVC, via FindSIMD.cmake). That pins the shipped binary
  # to whatever CPU the CI runner happened to be scheduled on, and the
  # GitHub-hosted pool is heterogeneous — native-v0.1.29 shipped a
  # linux-x64-vulkan `libggml-cpu.so` full of AVX-512 + AVX512-VNNI
  # while the cpu and cuda legs of the SAME release got AVX2-only code.
  # A user whose CPU lacks the runner's ISA gets SIGILL before
  # llama-server ever binds its port, which the supervisor reports as
  # "on-device engine crashed (SIGILL) ... before becoming ready".
  #
  # CI can never catch this: the runner that built the binary is by
  # definition a machine that can execute it.
  #
  # NATIVE=OFF + BACKEND_DL + CPU_ALL_VARIANTS is upstream's own release
  # recipe. ggml builds one dlopen-able `libggml-cpu-<variant>` module
  # per ISA level (x64, sse42, sandybridge, haswell, skylakex, icelake,
  # zen4, alderlake, … on x86; armv8.0 … armv9.2 on Linux ARM; apple_m1
  # / m2_m3 / m4 on macOS) and `ggml_backend_load_all()` picks the best
  # one the running CPU actually supports. Portable AND faster than a
  # fixed baseline. The modules sit beside the server binary in $out_dir,
  # which is one of the directories ggml-backend-reg.cpp searches.
  -DGGML_NATIVE=OFF
  -DGGML_BACKEND_DL=ON
  -DGGML_CPU_ALL_VARIANTS=ON
  # No OpenSSL. This gates cpp-httplib's CPPHTTPLIB_OPENSSL_SUPPORT —
  # llama-server terminating TLS itself — which gezel never uses: the
  # engine is spawned on loopback and spoken to over plain HTTP. Leaving
  # it ON forced us to bundle three different unpinned, build-host-
  # scavenged OpenSSL copies. See section 8 below.
  -DLLAMA_OPENSSL=OFF
  # Upstream defaults LLAMA_BUILD_IS_DEV=ON, which stamps the binary
  # `<version>-dev` and is what its own CMakeLists tells release builders to
  # turn off: "set this to OFF when making a release from a release tag
  # (vX.Y.Z)". Gezel always builds from a pinned release tag, so leaving the
  # default would ship engines that self-identify as upstream nightlies —
  # wrong in a crash report, and the string `assert-llama-version.mjs`
  # cross-checks the pin against.
  -DLLAMA_BUILD_IS_DEV=OFF
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  # libcurl enables HF-hub pulls from inside llama-server. Gezel
  # does its own model management, so turn it off to drop a runtime
  # dep and shrink the binary.
  -DLLAMA_CURL=OFF
)
if [[ "$os" == "Darwin" ]]; then
  macos_deployment_target="${MACOSX_DEPLOYMENT_TARGET:-13.3}"
  cmake_flags+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$macos_deployment_target")
fi
case "$backend" in
  metal)
    cmake_flags+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
    ;;
  vulkan)
    cmake_flags+=(-DGGML_VULKAN=ON)
    ;;
  cuda)
    cmake_flags+=(-DGGML_CUDA=ON)
    cmake_flags+=(
      "-DCMAKE_CUDA_FLAGS=-Xcompiler=-ffile-prefix-map=$src=llama.cpp -Xcompiler=-fmacro-prefix-map=$src=llama.cpp -Xcompiler=-fdebug-prefix-map=$src=llama.cpp"
    )
    # CUDA arch selection. Release legs MUST set LLAMA_CUDA_ARCH explicitly:
    # on a GPU-less runner CMake/nvcc can pre-populate the variable with its
    # legacy sm_52 fallback before llama.cpp installs its portable defaults.
    # Local builds may leave it empty, but the build log + emitted metadata
    # make that choice visible. Overrides:
    #   LLAMA_CUDA_ARCH="60-virtual;75-real;120" explicit CMake arch list.
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
echo "[build] platform=$platform backend=$backend cuda_architectures=${llama_cuda_arch:-unset}"

# ── 4. Configure + build ───────────────────────────────────────────
build_dir="$src/build-$platform-$backend"

# Wipe the CMake tree on a pin bump. llama.cpp ships VERSIONED shared
# libs (libggml-base.so.0.15.3); an incremental reconfigure after a pin
# bump leaves the PREVIOUS pin's versioned .so files in the tree, and
# step 6's `find … *.so.*` then bundles BOTH generations — the
# mixed-libggml `undefined symbol` crash that broke the CUDA engine on
# the b8892→b9843 bump. Stamp the build dir and wipe when it differs (or
# when a pre-stamp tree is found). Same-pin iteration stays incremental.
# Override with LLAMA_FORCE_CLEAN=1.
#
# The stamp covers the cmake FLAGS as well as the pin, because a
# configuration change produces differently-named outputs from the same
# sources and cmake does not remove the old ones. Turning GGML_BACKEND_DL
# on is exactly that case: the CPU/Metal backends switch from versioned
# SHARED libs (libggml-cpu.0.17.0.dylib) to dlopen-able MODULEs
# (libggml-cpu-apple_m1.so), and an incremental tree keeps both — so the
# bundle ships a stale, host-tuned libggml-cpu alongside the dispatching
# modules. CI always starts clean; this is for local iteration.
pinned_commit="$(sed -n 's/^commit=//p' "$here/VERSION" | head -1)"
build_stamp="$build_dir/.gezel-built-commit"
build_identity="$pinned_commit ${cmake_flags[*]}"
if [[ -d "$build_dir" ]]; then
  if [[ "${LLAMA_FORCE_CLEAN:-0}" == "1" ]]; then
    echo "[build] LLAMA_FORCE_CLEAN=1 — wiping $build_dir"
    rm -rf "$build_dir"
  elif [[ ! -f "$build_stamp" || "$(cat "$build_stamp" 2>/dev/null)" != "$build_identity" ]]; then
    echo "[build] pin/flags changed or unstamped tree — wiping $build_dir to avoid stale output mixing"
    rm -rf "$build_dir"
  fi
fi

cmake -S "$src" -B "$build_dir" "${cmake_flags[@]}"
# Cap parallelism. GitHub-hosted ubuntu runners have 16GB RAM;
# llama.cpp's template-heavy ggml compile easily eats 2-4GB per object
# file across all backends (not just CUDA/Vulkan — the CPU build OOM'd
# on `-j` = 4 cores in CI, surfacing as "runner lost communication with
# the server"). `-j 2` is slower but survives. Override with
# LLAMA_BUILD_JOBS=N.
#
# macOS was exempted here on the theory that it had more headroom. It
# does not: the hosted arm64 runner is a ~7GB box, and `src/models/` is
# ~150 independent translation units that make fans out in one burst
# under an unlimited `-j`. The symptom was never a compile error — it
# was the *npm* install for llama.cpp's embedded web UI, which the
# same build runs concurrently. On darwin it self-reported "added 1053
# packages ... in 1h"; the identical cold `npm ci` takes 3.5 min on the
# Windows runner and 18s on Linux, and 1462 packages install in 41s on
# a macos-latest runner that isn't compiling at the same time. Run
# 33351677171 lost the runner outright at 46 min ("received a shutdown
# signal", exit 143) still inside that install. Unlimited `-j` buys
# nothing over core count anyway, so derive the cap from cores AND RAM
# and keep a well-provisioned local Mac fast.
jobs_flag="-j"
if [[ -n "${LLAMA_BUILD_JOBS:-}" ]]; then
  jobs_flag="-j${LLAMA_BUILD_JOBS}"
elif [[ "$os" == "Linux" ]]; then
  jobs_flag="-j2"
elif [[ "$os" == "Darwin" ]]; then
  # bash 3.2 on the macOS runner: plain arithmetic only, no arrays.
  build_cores="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 2)"
  build_mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 2147483648) / 1073741824 ))
  # ~1.5GB per concurrent C++ job.
  build_jobs=$(( build_mem_gb * 2 / 3 ))
  if [[ "$build_cores" -lt "$build_jobs" ]]; then
    build_jobs="$build_cores"
  fi
  if [[ "$build_jobs" -lt 2 ]]; then
    build_jobs=2
  fi
  jobs_flag="-j${build_jobs}"
fi
echo "[build] parallelism: $jobs_flag"
cmake --build "$build_dir" --config Release --target llama-server $jobs_flag

# Stamp the pin + flags this tree was built with, so the next run can
# detect a bump or a reconfigure and wipe (see the wipe guard above).
echo "$build_identity" > "$build_stamp"

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

# Runtime diagnostics travel with the binary. The service reads this file at
# launch and includes the exact upstream revision + CUDA target in structured
# crash records, so an operator can distinguish a kernel bug from a malformed
# release artifact without reverse-engineering the shared library.
metadata_cuda_arch=""
metadata_cuda_toolkit=""
if [[ "$backend" == "cuda" ]]; then
  metadata_cuda_arch="${llama_cuda_arch:-}"
  if command -v nvcc >/dev/null 2>&1; then
    metadata_cuda_toolkit="$(nvcc --version | sed -n 's/.*release \([^,]*\).*/\1/p' | tail -n1)"
  fi
fi
node - "$out_dir/gezel-llama-build.json" "$pinned_commit" "$platform" "$backend" "$metadata_cuda_arch" "$metadata_cuda_toolkit" <<'NODE'
const { writeFileSync } = require('node:fs');
const [path, revision, platform, backend, cudaArchitectures, cudaToolkit] = process.argv.slice(2);
writeFileSync(
  path,
  `${JSON.stringify({
    schemaVersion: 1,
    engine: 'llama-cpp',
    revision,
    platform,
    backend,
    ...(cudaArchitectures ? { cudaArchitectures: cudaArchitectures.split(';') } : {}),
    ...(cudaToolkit ? { cudaToolkit } : {}),
  }, null, 2)}\n`,
  'utf8',
);
NODE

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
#
# macOS matches `*.so` as well as `*.dylib`. CMake gives MODULE libraries
# a `.so` suffix on Apple, and ggml's loader agrees —
# `backend_filename_extension()` in ggml-backend-reg.cpp returns `.so` on
# every non-Windows platform. So under GGML_BACKEND_DL the dlopen-able
# `libggml-cpu-apple_m1.so` etc. are Mach-O files with an ELF-looking
# extension. A dylib-only sweep here would silently ship a macOS bundle
# with no CPU backend at all.
case "$os" in
  Darwin) lib_pattern=( -name '*.dylib' -o -name '*.dylib.*' -o -name '*.so' ) ;;
  *)      lib_pattern=( -name '*.so' -o -name '*.so.*' ) ;;
esac
#
# Prune vendored dependency trees before matching. llama.cpp's web UI
# (`tools/ui/ui-src/`) npm-installs into the build directory, and
# `@img/sharp-libvips-*` drops a 15 MB `libvips-cpp` there that matches
# the pattern below. native-v0.1.18 shipped it in all six llama bundles:
# ~92 MB of dead weight nothing links or dlopens, plus an undisclosed
# LGPL dependency. The Windows script never had this because its glob is
# scoped to the cmake output dir without -Recurse.
lib_paths=()
while IFS= read -r -d '' lib; do
  lib_paths+=("$lib")
done < <(find "$build_dir" \
  \( -name node_modules -o -name .git \) -prune -o \
  \( "${lib_pattern[@]}" \) -print0 2>/dev/null || true)
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

# ── 6a. Foreign-library guard ──────────────────────────────────────
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
    # llama.cpp's own outputs.
    libggml*|libllama*|libmtmd*) ;;
    # Bundled separately further down, and by sibling engines when a
    # local build stages several into one platform directory (an
    # untagged llama build shares out_dir with sd-cpp, which bundles
    # libvulkan.so.1, and whisper-cpp).
    libssl*|libcrypto*|libcudart*|libcublas*|libwhisper*|libvulkan*) ;;
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

# ── 6b2. CPU-dispatch guard ────────────────────────────────────────
# The whole point of GGML_CPU_ALL_VARIANTS is that the bundle carries
# several `libggml-cpu-<variant>` modules and ggml picks one at load
# time. If a future pin bump drops the option, renames the modules, or
# stops building them under `--target llama-server`, cmake does NOT
# fail: it quietly falls back to a single host-tuned `libggml-cpu`, and
# the only symptom is a SIGILL on somebody else's machine weeks later.
# The build runner can never reproduce that. So assert the shape here.
variant_count=0
shopt -s nullglob
for so in "$out_dir"/libggml-cpu-*.so "$out_dir"/libggml-cpu-*.dylib; do
  [[ -L "$so" ]] && continue
  variant_count=$((variant_count + 1))
done
shopt -u nullglob
if [[ "$variant_count" -lt 2 ]]; then
  echo "[build] error: expected multiple libggml-cpu-<variant> modules, found $variant_count" >&2
  echo "[build]        GGML_CPU_ALL_VARIANTS did not take effect, so the CPU backend is" >&2
  echo "[build]        compiled for THIS build host's instruction set and will SIGILL on" >&2
  echo "[build]        any user CPU that lacks it. Check the ggml pin's support for" >&2
  echo "[build]        GGML_CPU_ALL_VARIANTS on $platform before shipping." >&2
  exit 1
fi
echo "[build] cpu-dispatch guard passed ($variant_count variant modules)"

# ── 6c. Strip our own bundled libraries (Linux) ────────────────────
# Step 5 stripped the server binary but not the peers it loads, so the
# .so's kept full .symtab — libggml-cuda.so alone shipped ~17,900 symbols.
# --strip-unneeded drops those while preserving .dynsym, which is what the
# loader actually resolves against.
#
# Restricted to the families we compile, and run here — before section 7
# stages NVIDIA's libcublas/libcudart — so vendor binaries are never
# touched. Same rule as signing: we modify only what we build, so a user
# can hash a vendor .so against the vendor's own manifest. Stripping also
# has to precede the patchelf pass below; reordering them can corrupt the
# sections patchelf rewrites.
if [[ "$os" == "Linux" ]]; then
  shopt -s nullglob
  for so in "$out_dir"/*.so "$out_dir"/*.so.*; do
    [[ -L "$so" ]] && continue
    case "$(basename "$so")" in
      libggml*|libllama*|libmtmd*)
        strip --strip-unneeded "$so" 2>/dev/null || true
        ;;
    esac
  done
  shopt -u nullglob
  echo "[build] stripped bundled first-party shared libs"
fi

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

# ── 8. OpenSSL: not linked, not bundled ────────────────────────────
# There used to be an OpenSSL bundling step here. At b8892 llama.cpp
# called find_package(OpenSSL) unconditionally and ignored
# `-DLLAMA_SERVER_SSL=OFF`, so the server linked libssl/libcrypto
# whether we wanted it or not and the only way to ship a self-contained
# tarball was to copy the build host's copies in beside it. That meant
# three different unpinned OpenSSL versions across the platforms
# (Ubuntu's on Linux, Homebrew's on macOS, Git-for-Windows' MinGW build
# on Windows), each frozen at build time and only patchable by cutting a
# new native release. Bad shape for a TLS library.
#
# b10099 has a real option — `option(LLAMA_OPENSSL "llama: use openssl
# to support HTTPS" ON)` — so we turn it OFF in the cmake flags above
# and ship no OpenSSL at all. What it gates is cpp-httplib's
# CPPHTTPLIB_OPENSSL_SUPPORT, i.e. llama-server terminating TLS itself.
# Gezel spawns the engine on loopback and speaks plain HTTP to it; the
# daemon's own loopback TLS is a separate layer, and model downloads are
# gezel's own fetch, not the engine's (LLAMA_CURL=OFF).
#
# If you ever need the engine to serve HTTPS directly, prefer upstream's
# LLAMA_BUILD_BORINGSSL / LLAMA_BUILD_LIBRESSL (vendored, pinned, built
# from source) over reinstating a scavenge from the build host.

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
    # CMake also bakes the .upstream build dir into LC_RPATH — on CI an
    # absolute /Users/runner/… path, i.e. the build host's filesystem
    # layout fingerprinted into a shipping binary (native-v0.1.19 shipped
    # with it, visible to anyone running `otool -l`). @loader_path above
    # reaches every bundled peer, so absolute entries buy nothing: delete
    # them, keep @-relative ones. Backstopped by the workflow's
    # "Assert no absolute rpaths (macOS)" step.
    while read -r rp; do
      [[ "$rp" == @* ]] && continue
      install_name_tool -delete_rpath "$rp" "$target" 2>/dev/null || true
    done < <(otool -l "$target" | awk '/cmd LC_RPATH/{p=1} p && $1 == "path" {print $2; p=0}')
    # otool prints absolute paths; we rewrite any whose basename
    # matches a file we just bundled.
    while read -r dep; do
      base=$(basename "$dep")
      if [[ -f "$out_dir/$base" && "$dep" != "@rpath/$base" ]]; then
        install_name_tool -change "$dep" "@rpath/$base" "$target"
      fi
    done < <(otool -L "$target" | awk 'NR>1 && /^[[:space:]]/{print $1}')
  }
  rewrite_macho "$out_dir/$server_name"
  shopt -s nullglob
  # `*.so` is included on purpose — see the note on lib_pattern above.
  # The GGML_BACKEND_DL modules are Mach-O with a `.so` suffix, and they
  # need the same rpath rewrite and ad-hoc re-signature as the dylibs or
  # dlopen fails at runtime.
  for dylib in "$out_dir"/*.dylib "$out_dir"/*.so; do
    rewrite_macho "$dylib"
  done
  # Apple Silicon linkers add an ad-hoc signature automatically.
  # install_name_tool invalidates it, and macOS then kills the binary
  # before main() with exit 137. Re-sign concrete Mach-O files after
  # all load-command edits; release CI may replace these ad-hoc
  # signatures with Developer ID signatures later.
  for dylib in "$out_dir"/*.dylib "$out_dir"/*.so; do
    [[ -L "$dylib" ]] && continue
    codesign --force --sign - "$dylib"
  done
  shopt -u nullglob
  codesign --force --sign - "$out_dir/$server_name"
  echo "[build] install_name_tool fixup complete on $server_name + bundled dylibs"
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
