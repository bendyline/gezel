#!/usr/bin/env bash
# fetch-upstream.sh — clone or update a single engine's upstream repo
# at the commit pinned in its VERSION file.
#
# Usage: native/scripts/fetch-upstream.sh <engine-name>
#   engine-name: a directory under native/engines/, e.g. "sd-cpp".
#
# Side effects:
#   - Writes / updates native/engines/<engine>/.upstream/ (a shallow
#     checkout of the exact pinned commit).
#   - Leaves that directory at the pinned commit. Build scripts take it
#     from there.
#
# Fails loudly if VERSION's `commit=` line is a placeholder (all zeros)
# OR not a 40-char hex sha. This is the hook the CI workflow relies on
# to refuse to build unpinned versions.

set -euo pipefail

max_attempts="${GEZEL_FETCH_MAX_ATTEMPTS:-3}"
retry_delay_seconds="${GEZEL_FETCH_RETRY_DELAY_SECONDS:-2}"
git_bin="${GEZEL_FETCH_GIT_BIN:-git}"

if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: GEZEL_FETCH_MAX_ATTEMPTS must be a positive integer: $max_attempts" >&2
  exit 2
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "error: GEZEL_FETCH_RETRY_DELAY_SECONDS must be a non-negative integer: $retry_delay_seconds" >&2
  exit 2
fi

retry_git() {
  local operation="$1"
  shift
  local attempt=1
  local delay="$retry_delay_seconds"
  local status

  while true; do
    if "$git_bin" "$@"; then
      return 0
    else
      status=$?
    fi

    if (( attempt >= max_attempts )); then
      echo "[fetch-upstream] $operation failed after $attempt attempt(s) (exit $status)" >&2
      return "$status"
    fi

    echo "[fetch-upstream] $operation failed on attempt $attempt/$max_attempts (exit $status); retrying in ${delay}s" >&2
    if (( delay > 0 )); then
      sleep "$delay"
    fi
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

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

# Do not use a partial-clone filter here. A filtered clone turns checkout into
# another hidden network operation for promised objects; Windows Schannel has
# intermittently rejected that later request even after clone/fetch succeeded.
# Fetching the exact shallow pin transfers the same build tree in one explicit,
# retryable operation and leaves checkout local for every fresh build.
if [[ ! -d "$target/.git" ]]; then
  echo "[fetch-upstream] initializing $target for $upstream"
  mkdir -p "$target"
  "$git_bin" -C "$target" init
fi

if "$git_bin" -C "$target" remote get-url origin >/dev/null 2>&1; then
  "$git_bin" -C "$target" remote set-url origin "$upstream"
else
  "$git_bin" -C "$target" remote add origin "$upstream"
fi

echo "[fetch-upstream] pinning $engine to $commit (tag $tag)"
retry_git "fetching pinned $engine commit" -C "$target" fetch --force --tags --depth 1 origin "$commit"
retry_git "checking out pinned $engine commit" -C "$target" checkout --detach "$commit"
retry_git "updating $engine submodules" -C "$target" submodule update --init --recursive --depth 1

echo "[fetch-upstream] $engine ready at $("$git_bin" -C "$target" rev-parse HEAD)"
