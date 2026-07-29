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
      # then CPU.
      #
      # This `auto` path is for LOCAL builds only. CI pins the backend
      # per matrix row via SD_BACKEND, because inferring it from
      # `command -v vulkaninfo` couples the shipped artifact to whether
      # the Vulkan SDK install step ran on that runner. It did on
      # linux-x64, so native-v0.1.18 shipped a Vulkan-linked sd-server
      # while an earlier version of this comment still claimed the
      # shipped default stayed CPU. Backend choice is a release
      # decision — keep it declared in the matrix, not inferred here.
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

source_map_flags="-ffile-prefix-map=$src=stable-diffusion.cpp -fmacro-prefix-map=$src=stable-diffusion.cpp -fdebug-prefix-map=$src=stable-diffusion.cpp"
cmake_flags=(
  -DCMAKE_BUILD_TYPE=Release
  # Keep the CI checkout path out of __FILE__ assert strings; see the
  # longer note in native/engines/llama-cpp/build.sh. Unix-only.
  "-DCMAKE_C_FLAGS=$source_map_flags"
  "-DCMAKE_CXX_FLAGS=$source_map_flags"
  # Drops the unbundled libgomp.so.1 / VCOMP140.DLL load-time dependency
  # ggml's default OPENMP=ON bakes into libggml-base + libggml-cpu, and
  # here into sd-server itself. See the longer note in
  # native/engines/llama-cpp/build.sh.
  -DGGML_OPENMP=OFF
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
if [[ "$os" == "Darwin" ]]; then
  macos_deployment_target="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
  cmake_flags+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$macos_deployment_target")
fi
# NOTE: upstream removed the `SD_BUILD_SERVER` option (commit
# .../examples/CMakeLists.txt now unconditionally
# `add_subdirectory(server)`); passing it produces a "manually-
# specified variables were not used" CMake warning. Don't restore it.
case "$backend" in
  metal)  cmake_flags+=(-DSD_METAL=ON) ;;
  vulkan) cmake_flags+=(-DSD_VULKAN=ON) ;;
  cuda)
    cmake_flags+=(-DSD_CUDA=ON)
    cmake_flags+=(
      "-DCMAKE_CUDA_FLAGS=-Xcompiler=-ffile-prefix-map=$src=stable-diffusion.cpp -Xcompiler=-fmacro-prefix-map=$src=stable-diffusion.cpp -Xcompiler=-fdebug-prefix-map=$src=stable-diffusion.cpp"
    )
    ;;
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

# ── 7. Vulkan loader bundling (Linux) ──────────────────────────────
# A Vulkan build names `libvulkan.so.1` in DT_NEEDED, which is a
# load-time dependency, not a dlopen: without it the dynamic linker
# kills the process before main(), so sd.cpp never reaches its own
# "Using CPU backend" fallback. The loader comes from the `libvulkan1`
# package, which mainstream desktop images have but minimal/server
# images, some containers, and GPU-less WSL do not — and CI can never
# catch that, because the ldd smoke check runs on a runner where the
# Vulkan SDK was just installed.
#
# So bundle it (Apache-2.0, ~1 MB, redistributable — see NOTICE.md and
# native/licenses/manifest.json). The loader still discovers the host's
# ICDs through /usr/share/vulkan/icd.d, so a bundled loader plus system
# drivers is the normal, supported arrangement; when there is no usable
# device sd.cpp drops to CPU on its own.
if [[ "$os" == "Linux" && "$backend" == "vulkan" ]]; then
  vulkan_lib=""
  # Prefer the LunarG SDK copy CI installs (the canonical redistributable)
  # before the distro's, so the bundled loader matches what we built against.
  for candidate in \
      "${VULKAN_SDK:-}/lib" \
      /usr/lib/x86_64-linux-gnu \
      /usr/lib/aarch64-linux-gnu \
      /usr/lib64 \
      /usr/lib; do
    if [[ -n "$candidate" && -f "$candidate/libvulkan.so.1" ]]; then
      vulkan_lib="$candidate"
      break
    fi
  done
  if [[ -z "$vulkan_lib" ]]; then
    echo "[build] error: libvulkan.so.1 not found in \$VULKAN_SDK/lib, /usr/lib/{x86_64,aarch64}-linux-gnu, /usr/lib64, /usr/lib" >&2
    echo "[build]        a Vulkan build must ship the loader; install with:" >&2
    echo "[build]          sudo apt-get install -y libvulkan1" >&2
    exit 1
  fi
  # -L dereferences the SDK's libvulkan.so.1 -> libvulkan.so.1.x.yyy
  # symlink so the bundled file carries the SONAME the binary asks for.
  cp -L "$vulkan_lib/libvulkan.so.1" "$out_dir/libvulkan.so.1"
  echo "[build] bundled libvulkan.so.1 (from $vulkan_lib)"

  # sd-cpp links everything else statically, so it shipped with no rpath
  # at all until now — the bundled loader would be invisible without this.
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "[build] installing patchelf for rpath fixup"
    sudo apt-get install -y --no-install-recommends patchelf
  fi
  patchelf --set-rpath '$ORIGIN' "$out_dir/$server_name"
  echo "[build] patchelf set rpath \$ORIGIN on $server_name"

  # Prove the binary now resolves the loader to the bundled copy rather
  # than to a host path that may not exist on a user's machine. Compare
  # realpaths: $ORIGIN resolves to the binary's *real* directory, so a
  # symlinked checkout would fail a plain string compare on $out_dir.
  # `env -u LD_LIBRARY_PATH` is load-bearing, not tidiness: CI exports
  # LD_LIBRARY_PATH=$VULKAN_SDK/lib for the build, and LD_LIBRARY_PATH is
  # searched BEFORE RUNPATH. Without unsetting it, ldd resolves the SDK's
  # loader rather than the bundled one and this check fails on a bundle that
  # is actually correct — the same reason build-native.yml's smoke step
  # unsets it.
  if command -v ldd >/dev/null 2>&1; then
    resolved="$(env -u LD_LIBRARY_PATH ldd "$out_dir/$server_name" 2>/dev/null | awk '/libvulkan\.so\.1/ {print $3}')"
    echo "[build] libvulkan.so.1 resolves to: ${resolved:-<unresolved>}"
    if [[ -z "$resolved" || ! -e "$resolved" ]]; then
      echo "[build] error: libvulkan.so.1 is unresolved after bundling — the rpath fixup did not take" >&2
      exit 1
    fi
    resolved_dir="$(cd "$(dirname "$resolved")" && pwd -P)"
    bundle_dir="$(cd "$out_dir" && pwd -P)"
    if [[ "$resolved_dir" != "$bundle_dir" ]]; then
      echo "[build] error: libvulkan.so.1 resolved to '$resolved', outside the bundle" >&2
      echo "[build]        expected it under $bundle_dir — the binary would depend on a host path" >&2
      exit 1
    fi
  fi
fi

echo "[build] installed: $out_dir/$server_name"
echo "[build] sha256: $(shasum -a 256 "$out_dir/$server_name" | awk '{print $1}')"
