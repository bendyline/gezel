#!/usr/bin/env bash
# build.sh — Linux + macOS "build" of the DuckDB CLI from the pinned upstream.
#
# DuckDB ships a precompiled single-file CLI, so this script **downloads**
# rather than compiles. Verifies the archive sha256 against the pin in
# VERSION, extracts the `duckdb` binary, and copies it into the canonical
# native-engine output tree.
#
# Emits: native/build/<platform>/duckdb
#
# Env:
#   DUCKDB_ARCHIVE_OVERRIDE — absolute path to a pre-downloaded zip to
#     use instead of fetching from GitHub. Handy for airgapped CI
#     smoke tests; skips the sha256 check (trust the caller).
#
# Platform matrix maps to duckdb/duckdb release asset names:
#   darwin-arm64 → duckdb_cli-osx-arm64.zip
#   linux-x64    → duckdb_cli-linux-amd64.zip
#   linux-arm64  → duckdb_cli-linux-arm64.zip
# (Windows is build.ps1 — duckdb_cli-windows-amd64.zip.)
#
# The glibc archives are chosen over the `-musl` variants to match the
# rest of the native tree.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

# ── 1. Resolve target platform ─────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64)  platform="darwin-arm64"; asset="duckdb_cli-osx-arm64.zip" ;;
      *) echo "unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64)  platform="linux-x64";   asset="duckdb_cli-linux-amd64.zip" ;;
      aarch64) platform="linux-arm64"; asset="duckdb_cli-linux-arm64.zip" ;;
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
commit=$(grep -E '^commit=' "$version_file" | head -n1 | cut -d= -f2 | tr -d '[:space:]')
expected_sha_key="sha256_${platform//-/_}"
expected_sha=$(grep -E "^${expected_sha_key}=" "$version_file" | head -n1 | cut -d= -f2 | tr -d '[:space:]')

if [[ -z "$tag" || "$tag" == "v0.0.0-placeholder" ]]; then
  echo "error: duckdb VERSION is still the placeholder — pin a real release tag before building" >&2
  exit 1
fi
if [[ -z "$expected_sha" || "$expected_sha" =~ ^0+$ ]]; then
  echo "error: no sha256 pinned for $platform ($expected_sha_key in VERSION)" >&2
  exit 1
fi

echo "[build] duckdb $tag for $platform"

# ── 3. Fetch the archive ──────────────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/$asset"

if [[ -n "${DUCKDB_ARCHIVE_OVERRIDE:-}" ]]; then
  echo "[build] using override archive: $DUCKDB_ARCHIVE_OVERRIDE"
  cp "$DUCKDB_ARCHIVE_OVERRIDE" "$archive"
else
  url="https://github.com/duckdb/duckdb/releases/download/$tag/$asset"
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
unzip -o -q "$archive" -d "$extract"

# DuckDB's CLI archive holds a single `duckdb` at the archive root, but
# locate it by `find` so an upstream layout change doesn't silently
# produce an empty output tree.
found=""
while IFS= read -r -d '' f; do
  found="$f"
  break
done < <(find "$extract" -type f -name 'duckdb' -print0 2>/dev/null || true)

if [[ -z "$found" ]]; then
  echo "error: no 'duckdb' binary found inside $asset" >&2
  exit 1
fi
chmod +x "$found"
echo "[build] extracted: $found"

# ── 5. Smoke test the pinned build ────────────────────────────────
# `duckdb --version` echoes the upstream commit; confirming it against
# the VERSION pin proves we extracted the build we think we did, before
# the binary is hashed and published.
version_out="$("$found" --version 2>&1 || true)"
echo "[build] version: $version_out"
if [[ -n "$commit" && ! "$commit" =~ ^0+$ ]]; then
  short="${commit:0:10}"
  if [[ "$version_out" != *"$short"* ]]; then
    echo "error: duckdb --version does not mention pinned commit $short" >&2
    echo "  got: $version_out" >&2
    exit 1
  fi
fi
if [[ "$(echo 'SELECT 1;' | "$found" -noheader -list :memory: 2>&1)" != "1" ]]; then
  echo "error: duckdb smoke query did not return 1" >&2
  exit 1
fi

# ── 6. Copy into the canonical output tree ────────────────────────
out_dir="$repo_root/native/build/$platform"
mkdir -p "$out_dir"
cp "$found" "$out_dir/duckdb"
chmod +x "$out_dir/duckdb"
echo "[build] installed: $out_dir/duckdb"
echo "[build] sha256: $(shasum -a 256 "$out_dir/duckdb" 2>/dev/null | awk '{print $1}' || sha256sum "$out_dir/duckdb" | awk '{print $1}')"
