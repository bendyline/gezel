#!/usr/bin/env bash
# build.sh — Linux + macOS "build" of uv from the pinned upstream.
#
# uv ships precompiled static binaries, so this script **downloads**
# rather than compiles. Verifies the archive sha256 against the pin in
# VERSION, extracts the `uv` binary, and copies it into the canonical
# native-engine output tree.
#
# Emits: native/build/<platform>/uv
#
# Env:
#   UV_ARCHIVE_OVERRIDE — absolute path to a pre-downloaded tarball to
#     use instead of fetching from GitHub. Handy for airgapped CI
#     smoke tests; skips the sha256 check (trust the caller).
#
# Platform matrix maps to astral-sh/uv release asset names:
#   darwin-arm64 → uv-aarch64-apple-darwin.tar.gz
#   darwin-x64   → uv-x86_64-apple-darwin.tar.gz
#   linux-x64    → uv-x86_64-unknown-linux-gnu.tar.gz
#   linux-arm64  → uv-aarch64-unknown-linux-gnu.tar.gz
# (Windows is build.ps1 — uv-x86_64-pc-windows-msvc.zip.)

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Resolve target platform ─────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64)  platform="darwin-arm64"; asset="uv-aarch64-apple-darwin.tar.gz" ;;
      x86_64) platform="darwin-x64";   asset="uv-x86_64-apple-darwin.tar.gz" ;;
      *) echo "unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64)  platform="linux-x64";   asset="uv-x86_64-unknown-linux-gnu.tar.gz" ;;
      aarch64) platform="linux-arm64"; asset="uv-aarch64-unknown-linux-gnu.tar.gz" ;;
      *) echo "unsupported Linux arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "unsupported OS: $os (use build.ps1 for Windows)" >&2
    exit 1
    ;;
esac

# ── 2. Read VERSION pin ────────────────────────────────────────────
version_file="$here/VERSION"
tag=$(grep -E '^tag=' "$version_file" | head -n1 | cut -d= -f2 | tr -d '[:space:]')
expected_sha_key="sha256_${platform//-/_}"
expected_sha=$(grep -E "^${expected_sha_key}=" "$version_file" | head -n1 | cut -d= -f2 | tr -d '[:space:]')

if [[ -z "$tag" || "$tag" == "v0.0.0-placeholder" ]]; then
  echo "error: uv VERSION is still the placeholder — pin a real release tag before building" >&2
  exit 1
fi
if [[ -z "$expected_sha" || "$expected_sha" =~ ^0+$ ]]; then
  echo "error: no sha256 pinned for $platform ($expected_sha_key in VERSION)" >&2
  exit 1
fi

echo "[build] uv $tag for $platform"

# ── 3. Fetch the archive ──────────────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/$asset"

if [[ -n "${UV_ARCHIVE_OVERRIDE:-}" ]]; then
  echo "[build] using override archive: $UV_ARCHIVE_OVERRIDE"
  cp "$UV_ARCHIVE_OVERRIDE" "$archive"
else
  url="https://github.com/astral-sh/uv/releases/download/$tag/$asset"
  echo "[build] downloading $url"
  curl -sSL --fail -o "$archive" "$url"

  # Verify sha256.
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  fi
  if [[ "$actual" != "$expected_sha" ]]; then
    echo "error: sha256 mismatch for $asset" >&2
    echo "  expected: $expected_sha" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "[build] sha256 ok: $actual"
fi

# ── 4. Extract ────────────────────────────────────────────────────
extract="$tmp/extract"
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"

# uv release layout: binary lives at `uv-<target>/uv` relative to the
# archive root. Locate it by `find` so we tolerate upstream renames.
found=""
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "$extract" -type f -name 'uv' -perm -u+x -print0 2>/dev/null || true)

if [[ -z "$found" ]]; then
  echo "error: no executable 'uv' found inside $asset" >&2
  exit 1
fi
echo "[build] extracted: $found"

# ── 5. Copy into the canonical output tree ────────────────────────
out_dir="$repo_root/native/build/$platform"
mkdir -p "$out_dir"
cp "$found" "$out_dir/uv"
chmod +x "$out_dir/uv"
echo "[build] installed: $out_dir/uv"
echo "[build] sha256: $(shasum -a 256 "$out_dir/uv" | awk '{print $1}')"
