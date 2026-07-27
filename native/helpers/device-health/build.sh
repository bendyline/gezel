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
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build "$build_dir" --parallel
ctest --test-dir "$build_dir" --output-on-failure

mkdir -p "$output_dir"
cp "$build_dir/gezel-device-health" "$output_dir/gezel-device-health"
chmod +x "$output_dir/gezel-device-health"
# Every other engine strips on Linux; this helper was the one that didn't,
# so it shipped its .symtab. Small (~a few KB) but it is also the only
# first-party binary still carrying build-tree symbol names.
strip -s "$output_dir/gezel-device-health" 2>/dev/null || true
echo "[device-health] wrote $output_dir/gezel-device-health"
