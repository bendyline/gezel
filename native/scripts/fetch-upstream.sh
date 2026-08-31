#!/usr/bin/env bash
# fetch-upstream.sh — fetch or update a single engine's upstream repo
# at the commit pinned in its VERSION file.
#
# Usage: native/scripts/fetch-upstream.sh <engine-name>
#   engine-name: a directory under native/engines/, e.g. "sd-cpp".
#
# Side effects:
#   - Writes / updates native/engines/<engine>/.upstream/ (a filtered
#     checkout of the exact pinned commit with complete commit ancestry).
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
eval "$(grep -E '^(upstream|tag|build|commit)=' "$version_file" | sed 's/^/declare /')"

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

# Preserve the full commit graph because llama.cpp and whisper.cpp embed
# `git rev-list --count HEAD` as their build number. Filtering trees keeps the
# transfer close to a shallow checkout: fetch downloads ancestry, then the
# retried checkout hydrates only the pinned working tree. This also avoids the
# old unguarded partial-clone checkout that exposed Windows Schannel failures.
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

"$git_bin" -C "$target" config remote.origin.promisor true
"$git_bin" -C "$target" config remote.origin.partialclonefilter tree:0

echo "[fetch-upstream] pinning $engine to $commit (tag $tag)"
if [[ "$("$git_bin" -C "$target" rev-parse --is-shallow-repository)" == "true" ]]; then
  retry_git "unshallowing pinned $engine commit" -C "$target" fetch --force --tags --unshallow --filter=tree:0 origin "$commit"
else
  retry_git "fetching pinned $engine commit" -C "$target" fetch --force --tags --filter=tree:0 origin "$commit"
fi
retry_git "checking out pinned $engine commit" -C "$target" checkout --detach "$commit"
retry_git "updating $engine submodules" -C "$target" submodule update --init --recursive --depth 1

if [[ "$("$git_bin" -C "$target" rev-parse --is-shallow-repository)" != "false" ]]; then
  echo "error: $engine checkout is still shallow; upstream build metadata would be incorrect" >&2
  exit 1
fi

head_commit="$("$git_bin" -C "$target" rev-parse HEAD)"
if [[ "$head_commit" != "$commit" ]]; then
  echo "error: $engine checkout resolved to $head_commit instead of pinned commit $commit" >&2
  exit 1
fi

# llama.cpp embeds `git rev-list --count HEAD` as its reported version, so a
# truncated fetch produces a binary that lies about which upstream it is. The
# expected count came free from a `b####` tag until upstream added semver
# stable tags (v0.3.0); those declare `build=` instead. Resolve from either,
# and refuse to continue when neither is available — an unverifiable pin has
# to fail here rather than silently skip the only check that catches this.
if [[ "$engine" == "llama-cpp" ]]; then
  if [[ -n "${build:-}" ]]; then
    if [[ ! "$build" =~ ^[0-9]+$ ]]; then
      echo "error: build number in $version_file is not an integer: $build" >&2
      exit 1
    fi
    expected_build_number="$build"
    if [[ "$tag" =~ ^b([0-9]+)$ && "${BASH_REMATCH[1]}" != "$expected_build_number" ]]; then
      echo "error: $version_file declares build=$expected_build_number but tag $tag implies ${BASH_REMATCH[1]}" >&2
      exit 1
    fi
  elif [[ "$tag" =~ ^b([0-9]+)$ ]]; then
    expected_build_number="${BASH_REMATCH[1]}"
  else
    echo "error: llama.cpp tag $tag is not a b<number> tag, so $version_file must declare build=<number>" >&2
    exit 1
  fi

  actual_build_number="$("$git_bin" -C "$target" rev-list --count HEAD)"
  if [[ "$actual_build_number" != "$expected_build_number" ]]; then
    echo "error: llama.cpp tag $tag requires build number $expected_build_number, but git ancestry reports $actual_build_number" >&2
    exit 1
  fi
  echo "[fetch-upstream] llama.cpp build number verified: $actual_build_number ($tag)"
fi

echo "[fetch-upstream] $engine ready at $head_commit"
