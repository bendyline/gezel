#!/usr/bin/env bash
# bundle.sh — assemble every engine's per-platform binaries from
# native/build/<platform>/ into packages/app/native-bin/<platform>/
# so electron-builder's extraResources picks them up.
#
# Usage: native/scripts/bundle.sh [platform]
#
# When run without args, bundles whatever is present (CI calls this
# after matrix jobs download each platform's artifacts into
# native/build/). Locally, bundling your host's platform only:
#   native/scripts/bundle.sh darwin-arm64
#
# Produces a summary + sha256 manifest at
# packages/app/native-bin/<platform>/MANIFEST.txt so the supervisor
# can do an integrity check at launch time if we want to later.

set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$here/.." && pwd)"
in_root="$here/build"
out_root="$repo_root/packages/app/native-bin"

if [[ ! -d "$in_root" ]]; then
  echo "error: no build outputs at $in_root" >&2
  echo "       run build.sh / build.ps1 or download CI artifacts first." >&2
  exit 1
fi

# ── Resolve platform list ───────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  platforms=("$1")
else
  mapfile -t platforms < <(find "$in_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
fi

if [[ ${#platforms[@]} -eq 0 ]]; then
  echo "error: no per-platform subdirectories under $in_root" >&2
  exit 1
fi

for platform in "${platforms[@]}"; do
  src="$in_root/$platform"
  dest="$out_root/$platform"
  if [[ ! -d "$src" ]]; then
    echo "skip: no $src" >&2
    continue
  fi
  echo "[bundle] $platform"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$src"/* "$dest/"

  manifest="$dest/MANIFEST.txt"
  {
    echo "# native binaries — $platform"
    echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo ""
    for f in "$dest"/*; do
      [[ "$f" == "$manifest" ]] && continue
      name=$(basename "$f")
      sha=$(shasum -a 256 "$f" | awk '{print $1}')
      size=$(wc -c < "$f" | awk '{print $1}')
      echo "$sha  $size  $name"
    done
  } > "$manifest"
  cat "$manifest"
done

echo "[bundle] done → $out_root"
