#!/usr/bin/env bash
# fetch-upstream.sh — clone or update a single engine's upstream repo
# at the commit pinned in its VERSION file.
#
# Usage: native/scripts/fetch-upstream.sh <engine-name>
#   engine-name: a directory under native/engines/, e.g. "sd-cpp".
#
# Side effects:
#   - Writes / updates native/engines/<engine>/.upstream/ (a shallow-ish
#     git checkout).
#   - Leaves that directory at the pinned commit. Build scripts take it
#     from there.
#
# Fails loudly if VERSION's `commit=` line is a placeholder (all zeros)
# OR not a 40-char hex sha. This is the hook the CI workflow relies on
# to refuse to build unpinned versions.

set -euo pipefail

engine="${1:-}"
if [[ -z "$engine" ]]; then
  echo "usage: $0 <engine-name>" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
engine_dir="$here/engines/$engine"
version_file="$engine_dir/VERSION"

if [[ ! -f "$version_file" ]]; then
  echo "error: $version_file not found" >&2
  exit 1
fi

# shellcheck disable=SC2046
eval "$(grep -E '^(upstream|tag|commit)=' "$version_file" | sed 's/^/declare /')"

if [[ -z "${upstream:-}" || -z "${commit:-}" ]]; then
  echo "error: $version_file missing upstream or commit" >&2
  exit 1
fi
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: commit sha in $version_file is not a 40-char hex string: $commit" >&2
  echo "       update the VERSION file with a real pin before building in CI." >&2
  exit 1
fi
# The all-hex regex above happily accepts 40 zeros — the bring-up
# placeholder format. Reject it explicitly so a forgotten pin fails
# with a readable message here rather than 30s later with
# `fatal: upload-pack: not our ref 0000…`. Matches the promise the
# header comment makes.
if [[ "$commit" =~ ^0+$ ]]; then
  echo "error: commit sha in $version_file is the all-zeros placeholder." >&2
  echo "       update the VERSION file with a real pin before building in CI." >&2
  exit 1
fi

target="$engine_dir/.upstream"

if [[ ! -d "$target/.git" ]]; then
  echo "[fetch-upstream] cloning $upstream into $target"
  git clone --filter=tree:0 "$upstream" "$target"
fi

echo "[fetch-upstream] pinning $engine to $commit (tag $tag)"
git -C "$target" fetch --tags origin "$commit"
git -C "$target" checkout --detach "$commit"
git -C "$target" submodule update --init --recursive --depth 1

echo "[fetch-upstream] $engine ready at $(git -C "$target" rev-parse HEAD)"
