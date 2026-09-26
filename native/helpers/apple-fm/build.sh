#!/usr/bin/env bash
set -euo pipefail

helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$helper_dir/../../.." && pwd)"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "[apple-fm] Apple silicon macOS only" >&2
  exit 1
fi

# The app's floor is macOS 13.5; the model needs macOS 26. Build for the
# shared native floor and weak-link FoundationModels so older systems still
# launch the helper and are told the model is unavailable.
# The shared adapter reads Foundation Models' OS 27 stream usage behind a
# runtime check, which still needs the macOS 27 SDK to compile.
if (( $(xcrun --sdk macosx --show-sdk-version | cut -d. -f1) < 27 )); then
  for candidate in /Applications/Xcode_27*.app /Applications/Xcode-27*.app; do
    if [[ -d "$candidate/Contents/Developer" ]]; then
      export DEVELOPER_DIR="$candidate/Contents/Developer"
      break
    fi
  done
fi
if (( $(xcrun --sdk macosx --show-sdk-version | cut -d. -f1) < 27 )); then
  echo "[apple-fm] needs Xcode 27+ (macOS 27 SDK)" >&2
  exit 1
fi

deployment_target="${MACOSX_DEPLOYMENT_TARGET:-13.3}"
shared="$repo_root/native/runtime/ios/Sources/GezelRuntime"
build_dir="$helper_dir/.build"
output_dir="$repo_root/native/build/darwin-arm64"
mkdir -p "$build_dir" "$output_dir"

xcrun swiftc -O -target "arm64-apple-macos$deployment_target" \
  -file-prefix-map "$repo_root=gezel" -no-stdlib-rpath \
  -Xlinker -weak_framework -Xlinker FoundationModels \
  "$shared/AppleNativeTools.swift" \
  "$shared/AppleFoundationProvider.swift" \
  "$helper_dir/main.swift" \
  -o "$build_dir/gezel-apple-fm"

"$build_dir/gezel-apple-fm" --self-test
cp "$build_dir/gezel-apple-fm" "$output_dir/gezel-apple-fm"
chmod +x "$output_dir/gezel-apple-fm"
echo "[apple-fm] wrote $output_dir/gezel-apple-fm"
