#!/usr/bin/env bash
set -euo pipefail

helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$helper_dir/../../.." && pwd)"

case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64|arm64) platform=linux-arm64 ;;
  *) echo "unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

build_dir="$helper_dir/.build/$platform"
output_dir="$repo_root/native/build/$platform"

cmake -S "$helper_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_C_FLAGS=-ffile-prefix-map=$repo_root=gezel -fmacro-prefix-map=$repo_root=gezel -fdebug-prefix-map=$repo_root=gezel" \
  -DBUILD_TESTING=ON
cmake --build "$build_dir" --parallel
# The self-test applies every rule and proves it holds (for --deny-net:
# AF_INET refused, AF_UNIX working). A runner whose kernel lacks seccomp
# fails here, loudly. The other tests pin the flag contract.
ctest --test-dir "$build_dir" --output-on-failure

mkdir -p "$output_dir"
cp "$build_dir/gezel-sandbox" "$output_dir/gezel-sandbox"
chmod +x "$output_dir/gezel-sandbox"
strip -s "$output_dir/gezel-sandbox" 2>/dev/null || true
echo "[sandbox] wrote $output_dir/gezel-sandbox"
