#!/usr/bin/env bash
set -euo pipefail

# Compile the exact shared adapter for both physical iOS and Simulator without
# downloading llama.cpp, speech models, or requiring Apple Intelligence on CI.
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$helper_dir/../../.." && pwd)"
shared="$repo_root/native/runtime/ios/Sources/GezelRuntime"
if (( $(xcrun --sdk iphoneos --show-sdk-version | cut -d. -f1) < 27 )); then
  for candidate in /Applications/Xcode_27*.app /Applications/Xcode-27*.app; do
    if [[ -d "$candidate/Contents/Developer" ]]; then
      export DEVELOPER_DIR="$candidate/Contents/Developer"
      break
    fi
  done
fi
for sdk in iphoneos iphonesimulator; do
  if (( $(xcrun --sdk "$sdk" --show-sdk-version | cut -d. -f1) < 27 )); then
    echo "[apple-fm] iOS parity compilation needs the Xcode 27 SDKs" >&2
    exit 1
  fi
  target="arm64-apple-ios16.4"
  if [[ "$sdk" == iphonesimulator ]]; then target="$target-simulator"; fi
  xcrun swiftc -typecheck -sdk "$(xcrun --sdk "$sdk" --show-sdk-path)" \
    -target "$target" "$shared/AppleNativeTools.swift" "$shared/AppleFoundationProvider.swift"
done
echo '[apple-fm] shared adapter compiles for iOS device and simulator'
